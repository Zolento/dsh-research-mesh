/**
 * Persistent Mesh task scheduler.
 *
 * The integrated bridge task table owns the DAG, compare-and-set revisions and
 * lease rows. Mesh adds priority/FIFO ordering, worker claims, remote states,
 * concurrency limits, idempotent submission and crash recovery. Every claim
 * runs inside `BEGIN IMMEDIATE`, and the claim itself is a compare-and-set on
 * the bridge task revision, so two workers cannot receive the same task.
 */

import { MeshError } from '../errors.ts';
import type { MeshConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshTaskMeta, MeshTaskStatus, MeshTaskType } from '../storage/types.ts';
import { ID_PREFIX, newId } from '../util/ids.ts';
import { isoFromMs, nowIso } from '../util/time.ts';
import { idempotencyKey as bridgeIdempotencyKey } from '../bridge/ids.ts';
import type { ResearchRole, ResearchTask, TeamRecord } from '../bridge/types.ts';
import type { MeshLogger } from '../util/logger.ts';

/** Task submission input. */
export interface SubmitTaskInput {
  readonly projectId: string;
  readonly teamId: string;
  readonly type: MeshTaskType;
  readonly title: string;
  readonly objective?: string;
  readonly priority?: number;
  readonly dependencies?: readonly string[];
  readonly idempotencyKey?: string;
  readonly workspaceId?: string;
  readonly rsiStateVersion?: string;
  readonly receiptRef?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
  readonly role?: ResearchRole;
}

/** Result of a claim. */
export interface ClaimedTask {
  readonly task: MeshTaskView;
  readonly workerId: string;
  readonly attemptId: string;
  readonly leaseExpiresAt: string;
}

/** Caller-facing task projection. */
export interface MeshTaskView {
  readonly taskId: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly type: MeshTaskType;
  readonly status: MeshTaskStatus;
  readonly priority: number;
  readonly title: string;
  readonly objective: string;
  readonly role: ResearchRole;
  readonly dependencies: readonly string[];
  readonly workspaceId: string | null;
  readonly rsiStateVersion: string | null;
  readonly receiptRef: string | null;
  readonly jobId: string | null;
  readonly gpuId: number | null;
  readonly attemptId: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Recovery report after a restart. */
export interface SchedulerRecoveryReport {
  readonly reconciledRemote: readonly string[];
  readonly failedLocal: readonly string[];
  readonly untouched: readonly string[];
}

const CLAIMABLE: readonly ResearchTask['status'][] = ['pending', 'ready'];
const ACTIVE: readonly ResearchTask['status'][] = ['claimed', 'running'];
const REMOTE_ACTIVE: readonly MeshTaskStatus[] = ['SUBMITTED', 'RECONCILE_REQUIRED', 'OUTPUT_READY'];

function parsePayload(json: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // A malformed payload is surfaced as an empty object; the task row itself
    // remains authoritative and execution handlers reject missing fields.
  }
  return {};
}

function roleFor(type: MeshTaskType, provided?: ResearchRole): ResearchRole {
  if (provided !== undefined) return provided;
  if (type === 'experiment') return 'experiment';
  if (type === 'local') return 'experiment';
  return 'synthesis';
}

function mapStatus(task: ResearchTask, meta: MeshTaskMeta): MeshTaskStatus {
  if (meta.remoteStatus !== null) return meta.remoteStatus;
  switch (task.status) {
    case 'pending': return 'PENDING';
    case 'ready': return 'READY';
    case 'claimed': return 'CLAIMED';
    case 'running': return 'RUNNING';
    case 'completed': return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    case 'blocked': return 'BLOCKED';
    case 'cancelled': return 'CANCELLED';
  }
}

/** Persistent deterministic scheduler. */
export class TaskScheduler {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #logger: MeshLogger;

  /**
   * @param config - resolved Mesh configuration.
   * @param store - Mesh metadata store.
   * @param logger - structured logger.
   */
  constructor(config: MeshConfig, store: MeshStore, logger: MeshLogger) {
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
  }

