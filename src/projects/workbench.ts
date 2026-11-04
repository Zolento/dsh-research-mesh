/** Read-only Workbench projections assembled from the Mesh registry and RSI state. */

import type { MeshJobRecord, MeshWorkspaceRecord, GpuLeaseRecord, MeshEventRecord } from '../storage/types.ts';
import type { TeamView, SubagentView } from '../teams/manager.ts';
import type { MeshTaskView } from '../scheduler/scheduler.ts';
import type { ProjectView } from './registry.ts';
import type { AgentModelRecord } from '../storage/types.ts';

/** One RSI scheduler action, exactly as stored in `scheduler.json`. */
export interface RsiNextAction {
  readonly action: string;
  readonly type: string;
  readonly target: string;
  readonly eig: string;
  readonly cost: string;
}

/** Read-only RSI summary; `phaseAdvisory` is never a Mesh-invented stage. */
export interface RsiSummary {
  readonly available: boolean;
  readonly stateVersion: string | null;
  readonly goal: string | null;
  readonly phaseAdvisory: string | null;
  readonly updatedAt: string | null;
  readonly openCriticalUncertainties: number;
  readonly plannedExperiments: number;
  readonly runningExperiments: number;
  readonly acceptedExperimentResults: number;
  readonly scheduler: readonly RsiNextAction[];
  readonly error: string | null;
}

/** One group with its live membership, models and Mesh tasks. */
export interface WorkbenchGroup {
  readonly team: TeamView;
  readonly subagents: readonly SubagentView[];
  readonly agentModels: readonly AgentModelRecord[];
  readonly tasks: readonly MeshTaskView[];
  readonly workspace: MeshWorkspaceRecord | null;
  readonly liveStatus: Readonly<Record<string, string | null>>;
}

/** Everything the Project Workbench renders in one read. */
export interface WorkbenchSnapshot {
  readonly project: ProjectView;
  readonly groups: readonly WorkbenchGroup[];
  readonly jobs: readonly MeshJobRecord[];
  readonly gpuLeases: readonly GpuLeaseRecord[];
  readonly recentEvents: readonly MeshEventRecord[];
  readonly rsi: RsiSummary;
  readonly modelErrors: readonly { group: string; scope: string; provider: string; model: string; reason: string }[];
  readonly worker: { running: boolean; lastError: string | null };
  readonly generatedAt: string;
}
