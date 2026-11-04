/**
 * The state gate: the bridge's only path toward a canonical Research State change.
 *
 * ## What this class can and cannot do
 *
 * It can **read** the canonical state file, **evaluate** a decision proposal
 * against the frozen refusal rules, **stage** the proposal in the bridge's own
 * staging area, and **delegate** the mutation to the pipeline's own writer.
 *
 * It can **not** write canonical state. There is no code path in this module
 * that opens `statePath` for writing, renames onto it, or synthesises a new
 * state document. `commit()` re-reads the canonical file afterwards and reports
 * `committed` only when the version actually changed *because the delegated
 * writer changed it*. Every other outcome is an explicit `hold` or `rejected`:
 * **a commit that did not happen is never reported as one.**
 *
 * ## Why `hold` is often the right answer
 *
 * The verified pipeline has exactly one program that writes a state,
 * `evidence_outcome.py apply`, and it is copy-on-write: it refuses to replace
 * its `--state` source. The pipeline's in-place write-back is an *agent* action,
 * not a program. So when the bridge is asked to commit and the pipeline cannot
 * legally change the canonical file, the honest result is
 * `hold` / `NO_LEGAL_WRITER` — never a fake `committed`.
 *
 * @module dsh-research-team-bridge/research/state-gate
 */

import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  readCanonicalStateFile, type CanonicalStateFile, type PipelineCommandResult,
  type ResearchPipelinePort, type StateWriteRequest,
} from '../adapters/research-pipeline.ts'
import { RtbError } from '../errors.ts'
import { idempotencyKey, isoNow, structuralHash, systemClock, type Clock } from '../ids.ts'
import type {
  CanonicalRefs, EvidenceRef, ResearchArtifact, ResearchDecisionProposal, StateGateCode,
  StateGateResult, StateVersion, TeamStore,
} from '../types.ts'
import { stageArtifact, type ArtifactDraft } from './artifacts.ts'

// ---------------------------------------------------------------------------
// Options and helper shapes
// ---------------------------------------------------------------------------

export interface ResearchStateGateOptions {
  readonly store: TeamStore
  /** `null` when the pipeline is not installed. */
  readonly pipeline: ResearchPipelinePort | null
  readonly clock?: Clock
  readonly statePath?: string | null
  readonly projectRoot?: string | null
}

/** A proposal staged in the bridge's own area. Never canonical state. */
export interface StagedProposal {
  readonly stagedPath: string
  readonly staged: ResearchArtifact
}

interface Finding {
  readonly code: StateGateCode
  readonly reason: string
}

/** Order in which a single `code` is chosen when several rules fire. */
const CODE_PRECEDENCE: readonly StateGateCode[] = [
  'EVIDENCE_NOT_VALID',
  'ASSURANCE_FAILED',
  'ASSURANCE_HELD',
  'MISSING_ASSURANCE_VERDICT',
  'STATE_VERSION_STALE',
  'STATE_VERSION_MISSING',
  'ILLEGAL_MUTATION',
  'UNAUTHORIZED_PRODUCER',
]

const STAGED_SCHEMA = 'rtb/staged-proposal@1'

/** Keys through which the bridge must never touch a canonical evidence tier. */
const EPISTEMIC_KEYS: readonly string[] = ['epistemic_status', 'epistemicStatus']

function pickCode(findings: readonly Finding[]): StateGateCode {
  for (const code of CODE_PRECEDENCE) {
    if (findings.some(finding => finding.code === code)) return code
  }
  return findings[0]?.code ?? 'OK'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * The gate. Constructing it performs no I/O.
 *
 * ## Single-writer lock
 *
 * `commit()` takes an exclusive lock by creating `<statePath>.rtb.lock` with
 * `O_EXCL`. A lock left behind by a crashed run is **not** auto-removed: the
 * gate reports `hold` / `CONCURRENT_WRITER` with the lock path so an operator
 * decides. Auto-expiry would silently allow two writers.
 */
/**
 * Whether an object graph contains a given key at any depth.
 *
 * The epistemic guard must not depend on where a caller chose to nest a forbidden
 * field: depth is not a permission.
 */
function containsKeyDeep(value: unknown, key: string, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(entry => containsKeyDeep(entry, key, depth + 1))
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, key)) return true
  return Object.values(record).some(entry => containsKeyDeep(entry, key, depth + 1))
}

