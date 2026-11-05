/**
 * Research Mesh service facade.
 *
 * One service owns the SQLite store, group registry, worktree manager,
 * scheduler, GPU leases, executor, RSI adapter and worker loop. The Cordis
 * plugin exposes it as `ctx.researchMesh`; every method is usable without the
 * chat context and all durable state survives a process restart.
 */

import { MeshError } from './errors.ts';
import type { MeshConfig } from './config/types.ts';
import { ensureProjectLayout, type ProjectLayout } from './project.ts';
import { MeshStore } from './storage/mesh-store.ts';
import type { MeshJobRecord, MeshJobStatus } from './storage/types.ts';
import { openTeamStore, type SqliteTeamStore } from './bridge/runtime/persistence.ts';
import { ResearchStateGate } from './bridge/research/state-gate.ts';
import { stageArtifact } from './bridge/research/artifacts.ts';
import type { ResearchDecisionProposal, StateGateResult } from './bridge/types.ts';
import { WorkspaceManager, type CleanupWorkspaceOptions, type CleanupWorkspaceResult, type WorkspaceInspection } from './workspaces/manager.ts';
import { ProjectRegistry, type CreateProjectInput, type ProjectView } from './projects/registry.ts';
import type { RsiNextAction, RsiSummary, WorkbenchGroup, WorkbenchSnapshot } from './projects/workbench.ts';
import { TeamManager, type CreateTeamInput, type RegisterSubagentInput, type SubagentView, type TeamView } from './teams/manager.ts';
import { DshSessionHost, ExternalSessionHost, type DshHostContext, type SessionHost } from './teams/session-host.ts';
import {
  MemoryModelSettingsStore,
  ModelResolver,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelSettingsDocument,
  type ModelSettingsStore,
} from './teams/models.ts';
import { DshModelCatalog, StaticModelCatalog, type DshLlmLike } from './dsh/model-catalog.ts';
import { TaskScheduler, type ClaimedTask, type MeshTaskView, type SchedulerRecoveryReport, type SubmitTaskInput } from './scheduler/scheduler.ts';
import { GpuLeaseManager, LocalGpuProbe, UnknownGpuProbe, type GpuProbe } from './resources/gpu.ts';
import { RsiAdapter, type RsiDiscovery, type RsiStateCheck } from './rsi/adapter.ts';
import { LocalExecutor } from './executors/local.ts';
import { RemoteJobExecutor, type IngestionResult, type SubmitResult } from './executors/remote.ts';
import { FakeTransport } from './executors/transport.ts';
import { SshGpuProbe, SshTransport } from './executors/ssh.ts';
import { ExperimentJobService } from './executors/job-service.ts';
import { MeshWorker, type WorkerRoundResult, type WorkerStatus } from './worker.ts';
import { nowIso } from './util/time.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MeshLogger } from './util/logger.ts';
import { newWorkerId } from './util/ids.ts';
import { canonicalStatePath, readCanonicalStateFile } from './bridge/adapters/research-pipeline.ts';

/** Host services the plugin optionally binds to. */
export interface MeshHostServices {
  readonly agents?: DshHostContext['agents'];
  readonly sessionController?: DshHostContext['sessionController'];
  readonly workspaceController?: DshHostContext['workspaceController'];
  readonly llm?: DshLlmLike;
  readonly subagents?: DshHostContext['subagents'];
}

/** Constructor options; tests inject deterministic seams here. */
export interface MeshServiceOptions {
  readonly config: MeshConfig;
  readonly logger: MeshLogger;
  readonly host?: MeshHostServices;
  readonly sessionHost?: SessionHost;
  readonly modelCatalog?: ModelCatalog;
  readonly modelSettings?: ModelSettingsStore;
  readonly gpuProbe?: GpuProbe;
  readonly transport?: import('./executors/transport.ts').JobTransport;
}

/** Compact service status. */
export interface MeshServiceStatus {
  readonly initialized: boolean;
  readonly projectRoot: string;
  readonly workerId: string;
  readonly worker: WorkerStatus;
  readonly teams: number;
  readonly activeTeams: number;
  readonly subagents: number;
  readonly tasks: number;
  readonly jobs: number;
  readonly rsiAvailable: boolean;
  readonly transport: string;
}

/** Extension-task input for an already-authorized RSI experiment. */
export interface SubmitExperimentTaskInput {
  readonly projectId: string;
  readonly teamId: string;
  readonly priority?: number;
  readonly dependencies?: readonly string[];
  readonly idempotencyKey?: string;
  readonly workerId: string;
  readonly gpuId: number;
  readonly rsi: import('./worker.ts').ExperimentTaskPayload['rsi'];
  readonly condaEnvironment?: string;
  readonly artifactDestination?: string;
  readonly requiredArtifacts?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

/** One initialized Research Mesh runtime. */
export class MeshService {
  readonly #config: MeshConfig;
  readonly #logger: MeshLogger;
  readonly #host: MeshHostServices;
  readonly #sessionHostOverride: SessionHost | undefined;
  readonly #catalogOverride: ModelCatalog | undefined;
  readonly #settingsOverride: ModelSettingsStore | undefined;
  readonly #gpuProbeOverride: GpuProbe | undefined;
  readonly #transportOverride: import('./executors/transport.ts').JobTransport | undefined;
  #initialized = false;
  #layout: ProjectLayout | null = null;
  #teamStore: SqliteTeamStore | null = null;
  #store: MeshStore | null = null;
  #workspaces: WorkspaceManager | null = null;
  #teams: TeamManager | null = null;
  #projects: ProjectRegistry | null = null;
  #scheduler: TaskScheduler | null = null;
  #gpu: GpuLeaseManager | null = null;
  #rsi: RsiAdapter | null = null;
  #local: LocalExecutor | null = null;
  #jobs: ExperimentJobService | null = null;
  #worker: MeshWorker | null = null;
  #models: ModelResolver | null = null;
  #agents: DshHostContext['agents'];
  #llm: DshLlmLike | undefined;
  #sessionController: DshHostContext['sessionController'];
  #workspaceController: DshHostContext['workspaceController'];
  #subagents: DshHostContext['subagents'];
  #workerId: string | null = null;
  #transportKind = 'none';
  #closing = false;

