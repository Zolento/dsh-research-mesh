/**
 * Durable recovery for an interrupted team run.
 *
 * Recovery is the one place where guessing is cheaper than thinking and far more
 * expensive than failing, so the rules here are deliberately asymmetric:
 *
 * - **An experiment is never restarted.** A `start_experiment` intent with no
 *   result is either *verified* (a real `experiment_result` artifact with
 *   recorded provenance exists) or *abandoned* with a stated reason. Re-running
 *   it could silently duplicate a real experiment, which is worse than holding.
 * - **A message may be redelivered** because delivery is idempotent, but only
 *   while it has not been handed to the transport yet (`pending`/`routed`) and
 *   only up to the policy's retry budget. A sibling delivery that travelled by
 *   captain relay is never forged by recovery.
 * - **A lease whose owner is gone is released and the task requeued**, but only
 *   after the lease is confirmed unchanged inside a compare-and-set.
 * - **Anything unresolved is a HOLD.** `RecoveryReport.held` is the honest
 *   signal a caller must surface; it is never set to `false` to look healthy.
 *
 * `inspect()` is strictly read-only: it calls no store mutation and no transport
 * method that changes state. `resume()` executes the plan it just built and
 * reports exactly what it did.
 *
 * @module dsh-research-team-bridge/runtime/recovery
 */

import { RtbError, RtbHold } from '../errors.ts'
import { systemClock } from '../ids.ts'
import type { Clock } from '../ids.ts'
import type {
  ActionId, AgentId, MessageId, RecoveryDecision, RecoveryReport, ResearchArtifact, ResearchTask, TaskId,
  TeamAction, TeamId, TeamMember, TeamMessage, TeamRecord, TeamRunState, TeamStore, TeamTransport, Timestamp,
} from '../types.ts'

/** Caller-tunable part of recovery. Everything else is a rule, not a knob. */
export interface RecoveryPolicy {
  /**
   * Maximum recovery retries for one unresolved action or message.
   * Defaults to 1: recovery redelivers a message at most once.
   */
  readonly maxRetries?: number
  /** Whether an undelivered (`pending`/`routed`) message may be redelivered. Defaults to true. */
  readonly redeliverMessages?: boolean
}

export interface TeamRecoveryOptions {
  readonly store: TeamStore
  readonly transport: TeamTransport
  readonly clock?: Clock
  readonly policy?: RecoveryPolicy
}

/** One journal intent with no definitive result. */
interface UnsettledIntent {
  readonly actionId: ActionId
  readonly action: TeamAction
  readonly taskId: TaskId | null
  readonly attemptId: string | null
  readonly payload: Readonly<Record<string, unknown>>
}

/** A lease that should not survive the restart, with the reason it is stale. */
interface StaleLease {
  readonly task: ResearchTask
  readonly reason: string
}

/** A message recovery intends to hand to the transport. */
interface PlannedDelivery {
  readonly message: TeamMessage
  readonly reason: string
}

/** A member session recovery intends to re-establish. */
interface PlannedResume {
  readonly actionId: ActionId
  readonly action: TeamAction
  readonly agentId: AgentId
  readonly parentAgentId: AgentId
}

interface RecoveryPlan {
  readonly team: TeamRecord
  readonly decisions: readonly RecoveryDecision[]
  readonly notes: readonly string[]
  readonly held: boolean
  readonly staleLeases: readonly StaleLease[]
  readonly deliveries: readonly PlannedDelivery[]
  readonly resumes: readonly PlannedResume[]
  readonly unsettled: readonly UnsettledIntent[]
  /** True when the team is not `active`, in which case nothing may be resumed. */
  readonly dormant: boolean
}

const DEFAULT_MAX_RETRIES = 1

/** The `retry` actions {@link TeamRecovery.resume} executes rather than advises. */
const EXECUTED_RETRY_ACTIONS: ReadonlySet<TeamAction> = new Set([
  'release_task', 'spawn_agent', 'resume_agent', 'send_message',
])
/** Delivery states that have not reached the transport yet and may be re-sent. */
const UNDELIVERED_STATUSES: readonly TeamMessage['delivery_status'][] = ['pending', 'routed']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the first non-empty string among `keys`. */
function pickString(payload: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const first = value.find(entry => typeof entry === 'string' && entry.length > 0)
      if (typeof first === 'string') return first
    }
  }
  return null
}

