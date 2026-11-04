/**
 * Staged research artifacts: the nine legal hand-off products.
 *
 * An artifact is **staged**, never canonical. It becomes scientific only after
 * the existing pipeline's own validators promote it, and the bridge never
 * performs that promotion. Three invariants are enforced mechanically here:
 *
 * 1. **No fabricated science.** `provenance.executed` may only be `true` for an
 *    `experiment_result` that carries real artifact paths and a real
 *    file / command / artifact `SourceRef`. Reasoning products are never
 *    stamped as executions.
 * 2. **Evidence is never upgraded by the bridge.** This module accepts a
 *    declared tier at or below `raw_observation` and refuses
 *    `evidence_supported` / `reviewed` outright: only the pipeline's own
 *    validators, reached through the state gate, may raise a canonical tier.
 *    An artifact with no canonical reference at all stays `speculation`.
 * 3. **References are shaped like real canonical ids.** Every entry in
 *    `CanonicalRefs` must match the pipeline's frozen id space
 *    (`references/research-state-policy.md` §2.1: `C / E / AS / H / X / LIT /
 *    F / U`, cognition revisions `REV<n>`, frozen prediction outcomes `O<n>`).
 *    Existence is *not* re-checked here — the pipeline's own `state_check.py`
 *    V2 / V7 / V9 rules own that, and the bridge must not pretend to own it.
 *
 * @module dsh-research-team-bridge/research/artifacts
 */

import { RtbError } from '../errors.ts'
import { isoNow, newId, structuralHash, systemClock, idempotencyKey as keyFrom, type Clock } from '../ids.ts'
import type {
  AgentId, ArtifactProvenance, AttemptId, CanonicalRefs, EpistemicStatus, EvidenceRef, EvidenceTier,
  ResearchArtifact, ResearchArtifactKind, ResearchRole, SourceRef, StateVersion, TaskId, TeamId,
  TeamStore,
} from '../types.ts'

// ---------------------------------------------------------------------------
// Schema vocabulary
// ---------------------------------------------------------------------------

/** What one staged artifact kind requires. Frozen shape; do not add fields. */
export interface ArtifactSchema {
  readonly kind: ResearchArtifactKind
  readonly requiredFields: readonly string[]
  readonly allowedProducerRoles: readonly ResearchRole[]
  readonly defaultEpistemicStatus: EpistemicStatus
  readonly requiresEvidenceRefs: boolean
  readonly routeHints: readonly string[]
}

/** The nine legal kinds. There is no tenth: this is not a second state model. */
export const ARTIFACT_KINDS: readonly ResearchArtifactKind[] = [
  'hypothesis_proposal',
  'mechanism_model',
  'novel_prediction',
  'discriminating_intervention',
  'literature_evidence',
  'experiment_result',
  'counterexample',
  'assurance_verdict',
  'research_decision_proposal',
]

/**
 * R3 exploration islands (`references/phase-r3-r6-discovery.md` §R3.3).
 * `P3` is deliberately absent: it produces only a typed intermediate skeleton,
 * never a candidate (`§R3.0.1`), so it may not appear on a hypothesis artifact.
 */
export const ISLAND_IDS: readonly string[] = ['P1', 'P2', 'P4', 'P5', 'P6', 'local']

/** Kinds that carry candidate *content* and are therefore island-scoped. */
export const CANDIDATE_BEARING_KINDS: readonly ResearchArtifactKind[] = [
  'hypothesis_proposal',
  'mechanism_model',
  'novel_prediction',
  'counterexample',
]

/** Experiment purpose classes (`references/research-state-policy.md` §3.5). */
const EXPERIMENT_STAGES: readonly string[] = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6']

