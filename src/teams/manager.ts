/**
 * Mesh Team Manager.
 *
 * A group is a durable research route with one DSH root session (the Captain),
 * at most four registered subagent identities, and one isolated worktree.
 * Group, member and workspace rows share one SQLite transaction; quotas are
 * checked inside that transaction, so concurrent creators cannot overshoot.
 *
 * Quota boundary: Mesh enforces quotas on every Mesh-owned creation path. A
 * model-invoked native `subagent` tool creates children without passing through
 * this API; a deployment that needs a hard global stop must disable that tool
 * or install a host guard. The limitation is documented rather than hidden.
 */

import { MeshError } from '../errors.ts';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative as relativePath, resolve as resolvePath } from 'node:path';
import type { MeshConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshGroupRecord, MeshGroupStatus } from '../storage/types.ts';
import type { MeshLogger } from '../util/logger.ts';
import { newId, requireSlug } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import type { TeamMember, TeamRecord, ResearchRole, Budget } from '../bridge/types.ts';
import { readCanonicalStateFile, canonicalStatePath } from '../bridge/adapters/research-pipeline.ts';
import { roleProfile } from '../bridge/team/roles.ts';
import type { WorkspaceManager } from '../workspaces/manager.ts';
import type { CreateRootSessionInput, SessionHost } from './session-host.ts';
import type { ModelResolver, ResolvedModel } from './models.ts';

/** Roles a registered subagent may hold. */
export const WORKER_ROLES: readonly ResearchRole[] = [
  'discovery',
  'theory',
  'literature',
  'experiment',
  'assurance',
  'synthesis',
];

/** Mesh-facing group state. */
export type TeamStatus = 'active' | 'paused' | 'stopped' | 'destroyed';

/** One group as exposed by the Mesh API. */
export interface TeamView {
  readonly teamId: string;
  readonly name: string;
  readonly objective: string;
  readonly status: TeamStatus;
  readonly rootSessionId: string;
  readonly subagentSessionIds: readonly string[];
  readonly workspaceId: string | null;
  readonly workspacePath: string | null;
  readonly researchProjectId: string;
  readonly researchRouteId: string;
  readonly currentTaskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One registered subagent identity. */
export interface SubagentView {
  readonly teamId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly role: ResearchRole;
  readonly status: TeamMember['status'];
  readonly createdAt: string;
}

/** Input for creating a group. */
export interface CreateTeamInput {
  readonly projectId: string;
  readonly routeId: string;
  readonly name: string;
  readonly objective?: string;
  readonly baseRef?: string;
  readonly baseCommit?: string;
  readonly rootSessionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly researchStatePath?: string;
  readonly pipelineRoot?: string;
  readonly teamId?: string;
}

/** Input for registering a subagent identity. */
export interface RegisterSubagentInput {
  readonly teamId: string;
  readonly name: string;
  readonly role: ResearchRole;
  /** Caller-supplied durable session id; omitted creation uses the session host. */
  readonly sessionId?: string;
}

const DEFAULT_BUDGET: Budget = {
  maxConcurrentAgents: 4,
  maxTaskAttempts: 3,
  maxMessagesPerTask: 64,
  maxExperimentRuns: 8,
  maxWallClockMs: 24 * 60 * 60 * 1000,
};

function mapTeamStatus(status: TeamRecord['status']): TeamStatus {
  if (status === 'active') return 'active';
  if (status === 'paused') return 'paused';
  return 'paused';
}

function reverseStatus(status: TeamStatus): TeamRecord['status'] {
  if (status === 'active') return 'active';
  if (status === 'paused') return 'paused';
  return 'paused';
}

/** Team and quota registry over the integrated bridge store. */
export class TeamManager {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #workspaces: WorkspaceManager | null;
  readonly #sessions: SessionHost;
  readonly #models: ModelResolver | null;
  readonly #logger: MeshLogger;

