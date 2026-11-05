/** Durable Mesh metadata types stored beside the integrated bridge domain. */

/** Research-group lifecycle in the Mesh registry. */
export type MeshGroupStatus = 'active' | 'paused' | 'stopped' | 'destroyed';

/** One group registry row. */
export interface MeshGroupRecord {
  readonly teamId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly workspaceId: string | null;
  readonly rootSessionId: string;
  readonly currentTaskId: string | null;
  readonly status: MeshGroupStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Declared execution class of a scheduled task. */
export type MeshTaskType = 'research' | 'local' | 'experiment';

/** External view of a task; remote states are resolved from `remoteStatus`. */
export type MeshTaskStatus =
  | 'PENDING'
  | 'READY'
  | 'CLAIMED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'SUBMITTED'
  | 'RECONCILE_REQUIRED'
  | 'OUTPUT_READY'
  | 'INGESTED'
  | 'ASSURANCE_PENDING';

/** Mesh-only task metadata; the bridge row owns DAG, lease and revision. */
export interface MeshTaskMeta {
  readonly taskId: string;
  readonly projectId: string;
  readonly taskType: MeshTaskType;
  readonly priority: number;
  /** Monotonic enqueue order used for deterministic FIFO. */
  readonly enqueueSeq: number;
  readonly workspaceId: string | null;
  readonly rsiStateVersion: string | null;
  readonly receiptRef: string | null;
  readonly jobId: string | null;
  readonly gpuId: number | null;
  /** Remote state, or null while the bridge status is authoritative. */
  readonly remoteStatus: MeshTaskStatus | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** JSON-safe task input; execution handlers own its shape. */
  readonly payloadJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Filesystem state of one registered worktree. */
export type MeshWorkspaceStatus = 'active' | 'missing' | 'broken' | 'removed';

/** One registered worktree. */
export interface MeshWorkspaceRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly teamId: string | null;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: MeshWorkspaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** GPU lease lifecycle. `quarantined` blocks reuse until an explicit release. */
export type GpuLeaseState = 'reserved' | 'active' | 'released' | 'quarantined';

/** One GPU lease row. */
export interface GpuLeaseRecord {
  readonly leaseId: string;
  readonly workerId: string;
  readonly gpuId: number;
  readonly taskId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly state: GpuLeaseState;
  readonly verified: boolean;
  readonly acquiredAt: string;
  readonly releasedAt: string | null;
}

/** Execution-layer job lifecycle; independent of scientific status. */
export type MeshJobStatus =
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'submitted_unconfirmed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'output_ready'
  | 'ingested'
  | 'reconcile_required'
  | 'cancelled';

/** One durably stored job manifest and its execution state. */
export interface MeshJobRecord {
  readonly jobId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly workerId: string;
  readonly gpuId: number;
  readonly manifestJson: string;
  readonly manifestDigest: string;
  readonly status: MeshJobStatus;
  readonly remoteDir: string;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** One verified ingested artifact. */
export interface MeshArtifactRecord {
  readonly artifactId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

/** One durable state-change record for audit and restart diagnosis. */
export interface MeshEventRecord {
  readonly seq: number;
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: string;
  readonly payloadJson: string;
  readonly createdAt: string;
}

/** Model actually used to create one agent identity, for traceability. */
export interface AgentModelRecord {
  readonly sessionId: string;
  readonly teamId: string;
  readonly role: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
  readonly configVersion: string;
  readonly createdAt: string;
}

/** Execution outcome handoff destined for RSI; never a scientific verdict. */
export interface MeshOutcomeRecord {
  readonly jobId: string;
  readonly experimentId: string;
  readonly receiptId: string;
  readonly stateVersion: string;
  readonly artifactManifestDigest: string;
  readonly status: 'ASSURANCE_PENDING';
  readonly payloadJson: string;
  readonly createdAt: string;
}


/** Project lifecycle. `registered` means visible but not runnable in this runtime. */
export type MeshProjectStatus = 'active' | 'paused' | 'archived' | 'registered';

/** One Research Project registry row. */
export interface MeshProjectRecord {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  /** Absolute canonical RSI state path selected by the user. */
  readonly rsiStateRef: string;
  /** Absolute Git repository path selected by the user. */
  readonly repositoryRef: string;
  readonly status: MeshProjectStatus;
  /** Whether this runtime can create groups/worktrees for the project. */
  readonly runnable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Session roles inside a project. */
export type SessionRole = 'control' | 'captain' | 'member';

/** One durable project/session binding. */
export interface MeshSessionBinding {
  readonly bindingId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly groupId: string | null;
  readonly attachedAt: string;
  readonly detachedAt: string | null;
}
