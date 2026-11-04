/**
 * Frozen shared contracts for the Research Team Bridge (RTB).
 *
 * This module is dependency-free on purpose: every other module in the plugin
 * codes against these types, and the tests build fakes from them. Nothing here
 * may import a DSH package — the DSH-specific surface lives in `src/adapters/`.
 *
 * Vocabulary rules (these are load-bearing, see README "Authority boundaries"):
 * - A {@link TeamMessage} is *transport*, never scientific evidence. Its
 *   `trust` field defaults to `unverified_input`.
 * - A {@link ResearchArtifact} is a *staged* research product. It becomes
 *   scientific only after the existing pipeline validators promote it.
 * - `StateVersion` is an opaque token owned by the canonical Research State.
 *   The bridge never mints one.
 *
 * @module dsh-research-team-bridge/types
 */

/** Stable identity of one research team run. */
export type TeamId = string
/** Stable identity of one research task inside a team. */
export type TaskId = string
/** One execution attempt of a task. A new attempt is a new identity. */
export type AttemptId = string
/** Identity of a DSH agent, expressed as its durable session id string. */
export type AgentId = string
/** Identity of one bridge message (not the DSH inbox message id). */
export type MessageId = string
/** Identity of one staged research artifact. */
export type ArtifactId = string
/** Identity of one durable bridge action (intent/result journal row). */
export type ActionId = string
/** Identity of one research decision proposal. */
export type ProposalId = string
/** Opaque canonical-state version token. Owned by the Research State, never minted here. */
export type StateVersion = string
/** ISO-8601 UTC timestamp. */
export type Timestamp = string

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Logical research roles. These mirror `references/roles.md` of the Research
 * Idea Pipeline; the bridge must not invent a conflicting role system.
 */
export type ResearchRole =
  | 'captain'
  | 'discovery'
  | 'theory'
  | 'literature'
  | 'experiment'
  | 'assurance'
  | 'synthesis'

/** Every role except the captain is a worker role. */
export type WorkerRole = Exclude<ResearchRole, 'captain'>

/** How much of the research workspace a role may touch. */
export type WorkspaceAccess = 'read-only' | 'experiment-write' | 'coordinate'

/**
 * Least-privilege permission set per role. `canWriteCanonicalState` is `false`
 * for every role including the captain: only the state gate's commit path may
 * write, and it does so through the pipeline's own writer.
 */
export interface RolePermissions {
  readonly workspace: WorkspaceAccess
  /** Always false. Kept explicit so a reviewer can assert it. */
  readonly canWriteCanonicalState: boolean
  readonly canStageArtifacts: boolean
  readonly canRunExperiments: boolean
  readonly canUseNetwork: boolean
  readonly canModifyCode: boolean
  readonly canDeleteFiles: boolean
  readonly canPublishGit: boolean
  /** May this role create further subagents? Only the captain may. */
  readonly canDelegate: boolean
}

/** A role's durable definition, loaded from the frozen role catalog. */
export interface RoleProfile {
  readonly role: ResearchRole
  readonly title: string
  readonly mission: string
  readonly permissions: RolePermissions
  /** Roles this role may address directly, or `'all'`. */
  readonly allowedRecipients: readonly ResearchRole[] | 'all'
  readonly defaultBudget: Budget
  /** Pipeline phases this role normally works in, e.g. `['R3', 'R4']`. */
  readonly phases: readonly string[]
  /** Isolation rules the role must obey, copied from the pipeline references. */
  readonly isolation: readonly string[]
}

/** Hard ceilings for one team, one task, or one attempt. */
export interface Budget {
  readonly maxConcurrentAgents: number
  readonly maxTaskAttempts: number
  readonly maxMessagesPerTask: number
  readonly maxExperimentRuns: number
  readonly maxWallClockMs: number
}

/** Consumed budget counters, persisted per team and per task. */
export interface BudgetUsage {
  readonly teamId: TeamId
  readonly concurrentAgents: number
  readonly messages: number
  readonly experimentRuns: number
  readonly startedAt: Timestamp | null
}

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

export type MemberStatus = 'provisioning' | 'running' | 'inactive' | 'failed' | 'disposed'

