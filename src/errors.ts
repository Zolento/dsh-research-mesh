/**
 * Stable error taxonomy for the Research Mesh.
 *
 * Callers branch on `code`, never on message text. `details` is JSON-safe and
 * is persisted where the failure becomes durable task/job state.
 */

/** Discriminator for every Mesh failure surfaced to a caller or persisted. */
export type MeshErrorCode =
  | 'CONFIG_INVALID'
  | 'PATH_ESCAPE'
  | 'PATH_CONFLICT'
  | 'WORKSPACE_EXISTS'
  | 'WORKSPACE_MISSING'
  | 'WORKSPACE_DIRTY'
  | 'WORKSPACE_CORRUPT'
  | 'WORKSPACE_CLEANUP_REFUSED'
  | 'GIT_COMMAND_FAILED'
  | 'TEAM_LIMIT'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_CONFLICT'
  | 'SESSION_BINDING_CONFLICT'
  | 'SESSION_NOT_FOUND'
  | 'TEAM_CONFLICT'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_STATE_INVALID'
  | 'SUBAGENT_LIMIT'
  | 'SUBAGENT_BUSY'
  | 'SUBAGENT_NOT_FOUND'
  | 'SUBAGENT_DUPLICATE'
  | 'SESSION_BINDING_UNAVAILABLE'
  | 'SESSION_CREATE_FAILED'
  | 'MODEL_CONFIG_INVALID'
  | 'TASK_NOT_FOUND'
  | 'TASK_CONFLICT'
  | 'TASK_STATE_INVALID'
  | 'TASK_DEPENDENCY_CYCLE'
  | 'TASK_DEPENDENCY_UNKNOWN'
  | 'TASK_IDEMPOTENT_REPLAY'
  | 'TASK_NOT_CLAIMABLE'
  | 'GPU_UNAVAILABLE'
  | 'GPU_LEASE_CONFLICT'
  | 'GPU_AVAILABILITY_UNKNOWN'
  | 'GPU_PROBE_FAILED'
  | 'EXECUTOR_DISABLED'
  | 'EXECUTOR_FAILED'
  | 'EXECUTOR_TIMEOUT'
  | 'SUBMIT_UNKNOWN'
  | 'RECONCILE_REQUIRED'
  | 'REMOTE_STATE_UNKNOWN'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_MISMATCH'
  | 'DIRTY_WORKTREE'
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_CHECKSUM_MISMATCH'
  | 'ARTIFACT_TRANSFER_INCOMPLETE'
  | 'RSI_UNAVAILABLE'
  | 'RSI_INVALID'
  | 'RSI_STATE_UNAVAILABLE'
  | 'RSI_STATE_CHANGED'
  | 'RSI_AUTHORIZATION_MISSING'
  | 'RSI_AUTHORIZATION_INVALID'
  | 'RSI_TEST_STUB_FORBIDDEN'
  | 'RSI_GATE_HOLD'
  | 'RSI_CONSUME_MISSING'
  | 'RSI_CONSUME_TIMEOUT'
  | 'RSI_RUN_FAILED'
  | 'RSI_RUN_TIMEOUT'
  | 'STORAGE_ERROR'
  | 'STORAGE_CLOSED'
  | 'CONCURRENCY_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL';

/** JSON-safe detail payload attached to a Mesh failure. */
export type MeshErrorDetails = Readonly<Record<string, unknown>>;

/** One typed Mesh failure. */
export class MeshError extends Error {
  /** Stable machine-readable discriminator. */
  readonly code: MeshErrorCode;
  /** JSON-safe context for logs, API responses and durable failure records. */
  readonly details: MeshErrorDetails;

  /**
   * @param code - stable discriminator.
   * @param message - human-readable, actionable description.
   * @param details - JSON-safe context; never include credentials or private keys.
   */
  constructor(code: MeshErrorCode, message: string, details: MeshErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = 'MeshError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Narrow any thrown value into a MeshError without losing an existing code.
 * @param error - value caught from a boundary.
 * @param fallback - code used for non-Mesh failures.
 * @param message - fallback message when the value is not an Error.
 * @returns a typed failure suitable for persistence.
 */
export function toMeshError(
  error: unknown,
  fallback: MeshErrorCode = 'INTERNAL',
  message = 'unexpected mesh failure',
): MeshError {
  if (error instanceof MeshError) return error;
  if (error instanceof Error) {
    return new MeshError(fallback, `${message}: ${error.message}`, { cause: error.name });
  }
  return new MeshError(fallback, message);
}

/**
 * Report whether a value is an Error instance without asserting its shape.
 * @param value - arbitrary caught value.
 * @returns true for Error instances.
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}
