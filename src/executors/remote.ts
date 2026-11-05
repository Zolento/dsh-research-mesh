/**
 * Shared remote job workflow used by the fake-SSH and SSH executors.
 *
 * Production and tests exercise the same manifest, wrapper, state file,
 * artifact manifest, digest verification and task transitions. The transport is
 * the only substituted boundary.
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshError } from '../errors.ts';
import type { MeshConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshJobRecord, MeshJobStatus } from '../storage/types.ts';
import type { MeshLogger } from '../util/logger.ts';
import { nowIso } from '../util/time.ts';
import { sha256File, sha256Text } from '../util/hash.ts';
import { archiveCommit } from '../workspaces/git.ts';
import type { TaskScheduler, MeshTaskView } from '../scheduler/scheduler.ts';
import type { GpuLeaseManager } from '../resources/gpu.ts';
import { validateManifest, digestManifest, type JobManifest } from './manifest.ts';
import { buildWrapperScript, wrapperPath, ARTIFACT_MANIFEST_PY } from './wrapper.ts';
import type { JobTransport, RemoteArtifactManifest } from './transport.ts';

/** Remote executor dependencies. */
export interface RemoteExecutorOptions {
  readonly config: MeshConfig;
  readonly store: MeshStore;
  readonly scheduler: TaskScheduler;
  readonly gpu: GpuLeaseManager;
  readonly transport: JobTransport;
  readonly artifactsRoot: string;
  readonly manifestsRoot: string;
  readonly outcomesRoot: string;
  readonly logger: MeshLogger;
}

/** Result of a submit attempt. */
export interface SubmitResult {
  readonly jobId: string;
  readonly status: MeshJobStatus;
  readonly task: MeshTaskView;
  readonly reconcileRequired: boolean;
}

/** Result of artifact ingestion. */
export interface IngestionResult {
  readonly jobId: string;
  readonly task: MeshTaskView;
  readonly artifacts: readonly { path: string; sha256: string; sizeBytes: number }[];
  readonly artifactManifestDigest: string;
  readonly outcomePath: string | null;
}

/** Shared remote execution workflow. */
export class RemoteJobExecutor {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #scheduler: TaskScheduler;
  readonly #gpu: GpuLeaseManager;
  readonly #transport: JobTransport;
  readonly #artifactsRoot: string;
  readonly #manifestsRoot: string;
  readonly #outcomesRoot: string;
  readonly #logger: MeshLogger;
  readonly #inFlight = new Map<string, Promise<SubmitResult>>();

  /**
   * @param options - resolved dependencies.
   */
  constructor(options: RemoteExecutorOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#gpu = options.gpu;
    this.#transport = options.transport;
    this.#artifactsRoot = options.artifactsRoot;
    this.#manifestsRoot = options.manifestsRoot;
    this.#outcomesRoot = options.outcomesRoot;
    this.#logger = options.logger;
  }

  /** Transport label. */
  get kind(): string {
    return this.#transport.kind;
  }