export class ResearchStateGate {
  readonly #store: TeamStore
  readonly #pipeline: ResearchPipelinePort | null
  readonly #clock: Clock
  readonly #statePath: string | null
  readonly #projectRoot: string | null

  constructor(options: ResearchStateGateOptions) {
    this.#store = options.store
    this.#pipeline = options.pipeline
    const statePath = options.statePath
    this.#statePath = statePath === null || statePath === undefined || statePath.trim() === ''
      ? null
      : resolve(statePath)
    const projectRoot = options.projectRoot
    this.#projectRoot = projectRoot === null || projectRoot === undefined || projectRoot.trim() === ''
      ? null
      : resolve(projectRoot)
    this.#clock = options.clock ?? systemClock
  }

  /** The resolved canonical state path, or null when none is configured. */
  get statePath(): string | null {
    return this.#statePath
  }

  /** Exclusive lock file, next to the canonical state. Null when unconfigured. */
  lockFilePath(): string | null {
    return this.#statePath === null ? null : `${this.#statePath}.rtb.lock`
  }

  /** Where a delegated successor copy would land. Null when unconfigured. */
  successorPathFor(proposalId: string): string | null {
    return this.#statePath === null
      ? null
      : join(dirname(this.#statePath), `${basename(this.#statePath)}.rtb-next.${proposalId}.json`)
  }

  /** Bridge-owned staging area. Never the canonical state path itself. */
  stagingDirectory(): string | null {
    const anchor = this.#statePath === null ? this.#projectRoot : dirname(this.#statePath)
    return anchor === null ? null : join(anchor, 'rtb-staged')
  }

  /**
   * Read the canonical version. Reads the file; mints nothing. Null when the
   * file is absent, unreadable, or carries no `state_version`.
   */
  readStateVersion(): StateVersion | null {
    return this.readStateFile().version
  }

  /** Full read-only snapshot of the canonical file, including its digest. */
  readStateFile(): CanonicalStateFile {
    return readCanonicalStateFile(this.#statePath)
  }

  // -------------------------------------------------------------------------
  // Rule evaluation
  // -------------------------------------------------------------------------

  /** Refusals that do not depend on the canonical state version. */
  #nonVersionFindings(proposal: ResearchDecisionProposal): readonly Finding[] {
    const findings: Finding[] = []

    if (proposal.evidenceValid !== true) {
      findings.push({
        code: 'EVIDENCE_NOT_VALID',
        reason: 'the proposal declares its own evidence invalid (evidenceValid is not true)',
      })
    }

    findings.push(...this.#assuranceFindings(proposal))
    findings.push(...this.#mutationFindings(proposal))
    return findings
  }

  #assuranceFindings(proposal: ResearchDecisionProposal): readonly Finding[] {
    const findings: Finding[] = []
    // Defensive: the artifact schema now requires both lists, but the gate is also
    // reachable with an in-memory proposal, and a missing list must not crash
    // evaluation with a TypeError.
    const proposalArtifacts = new Set((proposal.artifactRefs ?? []).map(ref => ref.artifactId))
    const verdicts = this.#store.listArtifacts(proposal.team_id, { kind: 'assurance_verdict' })

    // Every verdict names the artifacts it attacks. An empty target list was treated
    // as "team-wide", but the artifact schema refuses an empty list, so that branch
    // could only ever admit a row written outside `stageArtifact`. A missing list is
    // therefore treated as unreadable evidence rather than as blanket relevance.
    const relevant = verdicts.filter(verdict => {
      const targets = asStrings(verdict.content?.targetArtifacts)
      if (targets.length === 0) return false
      return targets.some(target => proposalArtifacts.has(target))
    })

    let passes = 0
    for (const verdict of relevant) {
      const declared = verdict.content?.verdict
      const evidenceValid = verdict.content?.evidenceValid === true
      // A "pass" that declares the underlying evidence invalid is a held review.
      const effective = declared === 'pass' && !evidenceValid ? 'hold' : declared
      const reasons = asStrings(verdict.content?.reasons)
      const detail = `${verdict.artifact_id}${reasons.length === 0 ? '' : `: ${reasons.join('; ')}`}`
      if (effective === 'fail') {
        findings.push({ code: 'ASSURANCE_FAILED', reason: `assurance verdict ${detail} failed the proposal` })
      } else if (effective === 'hold') {
        findings.push({
          code: 'ASSURANCE_HELD',
          reason: declared === 'pass'
            ? `assurance verdict ${detail} passed but declares the evidence invalid`
            : `assurance verdict ${detail} is a hold`,
        })
      } else if (effective === 'pass') {
        passes += 1
      } else {
        findings.push({
          code: 'MISSING_ASSURANCE_VERDICT',
          reason: `assurance verdict ${verdict.artifact_id} carries no usable verdict value`,
        })
      }
    }

    if (passes === 0 && !findings.some(finding => finding.code === 'ASSURANCE_FAILED' || finding.code === 'ASSURANCE_HELD')) {
      findings.push({
        code: 'MISSING_ASSURANCE_VERDICT',
        reason: relevant.length === 0
          ? (proposalArtifacts.size === 0
              ? 'no assurance verdict covers this proposal, and the proposal references no staged artifact'
              : 'no assurance verdict references the proposal artifacts')
          : 'no assurance verdict with verdict "pass" references the proposal artifacts',
      })
    }
    return findings
  }

  #mutationFindings(proposal: ResearchDecisionProposal): readonly Finding[] {
    const findings: Finding[] = []
    if (proposal.requestedStateChanges.length === 0) {
      findings.push({
        code: 'ILLEGAL_MUTATION',
        reason: 'the proposal requests no canonical mutation; there is nothing to commit',
      })
    }
    for (const change of proposal.requestedStateChanges) {
      const payload = asRecord(change.payload)
      // Scanned recursively. A top-level-only scan was bypassable by nesting the key
      // one level deeper, which reached the writer for a mutation the bridge is
      // explicitly forbidden from making.
      const illegal = EPISTEMIC_KEYS.filter(key => containsKeyDeep(payload, key))
      if (illegal.length > 0) {
        findings.push({
          code: 'ILLEGAL_MUTATION',
          reason:
            `change ${change.operation} ${change.collection} sets ${illegal.join('/')}: the bridge may not `
            + 'raise an epistemic status; only the pipeline\'s own validators may',
        })
      }
    }
    return findings
  }

  /** Refusals that depend on the canonical state version. */
  #versionFindings(proposal: ResearchDecisionProposal): readonly Finding[] {
    const file = this.readStateFile()
    if (this.#statePath === null) {
      return [{ code: 'STATE_VERSION_MISSING', reason: 'no canonical state path is configured' }]
    }
    if (!file.exists) {
      return [{ code: 'STATE_VERSION_MISSING', reason: file.error ?? `no canonical state at ${file.path}` }]
    }
    if (file.version === null) {
      return [{ code: 'STATE_VERSION_MISSING', reason: file.error ?? 'canonical state carries no state_version' }]
    }
    if (proposal.baseStateVersion === null) {
      return [{
        code: 'STATE_VERSION_MISSING',
        reason: 'the proposal declares no baseStateVersion, so it cannot be anchored to the current state',
      }]
    }
    if (proposal.baseStateVersion !== file.version) {
      return [{
        code: 'STATE_VERSION_STALE',
        reason:
          `the proposal was built against state version ${proposal.baseStateVersion} but the canonical `
          + `state is at ${file.version}`,
      }]
    }
    return []
  }

  // -------------------------------------------------------------------------
  // Read-only evaluation
  // -------------------------------------------------------------------------

  /**
   * Read-only evaluation of the proposal itself: every rule, including the
   * version rule. Never takes the lock, never probes the writer, never writes.
   * A clean proposal still returns `hold` — inspection is not a commit.
   */
  async inspect(proposal: ResearchDecisionProposal): Promise<StateGateResult> {
    const findings = [...this.#nonVersionFindings(proposal), ...this.#versionFindings(proposal)]
    if (findings.length > 0) return this.#result(proposal, 'rejected', pickCode(findings), findings.map(f => f.reason))
    return this.#result(proposal, 'hold', 'OK', [
      'read-only inspection: every rule passes, and no state was written',
    ])
  }