/** Durable mapping between a research role and a real DSH agent session. */
export interface TeamMember {
  readonly teamId: TeamId
  readonly agentId: AgentId
  readonly role: ResearchRole
  readonly name: string
  /** DSH session id of the direct parent agent (the captain for workers). */
  readonly parentAgentId: AgentId | null
  /** DSH provider name used to create the continuable child. */
  readonly provider: string
  readonly status: MemberStatus
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  /** Last DSH turn outcome observed by the bridge, for diagnostics only. */
  readonly lastTurn: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | null
  readonly failureReason: string | null
  /** Task currently leased by this member, if any. */
  readonly currentTaskId: TaskId | null
  readonly revision: number
}

/** Durable record of one team run. */
export interface TeamRecord {
  readonly teamId: TeamId
  readonly title: string
  readonly objective: string
  /** Canonical research state version observed when the team started. */
  readonly stateVersionAtStart: StateVersion | null
  readonly captainAgentId: AgentId
  readonly projectRoot: string | null
  readonly researchStatePath: string | null
  readonly pipelineRoot: string | null
  readonly budget: Budget
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly status: 'active' | 'paused' | 'stopped' | 'completed'
  readonly revision: number
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Closed vocabulary of research message types. Each type maps to a payload
 * shape in {@link TeamMessagePayloadMap}.
 */
export type TeamMessageType =
  | 'task_request'
  | 'task_result'
  | 'task_blocked'
  | 'resource_request'
  | 'hypothesis_proposal'
  | 'prediction'
  | 'mechanism_competition'
  | 'counterexample'
  | 'literature_note'
  | 'experiment_finding'
  | 'experiment_error'
  | 'challenge'
  | 'assurance_verdict'
  | 'captain_decision'
  | 'ack'
  | 'status'

/** Lifecycle of one message inside the durable ledger. */
export type DeliveryStatus =
  | 'pending'
  | 'routed'
  | 'delivered'
  | 'acknowledged'
  | 'failed'
  | 'dead_letter'
  | 'rejected'

/**
 * How much authority a message carries. Only `captain_ruling` may direct team
 * scheduling; only `validated_evidence` may back a state proposal, and even
 * then only after the state gate re-checks the underlying artifact.
 */
export type MessageTrust = 'unverified_input' | 'captain_ruling' | 'validated_evidence'

/** Reference to a staged research artifact. */
export interface ArtifactRef {
  readonly artifactId: ArtifactId
  readonly kind: ResearchArtifactKind
}

/** Reference to evidence inside the existing pipeline vocabulary. */
export interface EvidenceRef {
  /** Canonical object id in the Research State (`evidence`, `experiment`, ...). */
  readonly objectId: string
  /** Which canonical collection the id belongs to. */
  readonly collection: 'evidence' | 'experiment' | 'claim' | 'hypothesis' | 'prediction' | 'memory'
  /** Where the observation came from: a file, a command, a paper. */
  readonly source: SourceRef
  /** Tier declared by the producer. The bridge never upgrades it. */
  readonly tier: EvidenceTier
}

/** A pointer to a real, inspectable origin. Never free-floating prose. */
export interface SourceRef {
  readonly kind: 'file' | 'command' | 'url' | 'artifact' | 'session-event' | 'paper'
  readonly locator: string
  /** Optional content hash so a later reader can detect drift. */
  readonly sha256?: string
  readonly note?: string
}

/** Evidence tiers preserved from `references/evidence-policy.md`. */
export type EvidenceTier = 'speculation' | 'raw_observation' | 'reproduced' | 'reviewed'

/** Payload per message type. Kept small: typed products, not chat history. */
export interface TeamMessagePayloadMap {
  readonly task_request: {
    readonly taskId: TaskId
    readonly title: string
    readonly objective: string
    readonly role: ResearchRole
    readonly constraints: readonly string[]
  }
  readonly task_result: {
    readonly taskId: TaskId
    readonly summary: string
    readonly outcomes: readonly string[]
    readonly limitations: readonly string[]
  }
  readonly task_blocked: {
    readonly taskId: TaskId
    readonly blocker: string
    readonly neededFrom: readonly ResearchRole[]
  }
  readonly resource_request: {
    readonly resource: 'gpu' | 'network' | 'disk' | 'budget' | 'agent'
    readonly amount: string
    readonly justification: string
  }
  readonly hypothesis_proposal: {
    readonly statement: string
    readonly mechanismSketch: string
    readonly falsifier: string
    readonly islandId: string
  }
  readonly prediction: {
    readonly statement: string
    readonly observable: string
    readonly expectedRange: string
    readonly discriminatingAgainst: readonly string[]
  }
  readonly mechanism_competition: {
    readonly mechanisms: readonly string[]
    readonly discriminatingObservable: string
    readonly claim: string
  }
  readonly counterexample: {
    readonly targets: string
    readonly construction: string
    readonly impact: 'fatal' | 'serious' | 'minor'
    readonly assumptionBroken: string
  }
  readonly literature_note: {
    readonly nearestWork: readonly string[]
    readonly delta: string
    readonly threatToNovelty: 'high' | 'medium' | 'low'
  }
  readonly experiment_finding: {
    readonly taskId: TaskId
    readonly result: string
    readonly artifactPaths: readonly string[]
    readonly preregistered: boolean
  }
  readonly experiment_error: {
    readonly taskId: TaskId
    readonly error: string
    readonly retryable: boolean
    readonly consumedRuns: number
  }
  readonly challenge: {
    readonly targetMessageId: MessageId
    readonly reason: string
    readonly requestedAction: string
  }
  readonly assurance_verdict: {
    readonly targetArtifacts: readonly ArtifactId[]
    readonly verdict: 'pass' | 'fail' | 'hold'
    readonly reasons: readonly string[]
    readonly evidenceValid: boolean
  }
  readonly captain_decision: {
    readonly decisionId: string
    readonly action: string
    readonly rationale: string
    readonly nextTasks: readonly TaskId[]
  }
  readonly ack: {
    readonly ackedMessageId: MessageId
    readonly consumerAgentId: AgentId
    readonly outcome: 'accepted' | 'rejected' | 'duplicate'
  }
  readonly status: {
    readonly state: string
    readonly detail: string
  }
}

export type TeamMessageTypeOf<K extends TeamMessageType> = TeamMessagePayloadMap[K]

/**
 * One durable team message. Field names marked with `*` are contractually
 * required by the RTB specification and must never be removed.
 */
export interface TeamMessage {
  /** * */ readonly message_id: MessageId
  /** * */ readonly team_id: TeamId
  /** * */ readonly task_id: TaskId | null
  /** * Live DSH identity of the sender. Never a name written in prose. */
  readonly sender_agent_id: AgentId
  readonly sender_role: ResearchRole
  /** * */ readonly recipient_agent_id: AgentId
  readonly recipient_role: ResearchRole
  /** * */ readonly message_type: TeamMessageType
  /** * Pipeline route, e.g. `R3`. Null when the message is not phase-bound. */
  readonly research_route: string | null
  /** * Canonical state version observed by the sender, if any. */
  readonly state_version: StateVersion | null
  /** * */ readonly artifact_refs: readonly ArtifactRef[]
  /** * */ readonly evidence_refs: readonly EvidenceRef[]
  readonly payload: TeamMessagePayloadMap[TeamMessageType]
  /** Short human summary; never the agent's whole context. */
  readonly summary: string
  readonly trust: MessageTrust
  /** * */ readonly created_at: Timestamp
  /** * */ readonly delivery_status: DeliveryStatus
  readonly attempt: number
  readonly in_reply_to: MessageId | null
  readonly idempotency_key: string
  /** How the bytes actually travelled, so authority can be audited later. */
  readonly routing: MessageRouting
  readonly failure_reason: string | null
  readonly revision: number
}

/** Physical transport used for one message. */
export interface MessageRouting {
  readonly via: 'parent_child_direct' | 'captain_relay' | 'undelivered'
  readonly hops: number
  /** Agent ids the message physically passed through. */
  readonly path: readonly AgentId[]
  /** DSH inbox message id of the final delivery, when one exists. */
  readonly dsh_message_id: string | null
}

/** Caller-supplied half of a message; the service fills the rest. */
export interface TeamMessageDraft {
  readonly taskId: TaskId | null
  readonly recipientAgentId: AgentId
  readonly messageType: TeamMessageType
  readonly researchRoute?: string | null
  readonly stateVersion?: StateVersion | null
  readonly artifactRefs?: readonly ArtifactRef[]
  readonly evidenceRefs?: readonly EvidenceRef[]
  readonly payload: TeamMessagePayloadMap[TeamMessageType]
  readonly summary: string
  readonly inReplyTo?: MessageId | null
  readonly idempotencyKey?: string
}

/** Why a message was refused. Stable, so tests can assert on it. */
export type MessageRejectionCode =
  | 'UNKNOWN_SENDER'
  | 'SENDER_NOT_A_MEMBER'
  | 'UNKNOWN_RECIPIENT'
  | 'IDENTITY_MISMATCH'
  | 'ROLE_NOT_PERMITTED_TO_SEND'
  | 'RECIPIENT_NOT_PERMITTED'
  | 'TASK_NOT_OWNED'
  | 'PAYLOAD_INVALID'
  | 'BUDGET_EXCEEDED'
  | 'STATE_VERSION_STALE'

// ---------------------------------------------------------------------------
// Task DAG
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'claimed'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Exclusive lease held by one agent while it works a task. */
export interface TaskLease {
  readonly owner: AgentId
  readonly attemptId: AttemptId
  readonly acquiredAt: Timestamp
  readonly expiresAt: Timestamp
}

/**
 * One node of the lightweight research task graph. Field names marked `*` are
 * contractually required by the specification.
 */
export interface ResearchTask {
  /** * */ readonly task_id: TaskId
  readonly team_id: TeamId
  /** * */ readonly parent_task_id: TaskId | null
  /** * */ readonly dependencies: readonly TaskId[]
  /** * */ readonly role: ResearchRole
  readonly title: string
  readonly objective: string
  /** * */ readonly status: TaskStatus
  /** * */ readonly assigned_agent: AgentId | null
  /** * */ readonly attempt_id: AttemptId | null
  readonly attempt_count: number
  readonly max_attempts: number
  /** * */ readonly input_artifacts: readonly ArtifactRef[]
  /** * */ readonly output_artifacts: readonly ArtifactRef[]
  /** * */ readonly budget: Budget
  /** * */ readonly failure_reason: string | null
  readonly lease: TaskLease | null
  readonly research_route: string | null
  readonly state_version: StateVersion | null
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
  /** Compare-and-set revision; every update must present the current value. */
  readonly revision: number
  readonly idempotency_key: string
  readonly progress: TaskProgress
}

export interface TaskProgress {
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
  readonly messages: number
  readonly experimentRuns: number
}

/** Task creation input. */
export interface TaskDraft {
  readonly taskId?: TaskId
  readonly parentTaskId?: TaskId | null
  readonly dependencies?: readonly TaskId[]
  readonly role: ResearchRole
  readonly title: string
  readonly objective: string
  readonly inputArtifacts?: readonly ArtifactRef[]
  readonly budget?: Partial<Budget>
  readonly maxAttempts?: number
  readonly researchRoute?: string | null
  readonly stateVersion?: StateVersion | null
  readonly idempotencyKey?: string
}

export type TaskErrorCode =
  | 'TASK_NOT_FOUND'
  | 'DEPENDENCIES_UNSATISFIED'
  | 'DEPENDENCY_CYCLE'
  | 'ALREADY_CLAIMED'
  | 'REVISION_CONFLICT'
  | 'NOT_THE_OWNER'
  | 'ATTEMPTS_EXHAUSTED'
  | 'INVALID_TRANSITION'
  | 'BUDGET_EXCEEDED'
  | 'ROLE_MISMATCH'

// ---------------------------------------------------------------------------
// Research artifacts
// ---------------------------------------------------------------------------

/** The nine legal staged hand-off products. Not a tenth Research State object. */
export type ResearchArtifactKind =
  | 'hypothesis_proposal'
  | 'mechanism_model'
  | 'novel_prediction'
  | 'discriminating_intervention'
  | 'literature_evidence'
  | 'experiment_result'
  | 'counterexample'
  | 'assurance_verdict'
  | 'research_decision_proposal'

/** Epistemic status of an artifact. Only the gate may raise it. */
export type EpistemicStatus =
  | 'speculation'
  | 'raw_observation'
  | 'evidence_supported'
  | 'reviewed'
  | 'rejected'

/** Legal references from an artifact into canonical Research State objects. */
export interface CanonicalRefs {
  readonly claims: readonly string[]
  readonly hypotheses: readonly string[]
  readonly evidence: readonly string[]
  readonly experiments: readonly string[]
  readonly predictions: readonly string[]
  readonly cognitiveMemory: readonly string[]
}

/** One staged research product with full provenance. */
export interface ResearchArtifact {
  readonly artifact_id: ArtifactId
  readonly kind: ResearchArtifactKind
  readonly team_id: TeamId
  readonly task_id: TaskId
  readonly attempt_id: AttemptId | null
  readonly producer_agent_id: AgentId
  readonly producer_role: ResearchRole
  readonly epistemic_status: EpistemicStatus
  readonly research_route: string | null
  /** Canonical state version this artifact was produced against. */
  readonly state_version: StateVersion | null
  readonly refs: CanonicalRefs
  readonly evidence_refs: readonly EvidenceRef[]
  readonly content: Readonly<Record<string, unknown>>
  readonly provenance: ArtifactProvenance
  readonly created_at: Timestamp
  readonly idempotency_key: string
  readonly revision: number
}

export interface ArtifactProvenance {
  /** Bridge messages that carried this artifact's inputs. */
  readonly messageIds: readonly MessageId[]
  /** Task attempts that produced it. */
  readonly attemptIds: readonly AttemptId[]
  /** Raw sources (files, commands, papers). */
  readonly sources: readonly SourceRef[]
  /** True when the artifact came from a real execution, not from reasoning. */
  readonly executed: boolean
  /** Assurance verdicts that already looked at this artifact. */
  readonly verdicts: readonly ArtifactId[]
}

// ---------------------------------------------------------------------------
// Research decision + state gate
// ---------------------------------------------------------------------------

/** Everything the captain must record before a state change may be proposed. */
export interface ResearchDecisionProposal {
  readonly proposal_id: ProposalId
  readonly team_id: TeamId
  /** The important scientific question right now. */
  readonly question: string
  /** Competing mechanisms on the table. */
  readonly competingMechanisms: readonly string[]
  /** Per-role support and dissent, preserved verbatim. */
  readonly positions: readonly DecisionPosition[]
  /** New discriminating predictions. */
  readonly discriminatingPredictions: readonly string[]
  /** Whether the evidence backing the proposal is valid. */
  readonly evidenceValid: boolean
  readonly evidenceRefs: readonly EvidenceRef[]
  /** Cheapest next intervention that would discriminate. */
  readonly cheapestNextIntervention: string
  readonly stagnationTriggered: boolean
  readonly paradigmEscapeTriggered: boolean
  /** Canonical object mutations requested by the proposal. */
  readonly requestedStateChanges: readonly StateChangeRequest[]
  readonly artifactRefs: readonly ArtifactRef[]
  /** Canonical state version the proposal was built against. */
  readonly baseStateVersion: StateVersion | null
  readonly createdAt: Timestamp
}

/** One role's position. Dissent is data, not noise. */
export interface DecisionPosition {
  readonly role: ResearchRole
  readonly agentId: AgentId
  readonly stance: 'support' | 'oppose' | 'abstain' | 'unresolved'
  readonly reason: string
  readonly messageIds: readonly MessageId[]
}

/** A requested canonical mutation. The gate decides whether it may happen. */
export interface StateChangeRequest {
  readonly operation: 'add' | 'update' | 'supersede'
  readonly collection: CanonicalRefs extends never ? never : 'claim' | 'hypothesis' | 'evidence' | 'experiment' | 'prediction'
  readonly objectId: string | null
  readonly summary: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** Outcome of a gate evaluation. `hold` is a first-class, honest result. */
export type GateOutcome = 'committed' | 'rejected' | 'hold'

export interface StateGateResult {
  readonly outcome: GateOutcome
  readonly proposalId: ProposalId
  readonly code: StateGateCode
  readonly reasons: readonly string[]
  readonly stateVersionBefore: StateVersion | null
  readonly stateVersionAfter: StateVersion | null
  /** Which validator/writer actually performed the change, if any. */
  readonly performedBy: string | null
  readonly stagedPaths: readonly string[]
  readonly checkedAt: Timestamp
}

export type StateGateCode =
  | 'OK'
  | 'EVIDENCE_NOT_VALID'
  | 'MISSING_ASSURANCE_VERDICT'
  | 'ASSURANCE_FAILED'
  | 'ASSURANCE_HELD'
  | 'STATE_VERSION_STALE'
  | 'STATE_VERSION_MISSING'
  | 'NO_LEGAL_WRITER'
  | 'WRITER_FAILED'
  | 'VALIDATOR_FAILED'
  | 'CONCURRENT_WRITER'
  | 'ILLEGAL_MUTATION'
  | 'UNAUTHORIZED_PRODUCER'
  /** The optional external policy verifier denied the action. */
  | 'POLICY_DENIED'
  /** The optional external policy verifier could not allow it, or the rule set changed in flight. */
  | 'POLICY_HOLD'

// ---------------------------------------------------------------------------
// Durable execution
// ---------------------------------------------------------------------------

/** External operations the bridge journals before performing them. */
export type TeamAction =
  | 'spawn_agent'
  | 'resume_agent'
  | 'send_message'
  | 'interrupt_agent'
  | 'start_experiment'
  | 'commit_state'
  | 'consolidate_memory'
  | 'release_task'
  | 'dispose_team'
  /** The optional external verifier recorded which rule version allowed an action. */
  | 'policy_authority'
  /** The task mirror could not be reconciled against the native board. */
  | 'reconcile_task'
  /** A decision was recorded as durable audit state. */
  | 'record_decision'
  /** A recorded decision was deliberately pushed to named members. */
  | 'notify_decision'

export type ActionOutcome = 'ok' | 'failed' | 'unknown' | 'skipped'

/**
 * A deliberate request to tell team members about a recorded decision.
 *
 * Recording a decision and telling anyone about it are separate acts: the record
 * is durable audit state on its own, and a broadcast happens only because a
 * caller asked for one and said why.
 */
export interface DecisionNotificationRequest {
  /** Members to notify; omitted means every live member except the captain. */
  readonly memberAgentIds?: readonly AgentId[]
  /** Why these members must know. Required, so a broadcast is never implicit. */
  readonly reason: string
}

/** One attempted decision notification, carrying the real sender and both ids. */
export interface DecisionDelivery {
  /** The decision this delivery carries. */
  readonly decisionId: string
  /** The journaled action id for this delivery attempt. */
  readonly actionId: ActionId
  /** The agent that really sent it. Never a synthetic or borrowed identity. */
  readonly senderAgentId: AgentId
  /** The member that was addressed. */
  readonly targetAgentId: AgentId
  /** Which transport carried it. */
  readonly via: 'native_team_edge' | 'rtb_mailbox'
  /** The native team message id, when the native edge carried it. */
  readonly nativeMessageId: string | null
  /** The mailbox row id, when the legacy mailbox carried it. */
  readonly messageId: MessageId | null
  /** The transport outcome, or `failed` when the attempt was refused. */
  readonly status: string
  /** Why the attempt failed, or null. */
  readonly failureReason: string | null
}

/** What recording a decision did about notifying members. */
export interface DecisionNotification {
  /** Whether a notification was asked for at all. */
  readonly requested: boolean
  /** Why, in the caller's words, or the reason nothing was sent. */
  readonly reason: string
  /** One row per attempted delivery; empty when nothing was requested. */
  readonly deliveries: readonly DecisionDelivery[]
}

/** Write-ahead intent / result record. */
export interface JournalEntry {
  readonly action_id: ActionId
  readonly team_id: TeamId
  readonly task_id: TaskId | null
  readonly attempt_id: AttemptId | null
  readonly kind: 'intent' | 'result'
  readonly action: TeamAction
  readonly payload: Readonly<Record<string, unknown>>
  readonly outcome: ActionOutcome | null
  readonly error: string | null
  readonly idempotency_key: string
  readonly created_at: Timestamp
}

/** Durable pointer to what the team should do next after a restart. */
export interface TeamRunState {
  readonly teamId: TeamId
  readonly runId: string
  readonly status: 'active' | 'paused' | 'stopped' | 'completed'
  readonly currentStateVersion: StateVersion | null
  readonly pendingActionIds: readonly ActionId[]
  readonly openTaskIds: readonly TaskId[]
  readonly unacknowledgedMessageIds: readonly MessageId[]
  readonly lastCheckpointAt: Timestamp
  readonly nextResumableAction: string | null
  readonly revision: number
}

/** What recovery decided to do about one unfinished external action. */
export interface RecoveryDecision {
  readonly actionId: ActionId
  readonly action: TeamAction
  readonly decision: 'retry' | 'skip' | 'verify_then_retry' | 'abandon'
  readonly reason: string
}

/** Full recovery report; `hold` means the bridge refuses to guess. */
export interface RecoveryReport {
  readonly teamId: TeamId
  readonly decisions: readonly RecoveryDecision[]
  readonly resumedAgents: readonly AgentId[]
  readonly redeliveredMessages: readonly MessageId[]
  readonly requeuedTasks: readonly TaskId[]
  readonly held: boolean
  readonly notes: readonly string[]
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** What a transport can actually do. Never assume; always ask. */
export interface TransportCapabilities {
  readonly kind: string
  readonly continuableChildren: boolean
  readonly coldResume: boolean
  readonly interrupt: boolean
  readonly listChildren: boolean
  /** Whether the transport can address a non-adjacent agent directly. */
  readonly siblingDirectMessaging: boolean
  readonly durableAcrossRestart: boolean
  /** DSH provider name that backs this transport. */
  readonly provider: string | null
}

export interface StartWorkerSpec {
  readonly agentId: AgentId | null
  readonly label: string
  readonly prompt: string
  readonly parentAgentId: AgentId
  readonly persona?: string | null
  readonly toolFilter?: readonly string[] | null
  readonly provider?: string | null
  readonly signal: AbortSignal
}

export interface StartedWorker {
  readonly agentId: AgentId
  /** DSH inbox message id of the accepted initial prompt. */
  readonly dshMessageId: string
  readonly resumed: boolean
}

export type DeliveryOutcome = 'accepted' | 'queued' | 'rejected'

export interface DeliveryReceipt {
  readonly outcome: DeliveryOutcome
  readonly dshMessageId: string | null
  readonly error: string | null
  readonly code: string | null
}

export interface ChildEntry {
  readonly agentId: AgentId
  readonly mode: 'continuable' | 'one-shot' | 'unknown'
  readonly label: string | null
}

/**
 * Minimal team transport seam. Adapters implement it; tests fake it.
 * Implementations must never forge an agent identity: every send receives the
 * real DSH `Agent` that is the sender.
 */
export interface TeamTransport {
  readonly capabilities: TransportCapabilities
  /** Establish a durable continuable child of `parentAgentId`. */
  startWorker(spec: StartWorkerSpec): Promise<StartedWorker>
  /** Cold-resume a known child so it can receive messages again. */
  resumeWorker(agentId: AgentId, parentAgentId: AgentId, signal: AbortSignal): Promise<StartedWorker>
  /** Deliver one already-persisted envelope along an *adjacent* edge. */
  sendAdjacent(senderAgentId: AgentId, targetAgentId: AgentId, text: string, signal: AbortSignal): Promise<DeliveryReceipt>
  /** Ask a running descendant to stop its current turn. */
  interrupt(targetAgentId: AgentId, byAgentId: AgentId): Promise<void>
  listChildren(parentAgentId: AgentId): Promise<readonly ChildEntry[]>
  /** Is this agent resident (loaded) right now? */
  isResident(agentId: AgentId): boolean
  /** Release every resource this transport owns. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Persistence seam
// ---------------------------------------------------------------------------

export interface MessageQuery {
  readonly recipientAgentId?: AgentId
  readonly senderAgentId?: AgentId
  readonly taskId?: TaskId
  readonly status?: DeliveryStatus
  readonly limit?: number
}

export interface TaskQuery {
  readonly status?: readonly TaskStatus[]
  readonly role?: ResearchRole
  readonly assignedAgent?: AgentId
  readonly limit?: number
}

export interface ArtifactQuery {
  readonly kind?: ResearchArtifactKind
  readonly taskId?: TaskId
  readonly producerAgentId?: AgentId
  readonly limit?: number
}

/**
 * Durable store. One implementation is SQLite; tests use an in-memory fake.
 * Every mutating method that can race takes an explicit expected revision.
 */
export interface TeamStore {
  upsertTeam(team: TeamRecord): TeamRecord
  getTeam(teamId: TeamId): TeamRecord | undefined
  /**
   * Every team in the store, oldest first. Needed to resolve which team a
   * caller agent belongs to when a tool receives only an agent identity.
   */
  listTeams(): readonly TeamRecord[]

