/**
 * Project-scoped autonomy engine.
 *
 * One deterministic entry point records Triggers, applies the Gate, creates
 * Tickets with a persistent Mandate, binds Assignments and enqueues durable
 * effects. It is not a scheduler: Team Tasks and Compute Jobs keep their
 * existing owners; a Ticket references them.
 *
 * Two hard rules:
 * - a model's Assessment may propose work but can never widen a Mandate;
 * - an execution success never ends a Ticket as scientifically complete. It
 *   parks at `waiting_evidence` until RLP commits its own outcome.
 */

import { MeshError } from '../errors.ts';
import { newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { sha256Text } from '../util/hash.ts';
import { canonicalJson, type CanonicalValue } from '../util/canonical-json.ts';
import type { MeshStore } from '../storage/mesh-store.ts';
import type {
  AssignmentRecord,
  AutonomyPolicy,
  CompletionProof,
  CreateTicketInput,
  MandateRecord,
  ReceiveResult,
  SubscriptionMode,
  TicketRecord,
  TicketStatus,
  TriggerInput,
  TriggerRecord,
} from './types.ts';
import type { AutonomyStore } from './store.ts';
import type { EffectsRunner } from './effects.ts';
import { authorizeAction, type AuthorizedAction } from './authorize.ts';
import { SYSTEM_PRINCIPAL, isHuman, requireHuman, requireTrusted, type Principal } from './principal.ts';

/** Default policy: observe-only, no autonomous execution. */
export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  version: 'policy-1',
  mode: 'observe',
  allowedSources: [
    'user', 'session', 'ticket_followup', 'team_task', 'compute_job',
    'artifact', 'rlp_outcome', 'rlp_assurance', 'resource', 'policy', 'resume',
  ],
  allowedActors: [],
  maxOpenTickets: 12,
  allowAutonomousExperiment: false,
  resourceCeiling: { gpuIds: [], maxConcurrentJobs: 1 },
  rlpScope: 'discovery_only',
};

const EXPLICIT_SOURCES = new Set(['user', 'session', 'ticket_followup']);
const NEVER_AUTONOMOUS = new Set(['user_request', 'session_message', 'ticket_followup', 'policy_changed', 'resume']);

/** Effects the engine registers; Mesh wires the real callbacks. */
export interface AutonomyEffectHandlers {
  readonly notice?: (payload: Readonly<Record<string, unknown>>) => Promise<void> | void;
  readonly dispatch?: (payload: Readonly<Record<string, unknown>>) => Promise<void> | void;
  readonly launch?: (payload: Readonly<Record<string, unknown>>) => Promise<void> | void;
  readonly notify?: (payload: Readonly<Record<string, unknown>>) => Promise<void> | void;
}

/** Engine dependencies. */
export interface AutonomyEngineOptions {
  readonly store: AutonomyStore;
  readonly effects: EffectsRunner;
  /** Optional Mesh store for the shared audit event log. */
  readonly meshStore?: MeshStore;
  readonly policy?: AutonomyPolicy;
  readonly now?: () => number;
  readonly handlers?: AutonomyEffectHandlers;
  /** Project status lookup; the service supplies the real registry. */
  readonly projectStatus?: (projectId: string) => 'active' | 'paused' | 'archived' | 'registered';
  /** Whether the project's RLP root permits formal runs. */
  readonly rlpFormalRun?: (projectId: string) => boolean;
  /** Group lookup; the service supplies the real Mesh registry. */
  readonly groupFacts?: (teamId: string) => { teamId: string; projectId: string; status: import('../storage/types.ts').MeshGroupStatus } | undefined;
}

/** Operations an explicit Mandate may carry. */
const EXPLICIT_OPERATIONS = [
  'ticket.manage', 'team.dispatch', 'artifact.read', 'artifact.write',
  'rlp.context.read', 'rlp.outcome.handoff', 'compute.submit',
];
/** Operations an autonomous Mandate may carry; no experiment, no state write. */
const AUTONOMOUS_OPERATIONS = ['ticket.manage', 'team.dispatch', 'artifact.read', 'rlp.context.read'];

function payloadDigest(payload: Readonly<Record<string, unknown>>): string {
  return sha256Text(canonicalJson(JSON.parse(JSON.stringify(payload)) as CanonicalValue));
}

/** Deterministic project automation. */
export class AutonomyEngine {
  readonly #store: AutonomyStore;
  readonly #effects: EffectsRunner;
  readonly #meshStore: MeshStore | undefined;
  readonly #now: () => number;
  readonly #projectStatus: (projectId: string) => 'active' | 'paused' | 'archived' | 'registered';
  readonly #rlpFormalRun: (projectId: string) => boolean;
  readonly #groupFacts: (teamId: string) => { teamId: string; projectId: string; status: import('../storage/types.ts').MeshGroupStatus } | undefined;
  #policy: AutonomyPolicy;