/** Message-payload vocabulary is reused verbatim so no rename step can drift. */
export const ARTIFACT_SCHEMAS: Readonly<Record<ResearchArtifactKind, ArtifactSchema>> = {
  hypothesis_proposal: {
    kind: 'hypothesis_proposal',
    requiredFields: ['statement', 'mechanismSketch', 'falsifier', 'islandId'],
    allowedProducerRoles: ['discovery', 'theory'],
    defaultEpistemicStatus: 'speculation',
    requiresEvidenceRefs: false,
    routeHints: ['R3', 'R6'],
  },
  mechanism_model: {
    kind: 'mechanism_model',
    requiredFields: ['mechanism', 'claim', 'discriminatingObservable'],
    allowedProducerRoles: ['theory', 'discovery'],
    defaultEpistemicStatus: 'speculation',
    requiresEvidenceRefs: false,
    routeHints: ['R3', 'R5'],
  },
  novel_prediction: {
    kind: 'novel_prediction',
    requiredFields: ['statement', 'observable', 'expectedRange', 'discriminatingAgainst'],
    allowedProducerRoles: ['theory', 'discovery'],
    defaultEpistemicStatus: 'speculation',
    requiresEvidenceRefs: false,
    routeHints: ['R3', 'R6'],
  },
  discriminating_intervention: {
    kind: 'discriminating_intervention',
    // `stage` is validated by the field rules below, but the rule was unreachable
    // while the field was optional: an intervention could omit it entirely and any
    // stage value went unchecked.
    requiredFields: ['intervention', 'discriminatingObservable', 'alternativeTargeted', 'stage'],
    allowedProducerRoles: ['experiment', 'theory'],
    defaultEpistemicStatus: 'speculation',
    requiresEvidenceRefs: false,
    routeHints: ['R9'],
  },
  literature_evidence: {
    kind: 'literature_evidence',
    requiredFields: ['nearestWork', 'delta', 'threatToNovelty'],
    allowedProducerRoles: ['literature'],
    defaultEpistemicStatus: 'raw_observation',
    requiresEvidenceRefs: true,
    routeHints: ['R2', 'R5', 'R8'],
  },
  experiment_result: {
    kind: 'experiment_result',
    requiredFields: ['taskId', 'result', 'artifactPaths', 'preregistered'],
    allowedProducerRoles: ['experiment'],
    defaultEpistemicStatus: 'raw_observation',
    requiresEvidenceRefs: true,
    routeHints: ['R9'],
  },
  counterexample: {
    kind: 'counterexample',
    requiredFields: ['targets', 'construction', 'impact', 'assumptionBroken'],
    allowedProducerRoles: ['assurance', 'theory', 'discovery'],
    defaultEpistemicStatus: 'speculation',
    requiresEvidenceRefs: false,
    routeHints: ['R7', 'R13'],
  },
  assurance_verdict: {
    kind: 'assurance_verdict',
    requiredFields: ['targetArtifacts', 'verdict', 'reasons', 'evidenceValid'],
    allowedProducerRoles: ['assurance'],
    defaultEpistemicStatus: 'raw_observation',
    requiresEvidenceRefs: false,
    routeHints: ['R7', 'R10', 'R13'],
  },
  research_decision_proposal: {
    kind: 'research_decision_proposal',
    requiredFields: [
      'question', 'competingMechanisms', 'positions', 'discriminatingPredictions',
      'evidenceValid', 'cheapestNextIntervention', 'requestedStateChanges', 'baseStateVersion',
      // The gate dereferences both lists unconditionally, so a proposal without them
      // passed validation and then threw a TypeError deep inside evaluation.
      'artifactRefs', 'evidenceRefs',
    ],
    allowedProducerRoles: ['captain', 'synthesis'],
    defaultEpistemicStatus: 'speculation',
    requiresEvidenceRefs: false,
    routeHints: ['R8', 'R10', 'R14'],
  },
}

// ---------------------------------------------------------------------------
// Canonical id space
// ---------------------------------------------------------------------------

/**
 * Id shapes the bridge is willing to *reference*. These mirror
 * `references/research-state-policy.md` §2.1 and the CIE revision log
 * (`examples/cognition/model-revisions.jsonl`, `"id": "REV1"`). Frozen
 * predictions are identified by their owning experiment (`X<n>`) or the frozen
 * outcome id inside the prediction packet (`O<n>`); the bridge invents no new
 * prediction prefix.
 */
export const CANONICAL_ID_PATTERNS: Readonly<Record<keyof CanonicalRefs, RegExp>> = {
  claims: /^C\d+[a-z]?$/,
  hypotheses: /^H\d+$/,
  evidence: /^E\d+$/,
  experiments: /^X\d+$/,
  predictions: /^(?:O|X)\d+$/,
  cognitiveMemory: /^REV\d+$/,
}