  /**
   * Submit one task, idempotently.
   * @param input - task definition.
   * @returns the task and whether it was newly created.
   */
  submit(input: SubmitTaskInput): { readonly task: MeshTaskView; readonly created: boolean } {
    const team = this.#requireTeam(input.teamId);
    if (team.status !== 'active') {
      throw new MeshError('TEAM_STATE_INVALID', 'tasks can only be submitted to an active group', {
        teamId: input.teamId,
        status: team.status,
      });
    }
    const group = this.#store.getGroup(input.teamId);
    if (group === undefined) throw new MeshError('TEAM_NOT_FOUND', `unknown group ${input.teamId}`, { teamId: input.teamId });
    if (group.status !== 'active') {
      throw new MeshError('TEAM_STATE_INVALID', 'tasks can only be submitted to an active group', {
        teamId: input.teamId,
        groupStatus: group.status,
      });
    }
    const dependencies = [...new Set(input.dependencies ?? [])];
    if (input.priority !== undefined && (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 1000)) {
      throw new MeshError('INVALID_ARGUMENT', 'priority must be an integer in [0, 1000]', { priority: input.priority });
    }
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new MeshError('INVALID_ARGUMENT', 'maxAttempts must be an integer in [1, 10]', { maxAttempts });
    }
    const key = input.idempotencyKey ?? bridgeIdempotencyKey([
      'mesh-task',
      input.projectId,
      input.teamId,
      input.type,
      input.title,
      input.objective ?? '',
      ...dependencies,
    ]);