  /**
   * @param options - store, effects runner, optional audit store and policy.
   */
  constructor(options: AutonomyEngineOptions) {
    this.#store = options.store;
    this.#effects = options.effects;
    this.#meshStore = options.meshStore;
    this.#now = options.now ?? Date.now;
    this.#projectStatus = options.projectStatus ?? (() => 'active');
    this.#rlpFormalRun = options.rlpFormalRun ?? (() => false);
    this.#groupFacts = options.groupFacts ?? ((teamId) => options.store.groupFacts(teamId));
    const persisted = options.store.loadPolicy();
    if (persisted !== undefined) {
      const parsed = JSON.parse(persisted.json) as AutonomyPolicy;
      this.#policy = { ...parsed, version: persisted.version, digest: persisted.digest };
    } else {
      this.#policy = this.#persistPolicy(options.policy ?? DEFAULT_AUTONOMY_POLICY);
    }
    const handlers = options.handlers ?? {};
    this.#effects.register('notice', {
      retry: 'safe',
      run: async payload => { await handlers.notice?.(payload); return 'done'; },
    });
    this.#effects.register('dispatch_ticket', {
      retry: 'safe',
      run: async payload => { await handlers.dispatch?.(payload); return 'done'; },
    });
    this.#effects.register('launch_assignment', {
      retry: 'safe',
      run: async payload => { await handlers.launch?.(payload); return 'done'; },
    });
    this.#effects.register('notify', {
      retry: 'safe',
      run: async payload => { await handlers.notify?.(payload); return 'done'; },
    });
  }

  /** Current policy. */
  get policy(): AutonomyPolicy {
    return this.#policy;
  }

  /**
   * Replace the policy. The new version is monotonic and persisted; live
   * Tickets keep their Mandates, autonomous resumes are revalidated.
   * @param policy - new policy document.
   * @returns the stored policy with its digest.
   */
  setPolicy(policy: AutonomyPolicy): AutonomyPolicy {
    const current = this.#policy;
    const next = this.#nextVersion(current.version, policy.version);
    this.#policy = this.#persistPolicy({ ...policy, version: next });
    this.#event('policy', this.#policy.version, 'policy-changed', {
      mode: this.#policy.mode, version: this.#policy.version, digest: this.#policy.digest,
    });
    return this.#policy;
  }

  #nextVersion(current: string, requested: string): string {
    const number = (value: string): number => {
      const match = /^policy-(\d+)$/.exec(value);
      return match === null ? 0 : Number(match[1]);
    };
    const currentNumber = number(current);
    const requestedNumber = number(requested);
    return `policy-${Math.max(currentNumber + 1, requestedNumber > currentNumber ? requestedNumber : 0)}`;
  }

  #persistPolicy(policy: AutonomyPolicy): AutonomyPolicy {
    const { digest: _ignored, ...plain } = policy;
    const digest = sha256Text(canonicalJson(JSON.parse(JSON.stringify(plain)) as CanonicalValue));
    const stored: AutonomyPolicy = { ...plain, digest };
    this.#store.savePolicy(stored.version, digest, JSON.stringify(stored));
    return stored;
  }

  /**
   * Record one immutable Trigger and decide its disposition deterministically.
   * @param input - source event.
   * @returns stored Trigger and what happened to it.
   */
  receiveTrigger(input: TriggerInput, principal: Principal = SYSTEM_PRINCIPAL): ReceiveResult {
    if (input.projectId.trim() === '') throw new MeshError('INVALID_ARGUMENT', 'projectId is required');
    // Untrusted callers can only report chat-like messages, never system events
    // or human authorization. A request body cannot promote itself.
    const explicit = input.explicit === true && principal.authenticated && isHuman(principal);
    if (!principal.authenticated && input.source !== 'session') {
      throw new MeshError('PRINCIPAL_UNTRUSTED', 'unverified callers may only report session messages', {
        source: input.source, principal: principal.kind, via: principal.via,
      });
    }
    const dedupeKey = input.dedupeKey ?? `${input.source}:${input.eventId}`;
    const existing = this.#store.getTriggerByDedupe(dedupeKey);
    if (existing !== undefined) {
      return { trigger: existing, disposition: 'duplicate', ticket: null, reason: 'same dedupe key was already recorded' };
    }
    const occurredAt = input.occurredAt ?? nowIso();
    const payload = input.payload ?? {};
    const trigger: TriggerRecord = {
      triggerId: newId('trg'),
      source: input.source,
      eventId: input.eventId,
      projectId: input.projectId,
      kind: input.kind,
      dedupeKey,
      payloadJson: JSON.stringify(payload),
      payloadDigest: payloadDigest(payload),
      threadKey: input.threadKey ?? `${input.source}:${input.eventId}`,
      actor: input.actor ?? null,
      occurredAt,
      receivedAt: nowIso(),
      disposition: 'blocked',
      ticketId: input.ticketId ?? null,
      principalKind: principal.kind,
      principalId: principal.id,
    };
    if (!this.#store.insertTrigger(trigger)) {
      const raced = this.#store.getTriggerByDedupe(dedupeKey) ?? trigger;
      return { trigger: raced, disposition: 'duplicate', ticket: null, reason: 'a concurrent intake stored the same trigger' };
    }
    this.#store.upsertThread(trigger.threadKey, trigger.projectId);
    const decided = this.#decide({ trigger, explicit, input, principal });
    this.#store.setTriggerDisposition(trigger.triggerId, decided.disposition, decided.ticket?.ticketId ?? null);
    return { ...decided, trigger: this.#store.getTrigger(trigger.triggerId) ?? trigger };
  }

  #decide(args: { trigger: TriggerRecord; explicit: boolean; input: TriggerInput; principal: Principal }): {
    disposition: ReceiveResult['disposition'];
    ticket: TicketRecord | null;
    reason: string | null;
  } {
    const { trigger, explicit, input, principal } = args;
    const allowedSource = this.#policy.allowedSources.includes(trigger.source);
    const actorAllowed = this.#policy.allowedActors.length === 0
      || (trigger.actor !== null && this.#policy.allowedActors.includes(trigger.actor));
    if (!allowedSource || !actorAllowed) {
      this.#event('trigger', trigger.triggerId, 'blocked-by-policy', { source: trigger.source, actor: trigger.actor });
      return { disposition: 'blocked', ticket: null, reason: 'source or actor is not allowed by the current policy' };
    }
    // A follow-up that names a live Ticket stays with that Ticket.
    if (input.ticketId !== undefined && input.ticketId !== null) {
      const ticket = this.#store.getTicket(input.ticketId);
      if (ticket === undefined) {
        return { disposition: 'blocked', ticket: null, reason: 'trigger names an unknown ticket' };
      }
      if (ticket.projectId !== trigger.projectId) {
        return { disposition: 'blocked', ticket: null, reason: 'trigger and ticket belong to different projects' };
      }
      if (ticket.status === 'ended' && ticket.endReason === 'stopped') {
        return { disposition: 'blocked', ticket, reason: 'ticket was stopped by a person; it receives nothing' };
      }
      this.#store.upsertSubscription(ticket.ticketId, trigger.threadKey, 'owned');
      // A compute-completion event wakes a parked ticket back to open work; it
      // never skips the evidence gate of a ticket waiting for RLP.
      if (ticket.status === 'waiting_compute') {
        this.#store.updateTicket({ ...ticket, status: 'open', waitingReason: null, updatedAt: nowIso() });
        this.#event('ticket', ticket.ticketId, 'woken-by-trigger', { triggerId: trigger.triggerId, kind: trigger.kind });
      }
      this.#event('ticket', ticket.ticketId, 'trigger-attached', { triggerId: trigger.triggerId });
      this.#effects.enqueue('notice', `notice:${trigger.triggerId}`, {
        projectId: trigger.projectId, ticketId: ticket.ticketId, kind: 'trigger-attached', triggerId: trigger.triggerId,
      });
      return { disposition: 'attached', ticket, reason: null };
    }
    if (explicit) {
      const ticket = this.#createTicketFromTrigger(trigger, {
        projectId: trigger.projectId,
        routeId: String((input.payload as Record<string, unknown> | undefined)?.routeId ?? 'A'),
        title: String((input.payload as Record<string, unknown> | undefined)?.title ?? `Request ${trigger.eventId}`),
        objective: String((input.payload as Record<string, unknown> | undefined)?.objective ?? ''),
        explicit: true,
        ...(this.#payloadString(input, 'groupId') === null ? {} : { groupId: this.#payloadString(input, 'groupId') as string }),
        ...((input.payload as Record<string, unknown> | undefined)?.kind === 'research' ? { kind: 'research' as const } : {}),
      }, principal);
      return { disposition: 'accepted', ticket, reason: null };
    }
    if (this.#policy.mode === 'off') {
      return { disposition: 'ignored', ticket: null, reason: 'autonomy mode is off' };
    }
    if (NEVER_AUTONOMOUS.has(trigger.kind) || this.#policy.mode !== 'auto') {
      this.#effects.enqueue('notice', `notice:${trigger.triggerId}`, {
        projectId: trigger.projectId, ticketId: null, kind: 'candidate', triggerId: trigger.triggerId,
      });
      return { disposition: 'candidate', ticket: null, reason: this.#policy.mode === 'observe' ? 'observe mode records candidates only' : 'kind is not eligible for autonomous work' };
    }
    const ticket = this.#createTicketFromTrigger(trigger, {
      projectId: trigger.projectId,
      routeId: String((input.payload as Record<string, unknown> | undefined)?.routeId ?? 'A'),
      title: String((input.payload as Record<string, unknown> | undefined)?.title ?? `Autonomous ${trigger.kind}`),
      explicit: false,
    }, principal);
    return { disposition: 'accepted', ticket, reason: 'accepted by an auto-mode rule within the resource ceiling' };
  }

  #payloadString(input: TriggerInput, key: string): string | null {
    const value = (input.payload as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  /**
   * Create a Ticket and its Mandate atomically. Repeated calls with the same
   * trigger return the existing Ticket.
   * @param input - ticket definition and authorizing trigger.
   * @returns the durable Ticket.
   */
  createTicket(input: CreateTicketInput, principal: Principal = SYSTEM_PRINCIPAL): TicketRecord {
    const trigger = this.#store.getTrigger(input.triggerId);
    if (trigger === undefined) throw new MeshError('INVALID_ARGUMENT', 'ticket authorization names an unknown trigger', { triggerId: input.triggerId });
    if (trigger.projectId !== input.projectId) {
      throw new MeshError('POLICY_BLOCKED', 'trigger and ticket belong to different projects', {
        triggerProjectId: trigger.projectId, projectId: input.projectId,
      });
    }
    return this.#createTicketFromTrigger(trigger, input, principal);
  }

  #createTicketFromTrigger(trigger: TriggerRecord, input: Omit<CreateTicketInput, 'triggerId'>, principal: Principal): TicketRecord {
    const idempotencyKey = input.idempotencyKey ?? `trigger:${trigger.triggerId}`;
    const autonomous = !input.explicit;
    if (input.explicit) requireHuman(principal, 'creating an explicit ticket');
    const existing = this.#store.getTicketByIdempotency(idempotencyKey);
    if (existing !== undefined) return existing;
    if (autonomous && this.#policy.mode !== 'auto') {
      throw new MeshError('AUTONOMY_DENIED', 'autonomous ticket creation requires auto mode', { mode: this.#policy.mode });
    }
    authorizeAction({
      principal,
      action: 'ticket.create',
      policy: this.#policy,
      project: { projectId: input.projectId, status: this.#projectStatus(input.projectId) },
      rlp: { formalRunAllowed: this.#rlpFormalRun(input.projectId) },
    });
    const open = this.#store.countOpenTickets(input.projectId);
    if (open >= this.#policy.maxOpenTickets) {
      throw new MeshError('POLICY_BLOCKED', 'open ticket ceiling reached', { projectId: input.projectId, open, max: this.#policy.maxOpenTickets });
    }
    const now = nowIso();
    const operations = autonomous ? AUTONOMOUS_OPERATIONS : EXPLICIT_OPERATIONS;
    if (autonomous && operations.includes('experiment.run')) {
      throw new MeshError('AUTONOMY_DENIED', 'autonomous mandates cannot run experiments');
    }
    const mandate: MandateRecord = {
      mandateId: newId('mnd'),
      projectId: input.projectId,
      routeId: input.routeId,
      issuer: trigger.source,
      source: trigger.source,
      triggerId: trigger.triggerId,
      scopeJson: JSON.stringify(input.scope ?? {}),
      operationsJson: JSON.stringify(operations),
      resourceCeilingJson: JSON.stringify({
        gpuIds: [...this.#policy.resourceCeiling.gpuIds],
        maxConcurrentJobs: this.#policy.resourceCeiling.maxConcurrentJobs,
      }),
      rlpScope: autonomous ? this.#policy.rlpScope : 'full',
      policyVersion: this.#policy.version,
      policyDigest: this.#policy.digest ?? '',
      autonomous,
      createdAt: now,
      revokedAt: null,
      revokeReason: null,
    };
    const ticket: TicketRecord = {
      ticketId: newId('tkt'),
      projectId: input.projectId,
      routeId: input.routeId,
      title: input.title,
      objective: input.objective ?? input.title,
      status: 'open',
      kind: input.kind ?? 'engineering',
      outcomeRef: null,
      mandateId: mandate.mandateId,
      groupId: input.groupId ?? null,
      priority: input.priority ?? 0,
      autonomous,
      idempotencyKey,
      scopeJson: JSON.stringify(input.scope ?? {}),
      waitingReason: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      endReason: null,
    };
    this.#store.transaction(() => {
      this.#store.insertMandate(mandate);
      this.#store.insertTicket(ticket);
      this.#store.upsertSubscription(ticket.ticketId, trigger.threadKey, 'owned');
      this.#effects.enqueue('dispatch_ticket', `dispatch:${ticket.ticketId}`, {
        ticketId: ticket.ticketId, projectId: ticket.projectId, routeId: ticket.routeId,
      });
    });
    this.#event('ticket', ticket.ticketId, 'created', {
      mandateId: mandate.mandateId, autonomous, triggerId: trigger.triggerId, operations,
    });
    return ticket;
  }

  /**
   * Bind one execution attempt to a Ticket.
   * @param ticketId - ticket identity.
   * @param teamId - group that executes it.
   * @param options - optional task/session.
   * @returns the pending Assignment.
   */
  assign(ticketId: string, teamId: string, options: { taskId?: string; sessionId?: string } = {}, principal: Principal = SYSTEM_PRINCIPAL): AssignmentRecord {
    const ticket = this.#store.requireTicket(ticketId);
    if (ticket.status === 'ended') {
      throw new MeshError('TICKET_STATE_INVALID', 'cannot assign an ended ticket', { ticketId, endReason: ticket.endReason });
    }
    if (this.#groupFacts(teamId) === undefined) {
      throw new MeshError('TEAM_NOT_FOUND', `unknown group ${teamId}`, { teamId });
    }
    this.#authorizeTicket('ticket.assign', principal, ticket, {
      groupTeamId: teamId,
      rlp: { formalRunAllowed: this.#rlpFormalRun(ticket.projectId) },
    });
    if (this.#store.activeAssignment(ticketId) !== undefined) {
      throw new MeshError('TICKET_STATE_INVALID', 'ticket already has an active assignment', { ticketId });
    }
    const attempt = this.#store.maxAttempt(ticketId) + 1;
    const now = nowIso();
    const assignment: AssignmentRecord = {
      assignmentId: newId('asg'),
      ticketId,
      teamId,
      status: 'pending',
      attempt,
      taskId: options.taskId ?? null,
      jobId: null,
      sessionId: options.sessionId ?? null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    this.#store.transaction(() => {
      this.#store.insertAssignment(assignment);
      this.#store.updateTicket({ ...ticket, status: 'assigned', groupId: teamId, updatedAt: now });
      this.#effects.enqueue('launch_assignment', `launch:${assignment.assignmentId}`, {
        ticketId, assignmentId: assignment.assignmentId, teamId,
      });
    });
    this.#event('ticket', ticketId, 'assigned', { teamId, assignmentId: assignment.assignmentId, attempt });
    return assignment;
  }

  /**
   * Move a pending Assignment into execution.
   * @param assignmentId - assignment identity.
   * @param options - task, job or session attached to this attempt.
   * @returns updated Assignment.
   */
  startAssignment(assignmentId: string, options: { taskId?: string; jobId?: string; sessionId?: string } = {}, principal: Principal = SYSTEM_PRINCIPAL): AssignmentRecord {
    const assignment = this.#requireAssignment(assignmentId);
    if (assignment.status !== 'pending') {
      throw new MeshError('TICKET_STATE_INVALID', 'assignment is not pending', { assignmentId, status: assignment.status });
    }
    const ticket = this.#store.requireTicket(assignment.ticketId);
    this.#authorizeTicket('assignment.start', principal, ticket, {
      groupTeamId: assignment.teamId,
      assignment,
    });
    const now = nowIso();
    const updated: AssignmentRecord = {
      ...assignment,
      status: 'running',
      startedAt: now,
      taskId: options.taskId ?? assignment.taskId,
      jobId: options.jobId ?? assignment.jobId,
      sessionId: options.sessionId ?? assignment.sessionId,
    };
    this.#store.transaction(() => {
      this.#store.updateAssignment(updated);
      this.#store.updateTicket({ ...ticket, status: 'running', updatedAt: now });
    });
    this.#event('ticket', ticket.ticketId, 'assignment-started', { assignmentId });
    return updated;
  }

  /**
   * End one Assignment. Success only parks the Ticket at `waiting_evidence`:
   * the scientific outcome belongs to RLP.
   * @param assignmentId - assignment identity.
   * @param options - `ok` or a failure code/message, plus an optional job.
   * @returns updated Assignment.
   */
  finishAssignment(assignmentId: string, options: {
    ok: boolean;
    jobId?: string;
    errorCode?: string;
    errorMessage?: string;
  }, principal: Principal = SYSTEM_PRINCIPAL): AssignmentRecord {
    const assignment = this.#requireAssignment(assignmentId);
    if (assignment.status === 'ended') {
      throw new MeshError('TICKET_STATE_INVALID', 'assignment already ended', { assignmentId });
    }
    const ticket = this.#store.requireTicket(assignment.ticketId);
    this.#authorizeTicket('assignment.finish', principal, ticket, {
      groupTeamId: assignment.teamId,
      assignment,
    });
    const now = nowIso();
    const updated: AssignmentRecord = {
      ...assignment,
      status: 'ended',
      endedAt: now,
      jobId: options.jobId ?? assignment.jobId,
      errorCode: options.ok ? null : (options.errorCode ?? 'EXECUTOR_FAILED'),
      errorMessage: options.ok ? null : (options.errorMessage ?? 'assignment failed'),
    };
    const nextStatus: TicketStatus = options.ok ? 'waiting_evidence' : 'waiting_human';
    this.#store.transaction(() => {
      this.#store.updateAssignment(updated);
      this.#store.updateTicket({
        ...ticket,
        status: nextStatus,
        waitingReason: options.ok ? 'awaiting RLP evidence outcome' : (options.errorMessage ?? 'assignment failed'),
        updatedAt: now,
      });
      this.#effects.enqueue('notify', `notify:${assignmentId}`, {
        ticketId: ticket.ticketId, assignmentId, ok: options.ok,
      });
    });
    this.#event('ticket', ticket.ticketId, options.ok ? 'assignment-succeeded' : 'assignment-failed', {
      assignmentId, errorCode: updated.errorCode,
    });
    return updated;
  }

  /**
   * Park a Ticket while an external job runs; the Agent session may stop.
   * @param ticketId - ticket identity.
   * @param jobId - compute job identity.
   * @param assignmentId - assignment that submitted it.
   * @returns updated Ticket.
   */
  markCompute(ticketId: string, jobId: string, assignmentId?: string, principal: Principal = SYSTEM_PRINCIPAL): TicketRecord {
    const ticket = this.#store.requireTicket(ticketId);
    this.#authorizeTicket('ticket.mark_compute', principal, ticket, {
      rlp: { formalRunAllowed: this.#rlpFormalRun(ticket.projectId) },
    });
    const now = nowIso();
    const updated: TicketRecord = { ...ticket, status: 'waiting_compute', waitingReason: `compute job ${jobId}`, updatedAt: now };
    this.#store.transaction(() => {
      if (assignmentId !== undefined) {
        const assignment = this.#requireAssignment(assignmentId);
        this.#store.updateAssignment({
          ...assignment, status: 'ended', endedAt: now, jobId,
        });
      }
      this.#store.updateTicket(updated);
    });
    this.#event('ticket', ticketId, 'waiting-compute', { jobId, assignmentId: assignmentId ?? null });
    return updated;
  }

  /**
   * Park a Ticket for a human decision.
   * @param ticketId - ticket identity.
   * @param reason - why a human must act.
   * @returns updated Ticket.
   */
  waitForHuman(ticketId: string, reason: string): TicketRecord {
    return this.#transitionWaiting(ticketId, 'waiting_human', reason);
  }

  #transitionWaiting(ticketId: string, status: TicketStatus, reason: string): TicketRecord {
    const ticket = this.#store.requireTicket(ticketId);
    if (ticket.status === 'ended') throw new MeshError('TICKET_STATE_INVALID', 'ticket already ended', { ticketId });
    const updated: TicketRecord = { ...ticket, status, waitingReason: reason, updatedAt: nowIso() };
    this.#store.updateTicket(updated);
    this.#event('ticket', ticketId, 'waiting', { status, reason });
    return updated;
  }

  /**
   * Resume a Ticket. An ended Ticket resumes only when its Mandate is valid and
   * the caller is explicit; autonomous resume is denied after a policy change.
   * @param ticketId - ticket identity.
   * @param options - explicit human authorization and authorizing trigger.
   * @returns updated Ticket.
   */
  resumeTicket(ticketId: string, options: { explicit: boolean; triggerId?: string } = { explicit: false }, principal: Principal = SYSTEM_PRINCIPAL): TicketRecord {
    const ticket = this.#store.requireTicket(ticketId);
    if (ticket.status !== 'ended' && ticket.status !== 'waiting_human') {
      throw new MeshError('TICKET_STATE_INVALID', 'ticket is not resumable', { ticketId, status: ticket.status });
    }
    if (ticket.status === 'ended' && ticket.endReason === 'stopped') {
      throw new MeshError('MANDATE_REVOKED', 'a stopped ticket cannot be resumed', { ticketId });
    }
    const mandate = this.#store.getMandate(ticket.mandateId);
    if (mandate === undefined) throw new MeshError('MANDATE_REVOKED', 'ticket mandate is missing', { ticketId });
    if (mandate.revokedAt !== null) throw new MeshError('MANDATE_REVOKED', 'ticket mandate was revoked', { ticketId });
    this.#authorizeTicket('ticket.resume', principal, ticket);
    const policyChanged = mandate.policyVersion !== this.#policy.version;
    const explicitResume = options.explicit === true && isHuman(principal);
    if (policyChanged && !explicitResume) {
      throw new MeshError('MANDATE_REVALIDATION_REQUIRED', 'policy changed; resume needs a verified human re-authorization', {
        ticketId, mandatePolicy: mandate.policyVersion, policy: this.#policy.version,
      });
    }
    const now = nowIso();
    // An explicit resume after a policy change issues a new Mandate under the
    // current policy; the old one is never widened or rewritten in place.
    const mandateId = policyChanged ? this.#reissueMandate(mandate, now) : ticket.mandateId;
    const updated: TicketRecord = {
      ...ticket, mandateId, status: 'open', waitingReason: null, updatedAt: now, endedAt: null, endReason: null,
    };
    this.#store.transaction(() => {
      this.#store.updateTicket(updated);
      if (options.triggerId !== undefined) {
        this.#store.upsertSubscription(ticketId, `trigger:${options.triggerId}`, 'context');
      }
      this.#effects.enqueue('dispatch_ticket', `dispatch:${ticketId}:${now}`, { ticketId, projectId: ticket.projectId });
    });
    this.#event('ticket', ticketId, 'resumed', { explicit: options.explicit, policyChanged });
    return updated;
  }

  /**
   * A person stops a Ticket: the Mandate is revoked and pending work is
   * cancelled. No autonomous Trigger can undo this.
   * @param ticketId - ticket identity.
   * @param by - acting principal.
   * @param reason - audit reason.
   * @returns updated Ticket.
   */
  stopTicket(ticketId: string, by: string, reason: string, principal: Principal = SYSTEM_PRINCIPAL): TicketRecord {
    const ticket = this.#store.requireTicket(ticketId);
    if (ticket.status === 'ended') return ticket;
    // Stopping never expands authority, so an untrusted web operator may do it;
    // the revoke is recorded under that principal's identity.
    this.#authorizeTicket('ticket.stop', principal, ticket);
    const now = nowIso();
    const updated: TicketRecord = {
      ...ticket, status: 'ended', endedAt: now, endReason: 'stopped', waitingReason: reason, updatedAt: now,
    };
    this.#store.transaction(() => {
      this.#store.revokeMandate(ticket.mandateId, `stopped by ${by}: ${reason}`, now);
      for (const assignment of this.#store.listAssignments(ticketId)) {
        if (assignment.status === 'ended') continue;
        this.#store.updateAssignment({ ...assignment, status: 'ended', endedAt: now, errorCode: 'STOPPED', errorMessage: reason });
      }
      this.#store.updateTicket(updated);
      this.#effects.enqueue('notify', `notify:stop:${ticketId}`, { ticketId, reason });
    });
    this.#event('ticket', ticketId, 'stopped', { by, reason });
    return updated;
  }

  /**
   * End a Ticket normally, e.g. after RLP committed its outcome.
   * @param ticketId - ticket identity.
   * @param reason - `completed`, `failed` or `cancelled`.
   * @param by - acting principal.
   * @returns updated Ticket.
   */
  endTicket(
    ticketId: string,
    reason: 'completed' | 'failed' | 'cancelled',
    by: string,
    principal: Principal = SYSTEM_PRINCIPAL,
    proof?: CompletionProof,
  ): TicketRecord {
    const ticket = this.#store.requireTicket(ticketId);
    if (ticket.status === 'ended') return ticket;
    this.#authorizeTicket('ticket.end', principal, ticket, {
      ...(proof === undefined ? {} : { hasCompletionProof: true }),
    });
    if (reason === 'completed') {
      requireTrusted(principal, 'ending a ticket as completed');
      if (ticket.kind === 'research') {
        if (proof === undefined) {
          throw new MeshError('RLP_GATE_HOLD', 'a research ticket cannot complete without an RLP outcome proof', {
            ticketId, status: ticket.status,
          });
        }
        if (proof.ticketId !== ticketId || proof.experimentId.trim() === ''
          || proof.stateDigest.trim() === '' || proof.proofDigest.trim() === '') {
          throw new MeshError('RLP_GATE_HOLD', 'the RLP completion proof is incomplete or for another ticket', {
            ticketId, proofTicket: proof.ticketId,
          });
        }
      }
    }
    const now = nowIso();
    const updated: TicketRecord = {
      ...ticket,
      status: 'ended',
      endedAt: now,
      endReason: reason,
      updatedAt: now,
      outcomeRef: reason === 'completed' && proof !== undefined ? proof.proofDigest : ticket.outcomeRef,
    };
    this.#store.updateTicket(updated);
    this.#event('ticket', ticketId, 'ended', {
      reason, by, principal: principal.kind, proof: proof?.proofDigest ?? null,
    });
    return updated;
  }

  /**
   * Subscribe a Ticket to an event thread.
   * @param ticketId - ticket identity.
   * @param threadKey - thread identity.
   * @param mode - `owned` grants follow-up handling; `context` grants nothing.
   */
  subscribe(ticketId: string, threadKey: string, mode: SubscriptionMode, principal: Principal = SYSTEM_PRINCIPAL): void {
    const ticket = this.#store.requireTicket(ticketId);
    if (ticket.status === 'ended' && mode === 'owned') {
      throw new MeshError('TICKET_STATE_INVALID', 'an ended ticket cannot own a new follow-up thread', { ticketId });
    }
    const owner = this.#store.threadProject(threadKey);
    if (owner !== undefined && owner !== ticket.projectId) {
      throw new MeshError('POLICY_BLOCKED', 'thread belongs to another project', {
        ticketId, threadKey, threadProject: owner, projectId: ticket.projectId,
      });
    }
    const existing = this.#store.listSubscriptions(ticketId).find(row => row.threadKey === threadKey);
    this.#authorizeTicket('subscription.add', principal, ticket, {
      subscriptionMode: mode,
      ...(existing === undefined ? {} : { existingSubscription: existing.mode }),
    });
    this.#store.upsertSubscription(ticketId, threadKey, mode);
    this.#event('ticket', ticketId, 'subscribed', { threadKey, mode });
  }

  /** Ticket by id. */
  getTicket(ticketId: string): TicketRecord {
    return this.#store.requireTicket(ticketId);
  }

  /** Tickets of one project. */
  listTickets(projectId: string, statuses?: readonly TicketStatus[]): readonly TicketRecord[] {
    return this.#store.listTickets(projectId, statuses);
  }

  /** Recent triggers of one project. */
  listTriggers(projectId: string, limit?: number): readonly TriggerRecord[] {
    return this.#store.listTriggers(projectId, limit);
  }

  /** Assignments of one ticket. */
  listAssignments(ticketId: string): readonly AssignmentRecord[] {
    return this.#store.listAssignments(ticketId);
  }

  /** Mandate of one ticket. */
  getMandate(ticketId: string): MandateRecord | undefined {
    const ticket = this.#store.getTicket(ticketId);
    return ticket === undefined ? undefined : this.#store.getMandate(ticket.mandateId);
  }

  #reissueMandate(previous: MandateRecord, at: string): string {
    const mandateId = newId('mnd');
    this.#store.insertMandate({
      ...previous,
      mandateId,
      policyVersion: this.#policy.version,
      policyDigest: this.#policy.digest ?? '',
      createdAt: at,
      revokedAt: null,
      revokeReason: null,
    });
    return mandateId;
  }

  #authorizeTicket(
    action: AuthorizedAction,
    principal: Principal,
    ticket: TicketRecord,
    extra: {
      groupTeamId?: string;
      assignment?: AssignmentRecord;
      rlp?: { formalRunAllowed: boolean; requestedScope?: 'discovery_only' | 'strategy' | 'full' };
      existingSubscription?: SubscriptionMode;
      subscriptionMode?: SubscriptionMode;
      hasCompletionProof?: boolean;
    } = {},
  ): void {
    const mandate = this.#store.getMandate(ticket.mandateId);
    const group = extra.groupTeamId === undefined ? undefined : this.#groupFacts(extra.groupTeamId);
    authorizeAction({
      principal,
      action,
      policy: this.#policy,
      project: { projectId: ticket.projectId, status: this.#projectStatus(ticket.projectId) },
      ticket,
      ...(mandate === undefined ? {} : { mandate }),
      ...(group === undefined ? {} : { group }),
      ...(extra.assignment === undefined ? {} : { assignment: extra.assignment }),
      ...(extra.rlp === undefined ? {} : { rlp: extra.rlp }),
      ...(extra.existingSubscription === undefined ? {} : { existingSubscription: extra.existingSubscription }),
      ...(extra.subscriptionMode === undefined ? {} : { subscriptionMode: extra.subscriptionMode }),
      ...(extra.hasCompletionProof === undefined ? {} : { hasCompletionProof: extra.hasCompletionProof }),
    });
  }

  #requireAssignment(assignmentId: string): AssignmentRecord {
    const assignment = this.#store.getAssignment(assignmentId);
    if (assignment === undefined) throw new MeshError('TICKET_NOT_FOUND', `unknown assignment ${assignmentId}`, { assignmentId });
    return assignment;
  }

  #event(entityType: string, entityId: string, kind: string, payload: Record<string, unknown>): void {
    try { this.#meshStore?.appendEvent(entityType, entityId, kind, payload); } catch { /* the audit log is best effort */ }
  }
}