const SOURCE_KINDS: readonly SourceRef['kind'][] = [
  'file', 'command', 'url', 'artifact', 'session-event', 'paper',
]

const EVIDENCE_COLLECTIONS: readonly EvidenceRef['collection'][] = [
  'evidence', 'experiment', 'claim', 'hypothesis', 'prediction', 'memory',
]

const EVIDENCE_TIERS: readonly EvidenceTier[] = ['speculation', 'raw_observation', 'reproduced', 'reviewed']

/** Canonical state never contains these literals, so a staged artifact may not either. */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bTBD\b/i, /\bTODO\b/i, /\bFIXME\b/i, /\bXXX\b/, /待补/, /示例占位/, /<[^>]*>/,
]

/** A placeholder-free, non-blank string. */
function isRealText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function placeholderHit(value: string): string | null {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(value)
    if (match !== null) return match[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

type FieldCheck = (value: unknown) => string | null

const asText: FieldCheck = value => (isRealText(value) ? null : 'must be a non-blank string')

const asTextOrNull: FieldCheck = value =>
  value === null || isRealText(value) ? null : 'must be a non-blank string or null'

const asBoolean: FieldCheck = value => (typeof value === 'boolean' ? null : 'must be a boolean')

const asTextArray: FieldCheck = value => {
  if (!Array.isArray(value) || value.length === 0) return 'must be a non-empty array of strings'
  return value.every(isRealText) ? null : 'every entry must be a non-blank string'
}

const asObjectArray: FieldCheck = value => {
  if (!Array.isArray(value) || value.length === 0) return 'must be a non-empty array of objects'
  return value.every(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    ? null
    : 'every entry must be a JSON object'
}

const asEnum = (values: readonly string[]): FieldCheck =>
  value => (typeof value === 'string' && values.includes(value)
    ? null
    : `must be one of ${values.join(' | ')}`)

const asArtifactPaths: FieldCheck = value => {
  if (!Array.isArray(value) || value.length === 0) return 'must be a non-empty array of real artifact paths'
  for (const entry of value) {
    if (!isRealText(entry)) return 'every artifact path must be a non-blank string'
    if (placeholderHit(entry) !== null) return `artifact path ${entry} is a placeholder, not a path`
  }
  return null
}

/** Per-kind rules for fields whose shape is not obvious from its name. */
const CONTENT_FIELD_RULES: Readonly<Record<ResearchArtifactKind, Readonly<Record<string, FieldCheck>>>> = {
  hypothesis_proposal: {
    statement: asText,
    mechanismSketch: asText,
    falsifier: asText,
    islandId: value => {
      if (typeof value !== 'string') return 'must be a string island id'
      if (value === 'P3') {
        return 'P3 produces only a typed intermediate skeleton, never a candidate (phase-r3-r6-discovery.md §R3.0.1)'
      }
      return ISLAND_IDS.includes(value) ? null : `must be one of ${ISLAND_IDS.join(' | ')}`
    },
  },
  mechanism_model: {
    mechanism: asText,
    claim: asText,
    discriminatingObservable: asText,
  },
  novel_prediction: {
    statement: asText,
    observable: asText,
    expectedRange: asText,
    discriminatingAgainst: asTextArray,
  },
  discriminating_intervention: {
    intervention: asText,
    discriminatingObservable: asText,
    alternativeTargeted: asTextArray,
    stage: asEnum(EXPERIMENT_STAGES),
  },
  literature_evidence: {
    nearestWork: asTextArray,
    delta: asText,
    threatToNovelty: asEnum(['high', 'medium', 'low']),
  },
  experiment_result: {
    taskId: asText,
    result: asText,
    artifactPaths: asArtifactPaths,
    preregistered: asBoolean,
  },
  counterexample: {
    targets: asText,
    construction: asText,
    impact: asEnum(['fatal', 'serious', 'minor']),
    assumptionBroken: asText,
  },
  assurance_verdict: {
    targetArtifacts: asTextArray,
    verdict: asEnum(['pass', 'fail', 'hold']),
    reasons: asTextArray,
    evidenceValid: asBoolean,
  },
  research_decision_proposal: {
    question: asText,
    competingMechanisms: asTextArray,
    positions: asObjectArray,
    discriminatingPredictions: asTextArray,
    evidenceValid: asBoolean,
    cheapestNextIntervention: asText,
    requestedStateChanges: value => {
      if (!Array.isArray(value)) return 'must be an array of state change requests (may be empty)'
      return value.every(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
        ? null
        : 'every change request must be a JSON object'
    },
    baseStateVersion: asTextOrNull,
  },
}

const GENERIC_FIELD_RULE: FieldCheck = value => {
  if (isRealText(value)) return null
  if (Array.isArray(value) && value.length > 0) return null
  if (typeof value === 'boolean' || typeof value === 'number') return null
  if (value !== null && typeof value === 'object') return null
  return 'must be a non-blank string, a non-empty array, or a JSON value'
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Everything wrong with `content` for `kind`, as human-readable problems.
 * An empty array means the content satisfies the staged schema.
 *
 * This validates *shape and honesty*, not scientific truth: whether an id
 * exists in canonical state is the pipeline's own `state_check.py` V-rule job.
 */
export function validateArtifactContent(
  kind: ResearchArtifactKind,
  content: Readonly<Record<string, unknown>>,
): readonly string[] {
  const schema: ArtifactSchema | undefined = ARTIFACT_SCHEMAS[kind]
  if (schema === undefined) return [`unknown artifact kind ${String(kind)}`]
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return ['content must be a JSON object']
  }
  const rules = CONTENT_FIELD_RULES[kind] ?? {}
  const problems: string[] = []
  for (const field of schema.requiredFields) {
    const value = content[field]
    if (value === undefined) {
      problems.push(`missing required field ${field}`)
      continue
    }
    if (value === null) {
      // `baseStateVersion` is the one contractually nullable decision field.
      if (field === 'baseStateVersion') continue
      problems.push(`${field} must not be null`)
      continue
    }
    const rule = rules[field] ?? GENERIC_FIELD_RULE
    const problem = rule(value)
    if (problem !== null) problems.push(`${field}: ${problem}`)
  }
  for (const field of schema.requiredFields) {
    const value = content[field]
    if (typeof value !== 'string') continue
    const hit = placeholderHit(value)
    if (hit !== null) problems.push(`${field} contains the placeholder ${JSON.stringify(hit)}`)
  }
  return problems
}

/** Bad canonical ids, duplicates and placeholders in a `CanonicalRefs` block. */
export function validateCanonicalRefs(refs: CanonicalRefs): readonly string[] {
  const problems: string[] = []
  if (refs === null || typeof refs !== 'object') return ['refs must be a CanonicalRefs object']
  for (const collection of Object.keys(CANONICAL_ID_PATTERNS) as (keyof CanonicalRefs)[]) {
    const entries = refs[collection]
    if (!Array.isArray(entries)) {
      problems.push(`refs.${collection} must be an array (use [] for none)`)
      continue
    }
    const seen = new Set<string>()
    for (const id of entries) {
      if (!isRealText(id)) {
        problems.push(`refs.${collection} contains a non-string id`)
        continue
      }
      const hit = placeholderHit(id)
      if (hit !== null) {
        problems.push(`refs.${collection}[${id}] is a placeholder, not a canonical id`)
        continue
      }
      if (!CANONICAL_ID_PATTERNS[collection].test(id)) {
        problems.push(`refs.${collection}[${id}] is not a valid canonical id for that collection`)
        continue
      }
      if (seen.has(id)) problems.push(`refs.${collection} repeats ${id}`)
      seen.add(id)
    }
  }
  return problems
}

/** Bad sources inside an {@link EvidenceRef} or a provenance block. */
/**
 * Whether a locator looks like the kind of source it claims to be.
 *
 * Loose on purpose: the point is to reject prose and placeholders, not to police
 * how a project lays out its own tree.
 */
function locatorShapeProblems(kind: string, locator: string, where: string): readonly string[] {
  const text = locator.trim()
  switch (kind) {
    case 'file':
      // A path, not a sentence: a separator or a plausible file name, and no spaces
      // in the middle of a sentence.
      if (!/^[^\s]+$/.test(text) || !/[.\/\\]/.test(text)) {
        return [`${where}.locator must be a file path (no spaces) for kind 'file'`]
      }
      return []
    case 'url':
      if (!/^https?:\/\/\S+$/.test(text)) {
        return [`${where}.locator must be an http(s) URL for kind 'url'`]
      }
      return []
    case 'command':
      // A command may contain spaces; it may not be a prose sentence.
      if (text.split(/\s+/).length > 24) {
        return [`${where}.locator is too long to be a command for kind 'command'`]
      }
      return []
    case 'session-event':
      if (!/^[A-Za-z0-9_:.-]+$/.test(text)) {
        return [`${where}.locator must be a session event reference for kind 'session-event'`]
      }
      return []
    default:
      // `artifact`, `paper`: an identifier or a citation, never a paragraph.
      if (text.length > 300) {
        return [`${where}.locator is too long for kind '${kind}'`]
      }
      return []
  }
}

export function validateSourceRef(source: SourceRef, where: string): readonly string[] {
  const problems: string[] = []
  if (source === null || typeof source !== 'object') return [`${where} must be a SourceRef object`]
  if (!SOURCE_KINDS.includes(source.kind)) {
    problems.push(`${where}.kind must be one of ${SOURCE_KINDS.join(' | ')}`)
  }
  if (!isRealText(source.locator)) {
    problems.push(`${where}.locator must be a real locator, not blank prose`)
  } else {
    const hit = placeholderHit(source.locator)
    if (hit !== null) problems.push(`${where}.locator is a placeholder`)
    // The shape has to match the kind, or `executed: true` is "provable" with free
    // prose: any non-blank string used to satisfy a `file` source. The checks stay
    // deliberately loose (a path may be relative and platform-specific), but they do
    // require the locator to look like the thing it claims to be.
    problems.push(...locatorShapeProblems(source.kind, source.locator, where))
  }
  if (source.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(source.sha256)) {
    problems.push(`${where}.sha256 must be 64 lowercase hex characters`)
  }
  return problems
}

/** Bad entries in the artifact's declared evidence refs. */
export function validateEvidenceRefs(refs: readonly EvidenceRef[]): readonly string[] {
  const problems: string[] = []
  if (!Array.isArray(refs)) return ['evidence_refs must be an array']
  refs.forEach((ref, index) => {
    const where = `evidence_refs[${index}]`
    if (ref === null || typeof ref !== 'object') {
      problems.push(`${where} must be an EvidenceRef object`)
      return
    }
    if (!EVIDENCE_COLLECTIONS.includes(ref.collection)) {
      problems.push(`${where}.collection must be one of ${EVIDENCE_COLLECTIONS.join(' | ')}`)
    }
    if (!isRealText(ref.objectId)) problems.push(`${where}.objectId must be a real canonical object id`)
    if (!EVIDENCE_TIERS.includes(ref.tier)) {
      problems.push(`${where}.tier must be one of ${EVIDENCE_TIERS.join(' | ')}`)
    }
    problems.push(...validateSourceRef(ref.source, `${where}.source`))
  })
  return problems
}

/** True when no canonical object is referenced at all. */
export function refsAreEmpty(refs: CanonicalRefs): boolean {
  return (Object.keys(CANONICAL_ID_PATTERNS) as (keyof CanonicalRefs)[])
    .every(collection => (refs[collection] ?? []).length === 0)
}

/** Real, inspectable origins inside a provenance block. */
export function realSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return sources.filter(source =>
    source !== null
    && typeof source === 'object'
    && SOURCE_KINDS.includes(source.kind)
    && isRealText(source.locator))
}

/** A fresh, all-empty `CanonicalRefs` block. */
export function emptyCanonicalRefs(): CanonicalRefs {
  return { claims: [], hypotheses: [], evidence: [], experiments: [], predictions: [], cognitiveMemory: [] }
}

/**
 * Refuse `evidence_supported` / `reviewed`: only the pipeline's validators,
 * reached through the state gate, may raise a canonical tier. See the module
 * header, invariant 2.
 */
const GATE_ONLY_STATUSES: readonly EpistemicStatus[] = ['evidence_supported', 'reviewed']

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** Caller-supplied half of an artifact; `stageArtifact` fills the rest. */
export interface ArtifactDraft {
  readonly kind: ResearchArtifactKind
  readonly teamId: TeamId
  readonly taskId: TaskId
  readonly attemptId: AttemptId | null
  readonly producerAgentId: AgentId
  readonly producerRole: ResearchRole
  readonly researchRoute: string | null
  readonly stateVersion: StateVersion | null
  readonly refs: CanonicalRefs
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly content: Readonly<Record<string, unknown>>
  readonly provenance: ArtifactProvenance
  readonly idempotencyKey?: string
  readonly epistemicStatus?: EpistemicStatus
}

/** Throws when `role` is not allowed to produce `kind`. */
export function assertKindAllowedForRole(kind: ResearchArtifactKind, role: ResearchRole): void {
  const schema: ArtifactSchema | undefined = ARTIFACT_SCHEMAS[kind]
  if (schema === undefined) {
    throw new RtbError('UNAUTHORIZED_PRODUCER', `unknown artifact kind ${String(kind)}`, { kind, role })
  }
  if (!schema.allowedProducerRoles.includes(role)) {
    throw new RtbError(
      'UNAUTHORIZED_PRODUCER',
      `role ${role} may not produce a ${kind} artifact`,
      { kind, role, allowedProducerRoles: schema.allowedProducerRoles },
    )
  }
}

function validateProvenance(draft: ArtifactDraft): readonly string[] {
  const problems: string[] = []
  const provenance = draft.provenance
  if (provenance === null || typeof provenance !== 'object') return ['provenance must be an object']
  const sources = Array.isArray(provenance.sources) ? provenance.sources : null
  if (sources === null) {
    problems.push('provenance.sources must be an array (use [] for none)')
  } else {
    sources.forEach((source, index) => {
      problems.push(...validateSourceRef(source, `provenance.sources[${index}]`))
    })
  }
  const real = sources === null ? [] : realSources(sources)
  const executionOrigins = real.filter(source => source.kind === 'file' || source.kind === 'command' || source.kind === 'artifact')

  if (provenance.executed === true) {
    if (draft.kind !== 'experiment_result') {
      problems.push(
        `provenance.executed may only be true for an experiment_result, not for a ${draft.kind}: `
        + 'a reasoning product is not an execution',
      )
    } else {
      const paths = draft.content?.artifactPaths
      if (!Array.isArray(paths) || paths.length === 0) {
        problems.push('provenance.executed is true but content.artifactPaths is empty: no real execution is provable')
      }
      if (executionOrigins.length === 0) {
        problems.push(
          'provenance.executed is true but provenance.sources carries no file/command/artifact SourceRef',
        )
      }
    }
  }

  if (draft.kind === 'experiment_result' && provenance.executed !== true) {
    // Under-claiming an execution is not fabrication, so it is allowed; the
    // `artifactPaths` requirement below still forces a real path list. Only
    // over-claiming is refused.
    const paths = draft.content?.artifactPaths
    if (!Array.isArray(paths) || paths.length === 0) {
      problems.push('an experiment_result must carry a non-empty content.artifactPaths list')
    }
  }

  return problems
}

function validateEvidenceRequirements(draft: ArtifactDraft): readonly string[] {
  const schema = ARTIFACT_SCHEMAS[draft.kind]
  if (schema === undefined || !schema.requiresEvidenceRefs) return []
  const real = realSources(draft.provenance?.sources ?? [])
  if (draft.evidenceRefs.length === 0 && real.length === 0) {
    return [
      `${draft.kind} requires at least one evidence ref or one real SourceRef: `
      + 'a literature/experiment claim without a pointer to its origin is speculation, not evidence',
    ]
  }
  return []
}

function effectiveStatus(draft: ArtifactDraft): EpistemicStatus {
  const schema = ARTIFACT_SCHEMAS[draft.kind]
  const requested = draft.epistemicStatus ?? schema?.defaultEpistemicStatus ?? 'speculation'
  const unbacked = refsAreEmpty(draft.refs)
  if (unbacked && requested !== 'rejected') return 'speculation'
  return requested
}

function validateEpistemicRequest(draft: ArtifactDraft): readonly string[] {
  const requested = draft.epistemicStatus
  if (requested === undefined) return []
  const problems: string[] = []
  if (GATE_ONLY_STATUSES.includes(requested)) {
    problems.push(
      `epistemic_status ${requested} may only be set by the pipeline's validators through the state gate, `
      + 'never by a producer',
    )
  }
  if (refsAreEmpty(draft.refs) && requested !== 'speculation' && requested !== 'rejected') {
    problems.push(
      `epistemic_status ${requested} needs canonical refs: an artifact that references no canonical `
      + 'object must stay speculation',
    )
  }
  return problems
}

/** Deterministic semantic key when the caller does not supply one. */
function deriveIdempotencyKey(draft: ArtifactDraft): string {
  return keyFrom([
    'artifact',
    draft.kind,
    draft.teamId,
    draft.taskId,
    draft.attemptId,
    draft.producerAgentId,
    draft.producerRole,
    draft.researchRoute,
    structuralHash(draft.content),
    structuralHash({ refs: draft.refs, evidenceRefs: draft.evidenceRefs }),
  ])
}

/**
 * Stage one artifact. Idempotent: a repeated draft (or a repeated explicit
 * `idempotencyKey`) returns the artifact already in the store instead of
 * inserting a second row.
 *
 * Throws {@link RtbError} with code `SCHEMA_INVALID` / `UNAUTHORIZED_PRODUCER`
 * when the draft would fabricate science or misdeclare provenance.
 */
export function stageArtifact(store: TeamStore, draft: ArtifactDraft, clock: Clock = systemClock): ResearchArtifact {
  assertKindAllowedForRole(draft.kind, draft.producerRole)

  const task = store.getTask(draft.taskId)
  if (task !== undefined && task.team_id !== draft.teamId) {
    throw new RtbError(
      'SCHEMA_INVALID',
      `task ${draft.taskId} belongs to team ${task.team_id}, not ${draft.teamId}`,
      { taskId: draft.taskId, expectedTeamId: draft.teamId, actualTeamId: task.team_id },
    )
  }

  const problems = [
    ...validateArtifactContent(draft.kind, draft.content),
    ...validateCanonicalRefs(draft.refs),
    ...validateEvidenceRefs(draft.evidenceRefs),
    ...validateProvenance(draft),
    ...validateEvidenceRequirements(draft),
    ...validateEpistemicRequest(draft),
  ]
  if (problems.length > 0) {
    throw new RtbError(
      'SCHEMA_INVALID',
      `${draft.kind} artifact refused: ${problems[0]}`,
      { kind: draft.kind, problems },
    )
  }

  const idempotency = draft.idempotencyKey ?? deriveIdempotencyKey(draft)
  const existing = store.findArtifactByIdempotencyKey(draft.teamId, idempotency)
  if (existing !== undefined) return existing

  const artifact: ResearchArtifact = {
    artifact_id: newId('art', clock),
    kind: draft.kind,
    team_id: draft.teamId,
    task_id: draft.taskId,
    attempt_id: draft.attemptId,
    producer_agent_id: draft.producerAgentId,
    producer_role: draft.producerRole,
    epistemic_status: effectiveStatus(draft),
    research_route: draft.researchRoute,
    state_version: draft.stateVersion,
    refs: { ...emptyCanonicalRefs(), ...draft.refs },
    evidence_refs: [...draft.evidenceRefs],
    content: { ...draft.content },
    provenance: {
      messageIds: [...(draft.provenance?.messageIds ?? [])],
      attemptIds: [...(draft.provenance?.attemptIds ?? [])],
      sources: [...(draft.provenance?.sources ?? [])],
      executed: draft.provenance?.executed === true,
      verdicts: [...(draft.provenance?.verdicts ?? [])],
    },
    created_at: isoNow(clock),
    idempotency_key: idempotency,
    revision: 1,
  }
  return store.putArtifact(artifact)
}