  /**
   * @param config - resolved Mesh configuration.
   * @param store - Mesh metadata store.
   * @param sessions - root/subagent session binding.
   * @param workspaces - worktree manager; null disables workspace creation.
   * @param logger - structured logger.
   */
  constructor(
    config: MeshConfig,
    store: MeshStore,
    sessions: SessionHost,
    workspaces: WorkspaceManager | null,
    logger: MeshLogger,
    models: ModelResolver | null = null,
  ) {
    this.#config = config;
    this.#store = store;
    this.#sessions = sessions;
    this.#workspaces = workspaces;
    this.#logger = logger;
    this.#models = models;
  }

  /** The integrated bridge store. */
  get store(): MeshStore {
    return this.#store;
  }

  /** Session binding used by this manager. */
  get sessionHost(): SessionHost {
    return this.#sessions;
  }

  /**
   * Create a research group, its worktree and its DSH root session.
   * @param input - project, route, group name and optional base commit.
   * @returns the durable group view.
   */
  async createTeam(input: CreateTeamInput): Promise<TeamView> {
    const projectId = requireSlug(input.projectId, 'projectId');
    const routeId = requireSlug(input.routeId, 'routeId');
    const name = requireSlug(input.name, 'name');
    const teamId = input.teamId ?? newId('team');
    if (input.teamId !== undefined
      && (this.#store.teamStore.getTeam(teamId) !== undefined || this.#store.getGroup(teamId) !== undefined)) {
      throw new MeshError('TEAM_CONFLICT', `group id ${teamId} already exists`, { teamId });
    }
    const objective = input.objective?.trim() ?? `Research group ${name}`;
    const statePath = input.researchStatePath ?? canonicalStatePath(this.#config.projectRoot, routeId);
    const lexicalState = resolvePath(this.#config.projectRoot, statePath);
    const resolvedState = existsSync(lexicalState) ? realpathSync(lexicalState) : lexicalState;
    const stateRelative = relativePath(realpathSync(this.#config.projectRoot), resolvedState);
    if (stateRelative.startsWith('..') || isAbsolute(stateRelative)) {
      throw new MeshError('PATH_ESCAPE', 'research state path must stay inside the project root', { statePath });
    }
    const pipelineRoot = input.pipelineRoot ?? this.#config.rsi.skillPath ?? null;

    this.#assertQuota(projectId);

    let workspaceId: string | null = null;
    let workspacePath: string | null = null;
    let rootSessionId: string;
    let resolvedCaptain: ResolvedModel;
    try {
      if (this.#workspaces !== null) {
        const workspace = await this.#workspaces.createWorkspace({
          projectId,
          teamId,
          name,
          ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
          ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
        });
        workspaceId = workspace.workspaceId;
        workspacePath = workspace.path;
      }
      resolvedCaptain = await this.#resolveCaptainModel(name, input);
      if (this.#config.sessionBinding === 'external') {
        if (input.rootSessionId === undefined || input.rootSessionId.trim() === '') {
          throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'external sessionBinding requires rootSessionId', { teamId });
        }
        rootSessionId = input.rootSessionId;
      } else {
        const created = await this.#sessions.createRoot({
          teamId,
          projectId,
          name,
          cwd: workspacePath ?? this.#config.projectRoot,
          title: objective,
          provider: resolvedCaptain.provider,
          model: resolvedCaptain.model,
        } satisfies CreateRootSessionInput);
        rootSessionId = created.sessionId;
      }
    } catch (error) {
      if (workspaceId !== null && this.#workspaces !== null) {
        try {
          await this.#workspaces.cleanup(workspaceId, { confirm: true, force: true });
        } catch (cleanupError) {
          this.#logger.error('failed to clean up workspace after team creation failure', {
            workspaceId,
            error: String(cleanupError),
          });
        }
      }
      throw error;
    }