  upsertMember(member: TeamMember): TeamMember
  getMember(teamId: TeamId, agentId: AgentId): TeamMember | undefined
  listMembers(teamId: TeamId): readonly TeamMember[]

  insertTask(task: ResearchTask): ResearchTask
  getTask(taskId: TaskId): ResearchTask | undefined
  listTasks(teamId: TeamId, query?: TaskQuery): readonly ResearchTask[]
  /** Compare-and-set update. Throws {@link StoreConflictError} on a stale revision. */
  updateTask(task: ResearchTask, expectedRevision: number): ResearchTask
  /** Atomically take the exclusive lease. Throws when already leased. */
  claimTask(taskId: TaskId, owner: AgentId, attemptId: AttemptId, expectedRevision: number, expiresAt: Timestamp): ResearchTask
  /** Atomically drop the lease, keeping the attempt history. */
  releaseTask(taskId: TaskId, expectedRevision: number, reason: string | null): ResearchTask

  appendMessage(message: TeamMessage): TeamMessage
  getMessage(messageId: MessageId): TeamMessage | undefined
  listMessages(teamId: TeamId, query?: MessageQuery): readonly TeamMessage[]
  updateMessage(messageId: MessageId, expectedRevision: number, patch: MessagePatch): TeamMessage
  findByMessageIdempotencyKey(teamId: TeamId, key: string): TeamMessage | undefined

