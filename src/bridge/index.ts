/**
 * Integrated Research Team Bridge domain.
 *
 * These modules are copied from `dsh-research-team-bridge` (commit 2c94b93,
 * MIT) and kept host-free: they import no `@deepseek-ai/*` package. Research
 * Mesh adds groups, worktrees, execution scheduling, GPU leases and SSH/Conda
 * jobs on top of this durable research layer instead of re-implementing it.
 *
 * Local modifications are documented in `docs/bridge-integration.md`; the most
 * important one is the re-entrant transaction surface in `runtime/persistence`
 * so Mesh rows and bridge rows commit in the same SQLite transaction.
 */

export * from './types.ts'
export { RtbError, RtbHold, isRtbError, type RtbErrorCode, type AnyRtbErrorCode } from './errors.ts'
export {
  systemClock,
  fixedClock,
  newId as newBridgeId,
  idempotencyKey,
  structuralHash,
  isoNow as bridgeIsoNow,
  type Clock,
} from './ids.ts'
export { ResearchPipelineAdapter, readCanonicalStateFile, canonicalStatePath } from './adapters/research-pipeline.ts'
export {
  ARTIFACT_KINDS,
  ARTIFACT_SCHEMAS,
  CANONICAL_ID_PATTERNS,
  emptyCanonicalRefs,
  stageArtifact,
  validateArtifactContent,
  validateCanonicalRefs,
  type ArtifactDraft,
} from './research/artifacts.ts'
export { ResearchStateGate, refsFromEvidenceRefs, type ResearchStateGateOptions } from './research/state-gate.ts'
export {
  openTeamStore,
  SqliteTeamStore,
  TEAM_STORE_SCHEMA_VERSION,
  describeSchema,
  type OpenTeamStoreOptions,
} from './runtime/persistence.ts'
export { TeamRecovery, assertNoRecoveryHold } from './runtime/recovery.ts'
export { PermissionPolicy } from './runtime/permissions.ts'
export { roleProfile, ROLE_CATALOG } from './team/roles.ts'
export { TaskGraph, DEFAULT_LEASE_MS } from './team/tasks.ts'
