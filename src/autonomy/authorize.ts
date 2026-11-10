/**
 * The single authorization entry for every Ticket / Mandate transition.
 *
 * The Gate in `receiveTrigger` decides whether an event may *become* work; this
 * module decides whether an already-authorized Ticket may take a specific
 * action. All checks are mechanical and run inside the caller's transaction
 * boundary (the engine calls this before writing).
 */

import { MeshError } from '../errors.ts';
import type { MeshGroupStatus } from '../storage/types.ts';
import { isHuman, requireHuman, requireTrusted, type Principal } from './principal.ts';
import type {
  AssignmentRecord,
  AutonomyPolicy,
  MandateRecord,
  SubscriptionMode,
  TicketRecord,
} from './types.ts';

/** Every state-changing autonomy action. */
export type AuthorizedAction =
  | 'ticket.create'
  | 'ticket.assign'
  | 'assignment.start'
  | 'assignment.finish'
  | 'ticket.mark_compute'
  | 'ticket.resume'
  | 'ticket.stop'
  | 'ticket.end'
  | 'subscription.add'
  | 'policy.change';

/** Operation each action needs from the Mandate. */
const REQUIRED_OPERATION: Readonly<Record<AuthorizedAction, string | null>> = {
  'ticket.create': 'ticket.manage',
  'ticket.assign': 'team.dispatch',
  'assignment.start': 'team.dispatch',
  'assignment.finish': 'team.dispatch',
  'ticket.mark_compute': 'compute.submit',
  'ticket.resume': 'ticket.manage',
  'ticket.stop': 'ticket.manage',
  'ticket.end': 'ticket.manage',
  'subscription.add': 'ticket.manage',
  'policy.change': null,
};

/** Actions that expand or re-establish authority and need the current policy. */
const POLICY_BOUND: ReadonlySet<AuthorizedAction> = new Set([
  'ticket.create', 'ticket.assign', 'assignment.start', 'ticket.mark_compute',
  'subscription.add',
]);

/** Actions refused while the project or group is not active. */
const REQUIRES_ACTIVE: ReadonlySet<AuthorizedAction> = new Set([
  'ticket.create', 'ticket.assign', 'assignment.start', 'ticket.mark_compute', 'ticket.resume',
]);

/** Project facts the engine passes in; never trusted from an HTTP body. */
export interface ProjectFacts {
  readonly projectId: string;
  readonly status: 'active' | 'paused' | 'archived' | 'registered';
}

/** Group facts resolved by the engine from the store. */
export interface GroupFacts {
  readonly teamId: string;
  readonly projectId: string;
  readonly status: MeshGroupStatus;
}

/** RLP facts relevant to one action. */
export interface RlpFacts {
  /** True when the project's storage root permits formal runs. */
  readonly formalRunAllowed: boolean;
  /** Requested RLP scope; must be inside the Mandate scope. */
  readonly requestedScope?: 'discovery_only' | 'strategy' | 'full';
}

/** Resource request checked against the Mandate ceiling. */
export interface ResourceRequest {
  readonly gpuId?: number;
  readonly concurrentJobs?: number;
}

/** Complete input for one authorization decision. */
export interface AuthorizeInput {
  readonly principal: Principal;
  readonly action: AuthorizedAction;
  readonly policy: AutonomyPolicy;
  readonly project: ProjectFacts;
  readonly ticket?: TicketRecord;
  readonly mandate?: MandateRecord;
  readonly group?: GroupFacts;
  readonly assignment?: AssignmentRecord;
  readonly rlp?: RlpFacts;
  readonly resource?: ResourceRequest;
  /** Existing subscription mode when adding a subscription. */
  readonly existingSubscription?: SubscriptionMode;
  /** Requested subscription mode. */
  readonly subscriptionMode?: SubscriptionMode;
  /** True when a research Ticket carries a verified RLP completion proof. */
  readonly hasCompletionProof?: boolean;
}

const SCOPE_RANK: Readonly<Record<string, number>> = { discovery_only: 0, strategy: 1, full: 2 };

function deny(code: 'MANDATE_SCOPE_VIOLATION' | 'POLICY_BLOCKED' | 'MANDATE_REVOKED' | 'TICKET_STATE_INVALID' | 'PRINCIPAL_UNTRUSTED' | 'RLP_GATE_HOLD', message: string, details: Record<string, unknown> = {}): never {
  throw new MeshError(code, message, details);
}

/**
 * Authorize one action, or throw a typed Mesh failure.
 * @param input - principal, action, project and resolved entities.
 */
