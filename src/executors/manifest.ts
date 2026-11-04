/**
 * Immutable job manifest shared by local, fake-SSH and SSH execution.
 *
 * A manifest fixes the code commit, argv, environment identifier, working
 * directory, GPU and the RSI authorization reference. It is content-addressed
 * with SHA-256 over canonical JSON; the digest is persisted separately and is
 * rechecked before every submit/stage operation.
 */

import { MeshError } from '../errors.ts';
import { canonicalJson, type CanonicalValue } from '../util/canonical-json.ts';
import { sha256Text, requireSha256 } from '../util/hash.ts';
import { requireRelativePath } from '../util/fs-safe.ts';
import { requireGitCommit } from '../util/shell.ts';
import { requireSlug } from '../util/ids.ts';
import type { MeshConfig, WorkerConfig } from '../config/types.ts';

/** Allowed RSI authorization modes. */
export type AuthorizationMode = 'rsi-receipt' | 'test-stub' | 'none';

/** RSI authorization binding carried by the job. */
export interface JobAuthorization {
  readonly mode: AuthorizationMode;
  readonly rsi_receipt_ref: string | null;
  readonly research_state_version: string | null;
  readonly rsi_receipt_digest?: string;
  readonly rsi_experiment_id?: string;
  readonly rsi_manifest_digest?: string;
  readonly verified_by?: string;
  readonly verified_at?: string;
  readonly consumed_ledger_event_seal?: string;
}

/** One immutable execution manifest. Field names are the public wire contract. */
export interface JobManifest {
  readonly schema: 'dsh-research-mesh/job-manifest@1';
  readonly job_id: string;
  readonly attempt_id: string;
  readonly project_id: string;
  readonly team_id: string;
  readonly workspace_id: string | null;
  readonly code: {
    readonly commit: string;
    readonly branch?: string;
  };
  readonly execution: {
    readonly entrypoint: string;
    readonly argv: readonly string[];
    readonly working_directory: string;
    readonly conda_environment: string;
  };
  readonly resources: {
    readonly worker_id: string;
    readonly gpu_id: number | null;
  };
  readonly artifacts: {
    readonly destination: string;
    readonly required?: readonly string[];
  };
  readonly authorization: JobAuthorization;
  readonly environment?: Readonly<Record<string, string>>;
  readonly requested_hours?: number;
  readonly created_at: string;
  readonly manifest_sha256?: string;
}

const MANIFEST_SCHEMA = 'dsh-research-mesh/job-manifest@1';
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONDA_ENV = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const FORBIDDEN_ENV = new Set(['CUDA_VISIBLE_DEVICES', 'BASH_ENV', 'ENV', 'LD_PRELOAD']);

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new MeshError('MANIFEST_INVALID', message, details);
}

function requireString(value: unknown, field: string, max = 8192): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    invalid(`${field} must be a non-empty string of at most ${max} characters`, { field });
  }
  if (value.includes('\0')) invalid(`${field} contains NUL`, { field });
  return value;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  return value === undefined || value === null ? undefined : requireString(value, field);
}

function requireStringArray(value: unknown, field: string, maxItems = 256): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    invalid(`${field} must be a non-empty array with at most ${maxItems} entries`, { field });
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function normalizeWorkingDirectory(value: unknown): string {
  const raw = requireString(value, 'execution.working_directory', 4096);
  if (raw === '.' || raw === './') return '.';
  return requireRelativePath(raw, 'execution.working_directory');
}

function normalizeEntrypoint(value: unknown): string {
  const raw = requireString(value, 'execution.entrypoint', 4096);
  if (raw.includes('\0')) invalid('execution.entrypoint contains NUL');
  if (raw.startsWith('-') || raw.startsWith('~')) invalid('execution.entrypoint must not start with - or ~');
  if (raw.includes('/')) return requireRelativePath(raw, 'execution.entrypoint');
  if (!PROGRAM.test(raw)) invalid('execution.entrypoint is not a safe program name', { entrypoint: raw });
  return raw;
}

function normalizeArtifactDestination(value: unknown): string {
  const raw = requireString(value, 'artifacts.destination', 4096);
  const relative = requireRelativePath(raw, 'artifacts.destination');
  if (relative !== 'artifacts' && !relative.startsWith('artifacts/')) {
    invalid('artifacts.destination must be artifacts or a directory below it', { destination: raw });
  }
  return relative;
}