/** Artifact paths recorded on an `experiment_finding` message, if any. */
function findingPaths(message: TeamMessage): readonly string[] {
  if (message.message_type !== 'experiment_finding') return []
  const payload = message.payload as { readonly artifactPaths?: unknown }
  const paths = payload.artifactPaths
  return Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

/**
 * A staged experiment artifact counts as evidence of a real run only when it is
 * an `experiment_result` that was executed and carries a traceable source. A
 * reasoning-only artifact must not stop recovery, and must not restart it either.
 */
function executedExperiment(artifact: ResearchArtifact): boolean {
  return artifact.kind === 'experiment_result'
    && artifact.provenance.executed === true
    && (artifact.provenance.sources.length > 0 || artifact.evidence_refs.length > 0)
}

/**
 * Recover a team run that may have been interrupted mid-action.
 *
 * The class is stateless between calls: every decision is derived from the
 * durable rows, so `inspect()` before a restart and `inspect()` after one agree.
 */
export class TeamRecovery {
  readonly #store: TeamStore
  readonly #transport: TeamTransport
  readonly #clock: Clock
  readonly #maxRetries: number
  readonly #redeliverMessages: boolean

  constructor(options: TeamRecoveryOptions) {
    if (options?.store === undefined) throw new RtbError('CONFIG_INVALID', 'TeamRecovery requires a store')
    if (options?.transport === undefined) throw new RtbError('CONFIG_INVALID', 'TeamRecovery requires a transport')
    this.#store = options.store
    this.#transport = options.transport
    this.#clock = options.clock ?? systemClock
    const maxRetries = options.policy?.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RtbError('CONFIG_INVALID', `policy.maxRetries must be a non-negative integer, received ${String(maxRetries)}`, {
        field: 'maxRetries',
      })
    }
    this.#maxRetries = maxRetries
    this.#redeliverMessages = options.policy?.redeliverMessages ?? true
  }

  /** Read-only plan. Nothing is written, nothing is sent. */
  async inspect(teamId: TeamId): Promise<RecoveryReport> {
    const plan = this.#plan(teamId)
    return {
      teamId,
      decisions: plan.decisions,
      resumedAgents: [],
      redeliveredMessages: plan.deliveries.map(delivery => delivery.message.message_id),
      requeuedTasks: plan.staleLeases.map(lease => lease.task.task_id),
      held: plan.held,
      notes: [...plan.notes, 'inspect() is a plan only: nothing was written, sent or resumed'],
    }
  }

  /** Execute the plan produced by {@link inspect} and report exactly what happened. */
  async resume(teamId: TeamId): Promise<RecoveryReport> {
    const plan = this.#plan(teamId)
    const notes = [...plan.notes]
    let held = plan.held

    if (plan.dormant) {
      notes.push(
        `team status is '${plan.team.status}': recovery refuses to resume work for a team that is not active`,
      )
      return {
        teamId,
        decisions: plan.decisions,
        resumedAgents: [],
        redeliveredMessages: [],
        requeuedTasks: [],
        held: true,
        notes,
      }
    }

    const requeuedTasks = this.#releaseStaleLeases(plan, notes)
    if (requeuedTasks.held) held = true

    // A `release_task` intent is replayed here rather than merely recommended. It is
    // the one retry recovery can execute safely and it is idempotent, so leaving it
    // as advice with held=false reported a release that never happened.
    const replayed = this.#replayReleases(plan, notes)
    requeuedTasks.tasks.push(...replayed.tasks)
    if (replayed.held) held = true

    const resumedAgents = await this.#resumeAgents(plan, notes)
    if (resumedAgents.held) held = true

    const redeliveredMessages = await this.#redeliver(plan, notes)
    if (redeliveredMessages.held) held = true

    // Advisory decisions never execute here: the caller has to act on them, and
    // silence would be a silent success. That includes a `retry` recovery could not
    // carry out, which is why the hold is raised rather than only noted.
    for (const decision of plan.decisions) {
      if (decision.decision === 'verify_then_retry' || decision.decision === 'abandon') {
        notes.push(`action ${decision.actionId} (${decision.action}) is ${decision.decision}: no automatic execution was attempted`)
        continue
      }
      if (decision.decision !== 'retry') continue
      // The retries recovery actually performs: a resumed worker, a redelivered
      // message, and (below) a replayed release. Anything else claiming `retry` is
      // advice the caller has to act on, so it must raise the hold.
      if (EXECUTED_RETRY_ACTIONS.has(decision.action)) continue
      held = true
      notes.push(`action ${decision.actionId} (${decision.action}) is ${decision.decision} but recovery cannot replay it: `
        + 'it must be reissued deliberately, so this is a HOLD')
    }

    return {
      teamId,
      decisions: plan.decisions,
      resumedAgents: resumedAgents.agents,
      redeliveredMessages: redeliveredMessages.messages,
      requeuedTasks: requeuedTasks.tasks,
      held,
      notes,
    }
  }

  // -- planning ------------------------------------------------------------

  #plan(teamId: TeamId): RecoveryPlan {
    const team = this.#store.getTeam(teamId)
    if (team === undefined) {
      throw new RtbError('TEAM_NOT_FOUND', `no team ${teamId} in the store`, { teamId })
    }
    const runState = this.#store.getRunState(teamId)
    const decisions: RecoveryDecision[] = []
    const notes: string[] = []
    let held = false

    const unsettled = this.#unsettledIntents(teamId, notes)
    for (const intent of unsettled) {
      const outcome = this.#decide(intent, team, runState)
      decisions.push(outcome.decision)
      notes.push(`action ${intent.actionId} (${intent.action}): ${outcome.decision.decision} — ${outcome.decision.reason}`)
      if (outcome.held) held = true
    }

    // Run-state pointers that have no journal row would be invisible above.
    for (const actionId of runState?.pendingActionIds ?? []) {
      if (!unsettled.some(intent => intent.actionId === actionId)) {
        held = true
        notes.push(`run state lists pending action ${actionId} with no journal intent: refusing to guess what it was`)
      }
    }

    const staleLeases = this.#staleLeases(team, notes)
    const deliveries = this.#plannedDeliveries(teamId, runState, unsettled, notes, decisions)
    const resumes = this.#plannedResumes(unsettled)
    const dormant = team.status !== 'active'
    if (dormant) notes.push(`team status is '${team.status}'; the plan is advisory until the team is active again`)

    return { team, decisions, notes, held, staleLeases, deliveries, resumes, unsettled, dormant }
  }

  /** Journal intents with no result, or with only an `unknown` result. */
  #unsettledIntents(teamId: TeamId, notes: string[]): readonly UnsettledIntent[] {
    const entries = this.#store.listJournal(teamId)
    const results = new Map<ActionId, string[]>()
    const intents: UnsettledIntent[] = []
    for (const entry of entries) {
      if (entry.kind === 'result') {
        const bucket = results.get(entry.action_id) ?? []
        bucket.push(entry.outcome ?? 'unknown')
        results.set(entry.action_id, bucket)
      } else {
        intents.push({
          actionId: entry.action_id,
          action: entry.action,
          taskId: entry.task_id,
          attemptId: entry.attempt_id,
          payload: entry.payload,
        })
      }
    }
    const unsettled: UnsettledIntent[] = []
    for (const intent of intents) {
      const outcomes = results.get(intent.actionId) ?? []
      if (outcomes.length === 0) {
        unsettled.push(intent)
        continue
      }
      if (outcomes.every(outcome => outcome === 'unknown')) {
        unsettled.push(intent)
        notes.push(`action ${intent.actionId} recorded only an 'unknown' outcome: treated as unsettled`)
      }
    }
    return unsettled
  }

  #decide(intent: UnsettledIntent, team: TeamRecord, runState: TeamRunState | undefined): { decision: RecoveryDecision; held: boolean } {
    const decide = (
      decision: RecoveryDecision['decision'],
      reason: string,
      hold: boolean,
    ): { decision: RecoveryDecision; held: boolean } => ({
      decision: { actionId: intent.actionId, action: intent.action, decision, reason },
      held: hold,
    })

    switch (intent.action) {
      case 'start_experiment':
        return this.#decideExperiment(intent, team, decide)
      case 'send_message':
        return this.#decideMessage(intent, decide)
      case 'spawn_agent':
      case 'resume_agent': {
        const agentId = pickString(intent.payload, 'agentId', 'agent_id', 'childAgentId')
        if (agentId === null) {
          return decide('abandon', 'intent carries no agent id, so the durable member row cannot be checked', true)
        }
        const member = this.#store.getMember(team.teamId, agentId)
        if (member !== undefined) {
          return decide('retry', `member ${agentId} still exists (status ${member.status}); re-establish that session, never create a second child`, false)
        }
        return decide(
          'abandon',
          `no durable member row for ${agentId}: an orphan session may exist, so recovery will not spawn or resume anything`,
          true,
        )
      }
      case 'commit_state': {
        const base = pickString(intent.payload, 'baseStateVersion', 'stateVersion', 'state_version')
        const current = runState?.currentStateVersion ?? null
        if (base !== null && current !== null && current !== base) {
          return decide('skip', `canonical state moved from ${base} to ${current}: the commit most likely landed, so it is not repeated`, false)
        }
        return decide(
          'verify_then_retry',
          'cannot prove whether the canonical commit landed; the state gate must verify before any retry, and recovery never writes state itself',
          true,
        )
      }
      case 'release_task': {
        const taskId = pickString(intent.payload, 'taskId', 'task_id') ?? intent.taskId
        if (taskId === null) return decide('abandon', 'release_task intent carries no task id', true)
        const task = this.#store.getTask(taskId)
        if (task === undefined) return decide('abandon', `task ${taskId} no longer exists`, true)
        if (task.lease === null) return decide('skip', `task ${taskId} has no lease left: it was already released`, false)
        return decide('retry', `task ${taskId} is still leased by ${task.lease.owner}: the release is idempotent and may be replayed`, false)
      }
      case 'consolidate_memory':
        // Recovery has no way to replay a consolidation, and reporting `retry` with
        // held=false claimed a replay that never happened.
        return decide(
          'retry',
          'memory consolidation is keyed by its idempotency key, but recovery cannot replay it: the action must be reissued deliberately',
          true,
        )
      case 'interrupt_agent':
        return decide(
          'verify_then_retry',
          'a replayed interrupt could abort a turn started after the crash; verify with the member before retrying',
          true,
        )
      case 'dispose_team':
        return decide(
          'skip',
          `team teardown was in flight; recovery does not resurrect a disposing team (status ${team.status})`,
          team.status === 'active',
        )
      default:
        return decide('abandon', `unrecognised action ${String(intent.action)} in the journal`, true)
    }
  }

  #decideExperiment(
    intent: UnsettledIntent,
    team: TeamRecord,
    decide: (decision: RecoveryDecision['decision'], reason: string, hold: boolean) => { decision: RecoveryDecision; held: boolean },
  ): { decision: RecoveryDecision; held: boolean } {
    const evidence = this.#experimentEvidence(team.teamId, intent)
    if (evidence !== null) {
      return decide(
        'verify_then_retry',
        `real experiment evidence already exists (${evidence}); the experiment is NOT restarted — the recorded result must be verified instead`,
        false,
      )
    }
    return decide(
      'abandon',
      'the outcome of start_experiment is unknown and no executed experiment_result artifact exists; an automatic restart could duplicate a real experiment, so it is forbidden',
      true,
    )
  }

  /** Existing proof that the experiment ran: an executed artifact or real finding paths. */
  #experimentEvidence(teamId: TeamId, intent: UnsettledIntent): string | null {
    const taskId = intent.taskId ?? pickString(intent.payload, 'taskId', 'task_id')
    // Without a task id the search degenerates into "any executed experiment_result
    // in this team", and an unrelated result then read as proof that THIS experiment
    // landed. An unscoped intent therefore has no evidence, which is a HOLD.
    if (taskId === null) return null
    const attemptId = intent.attemptId ?? pickString(intent.payload, 'attemptId', 'attempt_id')
    const found: string[] = []
    for (const artifact of this.#store.listArtifacts(teamId, { taskId })) {
      if (!executedExperiment(artifact)) continue
      // A different attempt of the same task is a different experiment.
      if (attemptId !== null && artifact.attempt_id !== attemptId) continue
      found.push(`artifact ${artifact.artifact_id}`)
    }
    for (const message of this.#store.listMessages(teamId, { taskId })) {
      if (findingPaths(message).length > 0) found.push(`finding ${message.message_id} → ${findingPaths(message).join(', ')}`)
    }
    return found.length === 0 ? null : found.join('; ')
  }

  #decideMessage(
    intent: UnsettledIntent,
    decide: (decision: RecoveryDecision['decision'], reason: string, hold: boolean) => { decision: RecoveryDecision; held: boolean },
  ): { decision: RecoveryDecision; held: boolean } {
    if (!this.#redeliverMessages) {
      return decide('skip', 'policy.redeliverMessages is false: message redelivery is disabled by the caller', false)
    }
    const messageId = pickString(intent.payload, 'messageId', 'message_id', 'messageIds')
    if (messageId === null) return decide('abandon', 'send_message intent carries no message id', true)
    const message = this.#store.getMessage(messageId)
    if (message === undefined) {
      return decide('abandon', `message ${messageId} is not in the ledger: delivery cannot be verified`, true)
    }
    if (message.delivery_status === 'acknowledged') {
      return decide('skip', `message ${messageId} is already acknowledged`, false)
    }
    if (['failed', 'dead_letter', 'rejected'].includes(message.delivery_status)) {
      return decide('skip', `message ${messageId} is '${message.delivery_status}': recovery does not resurrect a dead letter`, false)
    }
    if (message.attempt >= this.#maxRetries) {
      // The retry budget is checked before the delivered reason: once recovery
      // has spent its retries, "the budget is exhausted" is the honest answer,
      // even when the last attempt did land.
      return decide('skip', `message ${messageId} already consumed ${message.attempt} recovery retries (maxRetries=${this.#maxRetries})`, false)
    }
    if (message.delivery_status === 'delivered') {
      return decide(
        'skip',
        `message ${messageId} was already handed to the transport; re-sending could duplicate the work, so only an explicit retry policy may resend it`,
        false,
      )
    }
    return decide('retry', `message ${messageId} is '${message.delivery_status}' and delivery is idempotent`, false)
  }

  /** Leases whose owner is gone or whose deadline passed. Read-only. */
  #staleLeases(team: TeamRecord, notes: string[]): readonly StaleLease[] {
    const now = this.#clock.now().toISOString()
    const stale: StaleLease[] = []
    for (const task of this.#store.listTasks(team.teamId, { status: ['claimed', 'running'] })) {
      if (task.lease === null) continue
      const reason = this.#leaseIsStale(team, task, now)
      if (reason === null) continue
      stale.push({ task, reason })
      notes.push(`task ${task.task_id}: lease held by ${task.lease.owner} is stale (${reason}); it will be released and requeued`)
    }
    return stale
  }

  #leaseIsStale(team: TeamRecord, task: ResearchTask, now: Timestamp): string | null {
    const lease = task.lease
    if (lease === null) return null
    if (new Date(lease.expiresAt).getTime() <= new Date(now).getTime()) {
      return `lease expired at ${lease.expiresAt}`
    }
    const member: TeamMember | undefined = this.#store.getMember(team.teamId, lease.owner)
    if (member === undefined) return `owner ${lease.owner} has no durable member row`
    if (member.status === 'failed' || member.status === 'disposed') return `owner ${lease.owner} is ${member.status}`
    // The captain is the root session: it is not a transport child, so a
    // child-centric residency probe must not be used to requeue its own lease.
    if (lease.owner !== team.captainAgentId && !this.#transport.isResident(lease.owner)) {
      return `owner ${lease.owner} is not resident`
    }
    return null
  }

  /** Messages recovery may hand to the transport, from the journal and the run state. */
  #plannedDeliveries(
    teamId: TeamId,
    runState: TeamRunState | undefined,
    unsettled: readonly UnsettledIntent[],
    notes: string[],
    decisions: RecoveryDecision[],
  ): readonly PlannedDelivery[] {
    if (!this.#redeliverMessages) return []
    const candidates = new Map<MessageId, string>()
    for (const message of this.#store.listMessages(teamId)) {
      if (UNDELIVERED_STATUSES.includes(message.delivery_status)) {
        candidates.set(message.message_id, `delivery_status is '${message.delivery_status}'`)
      }
    }
    for (const messageId of runState?.unacknowledgedMessageIds ?? []) {
      if (candidates.has(messageId)) continue
      const message = this.#store.getMessage(messageId)
      if (message === undefined) {
        notes.push(`run state lists unacknowledged message ${messageId} that is not in the ledger: held`)
        continue
      }
      if (message.delivery_status === 'acknowledged') continue
      candidates.set(message.message_id, `run state marks ${message.message_id} unacknowledged`)
      if (!UNDELIVERED_STATUSES.includes(message.delivery_status)) {
        notes.push(
          `message ${message.message_id} is '${message.delivery_status}' but still unacknowledged: recovery will not resend it, an explicit retry must decide`,
        )
      }
    }

    const planned: PlannedDelivery[] = []
    for (const [messageId, reason] of candidates) {
      const message = this.#store.getMessage(messageId)
      if (message === undefined) continue
      if (!UNDELIVERED_STATUSES.includes(message.delivery_status)) continue
      if (message.attempt >= this.#maxRetries) {
        notes.push(`message ${messageId} already consumed ${message.attempt} recovery retries (maxRetries=${this.#maxRetries})`)
        continue
      }
      if (message.routing.via === 'captain_relay') {
        const holdReason = `message ${messageId} travelled by captain relay; recovery will not forge a sibling delivery, the captain must relay it again`
        notes.push(holdReason)
        decisions.push({ actionId: `delivery:${messageId}`, action: 'send_message', decision: 'verify_then_retry', reason: holdReason })
        continue
      }
      planned.push({ message, reason })
    }

    // Keep the journal's own decision visible even when the message is not resent.
    for (const intent of unsettled) {
      if (intent.action !== 'send_message') continue
      const messageId = pickString(intent.payload, 'messageId', 'message_id', 'messageIds')
      if (messageId !== null && !planned.some(delivery => delivery.message.message_id === messageId)) {
        notes.push(`action ${intent.actionId} targets message ${messageId}, which recovery will not resend (see notes above)`)
      }
    }
    return planned
  }

  #plannedResumes(unsettled: readonly UnsettledIntent[]): readonly PlannedResume[] {
    const planned: PlannedResume[] = []
    for (const intent of unsettled) {
      if (intent.action !== 'spawn_agent' && intent.action !== 'resume_agent') continue
      const agentId = pickString(intent.payload, 'agentId', 'agent_id', 'childAgentId')
      if (agentId === null) continue
      const parentAgentId = pickString(intent.payload, 'parentAgentId', 'parent_agent_id')
      planned.push({ actionId: intent.actionId, action: intent.action, agentId, parentAgentId: parentAgentId ?? '' })
    }
    return planned
  }

  // -- execution -----------------------------------------------------------

  #releaseStaleLeases(plan: RecoveryPlan, notes: string[]): { tasks: TaskId[]; held: boolean } {
    const tasks: TaskId[] = []
    let held = false
    for (const stale of plan.staleLeases) {
      // Re-read: the plan may be older than the state we are about to change.
      const current = this.#store.getTask(stale.task.task_id)
      if (current === undefined) {
        notes.push(`task ${stale.task.task_id} disappeared before its lease could be released`)
        continue
      }
      if (current.lease === null) {
        notes.push(`task ${stale.task.task_id} was already released`)
        continue
      }
      if (current.lease.owner !== stale.task.lease?.owner || current.lease.attemptId !== stale.task.lease?.attemptId) {
        notes.push(`task ${stale.task.task_id} lease changed during recovery; refusing to release a lease we did not inspect`)
        held = true
        continue
      }
      try {
        const released = this.#store.releaseTask(current.task_id, current.revision, null)
        tasks.push(released.task_id)
        notes.push(`task ${released.task_id} released (${stale.reason}) and requeued as '${released.status}'`)
      } catch (error) {
        held = true
        notes.push(`task ${stale.task.task_id} lease release failed: ${messageOf(error)}`)
      }
    }
    return { tasks, held }
  }

  async #resumeAgents(plan: RecoveryPlan, notes: string[]): Promise<{ agents: AgentId[]; held: boolean }> {
    const agents: AgentId[] = []
    let held = false
    if (plan.resumes.length === 0) return { agents, held }
    if (plan.dormant) return { agents, held }
    if (!this.#transport.capabilities.coldResume) {
      notes.push(
        `transport '${this.#transport.capabilities.kind}' cannot cold-resume; ${plan.resumes.length} member(s) stay unresolved and are held`,
      )
      return { agents, held: true }
    }
    const controller = new AbortController()
    for (const resume of plan.resumes) {
      const member = this.#store.getMember(plan.team.teamId, resume.agentId)
      if (member === undefined) {
        held = true
        notes.push(`action ${resume.actionId}: member ${resume.agentId} vanished before it could be resumed`)
        continue
      }
      if (this.#transport.isResident(resume.agentId)) {
        notes.push(`action ${resume.actionId}: member ${resume.agentId} is already resident; no resume was issued`)
        continue
      }
      const parentAgentId = resume.parentAgentId.length > 0
        ? resume.parentAgentId
        : member.parentAgentId ?? plan.team.captainAgentId
      try {
        const started = await this.#transport.resumeWorker(resume.agentId, parentAgentId, controller.signal)
        agents.push(started.agentId)
        notes.push(`action ${resume.actionId}: resumed member ${started.agentId} under ${parentAgentId}`)
      } catch (error) {
        held = true
        notes.push(`action ${resume.actionId}: resuming ${resume.agentId} failed (${messageOf(error)}); the member row is kept for a later attempt`)
      }
    }
    return { agents, held }
  }

  /**
   * Replay a `release_task` intent that recovery can carry out itself.
   *
   * It is the one retry recovery executes rather than only recommending, because it
   * is genuinely idempotent: the task either still holds a lease or it does not. The
   * task row is re-read and released with a compare-and-set, so a concurrent release
   * wins instead of being clobbered.
   */
  #replayReleases(plan: RecoveryPlan, notes: string[]): { tasks: TaskId[]; held: boolean } {
    const tasks: TaskId[] = []
    let held = false
    for (const decision of plan.decisions) {
      if (decision.action !== 'release_task' || decision.decision !== 'retry') continue
      const intent = this.#store.findJournalByActionId(decision.actionId)
      const taskId = intent === undefined
        ? null
        : pickString(intent.payload, 'taskId', 'task_id') ?? intent.task_id
      if (taskId === null) {
        held = true
        notes.push(`action ${decision.actionId}: release_task intent carries no task id, so the release could not be replayed`)
        continue
      }
      const task = this.#store.getTask(taskId)
      if (task === undefined) {
        notes.push(`action ${decision.actionId}: task ${taskId} no longer exists; nothing to release`)
        continue
      }
      if (task.lease === null) {
        notes.push(`action ${decision.actionId}: task ${taskId} has no lease left; the release already landed`)
        continue
      }
      try {
        this.#store.releaseTask(taskId, task.revision, 'recovery replayed the release intent')
        tasks.push(taskId)
        notes.push(`action ${decision.actionId}: replayed the release of ${taskId} (was leased by ${task.lease.owner})`)
      } catch (error) {
        held = true
        notes.push(`action ${decision.actionId}: releasing ${taskId} failed (${messageOf(error)}); it stays leased for a later attempt`)
      }
    }
    return { tasks, held }
  }

  async #redeliver(plan: RecoveryPlan, notes: string[]): Promise<{ messages: MessageId[]; held: boolean }> {
    const messages: MessageId[] = []
    let held = false
    if (plan.deliveries.length === 0) return { messages, held }
    const controller = new AbortController()
    for (const delivery of plan.deliveries) {
      const message = delivery.message
      const text = this.#envelope(message)
      let receipt
      try {
        receipt = await this.#transport.sendAdjacent(
          message.sender_agent_id,
          message.recipient_agent_id,
          text,
          controller.signal,
        )
      } catch (error) {
        held = true
        notes.push(`message ${message.message_id} redelivery threw (${messageOf(error)}); it stays '${message.delivery_status}'`)
        continue
      }
      if (receipt.outcome === 'rejected') {
        // The attempt is consumed even though it failed, or a permanently rejected
        // message is retried on every recovery run forever.
        const nextAttempt = message.attempt + 1
        try {
          this.#store.updateMessage(message.message_id, message.revision, {
            delivery_status: nextAttempt >= this.#maxRetries ? 'dead_letter' : 'failed',
            attempt: nextAttempt,
            failure_reason: `recovery redelivery rejected: ${receipt.error ?? receipt.code ?? 'no reason given'}`,
          })
        } catch (error) {
          notes.push(`message ${message.message_id} was rejected and its attempt could not be recorded (${messageOf(error)})`)
        }
        held = true
        notes.push(`message ${message.message_id} redelivery was rejected (${receipt.error ?? receipt.code ?? 'no reason given'}); `
          + `attempt ${String(nextAttempt)} of ${String(this.#maxRetries)} consumed, not silently retried`)
        continue
      }
      // `queued` means the transport took the message but nothing has confirmed the
      // target recorded it, so `routed` is the honest state and a later run may retry
      // an unconfirmed handoff. It is not a duplicate: DeliveryOutcome has no such
      // value, and the transport's own queue is the thing that would dedupe.
      const status = receipt.outcome === 'accepted' ? 'delivered' : 'routed'
      try {
        const updated = this.#store.updateMessage(message.message_id, message.revision, {
          delivery_status: status,
          attempt: message.attempt + 1,
          routing: {
            via: 'parent_child_direct',
            hops: message.routing.hops + 1,
            path: [...message.routing.path, message.recipient_agent_id],
            dsh_message_id: receipt.dshMessageId,
          },
        })
        messages.push(updated.message_id)
        notes.push(`message ${updated.message_id} redelivered once as '${updated.delivery_status}' (attempt ${updated.attempt}; ${delivery.reason})`)
      } catch (error) {
        held = true
        notes.push(
          `message ${message.message_id} was delivered but its delivery state could not be recorded (${messageOf(error)}): the ledger is behind reality`,
        )
      }
    }
    return { messages, held }
  }

  /** Compact machine-readable header plus the stored summary, never chat history. */
  #envelope(message: TeamMessage): string {
    const task = message.task_id ?? '-'
    const state = message.state_version ?? '-'
    return `[rtb team=${message.team_id} msg=${message.message_id} type=${message.message_type} trust=${message.trust} task=${task} state=${state}] ${message.summary}`
  }
}

/**
 * Refuse to continue when recovery could not resolve everything.
 *
 * Callers that must not proceed on an uncertain plan use this instead of reading
 * `held` themselves; the thrown hold carries every note, so the reason is never
 * lost.
 */
export function assertNoRecoveryHold(report: RecoveryReport): RecoveryReport {
  if (!report.held) return report
  throw new RtbHold('RECOVERY_HOLD', `recovery for team ${report.teamId} is held: ${report.notes.length} note(s)`, {
    teamId: report.teamId,
    notes: report.notes,
    decisions: report.decisions,
  })
}
