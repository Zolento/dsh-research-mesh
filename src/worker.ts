/**
 * Deterministic Mesh worker.
 *
 * The worker is explicit: a host drives `runOnce()` / `pollJobs()` or starts the
 * interval loop. It persists every transition through the scheduler and never
 * relies on chat context. Experiments only run after the RSI adapter returns a
 * verification result; the worker never fabricates an authorization.
 */

import { readFileSync } from 'node:fs';
import { MeshError } from './errors.ts';
import type { MeshConfig } from './config/types.ts';
import type { MeshLogger } from './util/logger.ts';
import type { MeshStore } from './storage/mesh-store.ts';
import type { MeshJobStatus } from './storage/types.ts';
import { nowIso } from './util/time.ts';
import type { TaskScheduler, MeshTaskView } from './scheduler/scheduler.ts';
import type { TeamManager } from './teams/manager.ts';
import type { WorkspaceManager } from './workspaces/manager.ts';
import type { LocalExecutor } from './executors/local.ts';
import type { ExperimentJobService } from './executors/job-service.ts';
import type { RsiAdapter } from './rsi/adapter.ts';
import { runConsumedShim } from './rsi/consumed-run.ts';
import { dirname, join } from 'node:path';
import type { IngestionResult } from './executors/remote.ts';

/** Payload for a controller-local task. */
export interface LocalTaskPayload {
  readonly entrypoint: string;
  readonly argv?: readonly string[];
  readonly condaEnvironment?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Payload for an RSI-authorized experiment task. */
export interface ExperimentTaskPayload {
  readonly workerId: string;
  readonly gpuId: number;
  readonly rsi: {
    readonly mode: 'consumed' | 'preview';
    readonly experimentId: string;
    readonly routeId: string;
    readonly statePath: string;
    /** Manifest the RSI receipt is bound to (the shim manifest in consumed mode). */
    readonly manifestPath: string;
    /** Real Mesh execution manifest when it differs from the authorization manifest. */
    readonly executionManifestPath?: string;
    readonly schedulerPath: string;
    readonly receiptPath: string;
    readonly ledgerPath?: string;
    /** Required for the blocking consumed coordinator; absent uses direct verify. */
    readonly shim?: {
      readonly specPath: string;
      readonly resultPath: string;
      readonly journalPath?: string;
      readonly timeoutMs: number;
    };
  };
  readonly condaEnvironment?: string;
  readonly artifactDestination?: string;
  readonly requiredArtifacts?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

/** Result of one worker round. */
export interface WorkerRoundResult {
  readonly task: MeshTaskView | null;
  readonly collected: readonly IngestionResult[];
}

/** Worker status for the UI/diagnostics. */
export interface WorkerStatus {
  readonly running: boolean;
  readonly workerId: string;
  readonly lastError: string | null;
}

const JOB_POLL: readonly MeshJobStatus[] = [
  'submitted',
  'submitted_unconfirmed',
  'running',
  'output_ready',
  'reconcile_required',
];

/** One Mesh execution worker. */
export class MeshWorker {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #scheduler: TaskScheduler;
  readonly #teams: TeamManager;
  readonly #workspaces: WorkspaceManager;
  readonly #local: LocalExecutor;
  readonly #jobs: ExperimentJobService;
  readonly #rsi: RsiAdapter;
  readonly #logger: MeshLogger;
  readonly #workerId: string;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #lastError: string | null = null;