/**
 * Serialize a manifest without its digest field.
 * @param manifest - manifest value.
 * @returns canonical JSON text.
 */
export function serializeManifest(manifest: JobManifest): string {
  return canonicalManifestText(manifest);
}

/** JSON round-trip yields the plain object `canonicalJson` accepts. */
function canonicalManifestText(manifest: JobManifest): string {
  const copy: Record<string, unknown> = { ...manifest };
  delete copy.manifest_sha256;
  const plain: unknown = JSON.parse(JSON.stringify(copy));
  return canonicalJson(plain as CanonicalValue);
}

/**
 * Compute the content digest of a manifest.
 * @param manifest - manifest value.
 * @returns lower-case SHA-256.
 */
export function digestManifest(manifest: JobManifest): string {
  return sha256Text(canonicalManifestText(manifest));
}

/**
 * Validate a manifest against configuration and a worker.
 * @param value - parsed JSON or typed candidate.
 * @param config - resolved Mesh configuration.
 * @param options - expected identities and digest.
 * @returns a frozen, normalized manifest.
 */
export function validateManifest(
  value: unknown,
  config: MeshConfig,
  options: {
    expectedJobId?: string;
    expectedAttemptId?: string;
    expectedProjectId?: string;
    expectedTeamId?: string;
    expectedWorkerId?: string;
    expectedDigest?: string;
  } = {},
): JobManifest {
  try {
    return validateManifestInner(value, config, options);
  } catch (error) {
    if (error instanceof MeshError && (error.code === 'PATH_ESCAPE' || error.code === 'INVALID_ARGUMENT')) {
      throw new MeshError('MANIFEST_INVALID', error.message, { ...error.details, cause: error.code });
    }
    throw error;
  }
}