  /**
   * Stage the immutable job directory and submit it.
   * @param task - task view with an attempt.
   * @param manifest - validated manifest.
   * @returns submit outcome.
   */
  async submit(task: MeshTaskView, manifest: JobManifest): Promise<SubmitResult> {
    const key = manifest.job_id;
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running;
    const submission = this.#submitOnce(task, manifest);
    this.#inFlight.set(key, submission);
    try {
      return await submission;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #submitOnce(task: MeshTaskView, manifest: JobManifest): Promise<SubmitResult> {
    if (task.attemptId === null) throw new MeshError('TASK_STATE_INVALID', 'task has no active attempt', { taskId: task.taskId });
    const validated = validateManifest(manifest, this.#config, {
      expectedJobId: manifest.job_id,
      expectedAttemptId: task.attemptId,
      expectedProjectId: task.projectId,
      expectedTeamId: task.teamId,
      expectedWorkerId: manifest.resources.worker_id,
      ...(manifest.manifest_sha256 === undefined ? {} : { expectedDigest: manifest.manifest_sha256 }),
    });
    const worker = this.#config.workers[validated.resources.worker_id];
    if (worker === undefined) throw new MeshError('CONFIG_INVALID', 'manifest worker disappeared', { manifest: validated.job_id });
    const existing = this.#store.getJob(validated.job_id);
    if (existing !== undefined && ['submitted', 'submitted_unconfirmed', 'running', 'succeeded', 'output_ready', 'ingested'].includes(existing.status)) {
      if (['succeeded', 'output_ready', 'ingested'].includes(existing.status)) {
        // A crash may have left a lease behind after the remote run finished.
        this.#gpu.releaseForTask(task.taskId, `job is already ${existing.status}`);
      }
      return {
        jobId: existing.jobId,
        status: existing.status,
        task: this.#scheduler.get(task.taskId),
        reconcileRequired: existing.status === 'submitted_unconfirmed',
      };
    }
    const jobDir = this.#transport.jobDir(worker, validated.job_id, validated.attempt_id);
    const persisted = existing ?? {
      jobId: validated.job_id,
      taskId: task.taskId,
      attemptId: validated.attempt_id,
      projectId: task.projectId,
      teamId: task.teamId,
      workerId: worker.workerId,
      gpuId: validated.resources.gpu_id ?? -1,
      manifestJson: JSON.stringify(validated, null, 2),
      manifestDigest: validated.manifest_sha256 ?? digestManifest(validated),
      status: 'prepared' as MeshJobStatus,
      remoteDir: jobDir,
      submittedAt: null,
      updatedAt: nowIso(),
      errorCode: null,
      errorMessage: null,
    };
    if (existing === undefined) {
      try {
        this.#store.insertJob(persisted);
      } catch (error) {
        // Another controller inserted the same job between the read and the
        // write. The row is now the authority; this caller must not launch.
        const raced = this.#store.getJob(validated.job_id);
        if (raced === undefined) throw error;
        return {
          jobId: raced.jobId,
          status: raced.status,
          task: this.#scheduler.get(task.taskId),
          reconcileRequired: raced.status === 'submitting' || raced.status === 'submitted_unconfirmed',
        };
      }
    }

    // A prior controller may already have submitted this exact job. Read the
    // remote state BEFORE taking a GPU lease so an adopted run cannot leak one.
    let preState;
    try {
      preState = await this.#transport.readState(jobDir);
    } catch (error) {
      const meshError = error instanceof MeshError ? error : new MeshError('REMOTE_STATE_UNKNOWN', String(error));
      // We could not prove whether a previous controller submitted this job.
      // Never mark it failed (which would permit a resubmit); ask for reconcile.
      this.#store.updateJob(validated.job_id, {
        status: 'reconcile_required',
        errorCode: 'REMOTE_STATE_UNKNOWN',
        errorMessage: meshError.message,
      });
      const queued = this.#scheduler.markRemote(task.taskId, 'RECONCILE_REQUIRED', {
        jobId: validated.job_id,
        errorCode: 'REMOTE_STATE_UNKNOWN',
        errorMessage: meshError.message,
      });
      return { jobId: validated.job_id, status: 'reconcile_required', task: queued, reconcileRequired: true };
    }
    if (preState !== null) {
      this.#store.updateJob(validated.job_id, { status: 'submitted', submittedAt: nowIso() });
      const adopted = await this.query(validated.job_id);
      const current = this.#store.getJob(validated.job_id);
      this.#store.appendEvent('job', validated.job_id, 'adopted-existing-remote-state', { status: preState.status });
      return {
        jobId: validated.job_id,
        status: current?.status ?? 'submitted',
        task: adopted,
        reconcileRequired: current?.status === 'reconcile_required',
      };
    }

    // Only the caller that wins the durable prepared -> submitting CAS may
    // launch. A concurrent submitter sees `submitting` and returns without
    // starting a second remote process.
    if (!this.#store.claimJobSubmission(validated.job_id)) {
      const owner = this.#store.getJob(validated.job_id);
      if (owner === undefined) throw new MeshError('STORAGE_ERROR', 'job vanished before submission', { jobId: validated.job_id });
      this.#logger.warn('duplicate job submission refused; another controller owns this job', {
        jobId: validated.job_id,
        status: owner.status,
      });
      return {
        jobId: owner.jobId,
        status: owner.status,
        task: this.#scheduler.get(task.taskId),
        reconcileRequired: owner.status === 'submitting' || owner.status === 'submitted_unconfirmed',
      };
    }

    let leaseId: string | null = null;
    if (validated.resources.gpu_id !== null) {
      try {
        const acquired = await this.#gpu.acquire({
          workerId: worker.workerId,
          taskId: task.taskId,
          jobId: validated.job_id,
          attemptId: validated.attempt_id,
          gpuId: validated.resources.gpu_id,
        });
        leaseId = acquired.lease.leaseId;
      } catch (error) {
        const meshError = error instanceof MeshError ? error : new MeshError('GPU_UNAVAILABLE', String(error));
        if (meshError.code === 'GPU_LEASE_CONFLICT' && this.#store.listLeases(task.taskId)
          .some(lease => lease.state === 'active' || lease.state === 'reserved')) {
          // A concurrent submit already owns this task's GPU lease. Do not fail
          // the task from the losing submit; let the owner finish.
          return {
            jobId: validated.job_id,
            status: existing?.status ?? 'prepared',
            task: this.#scheduler.get(task.taskId),
            reconcileRequired: false,
          };
        }
        const blocked = this.#scheduler.block(task.taskId, task.attemptId, meshError.code, meshError.message);
        this.#store.updateJob(validated.job_id, { status: 'failed', errorCode: meshError.code, errorMessage: meshError.message });
        return { jobId: validated.job_id, status: 'failed', task: blocked, reconcileRequired: false };
      }
    }

    try {
      await this.#stage(validated, worker.workerId, jobDir);
      const submitted = await this.#transport.submit(jobDir, wrapperPath(jobDir), 60_000);
      this.#store.updateJob(validated.job_id, {
        status: 'submitted',
        submittedAt: nowIso(),
        errorCode: null,
        errorMessage: null,
      });
      const updated = this.#scheduler.markRemote(task.taskId, 'SUBMITTED', {
        jobId: validated.job_id,
        gpuId: validated.resources.gpu_id,
      });
      this.#store.appendEvent('job', validated.job_id, 'submitted', { pid: submitted.pid ?? null, transport: this.#transport.kind });
      return { jobId: validated.job_id, status: 'submitted', task: updated, reconcileRequired: false };
    } catch (error) {
      if (error instanceof MeshError && (error.code === 'SUBMIT_UNKNOWN' || error.code === 'EXECUTOR_TIMEOUT')) {
        this.#store.updateJob(validated.job_id, {
          status: 'submitted_unconfirmed',
          submittedAt: nowIso(),
          errorCode: 'SUBMIT_UNKNOWN',
          errorMessage: error.message,
        });
        const updated = this.#scheduler.markRemote(task.taskId, 'RECONCILE_REQUIRED', {
          jobId: validated.job_id,
          gpuId: validated.resources.gpu_id,
          errorCode: 'SUBMIT_UNKNOWN',
          errorMessage: error.message,
        });
        if (leaseId !== null) this.#gpu.quarantine(leaseId, 'submit response lost; remote state unknown');
        this.#store.appendEvent('job', validated.job_id, 'submit-unknown', { message: error.message });
        return { jobId: validated.job_id, status: 'submitted_unconfirmed', task: updated, reconcileRequired: true };
      }
      const meshError = error instanceof MeshError ? error : new MeshError('EXECUTOR_FAILED', String(error));
      this.#store.updateJob(validated.job_id, {
        status: 'failed',
        errorCode: meshError.code,
        errorMessage: meshError.message,
      });
      const updated = this.#scheduler.fail(task.taskId, validated.attempt_id, meshError.code, meshError.message, false);
      if (leaseId !== null) this.#gpu.release(leaseId, 'submit failed');
      return { jobId: validated.job_id, status: 'failed', task: updated, reconcileRequired: false };
    }
  }

  /**
   * Query the remote state and advance the job/task.
   * @param jobId - job identity.
   * @returns current task view.
   */
  async query(jobId: string): Promise<MeshTaskView> {
    const job = this.#requireJob(jobId);
    if (job.status === 'ingested') return this.#scheduler.get(job.taskId);
    const manifest = this.#manifestOf(job);
    const task = this.#scheduler.get(job.taskId);
    if (task.attemptId === null && job.status !== 'output_ready' && job.status !== 'succeeded') {
      return task;
    }
    const state = await this.#transport.readState(job.remoteDir);
    if (state === null) {
      if (['submitted', 'submitted_unconfirmed', 'running'].includes(job.status)) {
        this.#store.updateJob(jobId, {
          status: 'reconcile_required',
          errorCode: 'REMOTE_STATE_NOT_FOUND',
          errorMessage: 'no remote state; refusing to resubmit automatically',
        });
        this.#quarantineForJob(jobId, 'remote state not found');
        return this.#scheduler.markRemote(job.taskId, 'RECONCILE_REQUIRED', {
          jobId,
          errorCode: 'REMOTE_STATE_NOT_FOUND',
          errorMessage: 'no remote state; reconcile before retry',
        });
      }
      return task;
    }
    if (state.job_id !== job.jobId || state.attempt_id !== job.attemptId || state.manifest_sha256 !== job.manifestDigest) {
      this.#store.updateJob(jobId, {
        status: 'reconcile_required',
        errorCode: 'REMOTE_STATE_MISMATCH',
        errorMessage: 'remote state does not match the persisted job',
      });
      this.#quarantineForJob(jobId, 'remote state does not match the persisted job');
      return this.#scheduler.markRemote(job.taskId, 'RECONCILE_REQUIRED', {
        jobId,
        errorCode: 'REMOTE_STATE_MISMATCH',
        errorMessage: 'remote state does not match the persisted job',
      });
    }
    if (state.status === 'running') {
      this.#store.updateJob(jobId, { status: 'running', errorCode: null, errorMessage: null });
      return this.#scheduler.markRemote(job.taskId, 'SUBMITTED', { jobId });
    }
    if (state.status === 'failed') {
      this.#store.updateJob(jobId, {
        status: 'failed',
        errorCode: 'REMOTE_EXIT_NONZERO',
        errorMessage: `remote exit code ${String(state.exit_code)}`,
      });
      this.#gpu.releaseForTask(job.taskId, 'remote execution failed');
      return this.#scheduler.fail(
        job.taskId,
        job.attemptId,
        'REMOTE_EXIT_NONZERO',
        `remote exit code ${String(state.exit_code)}`,
        true,
      );
    }
    this.#store.updateJob(jobId, { status: 'output_ready', errorCode: null, errorMessage: null });
    this.#gpu.releaseForTask(job.taskId, 'remote execution finished');
    void manifest;
    return this.#scheduler.markRemote(job.taskId, 'OUTPUT_READY', { jobId });
  }

  /**
   * Reconcile one job against the remote state. This is a read plus adoption;
   * it never submits.
   * @param jobId - job identity.
   * @returns current task view.
   */
  async reconcile(jobId: string): Promise<MeshTaskView> {
    const job = this.#requireJob(jobId);
    const state = await this.#transport.readState(job.remoteDir);
    if (state === null) {
      this.#store.updateJob(jobId, {
        status: 'reconcile_required',
        errorCode: 'REMOTE_STATE_NOT_FOUND',
        errorMessage: 'reconcile found no remote state; manual decision required',
      });
      this.#quarantineForJob(jobId, 'reconcile found no remote state');
      return this.#scheduler.markRemote(job.taskId, 'RECONCILE_REQUIRED', {
        jobId,
        errorCode: 'REMOTE_STATE_NOT_FOUND',
        errorMessage: 'no remote state; manual decision required',
      });
    }
    return this.query(jobId);
  }

  /**
   * Collect and verify artifacts, then mark the task INGESTED and
   * ASSURANCE_PENDING. A failed verification leaves the job at OUTPUT_READY.
   * @param jobId - job identity.
   * @returns ingestion result.
   */
  async collect(jobId: string): Promise<IngestionResult> {
    const job = this.#requireJob(jobId);
    if (job.status === 'ingested') {
      const task = this.#scheduler.get(job.taskId);
      const artifacts = this.#store.listArtifacts(jobId).map(artifact => ({
        path: artifact.relativePath,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      }));
      return {
        jobId,
        task,
        artifacts,
        artifactManifestDigest: this.#store.getOutcome(jobId)?.artifactManifestDigest ?? '',
        outcomePath: existsSync(join(this.#outcomesRoot, `${jobId}.json`)) ? join(this.#outcomesRoot, `${jobId}.json`) : null,
      };
    }
    if (job.status !== 'output_ready' && job.status !== 'succeeded') {
      throw new MeshError('TASK_STATE_INVALID', `job ${jobId} is ${job.status}; artifacts are not ready`, {
        jobId,
        status: job.status,
      });
    }
    const manifest = this.#manifestOf(job);
    const artifactManifest = await this.#transport.readArtifactManifest(job.remoteDir, manifest.artifacts.destination);
    if (artifactManifest === null) {
      throw new MeshError('ARTIFACT_TRANSFER_INCOMPLETE', 'artifact manifest is missing', { jobId });
    }
    this.#validateArtifactManifest(artifactManifest, job, manifest);
    const staging = join(this.#artifactsRoot, jobId, `${job.attemptId}.staging`);
    const final = join(this.#artifactsRoot, jobId, job.attemptId);
    // The staging directory is Mesh-owned. Clear leftover bytes from a prior
    // failed transfer so stale files can never be promoted into the final set.
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      for (const file of artifactManifest.files) {
        const local = join(staging, file.path);
        await this.#transport.download(job.remoteDir, `${manifest.artifacts.destination}/${file.path}`, local);
        const size = statSync(local).size;
        if (size !== file.size_bytes) {
          throw new MeshError('ARTIFACT_CHECKSUM_MISMATCH', 'artifact size does not match the manifest', {
            path: file.path,
            expected: file.size_bytes,
            actual: size,
          });
        }
        const digest = await sha256File(local);
        if (digest !== file.sha256) {
          throw new MeshError('ARTIFACT_CHECKSUM_MISMATCH', 'artifact SHA-256 does not match the manifest', {
            path: file.path,
            expected: file.sha256,
            actual: digest,
          });
        }
      }
      const required = manifest.artifacts.required ?? [];
      for (const requiredPath of required) {
        if (!artifactManifest.files.some(file => file.path === requiredPath)) {
          throw new MeshError('ARTIFACT_INVALID', `required artifact is missing: ${requiredPath}`, { requiredPath });
        }
      }
      const rawManifest = JSON.stringify(artifactManifest, null, 2);
      const manifestCopy = join(staging, 'artifact-manifest.json');
      writeFileSync(manifestCopy, `${rawManifest}\n`, 'utf8');
      mkdirSync(dirname(final), { recursive: true, mode: 0o700 });
      if (existsSync(final)) {
        throw new MeshError('ARTIFACT_INVALID', 'final artifact directory already exists without an ingested job', { final });
      }
      renameSync(staging, final);
    } catch (error) {
      // Keep the staging directory for a retry; the job stays OUTPUT_READY and
      // the experiment is never rerun.
      throw error instanceof MeshError
        ? error
        : new MeshError('ARTIFACT_TRANSFER_INCOMPLETE', String(error), { jobId });
    }

    const artifacts = artifactManifest.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.size_bytes,
    }));
    const manifestDigest = sha256Text(JSON.stringify(artifactManifest));
    try {
      this.#store.transaction(() => {
        for (const [index, artifact] of artifacts.entries()) {
          this.#store.insertArtifact({
            artifactId: `artifact_${jobId}_${index}_${artifact.path.replace(/[^A-Za-z0-9._-]/g, '_')}`,
            jobId,
            attemptId: job.attemptId,
            relativePath: artifact.path,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            createdAt: nowIso(),
          });
        }
        this.#store.updateJob(jobId, { status: 'ingested', errorCode: null, errorMessage: null });
      });
    } catch (error) {
      // The DB did not accept the ingestion; keep the job ready for a clean
      // re-download rather than leaving a half-promoted final directory.
      rmSync(final, { recursive: true, force: true });
      throw error;
    }
    this.#gpu.releaseForTask(job.taskId, 'artifacts ingested');
    this.#scheduler.markRemote(job.taskId, 'INGESTED', { jobId });
    const task = this.#scheduler.markRemote(job.taskId, 'ASSURANCE_PENDING', { jobId });
    let outcomePath: string | null = null;
    const experimentId = manifest.authorization.rsi_experiment_id;
    const receiptId = manifest.authorization.rsi_receipt_ref;
    if (experimentId !== undefined && receiptId !== null) {
      outcomePath = join(this.#outcomesRoot, `${jobId}.json`);
      const payload = {
        schema: 'dsh-research-mesh/outcome-handoff@1',
        job_id: jobId,
        experiment_id: experimentId,
        receipt_ref: receiptId,
        state_version: manifest.authorization.research_state_version,
        artifact_manifest_digest: manifestDigest,
        artifacts,
        execution: {
          status: 'INGESTED',
          remote_state: 'succeeded',
          finished_at: nowIso(),
          transport: this.#transport.kind,
        },
        scientific_status: 'ASSURANCE_PENDING',
        note: 'Execution completed. This file is not a scientific verdict and must be evaluated by RSI R9.O/R10/R11.',
      };
      mkdirSync(this.#outcomesRoot, { recursive: true, mode: 0o700 });
      writeFileSync(outcomePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      this.#store.insertOutcome({
        jobId,
        experimentId,
        receiptId,
        stateVersion: manifest.authorization.research_state_version ?? '',
        artifactManifestDigest: manifestDigest,
        status: 'ASSURANCE_PENDING',
        payloadJson: JSON.stringify(payload),
        createdAt: nowIso(),
      });
    }
    this.#store.appendEvent('job', jobId, 'ingested', { artifacts: artifacts.length, manifestDigest });
    this.#logger.info('job artifacts ingested', { jobId, artifacts: artifacts.length });
    return { jobId, task, artifacts, artifactManifestDigest: manifestDigest, outcomePath };
  }

  /**
   * Mark every in-flight job as requiring reconciliation. No remote command is
   * sent and nothing is resubmitted.
   * @returns count of jobs marked.
   */
  recover(): number {
    let count = 0;
    for (const job of this.#store.listJobs()) {
      if (!['prepared', 'submitting', 'submitted', 'submitted_unconfirmed', 'running'].includes(job.status)) continue;
      this.#store.updateJob(job.jobId, {
        status: 'reconcile_required',
        errorCode: 'RECONCILE_REQUIRED',
        errorMessage: 'process restarted with an in-flight job; query remote state before retry',
      });
      this.#scheduler.markRemote(job.taskId, 'RECONCILE_REQUIRED', {
        jobId: job.jobId,
        errorCode: 'RECONCILE_REQUIRED',
        errorMessage: 'process restarted with an in-flight job; query remote state before retry',
      });
      this.#quarantineForJob(job.jobId, 'process restarted with an in-flight job');
      count += 1;
    }
    return count;
  }

  /**
   * Explicitly abandon a reconciled job. This never deletes remote data and
   * never resubmits; it records an operator decision.
   * @param jobId - job identity.
   * @param reason - operator-visible reason.
   * @returns updated task.
   */
  abandon(jobId: string, reason: string): MeshTaskView {
    const job = this.#requireJob(jobId);
    if (job.status !== 'reconcile_required' && job.status !== 'submitted_unconfirmed') {
      throw new MeshError('TASK_STATE_INVALID', 'only reconciled jobs may be abandoned', { jobId, status: job.status });
    }
    this.#store.updateJob(jobId, { status: 'cancelled', errorCode: 'ABANDONED', errorMessage: reason });
    for (const lease of this.#store.listLeases(job.taskId)) {
      if (lease.state === 'quarantined' || lease.state === 'active') this.#gpu.release(lease.leaseId, `job abandoned: ${reason}`);
    }
    return this.#scheduler.block(job.taskId, job.attemptId, 'ABANDONED', reason);
  }

  /** Read one persisted job. */
  get(jobId: string): MeshJobRecord {
    return this.#requireJob(jobId);
  }

  /**
   * List persisted jobs, optionally filtered by status.
   * @param statuses - statuses to include.
   * @returns job rows.
   */
  list(statuses?: readonly MeshJobStatus[]): readonly MeshJobRecord[] {
    return this.#store.listJobs(statuses);
  }

  async #stage(manifest: JobManifest, workerId: string, jobDir: string): Promise<void> {
    const worker = this.#config.workers[workerId];
    if (worker === undefined) throw new MeshError('CONFIG_INVALID', `worker ${workerId} is not configured`);
    await this.#transport.ensureJobDir(jobDir);
    await this.#transport.writeFile(jobDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    await this.#transport.writeFile(jobDir, 'artifact_manifest.py', ARTIFACT_MANIFEST_PY);
    const script = buildWrapperScript({
      manifest,
      jobDir,
      conda: this.#config.conda,
      gpuId: manifest.resources.gpu_id,
    });
    await this.#transport.writeFile(jobDir, 'run.sh', script);
    const archive = join(this.#manifestsRoot, `${manifest.job_id}.${manifest.attempt_id}.tar`);
    await archiveCommit(this.#config.sourceDir, manifest.code.commit, archive);
    await this.#transport.stageArchive(jobDir, archive);
    this.#store.updateJob(manifest.job_id, { status: 'prepared', remoteDir: jobDir });
  }

  #validateArtifactManifest(manifest: RemoteArtifactManifest, job: MeshJobRecord, jobManifest: JobManifest): void {
    if (manifest.job_id !== job.jobId || manifest.attempt_id !== job.attemptId) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest belongs to another job', { jobId: job.jobId });
    }
    if (manifest.files.length > this.#config.artifacts.maxFiles) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest exceeds the file limit', {
        files: manifest.files.length,
        limit: this.#config.artifacts.maxFiles,
      });
    }
    if (manifest.total_bytes > this.#config.artifacts.maxBytes) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest exceeds the byte limit', {
        bytes: manifest.total_bytes,
        limit: this.#config.artifacts.maxBytes,
      });
    }
    if (manifest.manifest_sha256 !== job.manifestDigest) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest does not bind the persisted job manifest');
    }
    void jobManifest;
  }

  #manifestOf(job: MeshJobRecord): JobManifest {
    const parsed: unknown = JSON.parse(job.manifestJson);
    return validateManifest(parsed, this.#config, {
      expectedJobId: job.jobId,
      expectedAttemptId: job.attemptId,
      expectedDigest: job.manifestDigest,
    });
  }

  #quarantineForJob(jobId: string, reason: string): void {
    const job = this.#store.getJob(jobId);
    if (job === undefined) return;
    for (const lease of this.#store.listLeases(job.taskId)) {
      if (lease.state === 'active' || lease.state === 'reserved') this.#gpu.quarantine(lease.leaseId, reason);
    }
  }

  #requireJob(jobId: string): MeshJobRecord {
    const job = this.#store.getJob(jobId);
    if (job === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown job ${jobId}`, { jobId });
    return job;
  }
}
