/**
 * Experiment job service.
 *
 * Converts an RSI-authorized experiment into one immutable Mesh job manifest,
 * binds it to the group's dirty-free worktree commit, and drives the shared
 * remote executor. The service refuses to build a manifest from a dirty
 * worktree, from a caller-invented authorization, or from content that is not
 * tracked by the pinned commit.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative as relativePath } from 'node:path';
import { MeshError } from '../errors.ts';
import type { MeshConfig, WorkerConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshLogger } from '../util/logger.ts';
import { ID_PREFIX, newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { requireRelativePath, readJsonObjectFile } from '../util/fs-safe.ts';
import { runGit } from '../util/shell.ts';
import type { WorkspaceManager } from '../workspaces/manager.ts';
import type { TaskScheduler, MeshTaskView } from '../scheduler/scheduler.ts';
import type { GpuLeaseManager } from '../resources/gpu.ts';
import { validateManifest, digestManifest, type JobManifest } from './manifest.ts';
import type { RemoteJobExecutor, IngestionResult, SubmitResult } from './remote.ts';
import type { RsiAuthorization } from '../rsi/adapter.ts';

/** Input for creating one experiment manifest. */
export interface CreateExperimentManifestInput {
  readonly taskId: string;
  readonly workerId: string;
  readonly gpuId: number;
  readonly rsiManifestPath: string;
  readonly authorization: RsiAuthorization;
  readonly condaEnvironment?: string;
  readonly artifactDestination?: string;
  readonly requiredArtifacts?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

/** Built manifest and its persisted path. */
export interface BuiltManifest {
  readonly manifest: JobManifest;
  readonly digest: string;
  readonly path: string;
}

/** Experiment job service. */
export class ExperimentJobService {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #scheduler: TaskScheduler;
  readonly #workspaces: WorkspaceManager;
  readonly #executor: RemoteJobExecutor;
  readonly #manifestsRoot: string;
  readonly #logger: MeshLogger;

  /**
   * @param config - resolved Mesh configuration.
   * @param store - Mesh metadata store.
   * @param scheduler - task scheduler.
   * @param workspaces - worktree manager.
   * @param executor - shared remote executor.
   * @param manifestsRoot - absolute manifest directory.
   * @param logger - structured logger.
   */
  constructor(
    config: MeshConfig,
    store: MeshStore,
    scheduler: TaskScheduler,
    workspaces: WorkspaceManager,
    executor: RemoteJobExecutor,
    manifestsRoot: string,
    logger: MeshLogger,
  ) {
    this.#config = config;
    this.#store = store;
    this.#scheduler = scheduler;
    this.#workspaces = workspaces;
    this.#executor = executor;
    this.#manifestsRoot = manifestsRoot;
    this.#logger = logger;
  }