  /**
   * Pre-flight for a commit: the refusal rules plus a live check that a legal
   * writer and a free lock exist. Writes nothing.
   *
   * When no legal writer exists the outcome is `hold` / `NO_LEGAL_WRITER`; the
   * version rule is reported in `reasons` but does not turn the hold into a
   * rejection, because with no writer there is no write for it to protect.
   */
  async evaluate(proposal: ResearchDecisionProposal): Promise<StateGateResult> {
    const findings = this.#nonVersionFindings(proposal)
    if (findings.length > 0) return this.#result(proposal, 'rejected', pickCode(findings), findings.map(f => f.reason))

    const writer = this.#writerProblem()
    if (writer !== null) {
      const versionNotes = this.#versionFindings(proposal).map(finding => finding.reason)
      return this.#result(proposal, 'hold', 'NO_LEGAL_WRITER', [writer, ...versionNotes])
    }

    const versionFindings = this.#versionFindings(proposal)
    if (versionFindings.length > 0) {
      return this.#result(proposal, 'rejected', pickCode(versionFindings), versionFindings.map(f => f.reason))
    }

    const lockPath = this.lockFilePath()
    if (lockPath !== null && existsSync(lockPath)) {
      return this.#result(proposal, 'hold', 'CONCURRENT_WRITER', [
        `another writer holds the single-writer lock at ${lockPath}; remove it only if you know the writer is gone`,
      ])
    }

    return this.#result(proposal, 'hold', 'OK', [
      'evaluation passed: a legal writer and a free lock are available; call commit() to apply',
    ])
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  /**
   * Delegate the canonical mutation to the pipeline's writer, then verify that
   * the canonical state actually changed.
   *
   * Outcomes:
   * - `rejected` — a rule refused the proposal, or the writer ran and failed.
   * - `hold` / `NO_LEGAL_WRITER` — no legal writer exists, or the writer did not
   *   change the canonical version (typically: it wrote a successor copy that
   *   only an operator may install). The bridge never installs it itself.
   * - `hold` / `CONCURRENT_WRITER` — someone else holds the lock.
   * - `committed` — the canonical version changed, and only then.
   */
  async commit(proposal: ResearchDecisionProposal, signal?: AbortSignal): Promise<StateGateResult> {
    const before = this.readStateFile()
    const findings = this.#nonVersionFindings(proposal)
    if (findings.length > 0) {
      return this.#result(proposal, 'rejected', pickCode(findings), findings.map(f => f.reason), before.version)
    }

    const writer = this.#writerProblem()
    if (writer !== null) {
      const versionNotes = this.#versionFindings(proposal).map(finding => finding.reason)
      return this.#result(proposal, 'hold', 'NO_LEGAL_WRITER', [writer, ...versionNotes], before.version)
    }

    const versionFindings = this.#versionFindings(proposal)
    if (versionFindings.length > 0) {
      return this.#result(proposal, 'rejected', pickCode(versionFindings), versionFindings.map(f => f.reason), before.version)
    }

    const lockPath = this.lockFilePath()
    const successorPath = this.successorPathFor(proposal.proposal_id)
    if (lockPath === null || successorPath === null) {
      return this.#result(proposal, 'hold', 'NO_LEGAL_WRITER', [
        'no canonical state path is configured, so no writer can be addressed',
      ], before.version)
    }

    const acquired = this.#acquireLock(lockPath, proposal)
    if (!acquired.ok) {
      return this.#result(proposal, 'hold', 'CONCURRENT_WRITER', [acquired.reason], before.version)
    }

    try {
      // Re-check under the lock: a proposal built against a version that moved
      // while we were evaluating must not be written.
      const current = this.readStateVersion()
      if (current !== proposal.baseStateVersion) {
        return this.#result(proposal, 'rejected', current === null ? 'STATE_VERSION_MISSING' : 'STATE_VERSION_STALE', [
          current === null
            ? 'the canonical state disappeared or lost its state_version before the write'
            : `the canonical state moved to ${current} after evaluation; rebuild the proposal`,
        ], before.version)
      }

      const request: StateWriteRequest = {
        statePath: this.#statePath as string,
        outputPath: successorPath,
        proposal,
        changes: proposal.requestedStateChanges,
        signal,
      }
      let result: PipelineCommandResult
      try {
        result = await (this.#pipeline as ResearchPipelinePort).writeState(request)
      } catch (error) {
        return this.#result(proposal, 'rejected', 'WRITER_FAILED', [
          `the pipeline writer threw: ${(error as Error).message}`,
        ], before.version)
      }

      if (result.unsupported) {
        return this.#result(proposal, 'hold', 'NO_LEGAL_WRITER', [
          result.stderr === '' ? 'the pipeline exposes no legal writer for this mutation' : result.stderr,
        ], before.version)
      }
      if (!result.ok) {
        return this.#result(proposal, 'rejected', 'WRITER_FAILED', [
          `the pipeline writer failed (exit ${String(result.exitCode)}): `
          + `${(result.stderr || result.stdout).trim().slice(0, 600) || 'no output'}`,
        ], before.version)
      }

      // The only evidence of a commit is a changed canonical version.
      const after = this.readStateFile()
      if (after.version !== null && after.version !== before.version) {
        return this.#result(proposal, 'committed', 'OK', [
          `canonical state moved from ${String(before.version)} to ${after.version}`,
        ], before.version, after.version, this.#performedBy(result))
      }

      const staged = existsSync(successorPath) ? [successorPath] : []
      return this.#result(proposal, 'hold', 'NO_LEGAL_WRITER', [
        'the delegated writer reported success but the canonical state version did not change',
        `the bridge will not install a successor itself${staged.length === 0 ? '' : `; the validated copy is at ${successorPath}`}`,
        'the pipeline\'s only state writer is copy-on-write and refuses to replace --state: an operator or '
        + 'the pipeline\'s own in-place procedure must install the successor',
      ], before.version, after.version, null, staged)
    } finally {
      this.#releaseLock(lockPath)
    }
  }

  // -------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------

  /**
   * Stage the proposal as a bridge artifact and as a JSON file in the bridge's
   * own staging area (`<state dir>/rtb-staged/`). Explicitly not canonical
   * state, and never written to `statePath`.
   */
  stageProposal(proposal: ResearchDecisionProposal): StagedProposal {
    const directory = this.stagingDirectory()
    if (directory === null) {
      throw new RtbError(
        'CONFIG_INVALID',
        'cannot stage a proposal: neither a canonical state path nor a project root is configured',
        { proposalId: proposal.proposal_id },
      )
    }
    const team = this.#store.getTeam(proposal.team_id)
    if (team === undefined) {
      throw new RtbError('TEAM_NOT_FOUND', `unknown team ${proposal.team_id}`, { teamId: proposal.team_id })
    }

    const verdicts = this.#store
      .listArtifacts(proposal.team_id, { kind: 'assurance_verdict' })
      .filter(verdict => {
        const targets = asStrings(verdict.content?.targetArtifacts)
        return targets.length === 0
          || targets.some(target => proposal.artifactRefs.some(ref => ref.artifactId === target))
      })

    const content: Record<string, unknown> = {
      question: proposal.question,
      competingMechanisms: [...proposal.competingMechanisms],
      positions: proposal.positions.map(position => ({
        role: position.role,
        agentId: position.agentId,
        stance: position.stance,
        reason: position.reason,
      })),
      discriminatingPredictions: [...proposal.discriminatingPredictions],
      evidenceValid: proposal.evidenceValid,
      cheapestNextIntervention: proposal.cheapestNextIntervention,
      requestedStateChanges: proposal.requestedStateChanges.map(change => ({
        operation: change.operation,
        collection: change.collection,
        objectId: change.objectId,
        summary: change.summary,
        payload: { ...change.payload },
      })),
      baseStateVersion: proposal.baseStateVersion,
      // `loadProposal` resolves a staged proposal by `content.proposal_id`, and the
      // gate dereferences both ref lists. Omitting these made a staged proposal
      // unfindable by the id the caller was given, and unreadable by the gate.
      proposal_id: proposal.proposal_id,
      artifactRefs: proposal.artifactRefs.map(ref => ({ artifactId: ref.artifactId, kind: ref.kind })),
      evidenceRefs: proposal.evidenceRefs.map(ref => ({ objectId: ref.objectId })),
    }

    const draft: ArtifactDraft = {
      kind: 'research_decision_proposal',
      teamId: proposal.team_id,
      // A decision is not a research task; reuse the captain's task when one
      // exists, otherwise label the row with the proposal id.
      taskId: this.#decisionTaskId(proposal) ?? `decision:${proposal.proposal_id}`,
      attemptId: null,
      producerAgentId: team.captainAgentId,
      producerRole: 'captain',
      researchRoute: null,
      stateVersion: proposal.baseStateVersion,
      refs: refsFromEvidenceRefs(proposal),
      evidenceRefs: [...proposal.evidenceRefs],
      content,
      provenance: {
        messageIds: [...new Set(proposal.positions.flatMap(position => [...position.messageIds]))],
        attemptIds: [],
        sources: [],
        executed: false,
        // Verdict artifact ids only: the bridge never mints a verdict.
        verdicts: verdicts.map(verdict => verdict.artifact_id),
      },
      idempotencyKey: idempotencyKey(['decision-proposal', proposal.team_id, proposal.proposal_id]),
    }
    const staged = stageArtifact(this.#store, draft, this.#clock)

    const before = this.readStateFile()
    const stagedPath = join(directory, `${safeFileComponent(proposal.proposal_id)}.json`)
    const document = {
      schema: STAGED_SCHEMA,
      proposal_id: proposal.proposal_id,
      team_id: proposal.team_id,
      base_state_version: proposal.baseStateVersion,
      staged_artifact_id: staged.artifact_id,
      content_digest: structuralHash(content),
      artifact_refs: proposal.artifactRefs.map(ref => ({ artifactId: ref.artifactId, kind: ref.kind })),
      assurance_verdict_artifact_ids: verdicts.map(verdict => verdict.artifact_id),
      canonical_state: {
        path: before.path === '' ? null : before.path,
        version: before.version,
        sha256: before.sha256,
      },
      created_at: isoNow(this.#clock),
      note:
        'Bridge staging only. This file is not Research State and must never be read as canonical; '
        + 'the canonical state remains the single scientific authority.',
    }
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(stagedPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    } catch (error) {
      throw new RtbError('PIPELINE_FAILED', `could not write the staged proposal: ${(error as Error).message}`, {
        stagedPath,
      })
    }
    return { stagedPath, staged }
  }

  #decisionTaskId(proposal: ResearchDecisionProposal): string | null {
    const tasks = this.#store.listTasks(proposal.team_id)
    const own = tasks.find(task => task.task_id === proposal.proposal_id)
    if (own !== undefined) return own.task_id
    const decisionTask = tasks.find(task => task.role === 'captain' || task.role === 'synthesis')
    return decisionTask?.task_id ?? null
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A human reason why no legal writer exists, or null when one does. */
  #writerProblem(): string | null {
    const pipeline = this.#pipeline
    if (pipeline === null) {
      return 'no pipeline is configured: there is no legal writer, and the bridge will not write canonical state itself'
    }
    let available = false
    try {
      available = pipeline.available()
    } catch (error) {
      return `the pipeline adapter failed its availability check: ${(error as Error).message}`
    }
    if (!available) {
      return 'the pipeline is unavailable: there is no legal writer, and the bridge will not write canonical state itself'
    }
    return null
  }

  #performedBy(result: PipelineCommandResult): string {
    const named = this.#pipeline?.writerName
    if (typeof named === 'string' && named.trim() !== '') return named
    const script = result.argv.find(argument => argument.endsWith('.py'))
    return script ?? 'pipeline-writer'
  }

  #acquireLock(lockPath: string, proposal: ResearchDecisionProposal): { ok: true } | { ok: false; reason: string } {
    try {
      const handle = openSync(lockPath, 'wx')
      try {
        writeFileSync(handle, JSON.stringify({
          proposalId: proposal.proposal_id,
          teamId: proposal.team_id,
          pid: process.pid,
          at: isoNow(this.#clock),
        }))
      } finally {
        closeSync(handle)
      }
      return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        return {
          ok: false,
          reason: `another writer holds the single-writer lock at ${lockPath}; `
            + 'the bridge never breaks a lock automatically',
        }
      }
      return { ok: false, reason: `could not take the single-writer lock at ${lockPath}: ${(error as Error).message}` }
    }
  }

  #releaseLock(lockPath: string): void {
    try {
      unlinkSync(lockPath)
    } catch {
      // A lock we cannot remove stays visible to the next caller, which is the
      // safe failure direction; it is never silently ignored as "free".
    }
  }

  #result(
    proposal: ResearchDecisionProposal,
    outcome: StateGateResult['outcome'],
    code: StateGateCode,
    reasons: readonly string[],
    stateVersionBefore: StateVersion | null = null,
    stateVersionAfter: StateVersion | null = null,
    performedBy: string | null = null,
    stagedPaths: readonly string[] = [],
  ): StateGateResult {
    return {
      outcome,
      proposalId: proposal.proposal_id,
      code,
      reasons,
      stateVersionBefore,
      stateVersionAfter,
      performedBy,
      stagedPaths,
      checkedAt: isoNow(this.#clock),
    }
  }
}