export function authorizeAction(input: AuthorizeInput): void {
  const { principal, action, policy, project, ticket, mandate } = input;

  // Principal class first: some actions are human-only regardless of Mandate.
  if (action === 'policy.change') requireHuman(principal, 'changing the autonomy policy');
  if (action === 'ticket.assign' || action === 'assignment.start'
    || action === 'assignment.finish' || action === 'ticket.mark_compute') {
    requireTrusted(principal, action);
  }
  if (action === 'ticket.create' && ticket === undefined) {
    // Creation is checked by the engine before a Ticket exists.
    requireTrusted(principal, action);
  }
  if (action === 'ticket.end' && input.hasCompletionProof === true) {
    // Scientific completion is a host/RLP outcome, not a chat decision.
    requireTrusted(principal, 'committing a scientific completion');
  }

  if (REQUIRES_ACTIVE.has(action) && project.status !== 'active') {
    deny('POLICY_BLOCKED', 'project is not active', { projectId: project.projectId, status: project.status });
  }

  if (ticket !== undefined) {
    if (ticket.projectId !== project.projectId) {
      deny('POLICY_BLOCKED', 'ticket belongs to another project', { ticketId: ticket.ticketId, projectId: project.projectId });
    }
    if (action === 'ticket.end' && ticket.kind === 'research' && ticket.status === 'waiting_evidence' && input.hasCompletionProof !== true) {
      deny('RLP_GATE_HOLD', 'research completion requires an RLP outcome proof', { ticketId: ticket.ticketId });
    }
  }

  if (mandate !== undefined && ticket !== undefined) {
    if (mandate.projectId !== ticket.projectId || mandate.projectId !== project.projectId) {
      deny('MANDATE_SCOPE_VIOLATION', 'mandate does not belong to this project', {
        mandateId: mandate.mandateId, projectId: project.projectId,
      });
    }
    if (mandate.routeId !== ticket.routeId) {
      deny('MANDATE_SCOPE_VIOLATION', 'mandate route differs from the ticket route', {
        mandateId: mandate.mandateId, mandateRoute: mandate.routeId, ticketRoute: ticket.routeId,
      });
    }
    if (mandate.revokedAt !== null) {
      deny('MANDATE_REVOKED', 'mandate was revoked', { mandateId: mandate.mandateId, reason: mandate.revokeReason });
    }
    const required = REQUIRED_OPERATION[action];
    if (required !== null) {
      const operations = JSON.parse(mandate.operationsJson) as string[];
      if (!operations.includes(required)) {
        deny('MANDATE_SCOPE_VIOLATION', `mandate does not allow ${required}`, {
          mandateId: mandate.mandateId, action, required, operations,
        });
      }
    }
    if (POLICY_BOUND.has(action) && mandate.policyVersion !== policy.version) {
      deny('MANDATE_SCOPE_VIOLATION', 'mandate was issued under a different policy', {
        mandatePolicy: mandate.policyVersion, currentPolicy: policy.version,
      });
    }
  }

  if (input.group !== undefined) {
    if (input.group.projectId !== project.projectId) {
      deny('POLICY_BLOCKED', 'group belongs to another project', {
        teamId: input.group.teamId, groupProject: input.group.projectId, projectId: project.projectId,
      });
    }
    if (action === 'ticket.assign' || action === 'assignment.start') {
      if (input.group.status !== 'active') {
        deny('POLICY_BLOCKED', 'group is not active', { teamId: input.group.teamId, status: input.group.status });
      }
    }
  }

  if (input.assignment !== undefined && ticket !== undefined) {
    if (input.assignment.ticketId !== ticket.ticketId) {
      deny('TICKET_STATE_INVALID', 'assignment belongs to another ticket', {
        assignmentId: input.assignment.assignmentId, ticketId: ticket.ticketId,
      });
    }
  }

  if (action === 'subscription.add') {
    if (input.existingSubscription === 'context' && input.subscriptionMode === 'owned') {
      deny('POLICY_BLOCKED', 'a context-only subscription cannot be upgraded in place; use a new explicit request', {
        ticketId: ticket?.ticketId,
      });
    }
    if (input.subscriptionMode === 'owned' && !isHuman(principal)) {
      requireTrusted(principal, 'granting an owned subscription');
    }
  }

  if (input.rlp !== undefined) {
    if (action === 'ticket.mark_compute' && !input.rlp.formalRunAllowed) {
      deny('RLP_GATE_HOLD', 'RLP storage root does not permit formal runs', {});
    }
    const requested = input.rlp.requestedScope;
    if (requested !== undefined && mandate !== undefined) {
      if ((SCOPE_RANK[requested] ?? 99) > (SCOPE_RANK[mandate.rlpScope] ?? -1)) {
        deny('MANDATE_SCOPE_VIOLATION', 'requested RLP scope exceeds the mandate', {
          requested, mandateScope: mandate.rlpScope,
        });
      }
    }
  }

  if (input.resource !== undefined && mandate !== undefined) {
    const ceiling = JSON.parse(mandate.resourceCeilingJson) as { gpuIds: number[]; maxConcurrentJobs: number };
    if (input.resource.gpuId !== undefined && !ceiling.gpuIds.includes(input.resource.gpuId)) {
      deny('MANDATE_SCOPE_VIOLATION', 'GPU request exceeds the mandate ceiling', {
        gpuId: input.resource.gpuId, ceiling: ceiling.gpuIds,
      });
    }
    if (input.resource.concurrentJobs !== undefined && input.resource.concurrentJobs > ceiling.maxConcurrentJobs) {
      deny('MANDATE_SCOPE_VIOLATION', 'concurrency request exceeds the mandate ceiling', {
        requested: input.resource.concurrentJobs, ceiling: ceiling.maxConcurrentJobs,
      });
    }
  }
}
