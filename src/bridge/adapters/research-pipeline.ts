/**
 * Adapter for the existing Research Idea Pipeline.
 *
 * This module is the bridge's **only** window onto the pipeline. It is built on
 * what the pipeline actually exposes as a program, verified by reading its
 * scripts (`/home/lenovo/.agents/skills/research-idea-pipeline/`):
 *
 * | Surface | Program? | What it does |
 * |---|---|---|
 * | `state_check.py <state> --check --json` | yes | read-only S1—S7 / V1—V24 gate. Exit 0 pass, 3 hard violation, 4 environment |
 * | `evidence_outcome.py apply --state --packet --analysis --audit --output` | yes | the **only** program that writes a state: copy-on-write, `open('x')`, and it refuses to overwrite the source snapshot |
 * | `strategy_memory.py <cmd> --state` | yes | emits strategy updates on stdout; writes no state |
 * | `cognition.py <cmd> --state` | yes | writes the cognition directory (index / brief / revision log); never `research-state.json` |
 * | `start-project` / `continue-research` / `explore` / `audit`, R0—R14 protocols | **no** | prompt contracts only |
 *
 * Consequences the rest of the bridge depends on:
 *
 * - **No program writes `research-state.json` in place.** The write-back that
 *   the pipeline's policy demands (in-place, one current state per round) is
 *   performed by the *agent*, by editing the file. So `writeState` can only ever
 *   produce a validated **successor copy** — never an in-place canonical change.
 * - **The bridge never fabricates a mutation.** `evidence_outcome.py apply`
 *   requires the pipeline's own agent-authored `packet` / `analysis` / `audit`
 *   triple. When the caller cannot supply them, `writeState` reports
 *   `unsupported: true` instead of inventing a packet.
 * - **A missing pipeline is normal.** Every operation returns
 *   `unsupported: true` rather than throwing, so all core team features work
 *   with no pipeline installed.
 *
 * @module dsh-research-team-bridge/adapters/research-pipeline
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isoNow, systemClock, type Clock } from '../ids.ts'
import type { ResearchDecisionProposal, StateChangeRequest, StateVersion, Timestamp } from '../types.ts'

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One pipeline invocation, reported faithfully. */
export interface PipelineCommandResult {
  /** True only when the command ran and exited 0 (the pipeline's own pass code). */
  readonly ok: boolean
  /** True when no legal program exists for this operation. Never a success. */
  readonly unsupported: boolean
  /** Process exit code, or `null` when no process ran. */
  readonly exitCode: number | null
  /** The exact argv that ran, or would have run. Empty when nothing was executed. */
  readonly argv: readonly string[]
  readonly stdout: string
  readonly stderr: string
  /** Parsed stdout JSON when the command emitted JSON, else `null`. */
  readonly json: unknown | null
  /**
   * True when the command was killed for exceeding the timeout.
   *
   * Optional because a hand-built result (a test double, or a path that never
   * spawned) has no process to have timed out; absent reads as false. Every result
   * this adapter produces sets it.
   */
  readonly timedOut?: boolean
  /** True when the command was aborted before it answered; absent reads as false. */
  readonly aborted?: boolean
}

/** What the installed pipeline can actually do. */
export interface PipelineCapabilities {
  readonly readState: boolean
  readonly runValidator: boolean
  /** Copy-on-write successor state via `evidence_outcome.py apply`. */
  readonly writeStateCopyOnWrite: boolean
  /** In-place canonical write. Always `false`: no pipeline program does this. */
  readonly writeStateInPlace: boolean
  readonly strategyMemory: boolean
  readonly cognitionMemory: boolean
  /** `preset_router.py` can route intent to a preset; it never runs an entry point. */
  readonly presetRouting: boolean
  /** `env_probe.py` probes interpreters and modules; it installs nothing. */
  readonly environmentProbe: boolean
  /** `experiment_execute.py` exists, but it is dry unless `--execute` is passed by a human. */
  readonly experimentExecution: boolean
}