  /**
   * @param options - dependencies and worker identity.
   */
  constructor(options: {
    config: MeshConfig;
    store: MeshStore;
    scheduler: TaskScheduler;
    teams: TeamManager;
    workspaces: WorkspaceManager;
    local: LocalExecutor;
    jobs: ExperimentJobService;
    rsi: RsiAdapter;
    logger: MeshLogger;
    workerId: string;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#teams = options.teams;
    this.#workspaces = options.workspaces;
    this.#local = options.local;
    this.#jobs = options.jobs;
    this.#rsi = options.rsi;
    this.#logger = options.logger;
    this.#workerId = options.workerId;
  }

  /** Current worker status. */
  status(): WorkerStatus {
    return { running: this.#timer !== null, workerId: this.#workerId, lastError: this.#lastError };
  }

  /**
   * Run one claim-and-execute round.
   * @returns executed task and ingestion results from the poll that followed.
   */
  async runOnce(options: { poll?: boolean } = {}): Promise<WorkerRoundResult> {
    const claim = this.#scheduler.claimNext(this.#workerId);
    if (claim === undefined) {
      const collected = options.poll === false ? [] : await this.pollJobs();
      return { task: null, collected };
    }
    const started = this.#scheduler.start(claim.task.taskId, this.#workerId, claim.attemptId);
    this.#store.appendEvent('task', started.taskId, 'worker-started', { workerId: this.#workerId, attemptId: claim.attemptId });
    try {
      if (started.type === 'local' || started.type === 'research') {
        await this.#runLocal(started, claim.attemptId);
      } else if (started.type === 'experiment') {
        await this.#runExperiment(started, claim.attemptId);
      } else {
        throw new MeshError('INVALID_ARGUMENT', `unsupported task type ${String(started.type)}`, { taskId: started.taskId });
      }
    } catch (error) {
      const meshError = error instanceof MeshError ? error : new MeshError('INTERNAL', String(error));
      this.#lastError = `${meshError.code}: ${meshError.message}`;
      this.#logger.error('worker task failed', { taskId: started.taskId, code: meshError.code, message: meshError.message, details: meshError.details });
      try {
        this.#scheduler.fail(started.taskId, claim.attemptId, meshError.code, meshError.message, meshError.code !== 'MANIFEST_INVALID');
      } catch (failError) {
        this.#logger.error('worker could not record task failure', { taskId: started.taskId, error: String(failError) });
      }
    }
    const collected = options.poll === false ? [] : await this.pollJobs();
    return { task: this.#scheduler.get(claim.task.taskId), collected };
  }

  /**
   * Poll every in-flight job and collect ready artifacts. Job queries are
   * read-only; a reconcile_required job is queried but never resubmitted.
   * @returns ingestion results.
   */
  async pollJobs(): Promise<readonly IngestionResult[]> {
    const collected: IngestionResult[] = [];
    for (const job of this.#jobs.list(JOB_POLL)) {
      try {
        if (job.status === 'reconcile_required' || job.status === 'submitted_unconfirmed') {
          await this.#jobs.reconcile(job.jobId);
        } else {
          await this.#jobs.query(job.jobId);
        }
        const after = this.#store.getJob(job.jobId);
        if (after !== undefined && (after.status === 'output_ready' || after.status === 'succeeded')) {
          try {
            collected.push(await this.#jobs.collect(job.jobId));
          } catch (error) {
            // A partial or failed transfer stays OUTPUT_READY; the experiment is
            // never rerun and the next poll retries only the transfer.
            this.#lastError = error instanceof Error ? error.message : String(error);
            this.#logger.warn('artifact collection incomplete; job retained at OUTPUT_READY', {
              jobId: job.jobId,
              error: this.#lastError,
            });
          }
        }
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#logger.warn('job poll failed', { jobId: job.jobId, error: this.#lastError });
      }
    }
    return collected;
  }

  /**
   * Run rounds until no work is claimable and no job is pollable.
   * @param maxRounds - safety bound.
   * @returns number of rounds executed.
   */
  async runUntilIdle(maxRounds = 50): Promise<number> {
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await this.runOnce();
      if (result.task === null) {
        const pending = this.#store.listJobs(JOB_POLL);
        if (pending.length === 0) return round + 1;
      }
    }
    throw new MeshError('INTERNAL', 'worker did not reach idle within the round bound', { maxRounds });
  }

  /** Start the explicit interval loop. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void this.runOnce().catch(error => {
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#logger.error('worker round failed', { error: this.#lastError });
      }).finally(() => { this.#busy = false; });
    }, this.#config.limits.schedulerPollMs);
    this.#timer.unref?.();
  }

  /** Stop the interval loop, waiting for no in-flight round. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #runLocal(task: MeshTaskView, attemptId: string): Promise<void> {
    const payload = task.payload as Partial<LocalTaskPayload>;
    if (typeof payload.entrypoint !== 'string' || payload.entrypoint === '') {
      throw new MeshError('TASK_STATE_INVALID', 'local task payload lacks entrypoint', { taskId: task.taskId });
    }
    if (task.workspaceId === null) {
      throw new MeshError('WORKSPACE_MISSING', 'local task has no workspace', { taskId: task.taskId });
    }
    const workspace = this.#workspaces.get(task.workspaceId);
    const result = await this.#local.run({
      taskId: task.taskId,
      attemptId,
      workspacePath: workspace.path,
      entrypoint: payload.entrypoint,
      argv: payload.argv ?? [],
      condaEnvironment: payload.condaEnvironment ?? this.#config.conda.defaultEnvironment,
      ...(payload.environment === undefined ? {} : { environment: payload.environment }),
      ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
    });
    if (result.status === 'succeeded') {
      this.#scheduler.succeed(task.taskId, attemptId);
    } else {
      this.#scheduler.fail(
        task.taskId,
        attemptId,
        result.timedOut ? 'EXECUTOR_TIMEOUT' : 'LOCAL_EXIT_NONZERO',
        `local task exited ${String(result.exitCode)}; logs: ${result.logDir}`,
        true,
      );
    }
  }

  #readReceiptId(path: string): string {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || typeof (parsed as { id?: unknown }).id !== 'string') {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt has no id', { path });
    }
    return (parsed as { id: string }).id;
  }

  async #waitForConsumedJob(jobId: string, timeoutMs: number): Promise<number> {
    // Give the freshly launched wrapper a moment to publish its remote state;
    // querying immediately races the transport and would quarantine a healthy
    // job as REMOTE_STATE_NOT_FOUND.
    await new Promise(resolve => setTimeout(resolve, 750));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { await this.#jobs.query(jobId); } catch { /* remote may not have state yet */ }
      const job = this.#store.getJob(jobId);
      if (job === undefined) return 1;
      if (job.status === 'output_ready') {
        const ingested = await this.#jobs.collect(jobId).catch(() => null);
        return ingested === null ? 1 : 0;
      }
      if (job.status === 'ingested' || job.status === 'succeeded') return 0;
      if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'reconcile_required') return 1;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return 1;
  }