  /**
   * @param options - configuration and injectable seams.
   */
  constructor(options: MeshServiceOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#host = options.host ?? {};
    this.#agents = this.#host.agents;
    this.#llm = this.#host.llm;
    this.#sessionController = this.#host.sessionController;
    this.#workspaceController = this.#host.workspaceController;
    this.#subagents = this.#host.subagents;
    this.#sessionHostOverride = options.sessionHost;
    this.#catalogOverride = options.modelCatalog;
    this.#settingsOverride = options.modelSettings;
    this.#gpuProbeOverride = options.gpuProbe;
    this.#transportOverride = options.transport;
  }

  /** Resolved configuration. */
  get config(): MeshConfig {
    return this.#config;
  }

  /** Initialize storage and all runtime components. Idempotent. */
  async init(): Promise<this> {
    if (this.#initialized) return this;
    const layout = ensureProjectLayout(this.#config);
    let teamStore: SqliteTeamStore | null = null;
    try {
      teamStore = openTeamStore({ path: this.#config.databasePath });
      const store = new MeshStore(teamStore);
      const workspaces = new WorkspaceManager(this.#config, store, this.#logger);
      const sessionHost = this.#sessionHostOverride ?? this.#createSessionHost();
      const catalog = this.#catalogOverride ?? this.#createCatalog();
      const settings = this.#settingsOverride ?? new MemoryModelSettingsStore();
      const models = new ModelResolver(settings, catalog, this.#config.agent);
      const projects = new ProjectRegistry(this.#config, store, this.#logger);
      const teams = new TeamManager(this.#config, store, sessionHost, workspaces, this.#logger, models);
      const scheduler = new TaskScheduler(this.#config, store, this.#logger);
      const primary = this.#primaryWorker();
      const transport = this.#transportOverride ?? this.#createTransport(primary);
      const gpu = new GpuLeaseManager(this.#config, store, this.#gpuProbeOverride ?? this.#createGpuProbe(transport), this.#logger);
      const rsi = new RsiAdapter(this.#config, this.#logger);
      const local = new LocalExecutor(this.#config.conda, layout.logs, this.#logger);
      const executor = new RemoteJobExecutor({
        config: this.#config,
        store,
        scheduler,
        gpu,
        transport,
        artifactsRoot: layout.artifacts,
        manifestsRoot: layout.manifests,
        outcomesRoot: layout.outcomes,
        logger: this.#logger,
      });
      const jobs = new ExperimentJobService(this.#config, store, scheduler, workspaces, executor, layout.manifests, this.#logger);
      const workerId = newWorkerId();
      const worker = new MeshWorker({
        config: this.#config,
        store,
        scheduler,
        teams,
        workspaces,
        local,
        jobs,
        rsi,
        logger: this.#logger,
        workerId,
      });
      this.#layout = layout;
      this.#teamStore = teamStore;
      this.#store = store;
      this.#workspaces = workspaces;
      this.#projects = projects;
      this.#teams = teams;
      this.#scheduler = scheduler;
      this.#gpu = gpu;
      this.#rsi = rsi;
      this.#local = local;
      this.#jobs = jobs;
      this.#worker = worker;
      this.#models = models;
      this.#workerId = workerId;
      this.#transportKind = transport.kind;
      this.#initialized = true;
      if (this.#config.startupRecovery) await this.#startupRecovery();
      if (this.#config.autoStartScheduler) worker.start();
      this.#logger.info('research mesh initialized', {
        projectRoot: this.#config.projectRoot,
        workerId,
        transport: transport.kind,
        sessionBinding: sessionHost.binding,
      });
      return this;
    } catch (error) {
      if (teamStore !== null) {
        try { teamStore.close(); } catch { /* retain the original initialization failure */ }
      }
      throw error;
    }
  }

  /** Stop timers, release live session handles and close SQLite. Idempotent. */
  async close(): Promise<void> {
    if (!this.#initialized) return;
    // Set before teardown: session disposal during shutdown must not detach
    // durable project bindings.
    this.#closing = true;
    this.#initialized = false;
    this.#worker?.stop();
    try { await this.#teams?.close(); } catch (error) {
      this.#logger.warn('team session teardown failed', { error: String(error) });
    }
    try { this.#teamStore?.close(); } catch (error) {
      this.#logger.warn('store close failed', { error: String(error) });
    }
    this.#teamStore = null;
    this.#store = null;
    this.#worker = null;
    this.#jobs = null;
    this.#gpu = null;
    this.#rsi = null;
    this.#local = null;
    this.#scheduler = null;
    this.#teams = null;
    this.#projects = null;
    this.#workspaces = null;
    this.#models = null;
    this.#layout = null;
    this.#logger.info('research mesh closed');
  }

  /** Whether `init()` completed and `close()` has not run. */
  get initialized(): boolean {
    return this.#initialized;
  }

  /** Replace the model-settings store when the DSH Settings service appears late. */
  attachModelSettingsStore(store: import('./teams/models.ts').ModelSettingsStore): void {
    this.#models?.replaceStore(store);
  }

  /** Late-bind the Host AgentRegistry when it activates after the plugin. */
  attachAgents(agents: import('./teams/session-host.ts').DshAgentsLike): void {
    this.#agents = agents;
    const host = this.#teams?.sessionHost;
    if (host instanceof DshSessionHost) host.attachAgents(agents);
  }

  /** Late-bind the Host LLM catalog when it activates after the plugin. */
  /** Late-bind the Host SubagentRuntime when it activates after the plugin. */
  attachSubagents(subagents: import('./teams/session-host.ts').DshSubagentRuntimeLike): void {
    this.#subagents = subagents;
    const host = this.#teams?.sessionHost;
    if (host instanceof DshSessionHost) host.attachSubagents(subagents);
  }

  attachLlm(llm: DshLlmLike): void {
    this.#llm = llm;
    this.#models?.replaceCatalog(new DshModelCatalog(llm));
  }

  /** Late-bind the Host SessionController when it activates after the plugin. */
  attachSessionController(controller: import('./teams/session-host.ts').DshSessionControllerLike): void {
    this.#sessionController = controller;
    const host = this.#teams?.sessionHost;
    if (host instanceof DshSessionHost) host.attachSessionController(controller);
  }

  /** Late-bind the Host WorkspaceController when it activates after the plugin. */
  attachWorkspaceController(controller: import('./teams/session-host.ts').DshWorkspaceControllerLike): void {
    this.#workspaceController = controller;
    const host = this.#teams?.sessionHost;
    if (host instanceof DshSessionHost) host.attachWorkspaceController(controller);
  }

  /** Service status for diagnostics and tests. */
  status(): MeshServiceStatus {
    this.#requireReady();
    const groups = this.#store?.listGroups() ?? [];
    const tasks = this.#store?.listTaskMeta() ?? [];
    return {
      initialized: this.#initialized,
      projectRoot: this.#config.projectRoot,
      workerId: this.#workerId ?? '',
      worker: this.#worker?.status() ?? { running: false, workerId: '', lastError: null },
      teams: groups.filter(group => group.status !== 'destroyed').length,
      activeTeams: groups.filter(group => group.status === 'active').length,
      subagents: this.#teams?.totalSubagents() ?? 0,
      tasks: tasks.length,
      jobs: this.#jobs?.list().length ?? 0,
      rsiAvailable: this.#rsi?.discover().available ?? false,
      transport: this.#transportKind,
    };
  }

  // -- projects and sessions ------------------------------------------------

  createProject(input: CreateProjectInput): ProjectView {
    return this.#requireProjects().create(input);
  }

  /** Inspect a repository for the attach-project form without modifying it. */
  inspectProjectRepository(repositoryRef: string): import('./projects/registry.ts').RepositoryInspection {
    return this.#requireProjects().inspect(repositoryRef);
  }

  listProjects(): readonly ProjectView[] {
    return this.#requireProjects().list();
  }

  getProject(projectId: string): ProjectView {
    return this.#requireProjects().get(projectId);
  }

  /** Reconcile group state with persisted project pause/archive state. */
  reconcileProjectPauses(): void {
    this.#requireReady();
    for (const project of this.#requireProjects().list()) {
      if (project.status === 'paused' || project.status === 'archived' || project.status === 'registered') {
        const active = this.#requireTeams().list(project.projectId).filter(team => team.status === 'active');
        this.#requireStore().recordProjectPauses(project.projectId, active.map(team => team.teamId));
        for (const team of active) this.#requireTeams().pause(team.teamId);
      } else if (project.status === 'active') {
        const parked = this.#requireStore().listProjectPauses(project.projectId);
        for (const teamId of parked) {
          const team = this.#requireTeams().list(project.projectId).find(candidate => candidate.teamId === teamId);
          if (team !== undefined && team.status === 'paused') this.#requireTeams().resume(teamId);
        }
        this.#requireStore().clearProjectPauses(project.projectId);
      }
    }
  }

  setProjectStatus(projectId: string, status: import('./storage/types.ts').MeshProjectStatus): ProjectView {
    const project = this.#requireProjects().setStatus(projectId, status);
    // Pausing or archiving a project parks new claims through the groups that
    // were active. Running jobs are untouched. Only groups parked by the project
    // are restored on resume; a manually paused group stays paused.
    if (status === 'paused' || status === 'archived' || status === 'registered') {
      const active = this.#requireTeams().list(projectId).filter(team => team.status === 'active');
      this.#requireStore().recordProjectPauses(projectId, active.map(team => team.teamId));
      for (const team of active) this.#requireTeams().pause(team.teamId);
    } else if (status === 'active') {
      const parked = this.#requireStore().listProjectPauses(projectId);
      for (const teamId of parked) {
        const team = this.#requireTeams().list(projectId).find(candidate => candidate.teamId === teamId);
        if (team !== undefined && team.status === 'paused') this.#requireTeams().resume(teamId);
      }
      this.#requireStore().clearProjectPauses(projectId);
    }
    return project;
  }

  listSessionBindings(projectId: string): readonly import('./storage/types.ts').MeshSessionBinding[] {
    return this.#requireProjects().bindings(projectId);
  }

  async createControlSession(projectId: string, options: { provider?: string; model?: string } = {}): Promise<{
    sessionId: string;
    projectId: string;
  }> {
    const project = this.#requireProjects().get(projectId);
    let provider = options.provider ?? this.#config.agent?.provider;
    let model = options.model ?? this.#config.agent?.model;
    if (provider === undefined || model === undefined) {
      const groups = this.#store?.listGroups(projectId) ?? [];
      const first = groups[0];
      if (first !== undefined) {
        const team = this.#requireTeamStore().getTeam(first.teamId);
        const groupName = team?.title ?? first.routeId;
        const resolved = await this.#requireModels().resolveCaptain(groupName);
        provider = resolved.provider;
        model = resolved.model;
      }
    }
    if (provider === undefined || model === undefined) {
      throw new MeshError('MODEL_CONFIG_INVALID', 'no model is configured for the control session', { projectId });
    }
    const created = await this.#requireTeams().sessionHost.createControl({
      teamId: `control-${projectId}`,
      projectId,
      name: project.name,
      cwd: project.repositoryRef,
      title: project.name,
      provider,
      model,
    });
    try {
      this.#requireProjects().bind(projectId, created.sessionId, 'control');
    } catch (error) {
      try { await this.#requireTeams().sessionHost.disposeRoot(created.sessionId); } catch { /* retain original */ }
      throw error;
    }
    this.#store?.appendEvent('project', projectId, 'control-session-created', { sessionId: created.sessionId });
    return { sessionId: created.sessionId, projectId };
  }

  attachSession(projectId: string, sessionId: string): import('./storage/types.ts').MeshSessionBinding {
    return this.#requireProjects().bind(projectId, sessionId, 'control');
  }

  /** Explicitly bind a member identity to a group (used by control-plane clients). */
  attachMemberSession(projectId: string, teamId: string, sessionId: string): import('./storage/types.ts').MeshSessionBinding {
    return this.#requireProjects().bind(projectId, sessionId, 'member', teamId);
  }

  detachSession(sessionId: string): boolean {
    return this.#requireProjects().detach(sessionId);
  }

  /**
   * React to a disposed Host session.
   *
   * A `control` binding is a durable association with a chat; when that chat is
   * deleted its binding is removed so the project is not left pointing at a
   * missing Session. Captain and member bindings are owned by the group
   * lifecycle and survive session disposal (a restart disposes Agents without
   * meaning to retire a group). Disposal during plugin shutdown is ignored.
   * @param sessionId - disposed session identity.
   * @returns true when a control binding was detached.
   */
  onSessionDisposed(sessionId: string): boolean {
    if (this.#closing || !this.#initialized) return false;
    const projects = this.#projects;
    if (projects === null) return false;
    const binding = projects.activeBinding(sessionId);
    if (binding === undefined || binding.role !== 'control') return false;
    const detached = projects.detach(sessionId);
    if (detached) {
      this.#store?.appendEvent('session', sessionId, 'control-session-disposed', { projectId: binding.projectId });
      this.#logger.info('control session disposed; project binding detached', {
        sessionId,
        projectId: binding.projectId,
      });
    }
    return detached;
  }

  sessionBinding(sessionId: string): import('./storage/types.ts').MeshSessionBinding | undefined {
    return this.#requireProjects().activeBinding(sessionId);
  }

  agentStatus(sessionId: string): string | undefined {
    return this.#agents?.get?.(sessionId)?.status;
  }

  /** Assemble the read-only Project Workbench projection. */
  async projectWorkbench(projectId: string): Promise<WorkbenchSnapshot> {
    this.#requireReady();
    const project = this.#requireProjects().get(projectId);
    const groups: WorkbenchGroup[] = [];
    for (const team of this.#requireTeams().list(projectId)) {
      if (team.status === 'destroyed') continue;
      const subagents = this.#requireTeams().listSubagents(team.teamId);
      const agentModels = subagents.map(subagent => this.#requireStore().getAgentModel(subagent.sessionId))
        .filter((record): record is import('./storage/types.ts').AgentModelRecord => record !== undefined);
      const rootModel = this.#requireStore().getAgentModel(team.rootSessionId);
      if (rootModel !== undefined) agentModels.unshift(rootModel);
      const liveStatus: Record<string, string | null> = {
        [team.rootSessionId]: this.#agents?.get?.(team.rootSessionId)?.status ?? null,
      };
      for (const subagent of subagents) liveStatus[subagent.sessionId] = this.#agents?.get?.(subagent.sessionId)?.status ?? null;
      const workspace = team.workspaceId === null ? null : this.#requireStore().getWorkspace(team.workspaceId) ?? null;
      groups.push({
        team,
        subagents,
        agentModels,
        tasks: this.#requireScheduler().listByTeam(team.teamId),
        workspace,
        liveStatus,
      });
    }
    const jobs = this.#requireJobs().list().filter(job => job.projectId === projectId);
    const leases = this.#requireGpu().list();
    const rsi = this.#rsiSummary(project);
    const modelErrors = await this.modelSettingsDiagnostics();
    return {
      project,
      groups,
      jobs,
      gpuLeases: leases,
      recentEvents: this.#requireStore().listRecentEvents(30),
      rsi,
      modelErrors,
      worker: this.#requireWorker().status(),
      generatedAt: nowIso(),
    };
  }

  /** Read-only RSI summary. No Mesh-invented phase is returned. */
  #rsiSummary(project: ProjectView): RsiSummary {
    const base: RsiSummary = {
      available: false,
      stateVersion: null,
      goal: null,
      phaseAdvisory: null,
      updatedAt: null,
      openCriticalUncertainties: 0,
      plannedExperiments: 0,
      runningExperiments: 0,
      acceptedExperimentResults: 0,
      scheduler: [],
      error: null,
    };
    try {
      const stat = statSync(project.rsiStateRef, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) return { ...base, error: 'RSI state file is missing' };
      const parsed: unknown = JSON.parse(readFileSync(project.rsiStateRef, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ...base, error: 'RSI state is not an object' };
      }
      const state = parsed as Record<string, unknown>;
      const contract = typeof state.contract === 'object' && state.contract !== null
        ? state.contract as Record<string, unknown>
        : {};
      const uncertainties = Array.isArray(state.uncertainties) ? state.uncertainties : [];
      const experiments = Array.isArray(state.experiments) ? state.experiments : [];
      const decision = typeof state.decision === 'object' && state.decision !== null
        ? state.decision as Record<string, unknown>
        : {};
      let scheduler: RsiNextAction[] = [];
      const schedulerPath = join(dirname(project.rsiStateRef), 'scheduler.json');
      if (existsSync(schedulerPath)) {
        try {
          const parsedScheduler: unknown = JSON.parse(readFileSync(schedulerPath, 'utf8'));
          if (typeof parsedScheduler === 'object' && parsedScheduler !== null && !Array.isArray(parsedScheduler)) {
            const actions = (parsedScheduler as Record<string, unknown>).next_actions;
            if (Array.isArray(actions)) {
              scheduler = actions.flatMap(action => {
                if (typeof action !== 'object' || action === null || Array.isArray(action)) return [];
                const record = action as Record<string, unknown>;
                if (typeof record.action !== 'string' || typeof record.type !== 'string'
                  || typeof record.target !== 'string' || typeof record.eig !== 'string'
                  || typeof record.cost !== 'string') return [];
                return [{ action: record.action, type: record.type, target: record.target, eig: record.eig, cost: record.cost }];
              });
            }
          }
        } catch {
          scheduler = [];
        }
      }
      const stateVersion = typeof state.state_version === 'number' ? String(state.state_version) : typeof state.state_version === 'string' ? state.state_version : null;
      return {
        available: stateVersion !== null,
        stateVersion,
        goal: typeof contract.goal === 'string' ? contract.goal : null,
        phaseAdvisory: typeof decision.next_phase === 'string' ? decision.next_phase : null,
        updatedAt: stat.mtime.toISOString(),
        openCriticalUncertainties: uncertainties.filter(item => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
          const record = item as Record<string, unknown>;
          return record.status === 'open' && record.importance === 'critical';
        }).length,
        plannedExperiments: experiments.filter(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).status === 'planned').length,
        runningExperiments: experiments.filter(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).status === 'running').length,
        acceptedExperimentResults: experiments.filter(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).status === 'done').length,
        scheduler,
        error: stateVersion === null ? 'state_version is missing' : null,
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Report configured routes that are not currently registered. */
  async modelSettingsDiagnostics(): Promise<readonly { group: string; scope: string; provider: string; model: string; reason: string }[]> {
    const document = this.#requireModels().document;
    const catalog = await this.#requireModels().listCatalog();
    const live = new Set(catalog.map(entry => `${entry.provider}\u0000${entry.model}`));
    const errors: { group: string; scope: string; provider: string; model: string; reason: string }[] = [];
    for (const [group, assignment] of Object.entries(document.groups)) {
      const check = (scope: string, choice: { provider: string; model: string } | undefined): void => {
        if (choice === undefined) return;
        if (!live.has(`${choice.provider}\u0000${choice.model}`)) {
          errors.push({ group, scope, provider: choice.provider, model: choice.model, reason: 'provider/model is not registered in the live catalog' });
        }
      };
      check('group-default', assignment.default);
      if (assignment.captain !== undefined && assignment.captain !== 'inherit') check('captain', assignment.captain);
      for (const [slot, choice] of Object.entries(assignment.subagents ?? {})) {
        if (choice !== 'inherit') check(`subagent:${slot}`, choice);
      }
    }
    return errors;
  }

  /** Create a demo local task and run one worker round, for the Workbench. */
  async simulateLocalTask(projectId: string, teamId?: string): Promise<import('./scheduler/scheduler.ts').MeshTaskView> {
    const groups = this.#requireTeams().list(projectId);
    this.#assertProjectActive(projectId);
    const group = teamId === undefined
      ? groups.find(candidate => candidate.status === 'active')
      : groups.find(candidate => candidate.teamId === teamId);
    if (group === undefined) throw new MeshError('TEAM_NOT_FOUND', 'no active group is available for a local simulation', { projectId });
    const task = this.#requireScheduler().submit({
      projectId,
      teamId: group.teamId,
      type: 'local',
      title: `local simulation ${new Date().toISOString()}`,
      objective: 'Mesh local executor smoke task created from the Workbench',
      payload: {
        entrypoint: 'python3',
        argv: ['-c', 'print("dsh-research-mesh local simulation ok")'],
      },
    }).task;
    const round = await this.#requireWorker().runOnce();
    return round.task?.taskId === task.taskId ? round.task : this.#requireScheduler().get(task.taskId);
  }

  // -- native delegation guard ---------------------------------------------

  /**
   * Decide whether a model-invoked native `subagent` tool may create another
   * child for this parent session.
   *
   * Mesh quotas apply to every Mesh-owned creation path, but the native
   * `subagent` tool creates children without passing through them. This is the
   * host-side guard that closes that hole: it denies a new native child when the
   * parent's group is already at its member cap, when the global cap is reached,
   * or when the parent is itself a member (a member must not fan out further).
   * Sessions that are not bound to a Mesh project are left alone.
   * @param parentSessionId - session invoking the tool.
   * @returns a denial reason, or undefined to allow.
   */
  nativeSubagentDenial(parentSessionId: string | undefined): string | undefined {
    if (parentSessionId === undefined || this.#initialized === false) return undefined;
    const binding = this.#projects?.activeBinding(parentSessionId);
    if (binding === undefined) return undefined;
    if (binding.role === 'control') return undefined;
    const team = this.#teams?.list().find(candidate => candidate.teamId === binding.groupId);
    if (team === undefined) return undefined;
    if (binding.role === 'member') {
      return `Research Mesh: member sessions cannot delegate further (group ${team.name})`;
    }
    if (team.status !== 'active') {
      return `Research Mesh: group ${team.name} is ${team.status}; native delegation is disabled`;
    }
    if (this.#teams !== null) {
      const inTeam = this.#teams.listSubagents(team.teamId).filter(member => member.status !== 'disposed').length;
      if (inTeam >= this.#config.limits.maxSubagentsPerTeam) {
        return `Research Mesh: group ${team.name} already has ${inTeam} subagents (limit ${this.#config.limits.maxSubagentsPerTeam})`;
      }
      const total = this.#teams.totalSubagents();
      if (total >= this.#config.limits.maxSubagentsTotal) {
        return `Research Mesh: ${total} subagents exist globally (limit ${this.#config.limits.maxSubagentsTotal})`;
      }
    }
    return undefined;
  }

  // -- teams ---------------------------------------------------------------



  /**
   * Create a group from the control-plane API. Unlike the lower-level
   * `createTeam` used by deterministic tests, this requires a registered,
   * runnable, active project and therefore cannot create an orphan group.
   */
  async createGroup(input: CreateTeamInput): Promise<TeamView> {
    const project = this.#requireProjects().get(input.projectId);
    this.#requireProjects().assertRunnable(input.projectId);
    if (!project.rsiReadable) {
      throw new MeshError('RSI_STATE_UNAVAILABLE', 'the project RSI state is not readable', {
        projectId: input.projectId,
        error: project.rsiError,
      });
    }
    if (project.status !== 'active') {
      throw new MeshError('TEAM_STATE_INVALID', 'project is not active; resume it before creating a group', {
        projectId: input.projectId,
        status: project.status,
      });
    }
    const routeStatePath = input.researchStatePath ?? canonicalStatePath(this.#config.projectRoot, input.routeId);
    const routeState = readCanonicalStateFile(routeStatePath);
    if (!routeState.exists || routeState.version === null) {
      throw new MeshError('RSI_STATE_UNAVAILABLE', 'the group research route has no readable RSI state', {
        projectId: input.projectId,
        routeId: input.routeId,
        statePath: routeStatePath,
        error: routeState.error,
      });
    }
    return this.createTeam(input);
  }

  async createTeam(input: CreateTeamInput): Promise<TeamView> {
    const projects = this.#projects;
    if (projects !== null && projects.list().some(project => project.projectId === input.projectId)) {
      projects.assertRunnable(input.projectId);
      const project = projects.get(input.projectId);
      if (!project.rsiReadable) {
        throw new MeshError('RSI_STATE_UNAVAILABLE', 'the project RSI state is not readable', {
          projectId: input.projectId,
          error: project.rsiError,
        });
      }
      if (project.status !== 'active') {
        throw new MeshError('TEAM_STATE_INVALID', 'project is not active; resume it before creating a group', { projectId: input.projectId });
      }
    }
    const team = await this.#requireTeams().createTeam(input);
    if (projects !== null && projects.list().some(project => project.projectId === input.projectId)) {
      try {
        projects.bind(input.projectId, team.rootSessionId, 'captain', team.teamId);
      } catch (error) {
        // A group without its captain binding would be unreachable from the
        // Workbench and would still consume a slot, so retire it immediately.
        try { await this.#requireTeams().destroy(team.teamId); } catch (cleanupError) {
          this.#logger.error('failed to retire group after captain binding failure', {
            teamId: team.teamId,
            error: String(cleanupError),
          });
        }
        if (team.workspaceId !== null) {
          try { await this.#requireWorkspaces().cleanup(team.workspaceId, { confirm: true, force: true }); } catch (cleanupError) {
            this.#logger.error('failed to clean up worktree after captain binding failure', {
              teamId: team.teamId,
              workspaceId: team.workspaceId,
              error: String(cleanupError),
            });
          }
        }
        throw error;
      }
    }
    return team;
  }

  getTeam(teamId: string): TeamView {
    return this.#requireTeams().get(teamId);
  }

  /** Resume the persisted captain Session with the group's assigned model. */
  resumeRootSession(teamId: string): Promise<void> {
    return this.#requireTeams().resumeRootSession(teamId);
  }

  listTeams(projectId?: string): readonly TeamView[] {
    return this.#requireTeams().list(projectId);
  }

  pauseTeam(teamId: string): TeamView {
    return this.#requireTeams().pause(teamId);
  }

  resumeTeam(teamId: string): TeamView {
    return this.#requireTeams().resume(teamId);
  }

  /**
   * Stop a group: park claims, cancel tasks that have not started, and retain
   * running tasks/jobs. Distinct from pause, which leaves queued work intact.
   * @param teamId - group identity.
   * @returns updated group and cancelled task ids.
   */
  stopTeam(teamId: string): { team: TeamView; cancelled: readonly string[] } {
    const team = this.#requireTeams().stop(teamId);
    const cancelled: string[] = [];
    for (const task of this.#requireScheduler().listByTeam(teamId)) {
      if (task.status === 'PENDING' || task.status === 'READY') {
        try {
          this.#requireScheduler().cancel(task.taskId, 'group stopped by operator');
          cancelled.push(task.taskId);
        } catch {
          // A concurrent claim moved it to RUNNING; leaving it alone is the
          // documented stop semantics.
        }
      }
    }
    return { team, cancelled };
  }

  async destroyTeam(teamId: string): Promise<TeamView> {
    const team = this.#requireTeams().get(teamId);
    const destroyed = await this.#requireTeams().destroy(teamId);
    // Bindings are Mesh management state too; leaving them active would pin
    // the sessions to a destroyed group and block reuse.
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      this.#projects.detach(team.rootSessionId);
      for (const subagent of this.#requireTeams().listSubagents(teamId)) this.#projects.detach(subagent.sessionId);
    }
    return destroyed;
  }

  async registerSubagent(input: RegisterSubagentInput): Promise<SubagentView> {
    const team = this.#requireTeams().get(input.teamId);
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      const project = this.#projects.get(team.researchProjectId);
      if (project.status !== 'active') {
        throw new MeshError('TEAM_STATE_INVALID', 'project is not active; cannot register a member', {
          projectId: project.projectId,
          status: project.status,
        });
      }
    }
    const subagent = await this.#requireTeams().registerSubagent(input);
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      try {
        this.#projects.bind(team.researchProjectId, subagent.sessionId, 'member', input.teamId);
      } catch (error) {
        // A partially registered member without a project binding is not a
        // usable Mesh identity; release it before surfacing the failure.
        try { this.#requireTeams().releaseSubagent(input.teamId, subagent.sessionId); } catch { /* retain original */ }
        throw error;
      }
    }
    return subagent;
  }

  releaseSubagent(teamId: string, sessionId: string): void {
    const team = this.#requireTeams().get(teamId);
    this.#requireTeams().releaseSubagent(teamId, sessionId);
    // A released identity must not keep an active member binding, otherwise it
    // could never be re-registered in another group.
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      this.#projects.detach(sessionId);
    }
  }

  listSubagents(teamId: string): readonly SubagentView[] {
    return this.#requireTeams().listSubagents(teamId);
  }

  /** Return the recorded provider/model for one agent identity. */
  agentModel(sessionId: string): import('./storage/types.ts').AgentModelRecord | undefined {
    return this.#requireStore().getAgentModel(sessionId);
  }

  // -- workspaces ----------------------------------------------------------

  listWorkspaces(projectId?: string): readonly import('./storage/types.ts').MeshWorkspaceRecord[] {
    return this.#requireWorkspaces().list(projectId);
  }

  inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection> {
    return this.#requireWorkspaces().inspect(workspaceId);
  }

  cleanupWorkspace(workspaceId: string, options: CleanupWorkspaceOptions): Promise<CleanupWorkspaceResult> {
    return this.#requireWorkspaces().cleanup(workspaceId, options);
  }

  /** Read a UTF-8 file through the workspace boundary. */
  readWorkspaceFile(workspaceId: string, path: string): string {
    return this.#requireWorkspaces().files(workspaceId).readText(path);
  }

  /** Atomically write a UTF-8 file through the workspace boundary. */
  writeWorkspaceFile(workspaceId: string, path: string, content: string): string {
    return this.#requireWorkspaces().files(workspaceId).writeText(path, content);
  }

  // -- tasks ---------------------------------------------------------------

  submitTask(input: SubmitTaskInput): { task: MeshTaskView; created: boolean } {
    this.#assertProjectActive(input.projectId);
    return this.#requireScheduler().submit(input);
  }

  submitExperimentTask(input: SubmitExperimentTaskInput): { task: MeshTaskView; created: boolean } {
    this.#assertProjectActive(input.projectId);
    const payload: import('./worker.ts').ExperimentTaskPayload = {
      workerId: input.workerId,
      gpuId: input.gpuId,
      rsi: input.rsi,
      ...(input.condaEnvironment === undefined ? {} : { condaEnvironment: input.condaEnvironment }),
      ...(input.artifactDestination === undefined ? {} : { artifactDestination: input.artifactDestination }),
      ...(input.requiredArtifacts === undefined ? {} : { requiredArtifacts: input.requiredArtifacts }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    };
    return this.#requireScheduler().submit({
      projectId: input.projectId,
      teamId: input.teamId,
      type: 'experiment',
      title: `experiment ${input.rsi.experimentId}`,
      objective: `RSI experiment ${input.rsi.experimentId} on route ${input.rsi.routeId}`,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      payload: JSON.parse(JSON.stringify(payload)) as Readonly<Record<string, unknown>>,
    });
  }

  getTask(taskId: string): MeshTaskView {
    return this.#requireScheduler().get(taskId);
  }

  listTasksByTeam(teamId: string): readonly MeshTaskView[] {
    return this.#requireScheduler().listByTeam(teamId);
  }

  listTasksByProject(projectId: string): readonly MeshTaskView[] {
    return this.#requireScheduler().listByProject(projectId);
  }

  claimNext(workerId?: string): ClaimedTask | undefined {
    return this.#requireScheduler().claimNext(workerId ?? this.#requireWorkerId());
  }

  /** Claim one named task through the explicit scheduler path. */
  claimTask(taskId: string, workerId?: string): ClaimedTask {
    return this.#requireScheduler().claimTask(taskId, workerId ?? this.#requireWorkerId());
  }

  startTask(taskId: string, workerId: string, attemptId: string): MeshTaskView {
    return this.#requireScheduler().start(taskId, workerId, attemptId);
  }

  succeedTask(taskId: string, attemptId: string): MeshTaskView {
    return this.#requireScheduler().succeed(taskId, attemptId);
  }

  failTask(taskId: string, attemptId: string, code: string, message: string, retryable = false): MeshTaskView {
    return this.#requireScheduler().fail(taskId, attemptId, code, message, retryable);
  }

  heartbeatTask(taskId: string, attemptId: string): MeshTaskView {
    return this.#requireScheduler().heartbeat(taskId, attemptId);
  }

  retryTask(taskId: string, options: { reason: string; extendAttempts?: boolean }): MeshTaskView {
    return this.#requireScheduler().retry(taskId, options);
  }

  cancelTask(taskId: string, reason: string): MeshTaskView {
    return this.#requireScheduler().cancel(taskId, reason);
  }

  blockTask(taskId: string, attemptId: string | null, code: string, message: string): MeshTaskView {
    return this.#requireScheduler().block(taskId, attemptId, code, message);
  }

  // -- worker and jobs -----------------------------------------------------

  runWorkerOnce(options: { poll?: boolean } = {}): Promise<WorkerRoundResult> {
    return this.#requireWorker().runOnce(options);
  }

  runUntilIdle(maxRounds = 50): Promise<number> {
    return this.#requireWorker().runUntilIdle(maxRounds);
  }

  startScheduler(): void {
    this.#requireWorker().start();
  }

  stopScheduler(): void {
    this.#requireWorker().stop();
  }

  workerStatus(): WorkerStatus {
    return this.#requireWorker().status();
  }

  listJobs(statuses?: readonly MeshJobStatus[]): readonly MeshJobRecord[] {
    return this.#requireJobs().list(statuses);
  }

  queryJob(jobId: string): Promise<MeshTaskView> {
    return this.#requireJobs().query(jobId);
  }

  reconcileJob(jobId: string): Promise<MeshTaskView> {
    return this.#requireJobs().reconcile(jobId);
  }

  collectJob(jobId: string): Promise<IngestionResult> {
    return this.#requireJobs().collect(jobId);
  }

  abandonJob(jobId: string, reason: string): MeshTaskView {
    return this.#requireJobs().abandon(jobId, reason);
  }

  async recover(): Promise<{
    scheduler: SchedulerRecoveryReport;
    jobs: number;
    gpu: { released: number; quarantined: number; retained: number };
    workspaces: readonly WorkspaceInspection[];
  }> {
    return this.recoverAt(Date.now());
  }

  /** Deterministic recovery clock, used by tests and explicit operator replays. */
  async recoverAt(nowMs: number): Promise<{
    scheduler: SchedulerRecoveryReport;
    jobs: number;
    gpu: { released: number; quarantined: number; retained: number };
    workspaces: readonly WorkspaceInspection[];
  }> {
    this.#requireReady();
    const scheduler = this.#requireScheduler().recover(nowMs);
    const jobs = this.#requireJobs().recover();
    const gpu = this.#requireGpu().reconcile();
    const workspaces = await this.#requireWorkspaces().recover();
    return { scheduler, jobs, gpu, workspaces };
  }

  // -- GPU leases ----------------------------------------------------------

  acquireGpu(input: {
    workerId: string;
    taskId: string;
    jobId: string;
    attemptId: string;
    gpuId?: number;
  }): Promise<import('./resources/gpu.ts').AcquiredGpuLease> {
    return this.#requireGpu().acquire(input);
  }

  releaseGpu(leaseId: string, reason: string): void {
    this.#requireGpu().release(leaseId, reason);
  }

  listGpuLeases(workerId?: string): readonly import('./storage/types.ts').GpuLeaseRecord[] {
    return this.#requireGpu().list(workerId);
  }

  reconcileGpu(): { released: number; quarantined: number; retained: number } {
    return this.#requireGpu().reconcile();
  }

  // -- RSI -----------------------------------------------------------------

  discoverRsi(): RsiDiscovery {
    return this.#requireRsi().discover();
  }

  async probeRsi(): Promise<import('./bridge/adapters/research-pipeline.ts').PipelineProbe> {
    return this.#requireRsi().probe();
  }

  readResearchState(routeId: string): import('./rsi/adapter.ts').RsiStateSnapshot {
    return this.#requireRsi().readState(this.#requireRsi().statePath(routeId));
  }

  checkResearchState(routeId: string): Promise<RsiStateCheck> {
    return this.#requireRsi().checkState(this.#requireRsi().statePath(routeId));
  }

  checkScheduler(routeId: string, schedulerPath: string): Promise<import('./bridge/adapters/research-pipeline.ts').PipelineCommandResult> {
    return this.#requireRsi().checkScheduler(this.#requireRsi().statePath(routeId), schedulerPath);
  }

  /**
   * Stage an RSI decision proposal through the integrated bridge gate. This
   * never writes canonical state; a commit remains the pipeline's own action.
   */
  stageResearchProposal(teamId: string, proposal: ResearchDecisionProposal): Promise<import('./bridge/research/state-gate.ts').StagedProposal> {
    const gate = this.#researchGate(teamId);
    return Promise.resolve(gate.stageProposal(proposal));
  }

  /** Evaluate a proposal against the integrated bridge gate without writing. */
  evaluateResearchProposal(teamId: string, proposal: ResearchDecisionProposal): Promise<StateGateResult> {
    return this.#researchGate(teamId).evaluate(proposal);
  }

  /** Stage one bridge research artifact; canonical state is never touched. */
  stageResearchArtifact(teamId: string, draft: import('./bridge/research/artifacts.ts').ArtifactDraft): import('./bridge/types.ts').ResearchArtifact {
    const team = this.#requireTeamStore().getTeam(teamId);
    if (team === undefined) throw new MeshError('TEAM_NOT_FOUND', `unknown group ${teamId}`, { teamId });
    if (draft.teamId !== teamId) throw new MeshError('INVALID_ARGUMENT', 'artifact team does not match the group', { teamId });
    return stageArtifact(this.#requireTeamStore(), draft);
  }

  // -- model settings ------------------------------------------------------

  getModelSettings(): ModelSettingsDocument {
    return this.#requireModels().document;
  }

  saveModelSettings(value: unknown): Promise<ModelSettingsDocument> {
    return this.#requireModels().save(value);
  }

  listModelCatalog(): Promise<readonly ModelCatalogEntry[]> {
    return this.#requireModels().listCatalog();
  }

  resolveModelPreview(groupName: string, kind: 'captain' | 'subagent', slot?: string): Promise<import('./teams/models.ts').ResolvedModel> {
    return kind === 'captain'
      ? this.#requireModels().resolveCaptain(groupName)
      : this.#requireModels().resolveSubagent(groupName, slot ?? '');
  }

  // -- internals -----------------------------------------------------------

  async #startupRecovery(): Promise<void> {
    try {
      this.reconcileProjectPauses();
      const scheduler = this.#requireScheduler().recover();
      const jobs = this.#requireJobs().recover();
      const gpu = this.#requireGpu().reconcile();
      const workspaces = await this.#requireWorkspaces().recover();
      this.#logger.warn('startup recovery completed', {
        schedulerReconciled: scheduler.reconciledRemote.length,
        schedulerFailed: scheduler.failedLocal.length,
        jobs,
        gpuReleased: gpu.released,
        gpuQuarantined: gpu.quarantined,
        workspaces: workspaces.length,
      });
    } catch (error) {
      this.#logger.error('startup recovery failed', { error: String(error) });
      throw error;
    }
  }

  #createSessionHost(): SessionHost {
    if (this.#config.sessionBinding === 'external') return new ExternalSessionHost();
    return new DshSessionHost({
      agents: this.#agents,
      ...(this.#sessionController === undefined ? {} : { sessionController: this.#sessionController }),
      ...(this.#workspaceController === undefined ? {} : { workspaceController: this.#workspaceController }),
      ...(this.#subagents === undefined ? {} : { subagents: this.#subagents }),
      nativeMembers: this.#config.nativeMembers,
    });
  }

  #createCatalog(): ModelCatalog {
    if (this.#llm !== undefined) return new DshModelCatalog(this.#llm);
    return new StaticModelCatalog([]);
  }

  #primaryWorker(): import('./config/types.ts').WorkerConfig {
    const workers = Object.values(this.#config.workers);
    const primary = workers.find(worker => worker.enabled) ?? workers[0];
    if (primary === undefined) throw new MeshError('CONFIG_INVALID', 'no worker is configured');
    return primary;
  }

  #createTransport(worker: import('./config/types.ts').WorkerConfig): import('./executors/transport.ts').JobTransport {
    if (worker.transport === 'fake') {
      if (worker.fakeRemoteRoot === undefined) {
        throw new MeshError('CONFIG_INVALID', 'fake worker lacks fakeRemoteRoot', { workerId: worker.workerId });
      }
      return new FakeTransport(worker.fakeRemoteRoot);
    }
    return new SshTransport({ config: this.#config });
  }

  #createGpuProbe(transport: import('./executors/transport.ts').JobTransport): GpuProbe {
    if (transport instanceof SshTransport) return new SshGpuProbe(transport);
    if (transport instanceof FakeTransport) return new LocalGpuProbe();
    return new UnknownGpuProbe();
  }

  #assertProjectActive(projectId: string): void {
    if (this.#projects === null) return;
    const existing = this.#projects.list().find(project => project.projectId === projectId);
    if (existing !== undefined && !existing.rsiReadable) {
      throw new MeshError('RSI_STATE_UNAVAILABLE', 'the project RSI state is not readable', {
        projectId,
        error: existing.rsiError,
      });
    }
    if (existing !== undefined && existing.status !== 'active') {
      throw new MeshError('TEAM_STATE_INVALID', 'project is not active; new tasks are not scheduled', { projectId, status: existing.status });
    }
  }

  #researchGate(teamId: string): ResearchStateGate {
    const team = this.#requireTeamStore().getTeam(teamId);
    if (team === undefined) throw new MeshError('TEAM_NOT_FOUND', `unknown group ${teamId}`, { teamId });
    const pipeline = this.#requireRsi().pipelineAdapter();
    if (pipeline === null) throw new MeshError('RSI_UNAVAILABLE', 'RSI skill is unavailable; state proposals cannot be gated');
    return new ResearchStateGate({
      store: this.#requireTeamStore(),
      pipeline,
      statePath: team.researchStatePath,
      projectRoot: this.#config.projectRoot,
    });
  }

  #requireReady(): void {
    if (!this.#initialized) throw new MeshError('STORAGE_CLOSED', 'research mesh is not initialized');
  }

  #requireProjects(): ProjectRegistry {
    this.#requireReady();
    if (this.#projects === null) throw new MeshError('STORAGE_CLOSED', 'project registry is closed');
    return this.#projects;
  }

  #requireTeams(): TeamManager {
    this.#requireReady();
    if (this.#teams === null) throw new MeshError('STORAGE_CLOSED', 'team manager is closed');
    return this.#teams;
  }

  #requireWorkspaces(): WorkspaceManager {
    this.#requireReady();
    if (this.#workspaces === null) throw new MeshError('STORAGE_CLOSED', 'workspace manager is closed');
    return this.#workspaces;
  }

  #requireScheduler(): TaskScheduler {
    this.#requireReady();
    if (this.#scheduler === null) throw new MeshError('STORAGE_CLOSED', 'scheduler is closed');
    return this.#scheduler;
  }

  #requireStore(): MeshStore {
    this.#requireReady();
    if (this.#store === null) throw new MeshError('STORAGE_CLOSED', 'store is closed');
    return this.#store;
  }

  #requireTeamStore(): SqliteTeamStore {
    this.#requireReady();
    if (this.#teamStore === null) throw new MeshError('STORAGE_CLOSED', 'bridge store is closed');
    return this.#teamStore;
  }

  #requireWorker(): MeshWorker {
    this.#requireReady();
    if (this.#worker === null) throw new MeshError('STORAGE_CLOSED', 'worker is closed');
    return this.#worker;
  }

  #requireWorkerId(): string {
    if (this.#workerId === null) throw new MeshError('STORAGE_CLOSED', 'worker id is unavailable');
    return this.#workerId;
  }

  #requireJobs(): ExperimentJobService {
    this.#requireReady();
    if (this.#jobs === null) throw new MeshError('STORAGE_CLOSED', 'job service is closed');
    return this.#jobs;
  }

  #requireGpu(): GpuLeaseManager {
    this.#requireReady();
    if (this.#gpu === null) throw new MeshError('STORAGE_CLOSED', 'GPU manager is closed');
    return this.#gpu;
  }

  #requireRsi(): RsiAdapter {
    this.#requireReady();
    if (this.#rsi === null) throw new MeshError('STORAGE_CLOSED', 'RSI adapter is closed');
    return this.#rsi;
  }

  #requireModels(): ModelResolver {
    this.#requireReady();
    if (this.#models === null) throw new MeshError('STORAGE_CLOSED', 'model resolver is closed');
    return this.#models;
  }
}

/** Keep the no-op status accessor honest for callers that only need a timestamp. */
export function serviceNow(): string {
  return nowIso();
}