    const now = nowIso();
    const stateFile = readCanonicalStateFile(statePath);
    const team: TeamRecord = {
      teamId,
      title: name,
      objective,
      stateVersionAtStart: stateFile.version,
      captainAgentId: rootSessionId,
      projectRoot: this.#config.projectRoot,
      researchStatePath: statePath,
      pipelineRoot,
      budget: {
        ...DEFAULT_BUDGET,
        maxConcurrentAgents: this.#config.limits.maxSubagentsPerTeam,
      },
      createdAt: now,
      updatedAt: now,
      status: 'active',
      revision: 1,
    };
    const captain: TeamMember = {
      teamId,
      agentId: rootSessionId,
      role: 'captain',
      name: 'captain',
      parentAgentId: null,
      provider: this.#config.sessionBinding,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      lastTurn: null,
      failureReason: null,
      currentTaskId: null,
      revision: 1,
    };
    const group: MeshGroupRecord = {
      teamId,
      projectId,
      routeId,
      workspaceId,
      rootSessionId,
      currentTaskId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    try {
      this.#store.transaction(() => {
        if (this.#store.teamStore.getTeam(teamId) !== undefined || this.#store.getGroup(teamId) !== undefined) {
          throw new MeshError('TEAM_CONFLICT', `group id ${teamId} already exists`, { teamId });
        }
        this.#assertQuota(projectId);
        this.#store.teamStore.upsertTeam(team);
        this.#store.teamStore.upsertMember(captain);
        this.#store.recordAgentModel({
          sessionId: rootSessionId,
          teamId,
          role: 'captain',
          name: 'captain',
          provider: resolvedCaptain.provider,
          model: resolvedCaptain.model,
          source: resolvedCaptain.source,
          configVersion: resolvedCaptain.configVersion,
          createdAt: now,
        });
        this.#store.insertGroup(group);
        if (workspaceId !== null) this.#store.updateWorkspace(workspaceId, { teamId });
        this.#store.appendEvent('team', teamId, 'created', {
          projectId,
          routeId,
          workspaceId,
          rootSessionId,
        });
      });
    } catch (error) {
      await this.#sessions.disposeRoot(rootSessionId).catch(() => undefined);
      if (workspaceId !== null && this.#workspaces !== null) {
        try {
          await this.#workspaces.cleanup(workspaceId, { confirm: true, force: true });
        } catch (cleanupError) {
          this.#logger.error('failed to clean up workspace after team registry failure', {
            workspaceId,
            error: String(cleanupError),
          });
        }
      }
      throw error;
    }

    this.#logger.info('research group created', { teamId, projectId, routeId, workspaceId });
    return this.#view(teamId);
  }

  /**
   * Read one group.
   * @param teamId - group identity.
   * @returns group view.
   */
  get(teamId: string): TeamView {
    return this.#view(teamId);
  }

  /**
   * List groups, newest last.
   * @param projectId - optional project filter.
   * @returns group views.
   */
  list(projectId?: string): readonly TeamView[] {
    return this.#store.listGroups(projectId).map(group => this.#view(group.teamId));
  }

  /**
   * Pause a group. The worktree, sessions and registry are retained.
   * @param teamId - group identity.
   * @returns updated group.
   */
  pause(teamId: string): TeamView {
    return this.#transition(teamId, 'paused');
  }

  /**
   * Resume a paused group.
   * @param teamId - group identity.
   * @returns updated group.
   */
  resume(teamId: string): TeamView {
    return this.#transition(teamId, 'active');
  }

  /**
   * Stop a group without destroying it: no new tasks may be claimed, and the
   * group is visibly distinct from a merely paused group. Running tasks are
   * left to finish; callers cancel queued work explicitly.
   * @param teamId - group identity.
   * @returns updated group.
   */
  stop(teamId: string): TeamView {
    return this.#transition(teamId, 'stopped');
  }

  /**
   * Destroy only the Mesh management state. The worktree is retained until an
   * explicit `WorkspaceManager.cleanup` call.
   * @param teamId - group identity.
   * @returns updated group.
   */
  async destroy(teamId: string): Promise<TeamView> {
    const current = this.#store.getGroup(teamId);
    if (current === undefined) throw this.#notFound(teamId);
    if (current.status === 'destroyed') return this.#view(teamId);
    const team = this.#requireTeam(teamId);
    const members = this.#store.teamStore.listMembers(teamId)
      .filter(member => member.role !== 'captain' && member.status !== 'disposed');
    const now = nowIso();
    this.#store.transaction(() => {
      this.#store.teamStore.upsertTeam({
        ...team,
        status: 'stopped',
        updatedAt: now,
        revision: team.revision + 1,
      });
      this.#store.updateGroup(teamId, { status: 'destroyed', currentTaskId: null, updatedAt: now });
      this.#store.appendEvent('team', teamId, 'destroyed', {});
    });
    await this.#sessions.disposeRoot(team.captainAgentId);
    for (const member of members) {
      await this.#sessions.disposeRoot(member.agentId);
    }
    this.#logger.info('research group destroyed (workspace retained)', { teamId });
    return this.#view(teamId);
  }

  /**
   * Register one subagent identity under a group.
   * @param input - group, name, role and optional existing session id.
   * @returns registered identity.
   */
  async registerSubagent(input: RegisterSubagentInput): Promise<SubagentView> {
    const team = this.#requireTeam(input.teamId);
    const group = this.#store.getGroup(input.teamId);
    if (group === undefined) throw this.#notFound(input.teamId);
    if (team.status !== 'active' || group.status !== 'active') {
      throw new MeshError('TEAM_STATE_INVALID', 'subagents can only be registered in an active group', {
        teamId: input.teamId,
        status: team.status,
        groupStatus: group.status,
      });
    }
    const name = requireSlug(input.name, 'subagent name');
    if (!WORKER_ROLES.includes(input.role)) {
      throw new MeshError('INVALID_ARGUMENT', `unknown subagent role: ${input.role}`, { role: input.role });
    }
    roleProfile(input.role);
    this.#assertSubagentQuota(input.teamId);

    // A caller-supplied session is validated before any new DSH session is
    // created, so a duplicate refusal cannot leak an unused identity.
    if (input.sessionId !== undefined) {
      this.#assertSessionUnclaimed(input.teamId, input.sessionId);
    }
    const currentSubagents = this.#store.teamStore.listMembers(input.teamId)
      .filter(member => member.role !== 'captain' && member.status !== 'disposed').length;
    const resolved = await this.#resolveSubagentModel(team.title, name, currentSubagents + 1);
    let sessionId = input.sessionId;
    if (sessionId === undefined) {
      if (this.#config.sessionBinding === 'external') {
        throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'external binding requires a caller-supplied subagent sessionId', {
          teamId: input.teamId,
        });
      }
      const created = await this.#sessions.createSubagent({
        teamId: input.teamId,
        rootSessionId: team.captainAgentId,
        name,
        role: input.role,
        cwd: group.workspaceId !== null
          ? this.#workspaces?.get(group.workspaceId).path ?? this.#config.projectRoot
          : this.#config.projectRoot,
        provider: resolved.provider,
        model: resolved.model,
      });
      sessionId = created.sessionId;
    } else if (sessionId.trim() === '') {
      throw new MeshError('INVALID_ARGUMENT', 'subagent sessionId must not be empty');
    }
    const now = nowIso();
    const member: TeamMember = {
      teamId: input.teamId,
      agentId: sessionId,
      role: input.role,
      name,
      parentAgentId: team.captainAgentId,
      provider: this.#config.sessionBinding === 'dsh' ? 'dsh' : 'external',
      status: 'inactive',
      createdAt: now,
      updatedAt: now,
      lastTurn: null,
      failureReason: null,
      currentTaskId: null,
      revision: 1,
    };
    try {
      this.#store.transaction(() => {
        const liveTeam = this.#store.teamStore.getTeam(input.teamId);
        const liveGroup = this.#store.getGroup(input.teamId);
        if (liveTeam?.status !== 'active' || liveGroup?.status !== 'active') {
          throw new MeshError('TEAM_STATE_INVALID', 'group was paused or destroyed while registering a subagent', {
            teamId: input.teamId,
          });
        }
        this.#assertSubagentQuota(input.teamId);
        this.#assertSessionUnclaimed(input.teamId, sessionId);
        this.#store.teamStore.upsertMember(member);
        this.#store.recordAgentModel({
          sessionId,
          teamId: input.teamId,
          role: input.role,
          name,
          provider: resolved.provider,
          model: resolved.model,
          source: resolved.source,
          configVersion: resolved.configVersion,
          createdAt: now,
        });
        this.#store.appendEvent('team', input.teamId, 'subagent-registered', { sessionId, role: input.role });
      });
    } catch (error) {
      // The DSH session may already exist; release a locally owned handle when
      // possible. SessionController-owned sessions are persistent and remain.
      try { await this.#sessions.disposeRoot(sessionId); } catch { /* retain original failure */ }
      throw error;
    }
    this.#logger.info('subagent identity registered', { teamId: input.teamId, sessionId, role: input.role });
    return {
      teamId: input.teamId,
      sessionId,
      name,
      role: input.role,
      status: member.status,
      createdAt: now,
    };
  }

  /**
   * Release a registered subagent identity. The DSH session is not deleted.
   * @param teamId - group identity.
   * @param sessionId - subagent session id.
   */
  releaseSubagent(teamId: string, sessionId: string): void {
    const member = this.#store.teamStore.getMember(teamId, sessionId);
    if (member === undefined || member.role === 'captain') {
      throw new MeshError('SUBAGENT_NOT_FOUND', 'unknown subagent identity', { teamId, sessionId });
    }
    if (member.status === 'running' || member.currentTaskId !== null) {
      throw new MeshError('SUBAGENT_BUSY', 'cannot release a subagent that is running or owns a task', {
        teamId,
        sessionId,
        currentTaskId: member.currentTaskId,
      });
    }
    this.#store.transaction(() => {
      this.#store.teamStore.upsertMember({
        ...member,
        status: 'disposed',
        updatedAt: nowIso(),
        revision: member.revision + 1,
      });
      this.#store.appendEvent('team', teamId, 'subagent-released', { sessionId });
    });
  }

  /**
   * List registered subagents, including released ones.
   * @param teamId - group identity.
   * @returns subagent views.
   */
  listSubagents(teamId: string): readonly SubagentView[] {
    return this.#store.teamStore.listMembers(teamId)
      .filter(member => member.role !== 'captain')
      .map(member => ({
        teamId: member.teamId,
        sessionId: member.agentId,
        name: member.name,
        role: member.role,
        status: member.status,
        createdAt: member.createdAt,
      }));
  }

  /**
   * Count live (not released) subagents across every group.
   * @returns global count.
   */
  totalSubagents(): number {
    let total = 0;
    for (const group of this.#store.listGroups()) {
      if (group.status === 'destroyed') continue;
      total += this.#store.teamStore.listMembers(group.teamId)
        .filter(member => member.role !== 'captain' && member.status !== 'disposed').length;
    }
    return total;
  }

  /**
   * Reconcile the registry after a restart. Sessions are not resumed eagerly;
   * `resumeRootSession` loads one on demand.
   * @returns group views.
   */
  restore(): readonly TeamView[] {
    return this.list();
  }

  /**
   * Resume the persisted root session of one group.
   * @param teamId - group identity.
   */
  async resumeRootSession(teamId: string): Promise<void> {
    const team = this.#requireTeam(teamId);
    const group = this.#store.getGroup(teamId);
    if (group === undefined) throw this.#notFound(teamId);
    if (group.status === 'destroyed') {
      throw new MeshError('TEAM_STATE_INVALID', 'cannot resume a destroyed group', { teamId });
    }
    // Resume with the group's resolved captain model, not a stale plugin-wide
    // fallback. This keeps a restart consistent with the manual assignment.
    const resolved = await this.#resolveCaptainModel(team.title, {
      projectId: group.projectId,
      routeId: group.routeId,
      name: team.title,
    });
    await this.#sessions.resumeRoot(team.captainAgentId, resolved.provider, resolved.model);
  }

  /**
   * Record the current task on a group (null clears it).
   * @param teamId - group identity.
   * @param taskId - task or null.
   */
  setCurrentTask(teamId: string, taskId: string | null): void {
    this.#requireTeam(teamId);
    this.#store.updateGroup(teamId, { currentTaskId: taskId });
  }

  /** Release live session handles. Persisted sessions remain on disk. */
  async close(): Promise<void> {
    await this.#sessions.disposeAll();
  }

  // -- internals -----------------------------------------------------------

  #assertSessionUnclaimed(teamId: string, sessionId: string): void {
    if (this.#store.teamStore.getTeam(teamId)?.captainAgentId === sessionId) {
      throw new MeshError('SUBAGENT_DUPLICATE', 'the Captain session cannot also be a subagent', { teamId, sessionId });
    }
    for (const other of this.#store.listGroups()) {
      if (other.teamId === teamId) continue;
      if (this.#store.teamStore.getTeam(other.teamId)?.captainAgentId === sessionId) {
        throw new MeshError('SUBAGENT_DUPLICATE', 'a Captain session cannot be registered as a subagent', {
          teamId, otherTeamId: other.teamId, sessionId,
        });
      }
    }
    const inTeam = this.#store.teamStore.listMembers(teamId)
      .find(member => member.agentId === sessionId && member.status !== 'disposed');
    if (inTeam !== undefined) {
      throw new MeshError('SUBAGENT_DUPLICATE', 'this session is already registered in the group', { teamId, sessionId });
    }
    for (const other of this.#store.listGroups()) {
      if (other.teamId === teamId) continue;
      const duplicate = this.#store.teamStore.listMembers(other.teamId)
        .find(member => member.agentId === sessionId && member.status !== 'disposed');
      if (duplicate !== undefined) {
        throw new MeshError('SUBAGENT_DUPLICATE', 'a session can belong to only one group', {
          teamId, otherTeamId: other.teamId, sessionId,
        });
      }
    }
  }

  async #resolveCaptainModel(groupName: string, input: CreateTeamInput): Promise<ResolvedModel> {
    if (input.provider !== undefined || input.model !== undefined) {
      if (input.provider === undefined || input.model === undefined) {
        throw new MeshError('MODEL_CONFIG_INVALID', 'provider and model must be supplied together', { groupName });
      }
      if (this.#models !== null) {
        const entry = (await this.#models.listCatalog()).find(candidate => candidate.provider === input.provider && candidate.model === input.model);
        if (entry === undefined) {
          throw new MeshError('MODEL_CONFIG_INVALID', 'caller-selected provider/model is not registered', {
            provider: input.provider,
            model: input.model,
          });
        }
      }
      return { provider: input.provider, model: input.model, source: 'caller', configVersion: 'caller' };
    }
    if (this.#models !== null) return this.#models.resolveCaptain(groupName);
    if (this.#config.agent === undefined) {
      throw new MeshError('MODEL_CONFIG_INVALID', 'no group default model and no plugin agent fallback is configured', {
        groupName,
      });
    }
    return { ...this.#config.agent, source: 'plugin-config', configVersion: 'config' };
  }

  async #resolveSubagentModel(groupName: string, slot: string, ordinal?: number): Promise<ResolvedModel> {
    if (this.#models !== null) return this.#models.resolveSubagent(groupName, slot, ordinal);
    if (this.#config.agent === undefined) {
      throw new MeshError('MODEL_CONFIG_INVALID', 'no group default model and no plugin agent fallback is configured', {
        groupName,
        slot,
      });
    }
    return { ...this.#config.agent, source: 'plugin-config', configVersion: 'config' };
  }

  #assertQuota(projectId: string): void {
    const active = this.#store.listGroups().filter(group => group.status !== 'destroyed');
    if (active.length >= this.#config.limits.maxTeams) {
      throw new MeshError('TEAM_LIMIT', `at most ${this.#config.limits.maxTeams} research groups are supported`, {
        limit: this.#config.limits.maxTeams,
        active: active.length,
      });
    }
    const inProject = active.filter(group => group.projectId === projectId);
    if (inProject.length >= this.#config.limits.maxTeams) {
      throw new MeshError('TEAM_LIMIT', `project ${projectId} already has ${inProject.length} groups`, {
        projectId,
        limit: this.#config.limits.maxTeams,
      });
    }
  }

  #assertSubagentQuota(teamId: string): void {
    const inTeam = this.#store.teamStore.listMembers(teamId)
      .filter(member => member.role !== 'captain' && member.status !== 'disposed').length;
    if (inTeam >= this.#config.limits.maxSubagentsPerTeam) {
      throw new MeshError('SUBAGENT_LIMIT', `group ${teamId} already has ${inTeam} subagents`, {
        teamId,
        limit: this.#config.limits.maxSubagentsPerTeam,
      });
    }
    if (this.totalSubagents() >= this.#config.limits.maxSubagentsTotal) {
      throw new MeshError('SUBAGENT_LIMIT', `the Mesh already has ${this.#config.limits.maxSubagentsTotal} subagents`, {
        limit: this.#config.limits.maxSubagentsTotal,
      });
    }
  }

  #requireTeam(teamId: string): TeamRecord {
    const team = this.#store.teamStore.getTeam(teamId);
    if (team === undefined || this.#store.getGroup(teamId) === undefined) throw this.#notFound(teamId);
    return team;
  }

  #notFound(teamId: string): MeshError {
    return new MeshError('TEAM_NOT_FOUND', `unknown group ${teamId}`, { teamId });
  }

  #transition(teamId: string, next: TeamStatus): TeamView {
    const team = this.#requireTeam(teamId);
    const group = this.#store.getGroup(teamId);
    if (group === undefined) throw this.#notFound(teamId);
    if (group.status === 'destroyed') {
      throw new MeshError('TEAM_STATE_INVALID', 'a destroyed group cannot change state', { teamId, status: group.status });
    }
    const current: TeamStatus = group.status === 'stopped' ? 'stopped' : group.status === 'paused' ? 'paused' : 'active';
    if (current === next) return this.#view(teamId);
    const now = nowIso();
    const groupStatus: MeshGroupStatus = next === 'active' ? 'active' : next === 'stopped' ? 'stopped' : 'paused';
    this.#store.transaction(() => {
      this.#store.teamStore.upsertTeam({
        ...team,
        status: reverseStatus(next),
        updatedAt: now,
        revision: team.revision + 1,
      });
      this.#store.updateGroup(teamId, { status: groupStatus, updatedAt: now });
      this.#store.appendEvent('team', teamId, next === 'active' ? 'resumed' : next === 'stopped' ? 'stopped' : 'paused', {});
    });
    return this.#view(teamId);
  }

  #view(teamId: string): TeamView {
    const team = this.#store.teamStore.getTeam(teamId);
    const group = this.#store.getGroup(teamId);
    if (team === undefined || group === undefined) throw this.#notFound(teamId);
    const members = this.#store.teamStore.listMembers(teamId);
    const subagents = members
      .filter(member => member.role !== 'captain' && member.status !== 'disposed')
      .map(member => member.agentId);
    let workspacePath: string | null = null;
    if (group.workspaceId !== null) {
      workspacePath = this.#store.getWorkspace(group.workspaceId)?.path ?? null;
    }
    return {
      teamId,
      name: team.title,
      objective: team.objective,
      status: group.status === 'destroyed'
        ? 'destroyed'
        : group.status === 'stopped'
          ? 'stopped'
          : mapTeamStatus(team.status),
      rootSessionId: team.captainAgentId,
      subagentSessionIds: subagents,
      workspaceId: group.workspaceId,
      workspacePath,
      researchProjectId: group.projectId,
      researchRouteId: group.routeId,
      currentTaskId: group.currentTaskId,
      createdAt: team.createdAt,
      updatedAt: group.updatedAt,
    };
  }
}