    return this.#store.transaction(() => {
      const existing = this.#store.teamStore.listTasks(input.teamId)
        .find(task => task.idempotency_key === key);
      if (existing !== undefined) {
        const meta = this.#store.getTaskMeta(existing.task_id);
        if (meta === undefined) {
          throw new MeshError('STORAGE_ERROR', 'task exists without Mesh metadata', { taskId: existing.task_id });
        }
        return { task: this.#view(existing, meta), created: false };
      }
      for (const dependency of dependencies) {
        const parent = this.#store.teamStore.getTask(dependency);
        if (parent === undefined || parent.team_id !== input.teamId) {
          throw new MeshError('TASK_DEPENDENCY_UNKNOWN', `dependency ${dependency} is not a task of this group`, {
            teamId: input.teamId,
            dependency,
          });
        }
      }
      const taskId = newId(ID_PREFIX.task);
      this.#assertAcyclic(input.teamId, taskId, dependencies);
      const now = nowIso();
      const role = roleFor(input.type, input.role);
      const task: ResearchTask = {
        task_id: taskId,
        team_id: input.teamId,
        parent_task_id: null,
        dependencies,
        role,
        title: input.title.trim(),
        objective: (input.objective ?? input.title).trim(),
        status: 'pending',
        assigned_agent: null,
        attempt_id: null,
        attempt_count: 0,
        max_attempts: maxAttempts,
        input_artifacts: [],
        output_artifacts: [],
        budget: team.budget,
        failure_reason: null,
        lease: null,
        research_route: group.routeId,
        state_version: input.rsiStateVersion ?? team.stateVersionAtStart,
        created_at: now,
        updated_at: now,
        revision: 1,
        idempotency_key: key,
        progress: { startedAt: null, finishedAt: null, messages: 0, experimentRuns: 0 },
      };
      const meta: MeshTaskMeta = {
        taskId,
        projectId: input.projectId,
        taskType: input.type,
        priority: input.priority ?? 0,
        enqueueSeq: 0,
        workspaceId: input.workspaceId ?? group.workspaceId,
        rsiStateVersion: input.rsiStateVersion ?? null,
        receiptRef: input.receiptRef ?? null,
        jobId: null,
        gpuId: null,
        remoteStatus: null,
        errorCode: null,
        errorMessage: null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: now,
        updatedAt: now,
      };
      this.#store.teamStore.insertTask(task);
      this.#store.insertTaskMeta(meta);
      this.#store.appendEvent('task', taskId, 'submitted', {
        projectId: input.projectId,
        teamId: input.teamId,
        type: input.type,
        priority: meta.priority,
      });
      this.#refreshReadinessLocked(input.teamId);
      const current = this.#store.teamStore.getTask(taskId);
      if (current === undefined) throw new MeshError('STORAGE_ERROR', 'task vanished after insert', { taskId });
      return { task: this.#view(current, meta), created: true };
    });
  }

  /**
   * Read one task.
   * @param taskId - task identity.
   * @returns task view.
   */
  get(taskId: string): MeshTaskView {
    const task = this.#store.teamStore.getTask(taskId);
    const meta = this.#store.getTaskMeta(taskId);
    if (task === undefined || meta === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown task ${taskId}`, { taskId });
    return this.#view(task, meta);
  }

  /**
   * List tasks of one group in enqueue order.
   * @param teamId - group identity.
   * @returns task views.
   */
  listByTeam(teamId: string): readonly MeshTaskView[] {
    return this.#store.teamStore.listTasks(teamId).map(task => {
      const meta = this.#store.getTaskMeta(task.task_id);
      if (meta === undefined) throw new MeshError('STORAGE_ERROR', 'task exists without Mesh metadata', { taskId: task.task_id });
      return this.#view(task, meta);
    });
  }

  /**
   * List all tasks of a project.
   * @param projectId - project identity.
   * @returns task views.
   */
  listByProject(projectId: string): readonly MeshTaskView[] {
    return this.#store.listTaskMeta(projectId).map(meta => {
      const task = this.#store.teamStore.getTask(meta.taskId);
      if (task === undefined) throw new MeshError('STORAGE_ERROR', 'Mesh metadata exists without a bridge task', { taskId: meta.taskId });
      return this.#view(task, meta);
    });
  }

  /**
   * Claim the next eligible task for one worker.
   * @param workerId - stable worker identity.
   * @param options - project/team filter and clock.
   * @returns the claimed task, or undefined when nothing is eligible.
   */
  claimNext(workerId: string, options: { projectId?: string; teamId?: string; nowMs?: number } = {}): ClaimedTask | undefined {
    const nowMs = options.nowMs ?? Date.now();
    const now = isoFromMs(nowMs);
    return this.#store.transaction(() => {
      const groups = this.#store.listGroups(options.projectId)
        .filter(group => group.status === 'active')
        .filter(group => this.#store.teamStore.getTeam(group.teamId)?.status === 'active')
        .filter(group => options.teamId === undefined || group.teamId === options.teamId);
      const globalActive = this.#countActive();
      if (globalActive >= this.#config.limits.maxConcurrentTasks) return undefined;
      const candidates: { task: ResearchTask; meta: MeshTaskMeta }[] = [];
      for (const group of groups) {
        if (this.#countActive(group.teamId) >= this.#config.limits.maxConcurrentTasksPerTeam) continue;
        for (const task of this.#store.teamStore.listTasks(group.teamId)) {
          if (!CLAIMABLE.includes(task.status)) continue;
          if (task.attempt_count >= task.max_attempts) continue;
          const meta = this.#store.getTaskMeta(task.task_id);
          if (meta === undefined) continue;
          if (meta.remoteStatus !== null) continue;
          if (this.#blockingDependencies(task).length > 0) continue;
          candidates.push({ task, meta });
        }
      }
      candidates.sort((left, right) =>
        right.meta.priority - left.meta.priority
        || left.meta.enqueueSeq - right.meta.enqueueSeq
        || left.task.task_id.localeCompare(right.task.task_id));
      const next = candidates[0];
      if (next === undefined) return undefined;
      return this.#claimLocked(next.task, next.meta, workerId, nowMs, now);
    });
  }

  /**
   * Claim one named task, failing when it is not eligible.
   * @param taskId - task identity.
   * @param workerId - worker identity.
   * @param nowMs - test clock override.
   * @returns claim.
   */
  claimTask(taskId: string, workerId: string, nowMs = Date.now()): ClaimedTask {
    const now = isoFromMs(nowMs);
    return this.#store.transaction(() => {
      const task = this.#store.teamStore.getTask(taskId);
      const meta = this.#store.getTaskMeta(taskId);
      if (task === undefined || meta === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown task ${taskId}`, { taskId });
      if (!CLAIMABLE.includes(task.status)) {
        throw new MeshError('TASK_NOT_CLAIMABLE', `task ${taskId} is ${task.status}`, { taskId, status: task.status });
      }
      const team = this.#store.teamStore.getTeam(task.team_id);
      const group = this.#store.getGroup(task.team_id);
      if (team?.status !== 'active' || group?.status !== 'active') {
        throw new MeshError('TASK_NOT_CLAIMABLE', 'task group or project is not active', { taskId, teamId: task.team_id });
      }
      if (this.#countActive() >= this.#config.limits.maxConcurrentTasks
        || this.#countActive(task.team_id) >= this.#config.limits.maxConcurrentTasksPerTeam) {
        throw new MeshError('TASK_NOT_CLAIMABLE', 'concurrency limit reached', { taskId, teamId: task.team_id });
      }
      if (task.attempt_count >= task.max_attempts) {
        throw new MeshError('TASK_NOT_CLAIMABLE', 'attempts exhausted', { taskId, attempts: task.attempt_count });
      }
      const blocking = this.#blockingDependencies(task);
      if (blocking.length > 0) {
        throw new MeshError('TASK_NOT_CLAIMABLE', 'dependencies are not complete', { taskId, blocking });
      }
      if (meta.remoteStatus !== null) {
        throw new MeshError('TASK_NOT_CLAIMABLE', 'task is in a remote state', { taskId, remoteStatus: meta.remoteStatus });
      }
      return this.#claimLocked(task, meta, workerId, nowMs, now);
    });
  }

  /**
   * Move a claimed task into execution.
   * @param taskId - task identity.
   * @param workerId - worker that holds the claim.
   * @param attemptId - attempt identity.
   * @returns updated task.
   */
  start(taskId: string, workerId: string, attemptId: string): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      if (task.status !== 'claimed' || task.assigned_agent !== workerId || task.attempt_id !== attemptId) {
        throw new MeshError('TASK_STATE_INVALID', 'task is not claimed by this worker/attempt', {
          taskId,
          status: task.status,
          workerId,
          attemptId,
        });
      }
      const now = nowIso();
      const updated = this.#store.teamStore.updateTask({
        ...task,
        status: 'running',
        updated_at: now,
        revision: task.revision + 1,
        progress: { ...task.progress, startedAt: task.progress.startedAt ?? now },
      }, task.revision);
      this.#store.updateAttempt(attemptId, { status: 'running' });
      this.#store.updateTaskMeta(taskId, { remoteStatus: null, errorCode: null, errorMessage: null, updatedAt: now });
      this.#store.appendEvent('task', taskId, 'started', { workerId, attemptId });
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Extend a live claim lease.
   * @param taskId - task identity.
   * @param attemptId - attempt identity.
   * @param leaseMs - new lease lifetime.
   * @returns updated task view.
   */
  heartbeat(taskId: string, attemptId: string, leaseMs = this.#config.limits.taskLeaseMs): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      if (!ACTIVE.includes(task.status) || task.lease === null || task.attempt_id !== attemptId) {
        throw new MeshError('TASK_STATE_INVALID', 'task has no matching live lease', { taskId, attemptId });
      }
      const now = nowIso();
      const updated = this.#store.teamStore.updateTask({
        ...task,
        lease: { ...task.lease, expiresAt: isoFromMs(Date.now() + leaseMs) },
        updated_at: now,
        revision: task.revision + 1,
      }, task.revision);
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Complete a local/research task.
   * @param taskId - task identity.
   * @param attemptId - attempt identity.
   * @returns updated task.
   */
  succeed(taskId: string, attemptId: string): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      if (!ACTIVE.includes(task.status) || task.attempt_id !== attemptId) {
        throw new MeshError('TASK_STATE_INVALID', 'task is not running under this attempt', { taskId, attemptId });
      }
      const now = nowIso();
      const updated = this.#store.teamStore.updateTask({
        ...task,
        status: 'completed',
        assigned_agent: null,
        attempt_id: null,
        lease: null,
        failure_reason: null,
        updated_at: now,
        revision: task.revision + 1,
        progress: { ...task.progress, finishedAt: now },
      }, task.revision);
      this.#finishAttempt(attemptId, 'succeeded');
      this.#store.updateTaskMeta(taskId, { remoteStatus: null, errorCode: null, errorMessage: null, updatedAt: now });
      this.#store.appendEvent('task', taskId, 'succeeded', { attemptId });
      this.#clearCurrentTask(task.team_id, taskId);
      this.#refreshReadinessLocked(task.team_id);
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Record a failed execution.
   * @param taskId - task identity.
   * @param attemptId - attempt identity.
   * @param code - stable error code.
   * @param message - human-readable detail.
   * @param retryable - whether the scheduler may return it to the ready queue.
   * @returns updated task.
   */
  fail(taskId: string, attemptId: string, code: string, message: string, retryable = false): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      if (!ACTIVE.includes(task.status) || task.attempt_id !== attemptId) {
        throw new MeshError('TASK_STATE_INVALID', 'task is not running under this attempt', { taskId, attemptId });
      }
      const exhausted = task.attempt_count >= task.max_attempts;
      const now = nowIso();
      const status: ResearchTask['status'] = retryable && !exhausted ? 'ready' : 'failed';
      const updated = this.#store.teamStore.updateTask({
        ...task,
        status,
        assigned_agent: null,
        attempt_id: null,
        lease: null,
        failure_reason: message,
        updated_at: now,
        revision: task.revision + 1,
        progress: { ...task.progress, finishedAt: now },
      }, task.revision);
      this.#finishAttempt(attemptId, 'failed', code, message);
      this.#store.updateTaskMeta(taskId, {
        remoteStatus: null,
        errorCode: code,
        errorMessage: message,
        updatedAt: now,
      });
      this.#store.appendEvent('task', taskId, 'failed', { attemptId, code, retryable, exhausted });
      this.#clearCurrentTask(task.team_id, taskId);
      if (status === 'ready') this.#refreshReadinessLocked(task.team_id);
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Block a task on an external condition; it is not retried automatically.
   * @param taskId - task identity.
   * @param attemptId - attempt identity or null before a claim.
   * @param code - stable reason code.
   * @param message - detail.
   * @returns updated task.
   */
  block(taskId: string, attemptId: string | null, code: string, message: string): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new MeshError('TASK_STATE_INVALID', `task is ${task.status}`, { taskId, status: task.status });
      }
      if (attemptId !== null && task.attempt_id !== null && task.attempt_id !== attemptId) {
        throw new MeshError('TASK_STATE_INVALID', 'attempt does not own the task', { taskId, attemptId });
      }
      const now = nowIso();
      const updated = this.#store.teamStore.updateTask({
        ...task,
        status: 'blocked',
        assigned_agent: null,
        attempt_id: null,
        lease: null,
        failure_reason: message,
        updated_at: now,
        revision: task.revision + 1,
      }, task.revision);
      if (attemptId !== null) this.#finishAttempt(attemptId, 'blocked', code, message);
      this.#store.updateTaskMeta(taskId, { errorCode: code, errorMessage: message, updatedAt: now });
      this.#store.appendEvent('task', taskId, 'blocked', { code, message });
      this.#clearCurrentTask(task.team_id, taskId);
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Cancel a task that has not entered a remote execution.
   * @param taskId - task identity.
   * @param reason - audit reason.
   * @returns updated task.
   */
  cancel(taskId: string, reason: string): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      const meta = this.#requireMeta(taskId);
      if (!['pending', 'ready', 'blocked', 'claimed'].includes(task.status) || REMOTE_ACTIVE.includes(meta.remoteStatus ?? 'PENDING')) {
        throw new MeshError('TASK_STATE_INVALID', 'only tasks that have not started remote execution can be cancelled', {
          taskId,
          status: task.status,
          remoteStatus: meta.remoteStatus,
        });
      }
      const now = nowIso();
      const updated = this.#store.teamStore.updateTask({
        ...task,
        status: 'cancelled',
        assigned_agent: null,
        attempt_id: null,
        lease: null,
        failure_reason: reason,
        updated_at: now,
        revision: task.revision + 1,
      }, task.revision);
      if (task.attempt_id !== null) this.#finishAttempt(task.attempt_id, 'cancelled', 'CANCELLED', reason);
      this.#store.updateTaskMeta(taskId, { errorCode: 'CANCELLED', errorMessage: reason, updatedAt: now });
      this.#store.appendEvent('task', taskId, 'cancelled', { reason });
      this.#clearCurrentTask(task.team_id, taskId);
      this.#refreshReadinessLocked(task.team_id);
      return this.#view(updated, meta);
    });
  }

  /**
   * Explicitly retry a failed or blocked task. Attempts are extended only when
   * the operator asks for another attempt.
   * @param taskId - task identity.
   * @param options - reason and whether to extend exhausted attempts.
   * @returns updated task.
   */
  retry(taskId: string, options: { reason: string; extendAttempts?: boolean }): MeshTaskView {
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      if (task.status !== 'failed' && task.status !== 'blocked') {
        throw new MeshError('TASK_STATE_INVALID', 'only failed or blocked tasks can be retried', { taskId, status: task.status });
      }
      const meta = this.#requireMeta(taskId);
      if (meta.jobId !== null || meta.remoteStatus !== null) {
        throw new MeshError('TASK_STATE_INVALID', 'task has a remote job; reconcile or abandon it before retry', {
          taskId,
          jobId: meta.jobId,
          remoteStatus: meta.remoteStatus,
        });
      }
      const now = nowIso();
      const maxAttempts = options.extendAttempts === true && task.attempt_count >= task.max_attempts
        ? task.attempt_count + 1
        : task.max_attempts;
      const updated = this.#store.teamStore.updateTask({
        ...task,
        status: 'ready',
        max_attempts: maxAttempts,
        failure_reason: null,
        assigned_agent: null,
        attempt_id: null,
        lease: null,
        updated_at: now,
        revision: task.revision + 1,
      }, task.revision);
      this.#store.updateTaskMeta(taskId, { errorCode: null, errorMessage: null, remoteStatus: null, updatedAt: now });
      this.#store.appendEvent('task', taskId, 'retried', { reason: options.reason, maxAttempts });
      this.#clearCurrentTask(task.team_id, taskId);
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Record a remote lifecycle state. Execution success stops at
   * `ASSURANCE_PENDING`; this method never marks a scientific result.
   * @param taskId - task identity.
   * @param status - remote state.
   * @param options - job, GPU and error detail.
   * @returns updated task.
   */
  markRemote(
    taskId: string,
    status: MeshTaskStatus,
    options: {
      jobId?: string | null;
      gpuId?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ): MeshTaskView {
    if (!['SUBMITTED', 'RECONCILE_REQUIRED', 'OUTPUT_READY', 'INGESTED', 'ASSURANCE_PENDING', 'RUNNING'].includes(status)) {
      throw new MeshError('INVALID_ARGUMENT', `remote status ${status} is not a remote transition`, { status });
    }
    return this.#store.transaction(() => {
      const task = this.#requireTask(taskId);
      const now = nowIso();
      let updated = task;
      if (status === 'INGESTED' || status === 'ASSURANCE_PENDING') {
        if (task.status !== 'completed') {
          updated = this.#store.teamStore.updateTask({
            ...task,
            status: 'completed',
            assigned_agent: null,
            attempt_id: null,
            lease: null,
            failure_reason: null,
            updated_at: now,
            revision: task.revision + 1,
            progress: { ...task.progress, finishedAt: now },
          }, task.revision);
          if (task.attempt_id !== null) this.#finishAttempt(task.attempt_id, 'succeeded');
        }
        this.#clearCurrentTask(task.team_id, taskId);
        this.#refreshReadinessLocked(task.team_id);
      }
      this.#store.updateTaskMeta(taskId, {
        remoteStatus: status,
        ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
        ...(options.gpuId === undefined ? {} : { gpuId: options.gpuId }),
        ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
        ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
        updatedAt: now,
      });
      this.#store.appendEvent('task', taskId, 'remote-state', { status });
      return this.#view(updated, this.#requireMeta(taskId));
    });
  }

  /**
   * Recover tasks whose worker disappeared. Remote work is never resubmitted:
   * an expired remote task enters `RECONCILE_REQUIRED` and waits for an explicit
   * remote query.
   * @param nowMs - test clock override.
   * @returns recovery report.
   */
  recover(nowMs = Date.now()): SchedulerRecoveryReport {
    const reconciledRemote: string[] = [];
    const failedLocal: string[] = [];
    const untouched: string[] = [];
    this.#store.transaction(() => {
      for (const group of this.#store.listGroups()) {
        for (const task of this.#store.teamStore.listTasks(group.teamId)) {
          if (!ACTIVE.includes(task.status)) continue;
          const meta = this.#store.getTaskMeta(task.task_id);
          if (meta === undefined) continue;
          const expired = task.lease === null || Date.parse(task.lease.expiresAt) <= nowMs;
          if (!expired) {
            untouched.push(task.task_id);
            continue;
          }
          const remote = meta.jobId !== null || REMOTE_ACTIVE.includes(meta.remoteStatus ?? 'PENDING');
          if (remote) {
            this.#store.updateTaskMeta(task.task_id, {
              remoteStatus: 'RECONCILE_REQUIRED',
              errorCode: 'RECONCILE_REQUIRED',
              errorMessage: 'worker lease expired after remote submission; query the remote job before any retry',
              updatedAt: nowIso(),
            });
            this.#store.appendEvent('task', task.task_id, 'reconcile-required', { previousWorker: task.assigned_agent });
            reconciledRemote.push(task.task_id);
            continue;
          }
          const now = nowIso();
          this.#store.teamStore.updateTask({
            ...task,
            status: 'failed',
            assigned_agent: null,
            attempt_id: null,
            lease: null,
            failure_reason: 'worker lease expired before the task completed',
            updated_at: now,
            revision: task.revision + 1,
          }, task.revision);
          if (task.attempt_id !== null) this.#finishAttempt(task.attempt_id, 'failed', 'WORKER_LOST', 'worker lease expired');
          this.#store.updateTaskMeta(task.task_id, {
            remoteStatus: null,
            errorCode: 'WORKER_LOST',
            errorMessage: 'worker lease expired before the task completed',
            updatedAt: now,
          });
          this.#store.appendEvent('task', task.task_id, 'recovered-as-failed', { previousWorker: task.assigned_agent });
          this.#clearCurrentTask(group.teamId, task.task_id);
          failedLocal.push(task.task_id);
        }
      }
    });
    this.#logger.info('scheduler recovery complete', {
      reconciledRemote: reconciledRemote.length,
      failedLocal: failedLocal.length,
      untouched: untouched.length,
    });
    return { reconciledRemote, failedLocal, untouched };
  }

  /**
   * Recompute pending/ready from dependency completion.
   * @param teamId - optional group filter.
   */
  refreshReadiness(teamId?: string): void {
    this.#store.transaction(() => {
      if (teamId === undefined) {
        for (const group of this.#store.listGroups()) this.#refreshReadinessLocked(group.teamId);
      } else {
        this.#refreshReadinessLocked(teamId);
      }
    });
  }

  // -- internals -----------------------------------------------------------

  #claimLocked(task: ResearchTask, meta: MeshTaskMeta, workerId: string, nowMs: number, now: string): ClaimedTask {
    const attemptId = newId(ID_PREFIX.attempt);
    const expiresAt = isoFromMs(nowMs + this.#config.limits.taskLeaseMs);
    const claimed = this.#store.teamStore.claimTaskAtStatus(
      task.task_id,
      workerId,
      attemptId,
      task.revision,
      expiresAt,
      'claimed',
    );
    this.#store.insertAttempt({
      attemptId,
      taskId: task.task_id,
      attemptNo: claimed.attempt_count,
      workerId,
      status: 'claimed',
      startedAt: now,
    });
    this.#store.updateTaskMeta(task.task_id, {
      remoteStatus: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    });
    this.#store.updateGroup(task.team_id, { currentTaskId: task.task_id, updatedAt: now });
    this.#store.appendEvent('task', task.task_id, 'claimed', {
      workerId,
      attemptId,
      attemptNo: claimed.attempt_count,
      priority: meta.priority,
    });
    return {
      task: this.#view(claimed, this.#requireMeta(task.task_id)),
      workerId,
      attemptId,
      leaseExpiresAt: expiresAt,
    };
  }

  #clearCurrentTask(teamId: string, taskId: string): void {
    const group = this.#store.getGroup(teamId);
    if (group?.currentTaskId === taskId) this.#store.updateGroup(teamId, { currentTaskId: null, updatedAt: nowIso() });
  }

  #refreshReadinessLocked(teamId: string): void {
    const tasks = this.#store.teamStore.listTasks(teamId);
    for (const task of tasks) {
      if (task.status !== 'pending') continue;
      if (this.#blockingDependencies(task).length > 0) continue;
      this.#store.teamStore.updateTask({
        ...task,
        status: 'ready',
        updated_at: nowIso(),
        revision: task.revision + 1,
      }, task.revision);
    }
  }

  #blockingDependencies(task: ResearchTask): readonly string[] {
    return task.dependencies.filter(dependency => {
      const parent = this.#store.teamStore.getTask(dependency);
      return parent === undefined || (parent.status !== 'completed' && parent.status !== 'cancelled');
    });
  }

  #assertAcyclic(teamId: string, newTaskId: string, dependencies: readonly string[]): void {
    const graph = new Map<string, readonly string[]>();
    for (const task of this.#store.teamStore.listTasks(teamId)) graph.set(task.task_id, task.dependencies);
    graph.set(newTaskId, dependencies);
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string, path: readonly string[]): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        const cycle = [...path.slice(path.indexOf(id)), id];
        throw new MeshError('TASK_DEPENDENCY_CYCLE', `task dependency cycle: ${cycle.join(' -> ')}`, { teamId, cycle });
      }
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) visit(dependency, [...path, id]);
      visiting.delete(id);
      done.add(id);
    };
    visit(newTaskId, []);
  }

  #countActive(teamId?: string): number {
    let count = 0;
    for (const group of this.#store.listGroups()) {
      if (teamId !== undefined && group.teamId !== teamId) continue;
      count += this.#store.teamStore.listTasks(group.teamId).filter(task => ACTIVE.includes(task.status)).length;
    }
    return count;
  }

  #finishAttempt(attemptId: string, status: string, errorCode?: string, errorMessage?: string): void {
    const current = this.#store.read(db => db.prepare('SELECT attempt_id FROM mesh_attempts WHERE attempt_id = ?').get(attemptId));
    if (current === undefined) return;
    this.#store.updateAttempt(attemptId, {
      status,
      finishedAt: nowIso(),
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
    });
  }

  #requireTeam(teamId: string): TeamRecord {
    const team = this.#store.teamStore.getTeam(teamId);
    if (team === undefined) throw new MeshError('TEAM_NOT_FOUND', `unknown group ${teamId}`, { teamId });
    return team;
  }

  #requireTask(taskId: string): ResearchTask {
    const task = this.#store.teamStore.getTask(taskId);
    if (task === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown task ${taskId}`, { taskId });
    return task;
  }

  #requireMeta(taskId: string): MeshTaskMeta {
    const meta = this.#store.getTaskMeta(taskId);
    if (meta === undefined) throw new MeshError('STORAGE_ERROR', 'task exists without Mesh metadata', { taskId });
    return meta;
  }

  #view(task: ResearchTask, meta: MeshTaskMeta): MeshTaskView {
    return {
      taskId: task.task_id,
      projectId: meta.projectId,
      teamId: task.team_id,
      type: meta.taskType,
      status: mapStatus(task, meta),
      priority: meta.priority,
      title: task.title,
      objective: task.objective,
      role: task.role,
      dependencies: task.dependencies,
      workspaceId: meta.workspaceId,
      rsiStateVersion: meta.rsiStateVersion,
      receiptRef: meta.receiptRef,
      jobId: meta.jobId,
      gpuId: meta.gpuId,
      attemptId: task.attempt_id,
      attemptCount: task.attempt_count,
      maxAttempts: task.max_attempts,
      errorCode: meta.errorCode,
      errorMessage: meta.errorMessage,
      payload: parsePayload(meta.payloadJson),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    };
  }
}
