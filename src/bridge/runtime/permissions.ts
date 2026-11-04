/**
 * Least-privilege enforcement for one research team.
 *
 * Every authorization question the bridge asks goes through this class, because
 * the answer must come from the durable member row plus the frozen role catalog
 * — never from a name written in a message. Two rules shape it:
 *
 * - **The live caller's identity decides.** `roleOf` resolves a real
 *   {@link TeamMember}; there is no way to assert a role directly.
 * - **Refusals are explicit.** Each refusal throws an `RtbError` with the stable
 *   code from `src/types.ts` (`ROLE_NOT_PERMITTED_TO_SEND`,
 *   `RECIPIENT_NOT_PERMITTED`, `PERMISSION_DENIED`, `TEAM_BUDGET_EXHAUSTED`), so
 *   a tool handler can report one honest line instead of guessing.
 *
 * @module dsh-research-team-bridge/runtime/permissions
 */

import { RtbError } from '../errors.ts'
import type { Clock } from '../ids.ts'
import { isoNow, systemClock } from '../ids.ts'
import { mayAddress, roleProfile } from '../team/roles.ts'
import type {
  AgentId, ResearchRole, RolePermissions, TaskId, TeamId, TeamMember, TeamRecord, TeamStore,
} from '../types.ts'

/** The three budgeted resources a caller must ask about before spending. */
export type BudgetKind = 'message' | 'experiment' | 'agent'

/** Optional scoping for {@link PermissionPolicy.assertBudget}. */
export interface BudgetCheckOptions {
  /** Check the task's own budget and counters instead of the team aggregate. */
  readonly taskId?: TaskId | null
  /** Explicit ceiling override, e.g. a caller-supplied per-call cap. */
  readonly limit?: number
}

/** Result of a non-throwing budget probe. */
export interface BudgetCheck {
  readonly kind: BudgetKind
  readonly exhausted: boolean
  readonly used: number
  readonly limit: number
  readonly scope: 'team' | 'task'
  readonly reason: string | null
}

export interface PermissionPolicyOptions {
  readonly store: TeamStore
  readonly clock?: Clock
}

/** Roles allowed to send at all. Every role currently may, but the gate is real. */
export class PermissionPolicy {
  readonly #store: TeamStore
  readonly #clock: Clock

  constructor(options: PermissionPolicyOptions) {
    this.#store = options.store
    this.#clock = options.clock ?? systemClock
  }

  /** The durable member row, or a stable failure. */
  memberOf(teamId: TeamId, agentId: AgentId): TeamMember {
    const member = this.#store.getMember(teamId, agentId)
    if (member === undefined) {
      throw new RtbError('MEMBER_NOT_FOUND', `agent ${agentId} is not a member of team ${teamId}`, { teamId, agentId })
    }
    return member
  }

  /** The team row, or a stable failure. */
  teamOf(teamId: TeamId): TeamRecord {
    const team = this.#store.getTeam(teamId)
    if (team === undefined) {
      throw new RtbError('TEAM_NOT_FOUND', `unknown team ${teamId}`, { teamId })
    }
    return team
  }

  /** Resolve the role of a real member. Throws `MEMBER_NOT_FOUND`. */
  roleOf(teamId: TeamId, agentId: AgentId): ResearchRole {
    return this.memberOf(teamId, agentId).role
  }

  /** Role without throwing; `undefined` for a non-member. */
  tryRoleOf(teamId: TeamId, agentId: AgentId): ResearchRole | undefined {
    return this.#store.getMember(teamId, agentId)?.role
  }

  /** The frozen permission set of a role. */
  permissionsFor(role: ResearchRole): RolePermissions {
    return roleProfile(role).permissions
  }

  /** True when this member holds the captain role. */
  isCaptain(teamId: TeamId, agentId: AgentId): boolean {
    return this.tryRoleOf(teamId, agentId) === 'captain'
  }

  /**
   * May `senderAgentId` address `recipientAgentId`?
   *
   * The role relationship must be **reciprocal** (see `mayAddress`): the sender's
   * allow-list must contain the recipient's role, and the recipient must accept
   * the sender's role. A sender-side violation is `ROLE_NOT_PERMITTED_TO_SEND`;
   * a recipient-side violation is `RECIPIENT_NOT_PERMITTED`. A member that ended
   * (`disposed` / `failed`) has no authority left and gets `PERMISSION_DENIED`.
   *
   * This says nothing about the *physical* edge: DSH adjacency is the transport's
   * business and the relay's business, never a permission.
   */
  assertCanSend(
    teamId: TeamId,
    senderAgentId: AgentId,
    recipientAgentId: AgentId,
  ): { senderRole: ResearchRole; recipientRole: ResearchRole } {
    const sender = this.memberOf(teamId, senderAgentId)
    const recipient = this.memberOf(teamId, recipientAgentId)
    if (sender.status === 'disposed' || sender.status === 'failed') {
      throw new RtbError('PERMISSION_DENIED', `member ${senderAgentId} is ${sender.status} and may not send`, {
        teamId, senderAgentId, status: sender.status,
      })
    }
    const senderProfile = roleProfile(sender.role)
    const allowed = senderProfile.allowedRecipients
    if (allowed !== 'all' && !allowed.includes(recipient.role)) {
      throw new RtbError(
        'ROLE_NOT_PERMITTED_TO_SEND',
        `role ${sender.role} may not address role ${recipient.role}`,
        { teamId, senderRole: sender.role, recipientRole: recipient.role, allowedRecipients: allowed },
      )
    }
    if (!mayAddress(sender.role, recipient.role)) {
      throw new RtbError(
        'RECIPIENT_NOT_PERMITTED',
        `role ${recipient.role} does not accept messages from role ${sender.role}`,
        {
          teamId, senderRole: sender.role, recipientRole: recipient.role,
          recipientAllowedRecipients: roleProfile(recipient.role).allowedRecipients,
        },
      )
    }
    return { senderRole: sender.role, recipientRole: recipient.role }
  }

