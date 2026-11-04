/**
 * Research task DAG with exclusive leases, dependency discipline and attempts.
 *
 * `TaskGraph` is the *only* place that mutates a task row. It sits directly on
 * the durable {@link TeamStore} primitives (`insertTask` / `claimTask` /
 * `releaseTask` / `updateTask`), which each enforce compare-and-set on the
 * task revision. That split matters:
 *
 * - the store guarantees **one writer wins** a contended claim, because the
 *   CAS lives in the same transaction as the row update;
 * - this module decides **whether the claim is legal at all** — role match,
 *   dependencies completed, attempts left.
 *
 * Two rules are load-bearing for the rest of the bridge:
 *
 * - **A dispatched task is not a finished task.** {@link TaskGraph.claim} only
 *   leases work; nothing is `completed` until {@link TaskGraph.complete} sees
 *   the owning agent's own call.
 * - **A release keeps the attempt history.** A dead agent's lease is dropped and
 *   `attempt_id` is cleared, because that field names the attempt currently in
 *   flight and none is; `attempt_count` survives, so a replacement is provably a
 *   *new* attempt on the same task rather than a silent replay.
 *
 * @module dsh-research-team-bridge/team/tasks
 */

import { RtbError } from '../errors.ts'
import { idempotencyKey, isoNow, newId, plusMs, type Clock, systemClock } from '../ids.ts'
import { roleProfile } from './roles.ts'
import { PermissionPolicy } from '../runtime/permissions.ts'
import type {
  AgentId, ArtifactRef, AttemptId, Budget, ResearchRole, ResearchTask, TaskDraft, TaskId, TaskQuery,
  TeamId, TeamStore, Timestamp,
} from '../types.ts'

/** How long one exclusive lease stays valid before `tick` may reclaim it. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000

/** Statuses a fresh task may hold, and that a claim will consider. */
/**
 * Statuses a claim will consider.
 *
 * `blocked` is deliberately absent: a reasoned release parks a task there so a
 * human sees why, and treating it as claimable re-dispatched it in the same tick.
 * A task whose dependencies are merely unfinished is `pending` and is filtered by
 * the dependency gate in {@link TaskGraph.nextActionable}.
 */
const CLAIMABLE: readonly ResearchTask['status'][] = ['pending', 'ready']

export interface TaskGraphOptions {
  readonly store: TeamStore
  readonly policy: PermissionPolicy
  readonly clock?: Clock
  /** Lease lifetime in milliseconds. Defaults to {@link DEFAULT_LEASE_MS}. */
  readonly leaseMs?: number
}

/**
 * The dependency-aware task graph of one or more teams.
 *
 * One instance serves every team; each method takes the `teamId` (directly, or
 * through the task row) and checks it against the durable member row.
 */
export class TaskGraph {
  readonly #store: TeamStore
  readonly #policy: PermissionPolicy
  readonly #clock: Clock
  readonly #leaseMs: number

