/**
 * Project-scoped autonomy objects.
 *
 * These are Mesh-owned work objects inspired by the DSH Superagent prototype:
 * an immutable Trigger is recorded once, a deterministic Gate decides whether it
 * may create work, a Ticket carries a persistent Mandate, and an Assignment
 * binds one execution attempt. RLP keeps sole authority over scientific state;
 * a Ticket or a Team Task is never a scientific verdict.
 */

/** Autonomy mode; `observe` is the default. */
export type AutonomyMode = 'off' | 'observe' | 'auto';

/** Where a Trigger came from. */
export type TriggerSource =
  | 'user'
  | 'session'
  | 'ticket_followup'
  | 'team_task'
  | 'compute_job'
  | 'artifact'
  | 'rlp_outcome'
  | 'rlp_assurance'
  | 'resource'
  | 'policy'
  | 'resume';

/** What a Trigger reports. */
export type TriggerKind =
  | 'user_request'
  | 'session_message'
  | 'ticket_followup'
  | 'team_task_completed'
  | 'team_task_failed'
  | 'compute_job_completed'
  | 'compute_job_failed'
  | 'artifact_ingested'
  | 'rlp_outcome_pending'
  | 'rlp_assurance_blocked'
  | 'rlp_assurance_completed'
  | 'resource_available'
  | 'resource_unavailable'
  | 'policy_changed'
  | 'resume';

/** Durable disposition of a Trigger. */
export type TriggerDisposition = 'accepted' | 'candidate' | 'ignored' | 'blocked' | 'duplicate' | 'attached';

/** What kind of work a Ticket represents. */
export type TicketKind = 'engineering' | 'research';

/** Authority proof for a scientific completion, produced by RLP checks. */
export interface CompletionProof {
  readonly ticketId: string;
  readonly experimentId: string;
  readonly stateVersion: string;
  readonly stateDigest: string;
  readonly decision: string;
  readonly verifiedAt: string;
  /** Digest of the RLP decision output used for this proof. */
  readonly proofDigest: string;
}

/** Ticket working state. */
export type TicketStatus =
  | 'open'
  | 'assigned'
  | 'running'
  | 'waiting_compute'
  | 'waiting_evidence'
  | 'waiting_human'
  | 'ended';

/** Why a Ticket ended. */
export type TicketEndReason = 'completed' | 'stopped' | 'failed' | 'cancelled';

/** Assignment state. */
export type AssignmentStatus = 'pending' | 'running' | 'ended';

/** Subscription relation of a Ticket to an event thread. */
export type SubscriptionMode = 'owned' | 'context';

/** Durable Trigger row. */
export interface TriggerRecord {
  readonly triggerId: string;
  readonly source: TriggerSource;
  readonly eventId: string;
  readonly projectId: string;
  readonly kind: TriggerKind;
  readonly dedupeKey: string;
  readonly payloadJson: string;
  readonly payloadDigest: string;
  readonly threadKey: string;
  readonly actor: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly disposition: TriggerDisposition;
  readonly ticketId: string | null;
}

/** Persistent authorization derived from a Trigger and the current Policy. */
export interface MandateRecord {
  readonly mandateId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly issuer: string;
  readonly source: TriggerSource;
  readonly triggerId: string;
  readonly scopeJson: string;
  readonly operationsJson: string;
  readonly resourceCeilingJson: string;
  readonly rlpScope: string;
  readonly policyVersion: string;
  /** Digest of the policy document the Mandate was issued under. */
  readonly policyDigest: string;
  readonly autonomous: boolean;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

/** Durable long-lived work item. */
export interface TicketRecord {
  readonly ticketId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly kind: TicketKind;
  readonly title: string;
  readonly objective: string;
  readonly status: TicketStatus;
  readonly mandateId: string;
  readonly groupId: string | null;
  readonly priority: number;
  readonly autonomous: boolean;
  readonly idempotencyKey: string;
  readonly scopeJson: string;
  readonly waitingReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
  readonly endReason: TicketEndReason | null;
  /** Digest of the RLP completion proof, when the ticket ended completed. */
  readonly outcomeRef: string | null;
  /** RLP experiment this Ticket is bound to, when known. */
  readonly experimentId: string | null;
}

/** One execution binding of a Ticket; a Ticket may have several over time. */
export interface AssignmentRecord {
  readonly assignmentId: string;
  readonly ticketId: string;
  readonly teamId: string;
  readonly status: AssignmentStatus;
  readonly attempt: number;
  readonly taskId: string | null;
  readonly jobId: string | null;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** One Ticket/thread relation. */
export interface SubscriptionRecord {
  readonly ticketId: string;
  readonly threadKey: string;
  readonly mode: SubscriptionMode;
  readonly createdAt: string;
}

/** Durable side-effect state. */
export type EffectStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

/** One durable effect row. */
export interface EffectRecord {
  readonly effectId: string;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly payloadJson: string;
  readonly status: EffectStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextRunAt: string;
  readonly lastError: string | null;
  /** Worker that currently owns the claim, when running. */
  readonly owner: string | null;
  /** Per-claim fencing token; every claim gets a fresh value. */
  readonly claimToken: string | null;
  readonly claimedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Deterministic authorization policy owned by Mesh configuration. */
export interface AutonomyPolicy {
  /** Policy version recorded on every new Mandate. */
  readonly version: string;
  /** Current autonomy mode. */
  readonly mode: AutonomyMode;
  /** Sources allowed to originate work. */
  readonly allowedSources: readonly TriggerSource[];
  /** Actor allow-list; empty means every actor known to the source. */
  readonly allowedActors: readonly string[];
  /** Maximum simultaneously open Tickets per project. */
  readonly maxOpenTickets: number;
  /** Hard ceiling: autonomous triggers can never run an experiment directly. */
  readonly allowAutonomousExperiment: false;
  /** Resource ceiling copied onto autonomous Mandates. */
  readonly resourceCeiling: { readonly gpuIds: readonly number[]; readonly maxConcurrentJobs: number };
  /** RLP execution scope for autonomous work. */
  readonly rlpScope: 'discovery_only' | 'strategy' | 'full';
  /** Monotonic policy digest, computed when persisted. */
  readonly digest?: string;
}

/** Input for recording one Trigger. */
export interface TriggerInput {
  readonly source: TriggerSource;
  readonly eventId: string;
  readonly projectId: string;
  readonly kind: TriggerKind;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
  readonly threadKey?: string;
  readonly actor?: string;
  readonly occurredAt?: string;
  /** Explicit user authorization carried by the event; never inferred. */
  readonly explicit?: boolean;
  /** Existing Ticket the trigger points at, when the source knows it. */
  readonly ticketId?: string;
}

/** Result of receiving one Trigger. */
export interface ReceiveResult {
  readonly trigger: TriggerRecord;
  readonly disposition: TriggerDisposition;
  readonly ticket: TicketRecord | null;
  readonly reason: string | null;
}

/** Input for creating a Ticket explicitly. */
export interface CreateTicketInput {
  readonly projectId: string;
  readonly routeId: string;
  readonly title: string;
  readonly objective?: string;
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly priority?: number;
  readonly groupId?: string;
  readonly idempotencyKey?: string;
  /** Trigger that authorizes the work. */
  readonly triggerId: string;
  /** Explicit human authorization; autonomous creation must leave this false. */
  readonly explicit: boolean;
  /** Engineering by default; research completion needs an RLP proof. */
  readonly kind?: TicketKind;
  /** RLP experiment bound at creation; may also be learned from a compute job. */
  readonly experimentId?: string;
}