  /** Only the captain may create further agents or tasks. */
  assertCanDelegate(teamId: TeamId, agentId: AgentId): void {
    this.#assertFlag(teamId, agentId, 'canDelegate', 'delegate work or create a subagent')
  }

  /** Permission **and** budget: an experiment run spends a bounded resource. */
  assertCanRunExperiment(teamId: TeamId, agentId: AgentId): void {
    this.#assertFlag(teamId, agentId, 'canRunExperiments', 'run an experiment')
    this.assertBudget(teamId, 'experiment')
  }

  /**
   * Only the experiment role may write experiment code.
   *
   * Advisory, and deliberately so: RTB has no action that mutates code, and the host
   * gives it no isolation over a worker's shell or files (see the bypass matrix in
   * `docs/native-consolidation-audit.md`). Kept as the one place the rule is
   * expressed, and not called from anywhere, because calling it would imply an
   * enforcement this release cannot provide.
   */
  assertCanMutateCode(teamId: TeamId, agentId: AgentId): void {
    this.#assertFlag(teamId, agentId, 'canModifyCode', 'modify code')
  }

  /** Only roles with `canStageArtifacts` may hand a product to the state gate. Enforced by `research_team_artifact`. */
  assertCanStageArtifacts(teamId: TeamId, agentId: AgentId): void {
    this.#assertFlag(teamId, agentId, 'canStageArtifacts', 'stage a research artifact')
  }

  /**
   * Probe a budget without throwing. Team-wide wall clock is checked for every
   * kind, because an expired team clock stops all spending.
   */
  checkBudget(teamId: TeamId, kind: BudgetKind, options: BudgetCheckOptions = {}): BudgetCheck {
    const team = this.teamOf(teamId)
    const usage = this.#store.getBudgetUsage(teamId)
    const task = options.taskId === undefined || options.taskId === null ? undefined : this.#store.getTask(options.taskId)
    const scope: 'team' | 'task' = task === undefined ? 'team' : 'task'

    if (usage.startedAt !== null && team.budget.maxWallClockMs > 0) {
      const elapsed = this.#clock.now().getTime() - new Date(usage.startedAt).getTime()
      if (elapsed >= team.budget.maxWallClockMs) {
        return {
          kind,
          exhausted: true,
          used: elapsed,
          limit: team.budget.maxWallClockMs,
          scope,
          reason: `team wall clock budget exhausted (${elapsed}ms of ${team.budget.maxWallClockMs}ms)`,
        }
      }
    }

    let used: number
    let builtInLimit: number
    if (kind === 'agent') {
      used = usage.concurrentAgents
      builtInLimit = team.budget.maxConcurrentAgents
    } else if (kind === 'experiment') {
      used = task === undefined ? usage.experimentRuns : task.progress.experimentRuns
      builtInLimit = task === undefined ? team.budget.maxExperimentRuns : task.budget.maxExperimentRuns
    } else {
      // `Budget` has no team-wide message ceiling: `maxMessagesPerTask` is the
      // only message ceiling in the frozen vocabulary, so the team aggregate is
      // guarded by it unless the caller scopes the check to one task.
      used = task === undefined ? usage.messages : task.progress.messages
      builtInLimit = task === undefined ? team.budget.maxMessagesPerTask : task.budget.maxMessagesPerTask
    }
    const limit = options.limit ?? builtInLimit
    const exhausted = used >= limit
    return {
      kind,
      exhausted,
      used,
      limit,
      scope,
      reason: exhausted ? `${kind} budget exhausted: ${used} of ${limit} (${scope} scope)` : null,
    }
  }

  /**
   * Consume-check a budgeted resource. Throws `TEAM_BUDGET_EXHAUSTED` carrying
   * `details.code = 'BUDGET_EXCEEDED'`, mirroring how the store reports a
   * conflict under `STORE_CONFLICT`.
   */
  assertBudget(teamId: TeamId, kind: BudgetKind, options: BudgetCheckOptions = {}): void {
    const check = this.checkBudget(teamId, kind, options)
    if (check.exhausted) {
      throw new RtbError('TEAM_BUDGET_EXHAUSTED', check.reason ?? `${kind} budget exhausted`, {
        code: 'BUDGET_EXCEEDED',
        teamId,
        kind,
        used: check.used,
        limit: check.limit,
        scope: check.scope,
        taskId: options.taskId ?? null,
        checkedAt: isoNow(this.#clock),
      })
    }
  }

  /** The captain's identity from the durable team row. */
  captainOf(teamId: TeamId): AgentId {
    return this.teamOf(teamId).captainAgentId
  }

  #assertFlag(teamId: TeamId, agentId: AgentId, flag: keyof RolePermissions, action: string): void {
    const member = this.memberOf(teamId, agentId)
    const permissions = this.permissionsFor(member.role)
    if (permissions[flag] !== true) {
      throw new RtbError('PERMISSION_DENIED', `role ${member.role} may not ${action}`, {
        teamId, agentId, role: member.role, flag, permissions,
      })
    }
  }
}