function validateManifestInner(
  value: unknown,
  config: MeshConfig,
  options: {
    expectedJobId?: string;
    expectedAttemptId?: string;
    expectedProjectId?: string;
    expectedTeamId?: string;
    expectedWorkerId?: string;
    expectedDigest?: string;
  },
): JobManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('manifest must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== MANIFEST_SCHEMA) invalid('manifest schema is not supported', { schema: record.schema });
  const jobId = requireSlug(requireString(record.job_id, 'job_id', 128), 'job_id');
  const attemptId = requireSlug(requireString(record.attempt_id, 'attempt_id', 128), 'attempt_id');
  const projectId = requireSlug(requireString(record.project_id, 'project_id', 64), 'project_id');
  const teamId = requireSlug(requireString(record.team_id, 'team_id', 128), 'team_id');
  const workspaceId = record.workspace_id === null || record.workspace_id === undefined
    ? null
    : requireSlug(requireString(record.workspace_id, 'workspace_id', 128), 'workspace_id');
  if (options.expectedJobId !== undefined && jobId !== options.expectedJobId) invalid('job_id does not match');
  if (options.expectedAttemptId !== undefined && attemptId !== options.expectedAttemptId) invalid('attempt_id does not match');
  if (options.expectedProjectId !== undefined && projectId !== options.expectedProjectId) invalid('project_id does not match');
  if (options.expectedTeamId !== undefined && teamId !== options.expectedTeamId) invalid('team_id does not match');

  const code = record.code;
  if (typeof code !== 'object' || code === null || Array.isArray(code)) invalid('code must be an object');
  const codeRecord = code as Record<string, unknown>;
  const commit = requireGitCommit(requireString(codeRecord.commit, 'code.commit', 64));
  const branch = requireOptionalString(codeRecord.branch, 'code.branch');
  if (branch !== undefined && (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('/'))) {
    invalid('code.branch is not a safe branch name', { branch });
  }

  const execution = record.execution;
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) invalid('execution must be an object');
  const execRecord = execution as Record<string, unknown>;
  const entrypoint = normalizeEntrypoint(execRecord.entrypoint);
  const argv = Array.isArray(execRecord.argv) && execRecord.argv.length === 0
    ? []
    : requireStringArray(execRecord.argv, 'execution.argv');
  const workingDirectory = normalizeWorkingDirectory(execRecord.working_directory);
  const condaEnvironment = requireString(execRecord.conda_environment, 'execution.conda_environment', 128);
  if (!CONDA_ENV.test(condaEnvironment)) invalid('execution.conda_environment is not a safe name', { condaEnvironment });

  const resources = record.resources;
  if (typeof resources !== 'object' || resources === null || Array.isArray(resources)) invalid('resources must be an object');
  const resourceRecord = resources as Record<string, unknown>;
  const workerId = requireSlug(requireString(resourceRecord.worker_id, 'resources.worker_id', 64), 'resources.worker_id');
  if (options.expectedWorkerId !== undefined && workerId !== options.expectedWorkerId) invalid('worker_id does not match');
  const worker: WorkerConfig | undefined = config.workers[workerId];
  if (worker === undefined) invalid(`worker ${workerId} is not configured`);
  let gpuId: number | null = null;
  if (resourceRecord.gpu_id !== null && resourceRecord.gpu_id !== undefined) {
    if (typeof resourceRecord.gpu_id !== 'number' || !Number.isSafeInteger(resourceRecord.gpu_id) || resourceRecord.gpu_id < 0) {
      invalid('resources.gpu_id must be a non-negative integer or null');
    }
    gpuId = resourceRecord.gpu_id;
    if (!worker.gpuIds.includes(gpuId)) invalid(`GPU ${gpuId} is not managed on ${workerId}`, { gpuId, workerId });
  }

  const artifacts = record.artifacts;
  if (typeof artifacts !== 'object' || artifacts === null || Array.isArray(artifacts)) invalid('artifacts must be an object');
  const artifactRecord = artifacts as Record<string, unknown>;
  const destination = normalizeArtifactDestination(artifactRecord.destination);
  const required = artifactRecord.required === undefined
    ? undefined
    : requireStringArray(artifactRecord.required, 'artifacts.required').map(entry => requireRelativePath(entry, 'artifacts.required'));

  const authorizationRaw = record.authorization;
  if (typeof authorizationRaw !== 'object' || authorizationRaw === null || Array.isArray(authorizationRaw)) {
    invalid('authorization must be an object');
  }
  const authRecord = authorizationRaw as Record<string, unknown>;
  const modeRaw = requireString(authRecord.mode, 'authorization.mode', 32);
  if (modeRaw !== 'rsi-receipt' && modeRaw !== 'test-stub' && modeRaw !== 'none') {
    invalid('authorization.mode is not supported', { mode: modeRaw });
  }
  const mode = modeRaw as AuthorizationMode;
  const receiptRef = authRecord.rsi_receipt_ref === null || authRecord.rsi_receipt_ref === undefined
    ? null
    : requireString(authRecord.rsi_receipt_ref, 'authorization.rsi_receipt_ref', 4096);
  const stateVersion = authRecord.research_state_version === null || authRecord.research_state_version === undefined
    ? null
    : requireString(authRecord.research_state_version, 'authorization.research_state_version', 256);
  if (mode === 'rsi-receipt') {
    if (receiptRef === null || receiptRef === '') invalid('rsi-receipt mode requires rsi_receipt_ref');
    if (stateVersion === null || stateVersion === '') invalid('rsi-receipt mode requires research_state_version');
    if (authRecord.rsi_receipt_digest === undefined) invalid('rsi-receipt mode requires rsi_receipt_digest');
    requireSha256(requireString(authRecord.rsi_receipt_digest, 'authorization.rsi_receipt_digest', 64), 'rsi_receipt_digest');
  }
  if (mode === 'test-stub' && !config.rsi.allowTestStub) {
    throw new MeshError('RSI_TEST_STUB_FORBIDDEN', 'test-stub authorization is disabled in this configuration');
  }
  const authorization: JobAuthorization = {
    mode,
    rsi_receipt_ref: receiptRef,
    research_state_version: stateVersion,
    ...(authRecord.rsi_receipt_digest === undefined ? {} : { rsi_receipt_digest: requireSha256(requireString(authRecord.rsi_receipt_digest, 'authorization.rsi_receipt_digest', 64), 'rsi_receipt_digest') }),
    ...(authRecord.rsi_experiment_id === undefined ? {} : { rsi_experiment_id: requireString(authRecord.rsi_experiment_id, 'authorization.rsi_experiment_id', 128) }),
    ...(authRecord.rsi_manifest_digest === undefined ? {} : { rsi_manifest_digest: requireSha256(requireString(authRecord.rsi_manifest_digest, 'authorization.rsi_manifest_digest', 64), 'rsi_manifest_digest') }),
    ...(authRecord.verified_by === undefined ? {} : { verified_by: requireString(authRecord.verified_by, 'authorization.verified_by', 256) }),
    ...(authRecord.verified_at === undefined ? {} : { verified_at: requireString(authRecord.verified_at, 'authorization.verified_at', 64) }),
    ...(authRecord.consumed_ledger_event_seal === undefined ? {} : { consumed_ledger_event_seal: requireString(authRecord.consumed_ledger_event_seal, 'authorization.consumed_ledger_event_seal', 128) }),
  };

  let environment: Record<string, string> | undefined;
  if (record.environment !== undefined) {
    if (typeof record.environment !== 'object' || record.environment === null || Array.isArray(record.environment)) {
      invalid('environment must be an object');
    }
    environment = {};
    for (const [key, raw] of Object.entries(record.environment as Record<string, unknown>)) {
      if (!ENV_KEY.test(key)) invalid('environment key is not a safe POSIX name', { key });
      if (FORBIDDEN_ENV.has(key)) invalid(`environment key ${key} is controlled by the executor`, { key });
      environment[key] = requireString(raw, `environment.${key}`, 4096);
    }
  }
  let requestedHours: number | undefined;
  if (record.requested_hours !== undefined) {
    if (typeof record.requested_hours !== 'number' || !Number.isFinite(record.requested_hours) || record.requested_hours <= 0) {
      invalid('requested_hours must be a positive finite number');
    }
    requestedHours = record.requested_hours;
  }
  const createdAt = requireString(record.created_at, 'created_at', 64);
  const digest = digestManifest({
    schema: MANIFEST_SCHEMA,
    job_id: jobId,
    attempt_id: attemptId,
    project_id: projectId,
    team_id: teamId,
    workspace_id: workspaceId,
    code: { commit, ...(branch === undefined ? {} : { branch }) },
    execution: { entrypoint, argv, working_directory: workingDirectory, conda_environment: condaEnvironment },
    resources: { worker_id: workerId, gpu_id: gpuId },
    artifacts: { destination, ...(required === undefined ? {} : { required }) },
    authorization,
    ...(environment === undefined ? {} : { environment }),
    ...(requestedHours === undefined ? {} : { requested_hours: requestedHours }),
    created_at: createdAt,
  });
  if (record.manifest_sha256 !== undefined) {
    const declared = requireSha256(requireString(record.manifest_sha256, 'manifest_sha256', 64), 'manifest_sha256');
    if (declared !== digest) invalid('manifest_sha256 does not match the manifest content', { declared, computed: digest });
  }
  if (options.expectedDigest !== undefined && digest !== options.expectedDigest) {
    throw new MeshError('MANIFEST_MISMATCH', 'manifest digest does not match the persisted digest', {
      expected: options.expectedDigest,
      computed: digest,
    });
  }
  const manifest: JobManifest = {
    schema: MANIFEST_SCHEMA,
    job_id: jobId,
    attempt_id: attemptId,
    project_id: projectId,
    team_id: teamId,
    workspace_id: workspaceId,
    code: { commit, ...(branch === undefined ? {} : { branch }) },
    execution: { entrypoint, argv, working_directory: workingDirectory, conda_environment: condaEnvironment },
    resources: { worker_id: workerId, gpu_id: gpuId },
    artifacts: { destination, ...(required === undefined ? {} : { required }) },
    authorization,
    ...(environment === undefined ? {} : { environment }),
    ...(requestedHours === undefined ? {} : { requested_hours: requestedHours }),
    created_at: createdAt,
    manifest_sha256: digest,
  };
  return manifest;
}

/**
 * Attach a digest to a manifest under construction.
 * @param manifest - manifest without digest.
 * @returns manifest with `manifest_sha256`.
 */
export function withDigest(manifest: JobManifest): JobManifest {
  return { ...manifest, manifest_sha256: digestManifest(manifest) };
}