  constructor(options: TaskGraphOptions) {
    this.#store = options.store
    this.#policy = options.policy
    this.#clock = options.clock ?? systemClock
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    if (!(this.#leaseMs > 0)) {
      throw new RtbError('CONFIG_INVALID', 'leaseMs must be > 0', { leaseMs: this.#leaseMs })
    }
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Create one task, or return the existing row when the draft carries an
   * idempotency key that was already used in this team.
   *
   * Only a member with `canDelegate` (the captain) may create tasks: a worker
   * cannot widen its own graph. Dependencies must already exist inside the same
   * team, which keeps the graph closed under its own ids.
   */
  create(teamId: TeamId, draft: TaskDraft, createdBy: AgentId): ResearchTask {
    this.#policy.assertCanDelegate(teamId, createdBy)
    const team = this.#policy.teamOf(teamId)

    const role = this.#assertRole(draft.role)
    const title = this.#assertText(draft.title, 'title')
    const objective = this.#assertText(draft.objective, 'objective')
    const dependencies = this.#assertDependencies(teamId, draft.dependencies ?? [])

    const key = draft.idempotencyKey
      ?? idempotencyKey(['task', teamId, role, title, objective, ...dependencies])
    const existing = this.#store.listTasks(teamId).find(task => task.idempotency_key === key)
    if (existing !== undefined) return existing

    const taskId = draft.taskId ?? newId('task', this.#clock)
    if (this.#store.getTask(taskId) !== undefined) {
      throw new RtbError('STORE_CONFLICT', `task ${taskId} already exists`, {
        code: 'DUPLICATE', entity: 'task', id: taskId,
      })
    }

    const now = isoNow(this.#clock)
    const budget: Budget = {
      ...team.budget,
      ...draft.budget,
    }
    const maxAttempts = draft.maxAttempts ?? budget.maxTaskAttempts
    if (!(maxAttempts > 0)) {
      throw new RtbError('CONFIG_INVALID', `task ${taskId} needs maxAttempts > 0`, { maxAttempts })
    }

    // The same check dependencies get: a parent from another team, or one that does
    // not exist, is a caller error rather than a dangling pointer nobody reads.
    if (draft.parentTaskId !== undefined && draft.parentTaskId !== null) {
      const parent = this.#store.getTask(draft.parentTaskId)
      if (parent === undefined) {
        throw new RtbError('TASK_NOT_FOUND', `parent task ${draft.parentTaskId} does not exist`, {
          taskId, parentTaskId: draft.parentTaskId,
        })
      }
      if (parent.team_id !== teamId) {
        throw new RtbError('PERMISSION_DENIED',
          `parent task ${draft.parentTaskId} belongs to team ${parent.team_id}, not ${teamId}`, {
            taskId, parentTaskId: draft.parentTaskId, parentTeamId: parent.team_id, teamId,
          })
      }
    }
    const task: ResearchTask = {
      task_id: taskId,
      team_id: teamId,
      parent_task_id: draft.parentTaskId ?? null,
      dependencies,
      role,
      title,
      objective,
      status: dependencies.length === 0 ? 'pending' : 'pending',
      assigned_agent: null,
      attempt_id: null,
      attempt_count: 0,
      max_attempts: maxAttempts,
      input_artifacts: draft.inputArtifacts ?? [],
      output_artifacts: [],
      budget,
      failure_reason: null,
      lease: null,
      research_route: draft.researchRoute ?? null,
      state_version: draft.stateVersion ?? team.stateVersionAtStart,
      created_at: now,
      updated_at: now,
      revision: 1,
      idempotency_key: key,
      progress: { startedAt: null, finishedAt: null, messages: 0, experimentRuns: 0 },
    }
    return this.#store.insertTask(task)
  }

  /** Read one task or fail with `TASK_NOT_FOUND`. */
  get(taskId: TaskId): ResearchTask {
    const task = this.#store.getTask(taskId)
    if (task === undefined) {
      throw new RtbError('TASK_NOT_FOUND', `unknown task ${taskId}`, { taskId })
    }
    return task
  }

  /** Read one task without throwing. */
  tryGet(taskId: TaskId): ResearchTask | undefined {
    return this.#store.getTask(taskId)
  }

  /** List a team's tasks, optionally filtered. */
  list(teamId: TeamId, query: TaskQuery = {}): readonly ResearchTask[] {
    return this.#store.listTasks(teamId, query)
  }

  // -------------------------------------------------------------------------
  // Claiming
  // -------------------------------------------------------------------------

  /**
   * Take the exclusive lease on a task.
   *
   * The checks run in cheapest-first order and none of them mutate the row:
   * a refused claim leaves the revision untouched, so a loser consumes neither
   * an attempt nor a revision.
   */
  claim(taskId: TaskId, agentId: AgentId): ResearchTask {
    const task = this.get(taskId)
    const member = this.#policy.memberOf(task.team_id, agentId)

    if (member.role !== task.role && member.role !== 'captain') {
      throw new RtbError('ROLE_MISMATCH', `role ${member.role} may not hold a ${task.role} task`, {
        taskId, teamId: task.team_id, agentId, taskRole: task.role, memberRole: member.role,
      })
    }

    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new RtbError('INVALID_TRANSITION', `task ${taskId} is ${task.status} and cannot be claimed`, {
        taskId, status: task.status,
      })
    }
    if (task.status === 'failed') {
      throw new RtbError('ATTEMPTS_EXHAUSTED', `task ${taskId} has failed permanently`, {
        taskId, attempts: task.attempt_count, maxAttempts: task.max_attempts,
      })
    }

    const unfinished = this.#blockingDependencies(task)
    if (unfinished.length > 0) {
      throw new RtbError('DEPENDENCIES_UNSATISFIED', `task ${taskId} waits on ${unfinished.join(', ')}`, {
        taskId, dependencies: task.dependencies, unfinished,
      })
    }

    // Exclusivity is absolute. Expiry is deliberately NOT consulted here: the
    // scheduler's `expireLeases` pass names expired leases and releases them, so one
    // place owns that decision and a claim never depends on wall-clock time.
    if (task.lease !== null && task.lease.owner !== agentId) {
      throw new RtbError('ALREADY_CLAIMED', `task ${taskId} is leased by ${task.lease.owner}`, {
        taskId, owner: task.lease.owner, agentId,
      })
    }

    if (task.attempt_count >= task.max_attempts) {
      throw new RtbError('ATTEMPTS_EXHAUSTED', `task ${taskId} used ${task.attempt_count} of ${task.max_attempts} attempts`, {
        taskId, attempts: task.attempt_count, maxAttempts: task.max_attempts,
      })
    }

    const attemptId: AttemptId = newId('attempt', this.#clock)
    const expiresAt = plusMs(isoNow(this.#clock), this.#leaseMs)
    return this.#store.claimTask(taskId, agentId, attemptId, task.revision, expiresAt)
  }

  // -------------------------------------------------------------------------
  // Completion and failure
  // -------------------------------------------------------------------------

  /**
   * Mark an owned task complete and attach its output artifacts.
   *
   * A second completion is an error, not a no-op: the caller is told the task
   * already finished instead of being allowed to believe its output counted
   * twice.
   */
  complete(taskId: TaskId, agentId: AgentId, outputs: readonly ArtifactRef[] = []): ResearchTask {
    const task = this.#requireOwner(taskId, agentId)
    if (task.status !== 'running' && task.status !== 'claimed') {
      throw new RtbError('INVALID_TRANSITION', `task ${taskId} is ${task.status} and cannot be completed`, {
        taskId, status: task.status,
      })
    }
    const now = isoNow(this.#clock)
    const next: ResearchTask = {
      ...task,
      status: 'completed',
      output_artifacts: [...outputs],
      failure_reason: null,
      lease: null,
      updated_at: now,
      revision: task.revision + 1,
      progress: { ...task.progress, finishedAt: now },
    }
    return this.#store.updateTask(next, task.revision)
  }

  /**
   * Release an owned lease.
   *
   * A reasoned release blocks the task (`blocked`) so the scheduler can see why
   * it stopped; a bare release returns it to `ready`. The attempt history is
   * preserved either way. Returns the updated row, or a no-op copy when the
   * task is already finished — recovery passes are idempotent.
   */
  release(taskId: TaskId, agentId: AgentId, reason: string | null): ResearchTask {
    const task = this.get(taskId)
    this.#assertMayAct(task, agentId)
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
      return task
    }
    if (task.lease === null && task.assigned_agent === null && task.status === 'pending') {
      return task
    }
    const now = isoNow(this.#clock)
    const next: ResearchTask = {
      ...task,
      status: reason === null ? 'ready' : 'blocked',
      assigned_agent: null,
      lease: null,
      // `attempt_id` names the in-flight attempt and is cleared here, matching the
      // store: the two layers used to disagree about the same release.
      attempt_id: null,
      failure_reason: reason,
      updated_at: now,
      revision: task.revision + 1,
    }
    return this.#store.updateTask(next, task.revision)
  }

  /**
   * Record a failed attempt.
   *
   * A retryable failure with attempts left returns the task to `pending` so the
   * scheduler can pick it up again; otherwise it becomes `failed` and stops
   * being actionable. Either way the reason is durable.
   */
  fail(taskId: TaskId, agentId: AgentId, reason: string, retryable: boolean): ResearchTask {
    const task = this.#requireOwner(taskId, agentId)
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new RtbError('INVALID_TRANSITION', `task ${taskId} is ${task.status} and cannot fail`, {
        taskId, status: task.status,
      })
    }
    const exhausted = task.attempt_count >= task.max_attempts
    const status: ResearchTask['status'] = retryable && !exhausted ? 'pending' : 'failed'
    const now = isoNow(this.#clock)
    const next: ResearchTask = {
      ...task,
      status,
      assigned_agent: null,
      lease: null,
      failure_reason: exhausted && retryable
        ? `${reason} (attempts exhausted: ${task.attempt_count}/${task.max_attempts})`
        : reason,
      updated_at: now,
      revision: task.revision + 1,
    }
    return this.#store.updateTask(next, task.revision)
  }

  // -------------------------------------------------------------------------
  // Scheduling support
  // -------------------------------------------------------------------------

  /**
   * Task ids whose lease has expired at `now`.
   *
   * This is a *read*: it names the leases a caller should reclaim, but does not
   * release them, so the caller can journal the reclaim before mutating.
   */
  expireLeases(now: Timestamp, teamId?: TeamId): readonly TaskId[] {
    const expired: TaskId[] = []
    // A scheduler round belongs to ONE team. Scanning every team made a tick for
    // team_a release team_b's running leases, and a foreign task with no owner then
    // threw NOT_THE_OWNER and aborted team_a's whole round.
    const teams = teamId === undefined
      ? this.#store.listTeams()
      : this.#store.listTeams().filter(team => team.teamId === teamId)
    for (const team of teams) {
      for (const task of this.#store.listTasks(team.teamId)) {
        if (task.lease === null) continue
        if (task.status !== 'running' && task.status !== 'claimed') continue
        if (Date.parse(task.lease.expiresAt) <= Date.parse(now)) expired.push(task.task_id)
      }
    }
    return expired.sort()
  }

  /**
   * Tasks a scheduler may dispatch now: claimable status, attempts left, and
   * every dependency already `completed`. Ordered oldest-first for fairness.
   */
  nextActionable(teamId: TeamId): readonly ResearchTask[] {
    return this.#store.listTasks(teamId)
      .filter(task => CLAIMABLE.includes(task.status))
      .filter(task => task.attempt_count < task.max_attempts)
      .filter(task => this.#blockingDependencies(task).length === 0)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id))
  }

  // -------------------------------------------------------------------------
  // Graph validation
  // -------------------------------------------------------------------------

  /**
   * Reject a dependency cycle in one team.
   *
   * Uses an iterative depth-first walk with a gray/black colouring so a long
   * chain cannot overflow the stack. A cycle is a structural defect in the
   * plan: it is never resolved by waiting.
   */
  assertAcyclic(teamId: TeamId): void {
    const tasks = new Map(this.#store.listTasks(teamId).map(task => [task.task_id, task]))
    const state = new Map<TaskId, 'visiting' | 'done'>()
    const path: TaskId[] = []

    for (const root of tasks.keys()) {
      if (state.get(root) === 'done') continue
      const stack: { id: TaskId; next: number }[] = [{ id: root, next: 0 }]
      state.set(root, 'visiting')
      path.push(root)

      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        const task = tasks.get(frame.id)
        const dependencies = task?.dependencies ?? []
        if (frame.next >= dependencies.length) {
          state.set(frame.id, 'done')
          stack.pop()
          path.pop()
          continue
        }
        const dependency = dependencies[frame.next]
        frame.next += 1
        const colour = state.get(dependency)
        if (colour === 'visiting') {
          const cycle = [...path.slice(path.indexOf(dependency)), dependency]
          throw new RtbError('DEPENDENCY_CYCLE', `task dependency cycle: ${cycle.join(' -> ')}`, {
            teamId, cycle,
          })
        }
        if (colour === 'done') continue
        state.set(dependency, 'visiting')
        path.push(dependency)
        stack.push({ id: dependency, next: 0 })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #assertRole(role: ResearchRole): ResearchRole {
    // `roleProfile` is the frozen catalog: an unknown role throws there.
    roleProfile(role)
    return role
  }

  #assertText(value: string, field: string): string {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed.length === 0) {
      throw new RtbError('SCHEMA_INVALID', `a task needs a non-empty ${field}`, { field })
    }
    return trimmed
  }

  #assertDependencies(teamId: TeamId, dependencies: readonly TaskId[]): readonly TaskId[] {
    const unique = [...new Set(dependencies)]
    for (const dependency of unique) {
      const task = this.#store.getTask(dependency)
      if (task === undefined || task.team_id !== teamId) {
        throw new RtbError('TASK_NOT_FOUND', `dependency ${dependency} is not a task of ${teamId}`, {
          teamId, dependency,
        })
      }
    }
    return unique
  }

  /** Dependencies that are not finished yet. Cancelled counts as finished. */
  #blockingDependencies(task: ResearchTask): readonly TaskId[] {
    const blocking: TaskId[] = []
    for (const dependency of task.dependencies) {
      const row = this.#store.getTask(dependency)
      if (row === undefined || (row.status !== 'completed' && row.status !== 'cancelled')) {
        blocking.push(dependency)
      }
    }
    return blocking
  }

  /** The caller must own the lease (or be the captain). */
  #requireOwner(taskId: TaskId, agentId: AgentId): ResearchTask {
    const task = this.get(taskId)
    this.#assertMayAct(task, agentId)
    return task
  }

  #assertMayAct(task: ResearchTask, agentId: AgentId): void {
    if (this.#policy.isCaptain(task.team_id, agentId)) return
    const owner = task.lease?.owner ?? task.assigned_agent
    if (owner !== agentId) {
      throw new RtbError('NOT_THE_OWNER', `agent ${agentId} does not hold task ${task.task_id}`, {
        taskId: task.task_id, agentId, owner,
      })
    }
  }
}