  putArtifact(artifact: ResearchArtifact): ResearchArtifact
  getArtifact(artifactId: ArtifactId): ResearchArtifact | undefined
  listArtifacts(teamId: TeamId, query?: ArtifactQuery): readonly ResearchArtifact[]
  findArtifactByIdempotencyKey(teamId: TeamId, key: string): ResearchArtifact | undefined

  appendJournal(entry: JournalEntry): JournalEntry
  listJournal(teamId: TeamId): readonly JournalEntry[]
  findJournalByActionId(actionId: ActionId): JournalEntry | undefined
  findJournalByIdempotencyKey(teamId: TeamId, key: string): JournalEntry | undefined

  saveRunState(state: TeamRunState): TeamRunState
  getRunState(teamId: TeamId): TeamRunState | undefined

  recordBudget(teamId: TeamId, delta: Partial<Omit<BudgetUsage, 'teamId'>>): BudgetUsage
  getBudgetUsage(teamId: TeamId): BudgetUsage

  close(): void

  /** True once the store was closed. Lets a host or an acceptance probe verify teardown. */
  readonly closed: boolean
}

export interface MessagePatch {
  readonly delivery_status?: DeliveryStatus
  readonly routing?: MessageRouting
  readonly attempt?: number
  readonly failure_reason?: string | null
}

/** Raised by the store when a compare-and-set precondition fails. */
export interface StoreConflict {
  readonly code: 'REVISION_CONFLICT' | 'ALREADY_CLAIMED' | 'DUPLICATE'
  readonly entity: string
  readonly id: string
  readonly expected: number
  readonly actual: number
}

// ---------------------------------------------------------------------------
// Stagnation / strategy
// ---------------------------------------------------------------------------

/** Observations the captain feeds to stagnation detection. */
export interface StagnationSignals {
  readonly teamId: TeamId
  readonly consecutiveRounds: number
  /** Candidate artifacts produced in the recent window. */
  readonly recentArtifacts: readonly ResearchArtifact[]
  /** Messages produced in the recent window. */
  readonly recentMessages: readonly TeamMessage[]
  /** Predictions that turned out to discriminate between mechanisms. */
  readonly discriminatingPredictionCount: number
  /** Canonical state version at the start of the window. */
  readonly windowStartStateVersion: StateVersion | null
  /** Canonical state version now. */
  readonly currentStateVersion: StateVersion | null
  /** History of attributions used to explain anomalies. */
  readonly attributionHistory: readonly string[]
  /** True when the state changed because of a decision, not just new prose. */
  readonly decisionChangedState: boolean
}

export type StagnationKind =
  | 'isomorphic_candidates'
  | 'repeated_attribution'
  | 'no_discriminating_prediction'
  | 'shared_unproven_assumption'
  | 'documents_without_decision'

export interface StagnationVerdict {
  readonly stagnant: boolean
  readonly kinds: readonly StagnationKind[]
  readonly reasons: readonly string[]
  readonly recommendedAction: 'continue' | 'stagnation_breaker' | 'paradigm_escape'
  /** Fraction of recent candidates that are structurally equivalent. */
  readonly isomorphismRatio: number
}

/** A strategy suggestion. Never applied by itself. */
export interface StrategyRecommendation {
  readonly recommendationId: string
  readonly teamId: TeamId
  readonly subject:
    | 'role_mix'
    | 'exploration_operator'
    | 'dependency_bottleneck'
    | 'information_exchange'
  readonly suggestion: string
  readonly supportingOutcomes: readonly string[]
  /**
   * `generated` — recorded only.
   * `consumed` — a captain decision actually cited it.
   * `validated` — an independent test showed it improves outcomes.
   */
  readonly status: 'generated' | 'consumed' | 'validated'
  readonly evidenceNote: string
  readonly createdAt: Timestamp
}