export interface PipelineProbe {
  readonly available: boolean
  readonly enabled: boolean
  readonly pipelineRoot: string | null
  readonly python: string | null
  readonly scripts: Readonly<Record<string, boolean>>
  readonly capabilities: PipelineCapabilities
  /** sha256 of the scripts whose contract the bridge depends on. */
  readonly digests: Readonly<Record<string, string>>
  /**
   * Pinned files whose content no longer matches. Non-empty means the audited
   * contract may have moved, so `writeState` refuses to touch state.
   */
  readonly pinMismatches: readonly string[]
  /** Prompt-only surfaces, recorded so nobody reports them as executions. */
  readonly notes: readonly string[]
  readonly checkedAt: Timestamp
  readonly error: string | null
}

/** Argument accepted by {@link ResearchPipelineAdapter.writeState}. */
export interface StateWriteRequest {
  /** The canonical state file the successor is derived from. */
  readonly statePath: string
  /** Where the successor copy is written. Must differ from `statePath`. */
  readonly outputPath?: string | null
  /** Context only; the adapter never turns a proposal into a pipeline packet. */
  readonly proposal?: ResearchDecisionProposal | null
  /** Context only; recorded, never written by this adapter. */
  readonly changes?: readonly StateChangeRequest[]
  /** The pipeline's own gate inputs. All three are mandatory for a real write. */
  readonly packetPath?: string | null
  readonly analysisPath?: string | null
  readonly auditPath?: string | null
  readonly executionLedgerPath?: string | null
  readonly signal?: AbortSignal
}

/** Argument accepted by {@link ResearchPipelineAdapter.recordStrategy}. */
export interface StrategyRequest {
  readonly statePath: string
  readonly command?: 'apply' | 'recommend' | 'validate' | 'value' | 'taste' | 'operators'
  readonly cognitionDir?: string | null
  readonly schedulerPath?: string | null
  readonly target?: string | null
  readonly signal?: AbortSignal
}

/** Argument accepted by {@link ResearchPipelineAdapter.consolidateMemory}. */
export interface MemoryRequest {
  readonly statePath: string
  readonly command?: 'build' | 'validate' | 'brief' | 'check' | 'recall'
  readonly cognitionDir?: string | null
  readonly outPath?: string | null
  readonly budget?: number | null
  readonly signal?: AbortSignal
}

/**
 * The minimum a state gate needs from a pipeline. Declared structurally so a
 * test stub is a plain object, and so the gate never depends on this class.
 */
export interface ResearchPipelinePort {
  /** Identity used in `StateGateResult.performedBy`. */
  readonly writerName?: string | null
  available(): boolean
  stateVersion(statePath: string): StateVersion | null
  readState(statePath: string): Promise<PipelineCommandResult>
  runValidator(name: string, args?: readonly string[]): Promise<PipelineCommandResult>
  writeState(args: StateWriteRequest): Promise<PipelineCommandResult>
}

// ---------------------------------------------------------------------------
// Canonical state file reading
// ---------------------------------------------------------------------------

/**
 * The pipeline's own state file name, used only to *read*. The bridge never
 * writes it; see the module header.
 */
export const CANONICAL_STATE_FILE = 'research-state.json'

/** Where a route keeps its machine state (`references/project-layout.md` §6). */
export function canonicalStatePath(projectRoot: string, route: string): string {
  return join(projectRoot, '.research-idea-pipeline', 'routes', route, CANONICAL_STATE_FILE)
}

export interface CanonicalStateFile {
  readonly path: string
  readonly exists: boolean
  readonly version: StateVersion | null
  readonly json: unknown | null
  readonly bytes: number
  readonly sha256: string | null
  readonly error: string | null
}

function unwrapState(parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.state_version !== undefined) return record
  // `state_check.py` tolerates one legacy wrapper key; mirror that read, nothing more.
  for (const key of ['world_model', 'state']) {
    const inner = record[key]
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      && (inner as Record<string, unknown>).state_version !== undefined) {
      return inner as Record<string, unknown>
    }
  }
  return record
}