/** Map the proposal's evidence refs onto the frozen canonical reference slots. */
export function refsFromEvidenceRefs(proposal: ResearchDecisionProposal): CanonicalRefs {
  const buckets: Record<keyof CanonicalRefs, string[]> = {
    claims: [], hypotheses: [], evidence: [], experiments: [], predictions: [], cognitiveMemory: [],
  }
  const slotOf: Record<EvidenceRef['collection'], keyof CanonicalRefs> = {
    evidence: 'evidence',
    experiment: 'experiments',
    claim: 'claims',
    hypothesis: 'hypotheses',
    prediction: 'predictions',
    memory: 'cognitiveMemory',
  }
  for (const ref of proposal.evidenceRefs) {
    const bucket = buckets[slotOf[ref.collection]]
    if (bucket !== undefined && !bucket.includes(ref.objectId)) bucket.push(ref.objectId)
  }
  return {
    claims: buckets.claims,
    hypotheses: buckets.hypotheses,
    evidence: buckets.evidence,
    experiments: buckets.experiments,
    predictions: buckets.predictions,
    cognitiveMemory: buckets.cognitiveMemory,
  }
}

/** Keep a proposal id usable as a filename without letting it escape the directory. */
function safeFileComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[.]+/, '')
  return cleaned === '' ? 'proposal' : cleaned.slice(0, 120)
}