  async #runExperiment(task: MeshTaskView, attemptId: string): Promise<void> {
    const payload = task.payload as Partial<ExperimentTaskPayload>;
    const rsi = payload.rsi;
    if (rsi === undefined || typeof payload.workerId !== 'string' || typeof payload.gpuId !== 'number') {
      throw new MeshError('TASK_STATE_INVALID', 'experiment task payload lacks RSI authorization or worker/GPU selection', {
        taskId: task.taskId,
      });
    }
    // In consumed mode the receipt may be bound to a shim manifest that only
    // consumes the ledger entry; the real wrapper comes from a separate
    // execution manifest.
    const executionManifestPath = rsi.executionManifestPath ?? rsi.manifestPath;
    const shim = rsi.shim;
    const workerId = payload.workerId;
    const gpuId = payload.gpuId;
    if (rsi.mode === 'consumed' && shim !== undefined) {
      const runner = this.#rsi.runner();
      const ledgerPath = rsi.ledgerPath ?? join(dirname(rsi.statePath), '.execution');
      await runConsumedShim({
        python: runner.python,
        script: runner.script,
        statePath: rsi.statePath,
        manifestPath: rsi.manifestPath,
        schedulerPath: rsi.schedulerPath,
        receiptPath: rsi.receiptPath,
        ledgerPath,
        experimentId: rsi.experimentId,
        shimSpecPath: shim.specPath,
        shimResultPath: shim.resultPath,
        timeoutMs: shim.timeoutMs,
        ...(shim.journalPath === undefined ? {} : { journalPath: shim.journalPath }),
      }, {
        receiptId: () => String(this.#readReceiptId(rsi.receiptPath)),
        verify: () => this.#rsi.verifyConsumed({ ...inputBase(rsi), ledgerPath }),
        onConsumed: async authorization => {
          const built = await this.#jobs.createManifest({
            taskId: task.taskId,
            workerId,
            gpuId,
            rsiManifestPath: executionManifestPath,
            authorization,
            ...(payload.condaEnvironment === undefined ? {} : { condaEnvironment: payload.condaEnvironment }),
            ...(payload.artifactDestination === undefined ? {} : { artifactDestination: payload.artifactDestination }),
            ...(payload.requiredArtifacts === undefined ? {} : { requiredArtifacts: payload.requiredArtifacts }),
            ...(payload.environment === undefined ? {} : { environment: payload.environment }),
          });
          await this.#jobs.submit(task.taskId, built.manifest);
          return await this.#waitForConsumedJob(built.manifest.job_id, shim.timeoutMs);
        },
      });
      return;
    }
    const input = {
      projectId: task.projectId,
      routeId: rsi.routeId,
      experimentId: rsi.experimentId,
      statePath: rsi.statePath,
      manifestPath: rsi.manifestPath,
      schedulerPath: rsi.schedulerPath,
      receiptPath: rsi.receiptPath,
      ...(rsi.ledgerPath === undefined ? {} : { ledgerPath: rsi.ledgerPath }),
    };
    const authorization = rsi.mode === 'consumed'
      ? this.#rsi.verifyConsumed(input)
      : await this.#rsi.verifyPreview(input);
    const built = await this.#jobs.createManifest({
      taskId: task.taskId,
      workerId: payload.workerId,
      gpuId: payload.gpuId,
      rsiManifestPath: executionManifestPath,
      authorization,
      ...(payload.condaEnvironment === undefined ? {} : { condaEnvironment: payload.condaEnvironment }),
      ...(payload.artifactDestination === undefined ? {} : { artifactDestination: payload.artifactDestination }),
      ...(payload.requiredArtifacts === undefined ? {} : { requiredArtifacts: payload.requiredArtifacts }),
      ...(payload.environment === undefined ? {} : { environment: payload.environment }),
    });
    await this.#jobs.submit(task.taskId, built.manifest);
    void attemptId;
    this.#logger.info('experiment submitted', { taskId: task.taskId, jobId: built.manifest.job_id });
  }
}

function inputBase(rsi: NonNullable<ExperimentTaskPayload['rsi']>): {
  projectId: string; routeId: string; experimentId: string; statePath: string; manifestPath: string; schedulerPath: string; receiptPath: string;
} {
  return { projectId: 'unused', routeId: rsi.routeId, experimentId: rsi.experimentId, statePath: rsi.statePath, manifestPath: rsi.manifestPath, schedulerPath: rsi.schedulerPath, receiptPath: rsi.receiptPath };
}