function versionOf(parsed: unknown): StateVersion | null {
  const state = unwrapState(parsed)
  if (state === null) return null
  const raw = state.state_version
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

/**
 * Read the canonical state file. This is a *read*; it mints nothing.
 *
 * `state_version` is an integer in the pipeline's schema and an opaque string in
 * the bridge's vocabulary, so it is stringified here and nowhere else.
 */
export function readCanonicalStateFile(statePath: string | null | undefined): CanonicalStateFile {
  const path = statePath === null || statePath === undefined || statePath.trim() === ''
    ? ''
    : resolve(statePath)
  const empty: CanonicalStateFile = {
    path, exists: false, version: null, json: null, bytes: 0, sha256: null,
    error: path === '' ? 'no canonical state path configured' : null,
  }
  if (path === '') return empty
  try {
    if (!existsSync(path) || !statSync(path).isFile()) {
      return { ...empty, error: `no canonical state file at ${path}` }
    }
    const buffer = readFileSync(path)
    const text = buffer.toString('utf8')
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return {
        path, exists: true, version: null, json: null, bytes: buffer.byteLength, sha256,
        error: `canonical state is not valid JSON: ${(error as Error).message}`,
      }
    }
    const version = versionOf(parsed)
    return {
      path, exists: true, version, json: parsed, bytes: buffer.byteLength, sha256,
      error: version === null ? 'canonical state carries no state_version' : null,
    }
  } catch (error) {
    return { ...empty, error: (error as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const PYTHON_DEFAULT = 'python3'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_BUFFER = 8 * 1024 * 1024

/** Scripts the adapter will execute, by stable name. No arbitrary paths. */
export const PIPELINE_SCRIPTS: Readonly<Record<string, string>> = {
  state_check: 'state_check.py',
  evidence_outcome: 'evidence_outcome.py',
  structural_equivalence: 'structural_equivalence_check.py',
  release_check: 'release_check.py',
  prediction_compare: 'prediction_compare.py',
  preset_router: 'preset_router.py',
  refs_index: 'refs_index.py',
  execution_gate: 'execution_gate.py',
  experiment_execute: 'experiment_execute.py',
  env_probe: 'env_probe.py',
  render_status: 'render_status.py',
  strategy_memory: 'strategy_memory.py',
  cognition: 'cognition.py',
}

/** The pipeline's own exit-code vocabulary (`docs/research-pipeline-audit.md` §11.2). */
export const EXIT_CODES: Readonly<Record<string, number>> = {
  OK: 0, ERROR: 1, SOURCE_DOWN: 2, HARD: 3, ENV: 4,
}

/** Human name for one pipeline exit code. `3` and `4` demand different handling. */
export function classifyExit(exitCode: number | null): 'ok' | 'error' | 'source_down' | 'hard' | 'environment' | 'unknown' {
  switch (exitCode) {
    case 0: return 'ok'
    case 1: return 'error'
    case 2: return 'source_down'
    case 3: return 'hard'
    case 4: return 'environment'
    default: return 'unknown'
  }
}

/**
 * sha256 prefixes of the revision this adapter was written against
 * (`docs/research-pipeline-audit.md`, header table). Pass as `pins` to make a
 * drifted skill tree refuse a canonical write instead of trusting the contract.
 */
export const AUDITED_PINS: Readonly<Record<string, string>> = {
  'SKILL.md': 'ec8956ce37a8823e',
  'scripts/state_check.py': '427c1438df5fddce',
  'scripts/preset_router.py': '6f5308246a214fd3',
  'templates/research-state.template.json': '26a4c8da501bbb8c',
  'templates/scheduler.template.json': '09a9a9789eb4d849',
  'schemas/scheduler.schema.json': '3da7b7e09c1d0f1c',
  'preset-registry.json': 'fec32d8c44ae570f',
}

/**
 * Capabilities the pipeline *appears* to have because its documentation or its
 * prompts describe them, and which therefore must never be reported as
 * executions. Faithful to `docs/research-pipeline-audit.md` §10.
 */
/**
 * Notes that describe the **reference** implementation only.
 *
 * RTB is not bound to any one rule set, so these are prefixed with a disclaimer
 * and reported as notes rather than as contract facts: a different skill root may
 * implement these surfaces as real entry points.
 */
export const REFERENCE_IMPLEMENTATION_NOTE =
  'The following notes describe the reference implementation (research-idea-pipeline). '
  + 'RTB is not bound to it: a different skill root implementing docs/skill-contract.md may differ.'

export const PROMPT_ONLY_SURFACES: readonly string[] = [
  'The four entry points start-project / continue-research / explore / audit are prompt contracts '
  + '(references/invocation-prompts.md). No script implements them; preset_router.py routes to a '
  + 'preset, it never runs an entry.',
  'Bootstrap B0-B6 (references/project-intake.md) is intake narrative. Only the mechanical guards in '
  + 'legacy_handoff.py (detect/audit/take/rollback/guard-bootstrap) are executable.',
  'Every role in references/roles.md (R-Novelty, R-Causal, S-Lit, S-Devil, ...) is dispatched by the '
  + 'orchestrating agent. No script dispatches or verifies one; their output enters state only as T0 assurance[].',
  'R3-R6 discovery generation (P1-P6 islands, domain erasure, hygiene screen) is agent work. '
  + 'strategy_memory.py --list-menus only lists the operator mapping; it generates no candidate.',
  'R12 narrative authoring is agent work. rhetorical_realization.py prepares payloads and scores '
  + 'adjudications and makes no model API calls; it writes no prose.',
  'The 16 preset protocols (presets/*.md) are instruction documents. preset_router.py run evaluates '
  + 'preconditions and projections; it does not perform the protocol\'s scientific work, and a '
  + '"record" entry does not prove the next decision changed ("被采纳 ≠ 研究能力提升").',
  'Event listening, background residency and auto-dispatch are the caller\'s job. trigger only '
  + 'produces recommended_only / HOLD unless the environment acts.',
  'R7/R10/R13 judgement itself (attack generation, repair design, artifact review) is agent work. '
  + 'evidence_outcome.py and prediction_compare.py check contracts and transitions and state that they '
  + '"do not infer causality or validity from log wording".',
  'Anchor selection, niche naming and novelty verdicts are agent work. No script decides novelty: '
  + 'structural_equivalence_check.py checks audit completeness only.',
  'No pipeline program writes research-state.json in place. state_check.py is read-only, cognition.py '
  + 'writes only the cognition directory, strategy_memory.py emits updates on stdout, preset_router.py '
  + 'only appends recovery-log.jsonl, and evidence_outcome.py apply refuses to overwrite its source snapshot.',
]

export interface ResearchPipelineAdapterOptions {
  /** Pipeline skill root, or null when the pipeline is not installed. */
  readonly pipelineRoot: string | null
  readonly python?: string
  readonly timeoutMs?: number
  readonly clock?: Clock
  readonly enabled?: boolean
  /**
   * Repo-relative path → sha256 prefix, e.g. {@link AUDITED_PINS}. When set, a
   * mismatch makes `writeState` refuse: an unverified revision must not mutate
   * the science. Omit to run unpinned.
   */
  readonly pins?: Readonly<Record<string, string>>
}

interface ExecOutcome {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly missing: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly error: string | null
}

function parseJson(stdout: string): unknown | null {
  const text = stdout.trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    // The pipeline's `--json` modes print only JSON on stdout, but a script may
    // print a human preamble first; locate the outermost JSON value.
    const first = text.search(/[[{]/)
    if (first < 0) return null
    const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
    if (lastBrace <= first) return null
    try {
      return JSON.parse(text.slice(first, lastBrace + 1))
    } catch {
      return null
    }
  }
}

/** The adapter. Constructing it never touches the filesystem or spawns. */
export class ResearchPipelineAdapter implements ResearchPipelinePort {
  readonly writerName: string
  readonly #root: string | null
  readonly #python: string
  readonly #timeoutMs: number
  readonly #clock: Clock
  readonly #enabled: boolean
  readonly #pins: Readonly<Record<string, string>> | null

  constructor(options: ResearchPipelineAdapterOptions) {
    const root = options.pipelineRoot
    this.#root = root === null || root === undefined || root.trim() === '' ? null : resolve(root)
    this.#python = options.python ?? PYTHON_DEFAULT
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#clock = options.clock ?? systemClock
    this.#enabled = options.enabled !== false
    this.#pins = options.pins ?? null
    this.writerName = 'research-pipeline:evidence_outcome.py'
  }

  /** The resolved pipeline root, or null. */
  get pipelineRoot(): string | null {
    return this.#root
  }

  /** True when the pipeline root exists and the adapter is enabled. Never throws. */
  available(): boolean {
    if (!this.#enabled) return false
    const root = this.#root
    if (root === null) return false
    try {
      return existsSync(root) && statSync(root).isDirectory()
    } catch {
      return false
    }
  }

  /** Absolute path of one known script, or null. */
  scriptPath(name: string): string | null {
    const file = PIPELINE_SCRIPTS[name]
    if (file === undefined || this.#root === null) return null
    return join(this.#root, 'scripts', file)
  }

  /**
   * Digest the files the bridge's contract depends on, and report pinned files
   * whose content moved.
   *
   * `digests` is always produced from what is on disk, so a probe is evidence
   * rather than a claim. `pinMismatches` is only non-empty when the caller
   * supplied `pins`: an unpinned adapter is explicit about not having verified
   * the revision, instead of pretending a digest equals a pin.
   */
  #auditPins(): { digests: Readonly<Record<string, string>>; pinMismatches: readonly string[] } {
    const digests: Record<string, string> = {}
    const pinMismatches: string[] = []
    const root = this.#root
    if (root === null) return { digests, pinMismatches }

    const targets = new Map<string, string>()
    for (const file of Object.values(PIPELINE_SCRIPTS)) {
      targets.set(`scripts/${file}`, join(root, 'scripts', file))
    }
    for (const relative of Object.keys(this.#pins ?? {})) {
      if (!targets.has(relative)) targets.set(relative, join(root, relative))
    }

    for (const [relative, absolute] of targets) {
      let digest: string | null = null
      try {
        if (existsSync(absolute) && statSync(absolute).isFile()) {
          digest = createHash('sha256').update(readFileSync(absolute)).digest('hex')
        }
      } catch {
        digest = null
      }
      const pin = this.#pins?.[relative]
      if (digest === null) {
        if (pin !== undefined) pinMismatches.push(relative)
        continue
      }
      digests[relative] = digest.slice(0, 16)
      if (pin !== undefined && !digest.startsWith(pin)) pinMismatches.push(relative)
    }
    return { digests, pinMismatches: pinMismatches.sort() }
  }

  /** Result used for every operation when no pipeline program may run. */
  #unsupported(argv: readonly string[], reason: string): PipelineCommandResult {
    return {
      ok: false, unsupported: true, exitCode: null, argv, stdout: '', stderr: reason, json: null,
      timedOut: false, aborted: false,
    }
  }

  /**
   * Prove what the installed pipeline can do. Never throws, and never claims an
   * execution that did not happen: `capabilities` is derived from files actually
   * present, and the interpreter is proved with one offline read-only command.
   */
  async probe(): Promise<PipelineProbe> {
    const checkedAt = isoNow(this.#clock)
    const base: PipelineProbe = {
      available: false,
      enabled: this.#enabled,
      pipelineRoot: this.#root,
      python: this.#python,
      scripts: {},
      capabilities: {
        readState: false, runValidator: false, writeStateCopyOnWrite: false,
        writeStateInPlace: false, strategyMemory: false, cognitionMemory: false,
        presetRouting: false, environmentProbe: false, experimentExecution: false,
      },
      notes: [REFERENCE_IMPLEMENTATION_NOTE, ...PROMPT_ONLY_SURFACES],
      digests: {},
      pinMismatches: [],
      checkedAt,
      error: null,
    }
    if (!this.#enabled) return { ...base, error: 'adapter disabled by configuration' }
    if (this.#root === null) return { ...base, error: 'no pipeline root configured' }

    const scripts: Record<string, boolean> = {}
    for (const [name, file] of Object.entries(PIPELINE_SCRIPTS)) {
      try {
        scripts[name] = existsSync(join(this.#root, 'scripts', file))
      } catch {
        scripts[name] = false
      }
    }
    const present = Object.values(scripts).filter(Boolean).length
    if (present === 0) {
      return {
        ...base,
        scripts,
        ...this.#auditPins(),
        error: `pipeline root ${this.#root} contains no known scripts under scripts/`,
      }
    }

    let fabricatesInPlace = false
    const evidenceOutcome = this.scriptPath('evidence_outcome')
    if (evidenceOutcome !== null && scripts.evidence_outcome === true) {
      try {
        const source = readFileSync(evidenceOutcome, 'utf8')
        fabricatesInPlace = /add_parser\(\s*['"]apply['"]\s*\)/.test(source)
          || source.includes("for command in ('validate', 'apply')")
      } catch {
        fabricatesInPlace = false
      }
    }

    const notes = [REFERENCE_IMPLEMENTATION_NOTE, ...PROMPT_ONLY_SURFACES]
    if (fabricatesInPlace) {
      notes.push(
        'evidence_outcome.py apply writes a successor copy (open mode "x") and refuses to replace '
        + '--state; a canonical in-place change is therefore never performed by this adapter.',
      )
    }

    // One offline, read-only proof that the interpreter works.
    let interpreterError: string | null = null
    const stateCheck = this.scriptPath('state_check')
    if (stateCheck !== null && scripts.state_check === true) {
      const outcome = await this.#exec([stateCheck, '--list-rules'], undefined)
      if (outcome.missing) interpreterError = `${this.#python} is not on PATH`
      else if (outcome.timedOut) interpreterError = `probe timed out after ${this.#timeoutMs}ms`
      else if (outcome.exitCode !== 0) {
        interpreterError = `state_check.py --list-rules exited ${String(outcome.exitCode)}`
      }
    } else {
      interpreterError = 'no state_check.py to probe the interpreter with'
    }

    return {
      available: true,
      enabled: true,
      pipelineRoot: this.#root,
      python: this.#python,
      scripts,
      capabilities: {
        readState: true,
        runValidator: scripts.state_check === true,
        writeStateCopyOnWrite: fabricatesInPlace,
        writeStateInPlace: false,
        strategyMemory: scripts.strategy_memory === true,
        cognitionMemory: scripts.cognition === true,
        presetRouting: scripts.preset_router === true,
        environmentProbe: scripts.env_probe === true,
        // `experiment_execute.py` is dry unless a human passes `--execute`, and
        // this adapter never does. Present on disk is not permission to run.
        experimentExecution: false,
      },
      notes,
      ...this.#auditPins(),
      checkedAt,
      error: interpreterError,
    }
  }

  /** Read the canonical version. A file read, never a mint. Null when unclear. */
  stateVersion(statePath: string): StateVersion | null {
    return readCanonicalStateFile(statePath).version
  }

  /**
   * Read canonical state. Nothing is executed, so `argv` is empty and
   * `exitCode` is null: a file read is not a research operation.
   */
  async readState(statePath: string): Promise<PipelineCommandResult> {
    if (!this.available()) {
      return this.#unsupported([], this.#unavailableReason())
    }
    const file = readCanonicalStateFile(statePath)
    if (file.error !== null && file.json === null) {
      return {
        ok: false, unsupported: false, exitCode: null, argv: [],
        stdout: '', stderr: file.error, json: null, timedOut: false, aborted: false,
      }
    }
    return {
      ok: true, unsupported: false, exitCode: null, argv: [], stdout: '', stderr: '', json: file.json,
      timedOut: false, aborted: false,
    }
  }

  /**
   * Run one named pipeline validator. `args` is the argv after the script path,
   * passed through verbatim — the caller decides, e.g.
   * `['<state>', '--check', '--json']`.
   *
   * `ok` mirrors the pipeline's own pass semantics: exit code 0 only.
   */
  async runValidator(name: string, args: readonly string[] = []): Promise<PipelineCommandResult> {
    if (PIPELINE_SCRIPTS[name] === undefined) {
      return {
        ok: false, unsupported: true, exitCode: null, argv: [], stdout: '', stderr:
          `unknown validator ${JSON.stringify(name)}; known: ${Object.keys(PIPELINE_SCRIPTS).sort().join(', ')}`,
        json: null, timedOut: false, aborted: false,
      }
    }
    if (!this.available()) return this.#unsupported([], this.#unavailableReason())
    const script = this.scriptPath(name) as string
    if (!existsSync(script)) return this.#unsupported([], `pipeline script missing: ${script}`)
    const outcome = await this.#exec([script, ...args], undefined)
    return this.#result([this.#python, script, ...args], outcome)
  }

  /**
   * Ask the pipeline for a canonical mutation. This adapter **never** writes
   * canonical state itself and never fabricates the pipeline's gate inputs.
   *
   * A real write requires the `packet` / `analysis` / `audit` triple that
   * `evidence_outcome.py apply` validates, plus an `outputPath` different from
   * `statePath`. Anything less returns `unsupported: true` with the reason.
   */
  async writeState(args: StateWriteRequest): Promise<PipelineCommandResult> {
    if (!this.available()) return this.#unsupported([], this.#unavailableReason())
    const script = this.scriptPath('evidence_outcome')
    if (script === null) {
      return this.#unsupported([], 'the pipeline exposes no state writer')
    }
    if (!existsSync(script)) return this.#unsupported([], `pipeline script missing: ${script}`)

    const pinned = this.#auditPins()
    if (pinned.pinMismatches.length > 0) {
      return this.#unsupported([], (
        `pipeline revision drift: ${pinned.pinMismatches.join(', ')} no longer match the audited revision; `
        + 'refusing to ask for a canonical mutation'
      ))
    }

    const packet = args.packetPath ?? null
    const analysis = args.analysisPath ?? null
    const audit = args.auditPath ?? null
    const output = args.outputPath ?? null
    if (packet === null || analysis === null || audit === null) {
      const missing = [
        packet === null ? 'packetPath' : null,
        analysis === null ? 'analysisPath' : null,
        audit === null ? 'auditPath' : null,
      ].filter((entry): entry is string => entry !== null)
      return this.#unsupported([], (
        `the pipeline's writer requires its own agent-authored ${missing.join(', ')}; `
        + 'the bridge will not fabricate a mutation packet'
      ))
    }
    if (output === null || output.trim() === '') {
      return this.#unsupported([], (
        'the pipeline writes a successor copy: supply outputPath. No legal writer replaces '
        + 'the canonical state in place'
      ))
    }
    const argv = [
      this.#python, script, 'apply',
      '--state', resolve(args.statePath),
      '--packet', resolve(packet),
      '--analysis', resolve(analysis),
      '--audit', resolve(audit),
    ]
    if (args.executionLedgerPath !== null && args.executionLedgerPath !== undefined) {
      argv.push('--execution-ledger', resolve(args.executionLedgerPath))
    }
    argv.push('--output', resolve(output))

    if (resolve(output) === resolve(args.statePath)) {
      return this.#unsupported(argv, (
        'evidence_outcome.py apply refuses to overwrite its source snapshot; the bridge will not '
        + 'route around that refusal to write canonical state itself'
      ))
    }
    const outcome = await this.#exec(argv.slice(1), args.signal)
    return this.#result(argv, outcome)
  }

  /**
   * Record a strategy recommendation through the pipeline's strategy memory.
   * `strategy_memory.py` emits updates on stdout; it writes no state, so a
   * successful call is a *recommendation*, never an applied strategy.
   */
  async recordStrategy(args: StrategyRequest): Promise<PipelineCommandResult> {
    if (!this.available()) return this.#unsupported([], this.#unavailableReason())
    const script = this.scriptPath('strategy_memory')
    if (script === null || !existsSync(script)) {
      return this.#unsupported([], script === null
        ? 'the pipeline exposes no strategy memory'
        : `pipeline script missing: ${script}`)
    }
    const argv = [this.#python, script, args.command ?? 'apply', '--state', resolve(args.statePath)]
    if (args.cognitionDir !== null && args.cognitionDir !== undefined) {
      argv.push('--cognition', resolve(args.cognitionDir))
    }
    if (args.schedulerPath !== null && args.schedulerPath !== undefined) {
      argv.push('--scheduler', resolve(args.schedulerPath))
    }
    if (args.target !== null && args.target !== undefined) argv.push('--target', args.target)
    const outcome = await this.#exec(argv.slice(1), args.signal)
    return this.#result(argv, outcome)
  }

  /**
   * Consolidate cognitive memory through the CIE. `cognition.py` writes inside
   * the cognition directory and never touches `research-state.json`.
   */
  async consolidateMemory(args: MemoryRequest): Promise<PipelineCommandResult> {
    if (!this.available()) return this.#unsupported([], this.#unavailableReason())
    const script = this.scriptPath('cognition')
    if (script === null || !existsSync(script)) {
      return this.#unsupported([], script === null
        ? 'the pipeline exposes no cognitive memory'
        : `pipeline script missing: ${script}`)
    }
    const argv = [this.#python, script, args.command ?? 'build', '--state', resolve(args.statePath), '--json']
    if (args.cognitionDir !== null && args.cognitionDir !== undefined) {
      argv.push('--cognition', resolve(args.cognitionDir))
    }
    if (args.outPath !== null && args.outPath !== undefined) argv.push('--out', resolve(args.outPath))
    if (typeof args.budget === 'number') argv.push('--budget', String(args.budget))
    const outcome = await this.#exec(argv.slice(1), args.signal)
    return this.#result(argv, outcome)
  }

  #unavailableReason(): string {
    if (!this.#enabled) return 'pipeline adapter is disabled; no pipeline operation is available'
    if (this.#root === null) {
      return 'no pipeline installed (pipelineRoot is null); core team features keep working without it'
    }
    return `pipeline root ${this.#root} is not a directory`
  }

  #result(argv: readonly string[], outcome: ExecOutcome): PipelineCommandResult {
    if (outcome.missing) {
      return {
        ok: false, unsupported: true, exitCode: null, argv, stdout: outcome.stdout,
        stderr: outcome.error ?? `${this.#python} is not on PATH`, json: null,
        timedOut: false, aborted: false,
      }
    }
    // A timeout and an abort both leave `exitCode: null`, and reporting them as a
    // plain failure hid that the run was cut short rather than that it answered no.
    const detail = outcome.timedOut
      ? `the pipeline script timed out after ${this.#timeoutMs}ms`
      : outcome.aborted ? 'the pipeline script was aborted' : outcome.stderr
    return {
      ok: outcome.exitCode === 0,
      unsupported: false,
      exitCode: outcome.exitCode,
      argv,
      stdout: outcome.stdout,
      stderr: outcome.exitCode === null && outcome.error !== null ? `${detail ?? ''}`.trim() || detail : outcome.stderr,
      json: parseJson(outcome.stdout),
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
    }
  }

  /** Spawn one pipeline script. Resolves for every outcome; never rejects. */
  #exec(scriptArgs: readonly string[], signal: AbortSignal | undefined): Promise<ExecOutcome> {
    const cwd = this.#root ?? process.cwd()
    return new Promise<ExecOutcome>(resolvePromise => {
      let settled = false
      const finish = (outcome: ExecOutcome): void => {
        if (settled) return
        settled = true
        resolvePromise(outcome)
      }
      try {
        execFile(
          this.#python,
          [...scriptArgs],
          { cwd, timeout: this.#timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8', signal },
          (error, stdout, stderr) => {
            const out = typeof stdout === 'string' ? stdout : ''
            const err = typeof stderr === 'string' ? stderr : ''
            if (error === null || error === undefined) {
              finish({ exitCode: 0, stdout: out, stderr: err, missing: false, timedOut: false, aborted: false, error: null })
              return
            }
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT') {
              finish({ exitCode: null, stdout: out, stderr: err, missing: true, timedOut: false, aborted: false, error: error.message })
              return
            }
            if ((error as { name?: string }).name === 'AbortError') {
              finish({ exitCode: null, stdout: out, stderr: err, missing: false, timedOut: false, aborted: true, error: 'aborted' })
              return
            }
            if ((error as { killed?: boolean }).killed === true) {
              finish({
                exitCode: null, stdout: out, stderr: err, missing: false, timedOut: true, aborted: false,
                error: `timed out after ${this.#timeoutMs}ms`,
              })
              return
            }
            finish({
              exitCode: typeof code === 'number' ? code : null,
              stdout: out, stderr: err, missing: false, timedOut: false, aborted: false,
              error: typeof code === 'number' ? null : error.message,
            })
          },
        )
      } catch (error) {
        finish({
          exitCode: null, stdout: '', stderr: '', missing: false, timedOut: false, aborted: false,
          error: (error as Error).message,
        })
      }
    })
  }
}

/** True when `value` looks like an absolute path (used by tests and callers). */
export function isAbsolutePath(value: string): boolean {
  return isAbsolute(value)
}