  /**
   * Build and persist one immutable manifest.
   * @param input - task, worker, RSI manifest and authorization.
   * @returns manifest, digest and local path.
   */
  async createManifest(input: CreateExperimentManifestInput): Promise<BuiltManifest> {
    const task = this.#scheduler.get(input.taskId);
    if (task.type !== 'experiment') {
      throw new MeshError('INVALID_ARGUMENT', 'only experiment tasks can produce an experiment manifest', { taskId: input.taskId });
    }
    if (task.attemptId === null) {
      throw new MeshError('TASK_STATE_INVALID', 'task has no active attempt; claim it before building a manifest', { taskId: input.taskId });
    }
    if (task.workspaceId === null) {
      throw new MeshError('WORKSPACE_MISSING', 'experiment task has no workspace', { taskId: input.taskId });
    }
    const workspace = this.#workspaces.assertTeamWorkspace(task.workspaceId, task.teamId);
    const inspection = await this.#workspaces.inspect(workspace.workspaceId);
    if (!inspection.valid) {
      throw new MeshError('WORKSPACE_CORRUPT', 'group worktree is not a valid worktree', {
        workspaceId: workspace.workspaceId,
        error: inspection.error,
      });
    }
    if (inspection.dirty) {
      throw new MeshError('DIRTY_WORKTREE', 'remote experiments require a clean, committed worktree', {
        workspaceId: workspace.workspaceId,
        changes: inspection.changes,
      });
    }
    if (inspection.head === null) {
      throw new MeshError('WORKSPACE_CORRUPT', 'cannot read the worktree HEAD commit', { workspaceId: workspace.workspaceId });
    }
    const worker = this.#worker(input.workerId);
    if (!worker.gpuIds.includes(input.gpuId)) {
      throw new MeshError('GPU_UNAVAILABLE', `GPU ${input.gpuId} is not managed on ${worker.workerId}`, {
        workerId: worker.workerId,
        gpuId: input.gpuId,
      });
    }
    const rsiPath = this.#resolveProjectFile(input.rsiManifestPath, 'rsiManifestPath');
    const rsiManifest = readJsonObjectFile(rsiPath, 'rsi execution manifest');
    const argv = rsiManifest.argv;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(entry => typeof entry === 'string')) {
      throw new MeshError('RSI_INVALID', 'RSI manifest argv is invalid', { path: rsiPath });
    }
    const cwd = typeof rsiManifest.cwd === 'string' ? rsiManifest.cwd : '';
    if (cwd === '') throw new MeshError('RSI_INVALID', 'RSI manifest has no cwd');
    const workingDirectory = this.#workspaceRelative(workspace.path, cwd, 'RSI manifest cwd');
    const entrypoint = this.#entrypoint(workspace.path, argv[0] ?? '', 'RSI argv[0]');
    const gpuDevices = rsiManifest.gpu_devices;
    if (!Array.isArray(gpuDevices) || gpuDevices.length !== 1 || String(gpuDevices[0]) !== String(input.gpuId)) {
      throw new MeshError('MANIFEST_MISMATCH', 'RSI manifest GPU selection does not match the leased GPU', {
        rsiGpuDevices: gpuDevices,
        gpuId: input.gpuId,
      });
    }
    const requestedHours = typeof rsiManifest.requested_hours === 'number' ? rsiManifest.requested_hours : undefined;
    const rsiEnv = rsiManifest.env;
    if (rsiEnv !== undefined && (typeof rsiEnv !== 'object' || rsiEnv === null || Array.isArray(rsiEnv))) {
      throw new MeshError('RSI_INVALID', 'RSI manifest env is invalid');
    }
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries((rsiEnv ?? {}) as Record<string, unknown>)) {
      if (key === 'CUDA_VISIBLE_DEVICES') continue;
      if (typeof value !== 'string') throw new MeshError('RSI_INVALID', `RSI manifest env ${key} is not a string`);
      environment[key] = value;
    }
    Object.assign(environment, input.environment ?? {});
    const files = rsiManifest.files;
    if (!Array.isArray(files)) throw new MeshError('RSI_INVALID', 'RSI manifest has no file bindings');
    for (const entry of files) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new MeshError('RSI_INVALID', 'RSI manifest file binding is invalid');
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== 'string') throw new MeshError('RSI_INVALID', 'RSI manifest file binding has no path');
      const absolute = isAbsolute(record.path) ? record.path : join(cwd, record.path);
      const relative = this.#workspaceRelative(workspace.path, absolute, 'RSI bound file');
      await this.#assertTracked(workspace.path, relative, absolute);
    }

    const jobId = newId(ID_PREFIX.job);
    const candidate: JobManifest = {
      schema: 'dsh-research-mesh/job-manifest@1',
      job_id: jobId,
      attempt_id: task.attemptId,
      project_id: task.projectId,
      team_id: task.teamId,
      workspace_id: workspace.workspaceId,
      code: { commit: inspection.head, branch: workspace.branch },
      execution: {
        entrypoint,
        argv: argv.slice(1),
        working_directory: workingDirectory,
        conda_environment: input.condaEnvironment ?? worker.condaEnvironment,
      },
      resources: { worker_id: worker.workerId, gpu_id: input.gpuId },
      artifacts: {
        destination: input.artifactDestination ?? 'artifacts',
        ...(input.requiredArtifacts === undefined ? {} : { required: input.requiredArtifacts }),
      },
      authorization: {
        mode: input.authorization.mode,
        rsi_receipt_ref: input.authorization.receiptRef,
        research_state_version: input.authorization.stateVersion,
        rsi_receipt_digest: input.authorization.receiptDigest,
        rsi_experiment_id: input.authorization.experimentId,
        rsi_manifest_digest: input.authorization.rsiManifestDigest,
        verified_by: input.authorization.verifiedBy,
        verified_at: input.authorization.verifiedAt,
        ...(input.authorization.consumedLedgerEventSeal === undefined
          ? {}
          : { consumed_ledger_event_seal: input.authorization.consumedLedgerEventSeal }),
      },
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
      ...(requestedHours === undefined ? {} : { requested_hours: requestedHours }),
      created_at: nowIso(),
    };
    const manifest = validateManifest(candidate, this.#config);
    const digest = manifest.manifest_sha256 ?? digestManifest(manifest);
    mkdirSync(this.#manifestsRoot, { recursive: true, mode: 0o700 });
    const path = join(this.#manifestsRoot, `${jobId}.json`);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.#store.updateTaskMeta(task.taskId, {
      jobId,
      gpuId: input.gpuId,
      rsiStateVersion: input.authorization.stateVersion,
      receiptRef: input.authorization.receiptRef,
      updatedAt: nowIso(),
    });
    this.#store.appendEvent('job', jobId, 'manifest-created', {
      taskId: task.taskId,
      digest,
      authorization: input.authorization.mode,
      experimentId: input.authorization.experimentId,
    });
    this.#logger.info('experiment manifest created', { jobId, taskId: task.taskId, digest });
    return { manifest, digest, path };
  }

  /**
   * Submit a built manifest through the shared remote executor.
   * @param taskId - task identity.
   * @param manifest - validated manifest.
   * @returns submit result.
   */
  async submit(taskId: string, manifest: JobManifest): Promise<SubmitResult> {
    const task = this.#scheduler.get(taskId);
    return this.#executor.submit(task, manifest);
  }

  /** Query one job. */
  async query(jobId: string): Promise<MeshTaskView> {
    return this.#executor.query(jobId);
  }

  /** Reconcile one job without resubmitting. */
  async reconcile(jobId: string): Promise<MeshTaskView> {
    return this.#executor.reconcile(jobId);
  }

  /** Collect verified artifacts. */
  async collect(jobId: string): Promise<IngestionResult> {
    return this.#executor.collect(jobId);
  }

  /** Abandon a reconciled job. */
  abandon(jobId: string, reason: string): MeshTaskView {
    return this.#executor.abandon(jobId, reason);
  }

  /** List persisted jobs, optionally filtered by status. */
  list(statuses?: readonly import('../storage/types.ts').MeshJobStatus[]): readonly import('../storage/types.ts').MeshJobRecord[] {
    return this.#executor.list(statuses);
  }

  /** Mark in-flight jobs for reconciliation after restart. */
  recover(): number {
    return this.#executor.recover();
  }

  #worker(workerId: string): WorkerConfig {
    const worker = this.#config.workers[workerId];
    if (worker === undefined) throw new MeshError('EXECUTOR_DISABLED', `unknown worker ${workerId}`, { workerId });
    if (!worker.enabled) throw new MeshError('EXECUTOR_DISABLED', `worker ${workerId} is disabled`, { workerId });
    return worker;
  }

  #resolveProjectFile(path: string, field: string): string {
    const absolute = isAbsolute(path) ? path : join(this.#config.projectRoot, path);
    const relative = relativePath(this.#config.projectRoot, absolute);
    if (relative.startsWith('..') || isAbsolute(relative)) {
      throw new MeshError('PATH_ESCAPE', `${field} escapes the project root`, { field, path });
    }
    if (!existsSync(absolute)) throw new MeshError('RSI_STATE_UNAVAILABLE', `${field} does not exist`, { field, path });
    return absolute;
  }

  #workspaceRelative(workspacePath: string, target: string, field: string): string {
    const absolute = isAbsolute(target) ? target : join(workspacePath, target);
    const relative = relativePath(workspacePath, absolute);
    if (relative.startsWith('..') || isAbsolute(relative)) {
      throw new MeshError('PATH_ESCAPE', `${field} is outside the group worktree`, { field, target, workspacePath });
    }
    if (relative === '') return '.';
    return requireRelativePath(relative, field);
  }

  #entrypoint(workspacePath: string, argv0: string, field: string): string {
    if (argv0 === '') throw new MeshError('RSI_INVALID', `${field} is empty`);
    if (!isAbsolute(argv0)) {
      if (argv0.includes('/')) return requireRelativePath(argv0, field);
      return argv0;
    }
    return this.#workspaceRelative(workspacePath, argv0, field);
  }

  async #assertTracked(workspacePath: string, relative: string, absolute: string): Promise<void> {
    const result = await runGit(workspacePath, ['ls-files', '--error-unmatch', '--', relative]);
    if (result.code !== 0) {
      throw new MeshError('DIRTY_WORKTREE', 'RSI-bound file is not tracked by the pinned commit', {
        path: absolute,
        relative,
      });
    }
  }
}
