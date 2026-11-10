/**
 * Research Mesh service facade.
 *
 * One service owns the SQLite store, group registry, worktree manager,
 * scheduler, GPU leases, executor, RSI adapter and worker loop. The Cordis
 * plugin exposes it as `ctx.researchMesh`; every method is usable without the
 * chat context and all durable state survives a process restart.
 */

import { MeshError } from './errors.ts';
import { RlpRuntime } from './rlp/index.ts';
import { ProjectRuntime } from './app/project-runtime.ts';
import type { RlpContextPlan, RlpContextPacket, RlpStorageResolution, RlpSubagentContract } from './rlp/types.ts';
import type { RlpSubagentRole } from './rlp/subagent-context.ts';
import { AutonomyStore } from './autonomy/store.ts';
import { EffectsRunner, type EffectsTickReport } from './autonomy/effects.ts';
import { AutonomyEngine, DEFAULT_AUTONOMY_POLICY } from './autonomy/engine.ts';
import type { AssignmentRecord, AutonomyPolicy, CompletionProof, CreateTicketInput, ReceiveResult, TicketRecord, TriggerInput, TriggerRecord } from './autonomy/types.ts';
import { RlpCompletionVerifier, requireScientificPass, type CompletionVerifier } from './rlp/outcome.ts';
import { createHash } from 'node:crypto';
import { authorizeAction } from './autonomy/authorize.ts';
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
import { findConsumeEvent } from './rsi/consumed-run.ts';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MeshLogger } from './util/logger.ts';
import { newWorkerId } from './util/ids.ts';
import { canonicalStatePath, detectStorageLayout, readCanonicalStateFile } from './bridge/adapters/research-pipeline.ts';

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
  /** Seam for tests; defaults to the RLP decision verifier. */
  readonly completionVerifier?: CompletionVerifier;
  /** Effect claim owner; defaults to a per-process id. */
  readonly effectOwner?: string;
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
  /** RLP v2.2.0 installation discovered and usable. */
  readonly rlpAvailable: boolean;
  readonly rlpVersion: string | null;
  readonly autonomyMode: AutonomyPolicy['mode'];
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
  #rlp: RlpRuntime | null = null;
  readonly #runtimes = new Map<string, ProjectRuntime>();
  #rlpReady = false;
  #rlpStatusValue: import('./rlp/types.ts').RlpStorageStatus | null = null;
  #autoStore: AutonomyStore | null = null;
  #effects: EffectsRunner | null = null;
  #autonomy: AutonomyEngine | null = null;
  #agents: DshHostContext['agents'];
  #llm: DshLlmLike | undefined;
  #sessionController: DshHostContext['sessionController'];
  #workspaceController: DshHostContext['workspaceController'];
  #subagents: DshHostContext['subagents'];
  #workerId: string | null = null;
  #transportKind = 'none';
  #completionVerifier: CompletionVerifier | null = null;
  readonly #completionOverride: CompletionVerifier | undefined;
  readonly #effectOwner: string | undefined;
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
    this.#completionOverride = options.completionVerifier;
    this.#effectOwner = options.effectOwner;
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
      const rlp = this.#createRlp();
      let rlpReady = false;
      let rlpStatusValue: import('./rlp/types.ts').RlpStorageStatus | null = null;
      if (rlp.available) {
        try {
          const resolution = await rlp.storage().resolve(this.#config.projectRoot);
          rlpReady = resolution.formalRunAllowed;
          rlpStatusValue = resolution.status;
        } catch (error) {
          this.#logger.warn('RLP storage resolution failed at startup', { error: String(error) });
        }
      }
      const autoStore = new AutonomyStore(teamStore);
      const effects = new EffectsRunner(autoStore, {
        ...(this.#effectOwner === undefined ? {} : { owner: this.#effectOwner }),
      });
      const autonomy = new AutonomyEngine({
        store: autoStore,
        effects,
        meshStore: store,
        policy: this.#initialPolicy(),
        projectStatus: (projectId: string) => {
          try {
            const project = this.#projects?.get(projectId);
            return project?.status ?? 'paused';
          } catch { return 'paused'; }
        },
        rlpFormalRun: () => this.#formalRunLayoutOk(),
        groupFacts: (teamId: string) => autoStore.groupFacts(teamId),
        handlers: {
          notice: payload => { store.appendEvent('trigger', String(payload.triggerId ?? 'unknown'), 'autonomy-notice', payload); },
          dispatch: payload => { store.appendEvent('ticket', String(payload.ticketId ?? 'unknown'), 'dispatch-requested', payload); },
          launch: payload => { store.appendEvent('ticket', String(payload.ticketId ?? 'unknown'), 'launch-requested', payload); },
          notify: payload => { store.appendEvent('ticket', String(payload.ticketId ?? 'unknown'), 'notify', payload); },
        },
      });
      const workspaces = new WorkspaceManager(this.#config, store, this.#logger);
      const sessionHost = this.#sessionHostOverride ?? this.#createSessionHost();
      const catalog = this.#catalogOverride ?? this.#createCatalog();
      const settings = this.#settingsOverride ?? new MemoryModelSettingsStore();
      const models = new ModelResolver(settings, catalog, this.#config.agent);
      const projects = new ProjectRegistry(this.#config, store, this.#logger, teamId => {
        for (const runtime of this.#runtimes.values()) {
          const group = runtime.store.getGroup(teamId);
          if (group !== undefined) return group;
        }
        return undefined;
      });
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
        onIngested: result => this.#recordArtifactIngested(result),
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
        effects,
      });
      this.#layout = layout;
      this.#teamStore = teamStore;
      this.#store = store;
      this.#rlp = rlp;
      this.#rlpReady = rlpReady;
      this.#rlpStatusValue = rlpStatusValue;
      this.#autoStore = autoStore;
      this.#effects = effects;
      this.#autonomy = autonomy;
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
      try { await effects.tick(); } catch (error) {
        this.#logger.warn('autonomy effects tick failed during startup', { error: String(error) });
      }
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
    await this.#worker?.stop();
    try { await this.#teams?.close(); } catch (error) {
      this.#logger.warn('team session teardown failed', { error: String(error) });
    }
    try { this.#teamStore?.close(); } catch (error) {
      this.#logger.warn('store close failed', { error: String(error) });
    }
    this.#teamStore = null;
    this.#store = null;
    this.#rlp = null;
    this.#autoStore = null;
    this.#effects = null;
    this.#autonomy = null;
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
      rlpAvailable: this.#rlp?.available ?? false,
      rlpVersion: this.#rlp?.skill?.version ?? null,
      autonomyMode: this.#autonomy?.policy.mode ?? 'off',
      transport: this.#transportKind,
    };
  }


  // -- RLP and autonomy -----------------------------------------------------

  #createRlp(): RlpRuntime {
    if (!this.#config.rlp.enabled) return RlpRuntime.unavailable('rlp.enabled is false');
    return RlpRuntime.create({
      ...(this.#config.rlp.skillPath === undefined ? {} : { skillPath: this.#config.rlp.skillPath }),
      python: this.#config.rlp.pythonExecutable,
      timeoutMs: this.#config.rlp.timeoutMs,
      optional: true,
    });
  }

  #initialPolicy(): AutonomyPolicy {
    return {
      ...DEFAULT_AUTONOMY_POLICY,
      version: this.#config.rlp.autonomyPolicyVersion,
      mode: this.#config.rlp.autonomyMode,
    };
  }

  /** Rebuild the RLP runtime when its skill digest changed. */
  #refreshRlp(): void {
    if (this.#rlp === null || !this.#rlp.available) return;
    if (!this.#rlp.isStale()) return;
    this.#logger.warn('RLP skill changed since discovery; rebuilding adapters');
    this.#rlp = this.#createRlp();
    this.#completionVerifier = null;
  }

  /** RLP installation status. */
  rlpStatus(): ReturnType<RlpRuntime['status']> {
    this.#refreshRlp();
    return this.#rlp?.status() ?? { available: false, skillPath: null, version: null, digest: null, reason: 'not initialized' };
  }

  /**
   * Resolve a project's RLP control root through the storage matrix.
   * @param projectRoot - defaults to this runtime's project root.
   * @returns storage resolution; throws when RLP is unavailable.
   */
  async rlpStorage(projectRoot = this.#config.projectRoot): Promise<RlpStorageResolution> {
    const rlp = this.#requireRlp();
    const resolution = await rlp.storage().resolve(projectRoot);
    if (projectRoot === this.#config.projectRoot) {
      this.#rlpReady = resolution.formalRunAllowed;
      this.#rlpStatusValue = resolution.status;
    }
    return resolution;
  }

  /**
   * Load the minimal RLP context plan for one task.
   * @param input - preset/entry/stage/authorization/domain.
   * @returns plan with real document bodies and load state.
   */
  async rlpContextPlan(input: { preset?: string; entry?: string; stage?: string; authorization?: string; domain?: string } = {}): Promise<RlpContextPlan> {
    this.#refreshRlp();
    const rlp = this.#requireRlp();
    const plan = await rlp.context().load(input);
    return rlp.context().assertProceed(plan);
  }

  /**
   * Build and verify a research context packet for one route.
   * @param projectId - registered project.
   * @param routeId - research route.
   * @param task - packet task.
   * @returns verified, non-canonical packet metadata.
   */
  async rlpContextPacket(projectId: string, routeId: string, task: 'continue_method' | 'review_paper' | 'audit_evidence' | 'discover' | 'inspect'): Promise<RlpContextPacket> {
    this.#refreshRlp();
    const rlp = this.#requireRlp();
    const project = this.#requireProjects().get(projectId);
    const resolution = await rlp.storage().resolve(project.repositoryRef);
    rlp.storage().assertFormalRun(resolution);
    const statePath = rlp.storage().statePath(resolution, routeId);
    return await rlp.context().buildPacket({ statePath, route: routeId, task });
  }

  /**
   * Build a role-scoped subagent contract and prove it does not escalate.
   * @param role - RLP research role.
   * @param task - one-line task.
   * @param authorization - RLP authorization level.
   * @returns usable contract.
   */
  async rlpSubagentContract(role: RlpSubagentRole, task: string, authorization?: string): Promise<RlpSubagentContract> {
    const rlp = this.#requireRlp();
    return await rlp.subagentContext().buildOrThrow({
      role,
      task,
      ...(authorization === undefined ? {} : { authorization }),
    });
  }

  /** Record one immutable Trigger and apply the deterministic Gate. */
  recordTrigger(input: TriggerInput): ReceiveResult {
    return this.#autonomyFor(input.projectId).receiveTrigger(input);
  }

  /** Create a Ticket explicitly from a previously accepted Trigger. */
  createTicket(input: CreateTicketInput): TicketRecord {
    return this.#autonomyFor(input.projectId).createTicket(input);
  }

  listTickets(projectId: string): readonly TicketRecord[] {
    return this.#autonomyFor(projectId).listTickets(projectId);
  }

  getTicket(ticketId: string): TicketRecord {
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).getTicket(ticketId);
  }

  listTriggers(projectId: string, limit?: number): readonly TriggerRecord[] {
    return this.#autonomyFor(projectId).listTriggers(projectId, limit);
  }

  listTicketAssignments(ticketId: string): readonly AssignmentRecord[] {
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).listAssignments(ticketId);
  }

  assignTicket(ticketId: string, teamId: string, options: { taskId?: string; sessionId?: string } = {}): AssignmentRecord {
    this.#teamsByTeam(teamId).get(teamId);
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).assign(ticketId, teamId, options);
  }

  startTicketAssignment(assignmentId: string, options: { taskId?: string; jobId?: string; sessionId?: string } = {}): AssignmentRecord {
    return this.#autonomyByAssignment(assignmentId).startAssignment(assignmentId, options);
  }

  finishTicketAssignment(assignmentId: string, options: { ok: boolean; jobId?: string; errorCode?: string; errorMessage?: string }): AssignmentRecord {
    return this.#autonomyByAssignment(assignmentId).finishAssignment(assignmentId, options);
  }

  markTicketCompute(ticketId: string, jobId: string, assignmentId?: string): TicketRecord {
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).markCompute(ticketId, jobId, assignmentId);
  }

  waitTicketForHuman(ticketId: string, reason: string): TicketRecord {
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).waitForHuman(ticketId, reason);
  }

  stopTicket(ticketId: string, reason: string, by = 'operator'): TicketRecord {
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).stopTicket(ticketId, by, reason);
  }

  resumeTicket(ticketId: string, explicit = false): TicketRecord {
    return (this.#runtimeByTicket(ticketId)?.autonomy ?? this.#requireAutonomy()).resumeTicket(ticketId, { explicit });
  }

  endTicket(ticketId: string, reason: 'completed' | 'failed' | 'cancelled', by = 'operator'): TicketRecord {
    return this.#requireAutonomy().endTicket(ticketId, reason, by);
  }

  /**
   * Complete a research ticket only after RLP's own decision passes.
   * @param ticketId - ticket identity.
   * @param experimentId - RLP experiment id.
   * @param routeId - RLP route that owns the state.
   * @param by - caller recorded on the ending event.
   * @returns ended ticket with the proof digest recorded.
   */
  async completeResearchTicket(ticketId: string, experimentId: string, assurancePath?: string): Promise<TicketRecord> {
    const owner = this.#runtimeByTicket(ticketId);
    const autonomy = owner?.autonomy ?? this.#requireAutonomy();
    const ticket = autonomy.getTicket(ticketId);
    if (ticket.kind !== 'research') {
      throw new MeshError('TICKET_STATE_INVALID', 'only research tickets require an RLP completion proof', { ticketId, kind: ticket.kind });
    }
    if (ticket.experimentId === null || ticket.experimentId !== experimentId) {
      throw new MeshError('MANDATE_SCOPE_VIOLATION', 'experiment is not bound to this ticket job', {
        ticketId, experimentId, bound: ticket.experimentId,
      });
    }
    if (owner !== null) await owner.primeRlp();
    const rlp = owner?.rlp.available === true ? owner.rlp : this.#requireRlp();
    const routeId = ticket.routeId;
    const resolution = await rlp.storage().resolve(this.#config.projectRoot);
    rlp.storage().assertFormalRun(resolution);
    const statePath = rlp.storage().statePath(resolution, routeId);
    const completion = await this.#verifier().verify({
      statePath, experimentId, ...(assurancePath === undefined ? {} : { assurancePath }),
    });
    requireScientificPass(completion);
    // The proof must still match the file that RLP will act on.
    const current = createHash('sha256').update(readFileSync(statePath)).digest('hex');
    if (`sha256:${current}` !== completion.stateDigest) {
      throw new MeshError('RLP_STATE_CHANGED', 'canonical state changed between the decision and completion', {
        ticketId, expected: completion.stateDigest, actual: `sha256:${current}`,
      });
    }
    const proof: CompletionProof = {
      ticketId,
      experimentId,
      stateVersion: completion.stateVersion,
      stateDigest: completion.stateDigest,
      decision: completion.decision,
      verifiedAt: nowIso(),
      proofDigest: completion.proofDigest,
    };
    return autonomy.endTicket(ticketId, 'completed', 'rlp-outcome', proof);
  }

  #verifier(): CompletionVerifier {
    if (this.#completionOverride !== undefined) return this.#completionOverride;
    if (this.#completionVerifier !== null) return this.#completionVerifier;
    const rlp = this.#requireRlp();
    const skill = rlp.skill;
    if (skill === null) throw new MeshError('RLP_UNAVAILABLE', 'RLP skill is unavailable for completion verification');
    this.#completionVerifier = new RlpCompletionVerifier(skill, this.#config.rlp.timeoutMs);
    return this.#completionVerifier;
  }

  /** Change the autonomy mode; existing Mandates are not revoked. */
  setAutonomyMode(mode: AutonomyPolicy['mode']): AutonomyPolicy {
    const autonomy = this.#requireAutonomy();
    return autonomy.setPolicy({ ...autonomy.policy, mode });
  }

  /** Run one durable-effects tick (also called by `runWorkerOnce`). */
  runEffects(): Promise<EffectsTickReport> {
    return this.#requireEffects().tick();
  }

  /** Durable effects rows, for diagnostics and tests. */
  listEffects(status?: import('./autonomy/types.ts').EffectStatus): readonly import('./autonomy/types.ts').EffectRecord[] {
    return this.#requireEffects().list(status);
  }

  /** Compact autonomy status for the Workbench. */
  autonomyStatus(projectId: string): {
    mode: AutonomyPolicy['mode'];
    policyVersion: string;
    openTickets: number;
    pendingEffects: number;
    recentCandidates: number;
  } {
    const autonomy = this.#autonomyFor(projectId);
    const tickets = autonomy.listTickets(projectId);
    const triggers = autonomy.listTriggers(projectId, 50);
    return {
      mode: autonomy.policy.mode,
      policyVersion: autonomy.policy.version,
      openTickets: tickets.filter(ticket => ticket.status !== 'ended').length,
      pendingEffects: this.runtime(projectId).effects.list('pending').length,
      recentCandidates: triggers.filter(trigger => trigger.disposition === 'candidate').length,
    };
  }


  /**
   * Fail closed unless the project uses a formal RLP runtime root.
   *
   * `MIGRATION_REQUIRED` and `AMBIGUOUS_STORAGE_ROOT` are engineering control
   * states: Mesh must not dispatch science, write outcomes or rebuild a root
   * from them. A missing root is resolved by RLP Bootstrap, not by Mesh.
   * @param projectRoot - project to check; defaults to the configured root.
   */
  #assertRlpFormalRunSync(projectRoot = this.#config.projectRoot): void {
    const layout = detectStorageLayout(projectRoot);
    if (layout.kind === 'ambiguous') {
      throw new MeshError('RLP_AMBIGUOUS_STORAGE_ROOT', 'both RLP storage roots exist; resolve them before formal runs', {
        projectRoot, newRoot: layout.newRoot, legacyRoot: layout.legacyRoot,
      });
    }
    if (layout.kind === 'legacy') {
      throw new MeshError('RLP_MIGRATION_REQUIRED', 'legacy RLP root only; migrate the project before formal runs', {
        projectRoot,
        migration: 'python3 scripts/migrate_project_root.py inspect --project <project>',
      });
    }
    if (this.#config.rlp.enabled && !this.#formalRunLayoutOk(projectRoot)) {
      throw new MeshError('RLP_GATE_HOLD', 'RLP storage root is not READY for formal runs', {
        projectRoot, status: this.#rlpStatusValue,
      });
    }
  }

  /**
   * Synchronous READY approximation for hot paths: the new runtime root must
   * exist with a routes directory. The asynchronous resolver remains the
   * authoritative check for status reporting and health.
   * @param projectRoot - project to check.
   * @returns true when a new-root route tree exists.
   */
  #formalRunLayoutOk(projectRoot = this.#config.projectRoot): boolean {
    const layout = detectStorageLayout(projectRoot);
    if (layout.kind === 'legacy' || layout.kind === 'ambiguous') return false;
    return existsSync(join(layout.newRoot, 'routes'));
  }

  async #requireRlpFormalRun(): Promise<void> {
    const rlp = this.#requireRlp();
    const resolver = rlp.storage();
    resolver.assertFormalRun(await resolver.resolve(this.#config.projectRoot));
  }

  #requireRlp(): RlpRuntime {
    this.#requireReady();
    if (this.#rlp === null || !this.#rlp.available) {
      throw new MeshError('RLP_UNAVAILABLE', 'research-lifecycle-protocol v2.2.0 is not available', {
        reason: this.#rlp?.status().reason ?? 'not initialized',
      });
    }
    return this.#rlp;
  }

  #requireAutonomy(): AutonomyEngine {
    this.#requireReady();
    if (this.#autonomy === null) throw new MeshError('STORAGE_CLOSED', 'autonomy engine is closed');
    return this.#autonomy;
  }

  #requireEffects(): EffectsRunner {
    this.#requireReady();
    if (this.#effects === null) throw new MeshError('STORAGE_CLOSED', 'effects runner is closed');
    return this.#effects;
  }

  // -- per-project runtimes ------------------------------------------------

  /**
   * Get (or lazily build) one project's isolated runtime.
   *
   * Each runtime owns its own database, worktrees, artifacts, scheduler, worker
   * and RLP resolver, so operations on one project cannot see another.
   * @param projectId - registered project.
   * @returns the runtime.
   */
  runtime(projectId: string): ProjectRuntime {
    this.#requireReady();
    const cached = this.#runtimes.get(projectId);
    if (cached !== undefined) return cached;
    const project = this.#requireStore().getProject(projectId);
    if (project === undefined) throw new MeshError('PROJECT_NOT_FOUND', `unknown project ${projectId}`, { projectId });
    const runtime = new ProjectRuntime({
      baseConfig: this.#config,
      logger: this.#logger,
      sessionHost: this.#requireTeams().sessionHost,
      settings: this.#settingsOverride ?? new MemoryModelSettingsStore(),
      catalog: this.#catalogOverride ?? this.#createCatalog(),
      ...(this.#transportOverride === undefined ? {} : { transport: this.#transportOverride }),
      ...(this.#gpuProbeOverride === undefined ? {} : { gpuProbe: this.#gpuProbeOverride }),
      onIngested: result => this.#recordArtifactIngested(result),
    }, project);
    this.#runtimes.set(projectId, runtime);
    return runtime;
  }

  /** Every live project runtime, in registration order. */
  runtimes(): readonly ProjectRuntime[] {
    this.#requireReady();
    for (const project of this.#requireStore().listProjects()) this.runtime(project.projectId);
    return [...this.#runtimes.values()];
  }

  /**
   * Ensure the project's resident control session ("项目主控").
   * @param projectId - registered project.
   * @returns the session id and whether it was created now.
   */
  async ensureProjectControlSession(projectId: string): Promise<{ sessionId: string; created: boolean }> {
    const runtime = this.runtime(projectId);
    await runtime.primeRlp();
    const result = await runtime.ensureControlSession();
    if (result.created) {
      try { this.#requireProjects().bind(projectId, result.sessionId, 'control'); } catch { /* already bound */ }
    }
    return result;
  }

  /** Control-plane status of every project runtime. */
  runtimeStatus(): readonly ReturnType<ProjectRuntime['status']>[] {
    return this.runtimes().map(runtime => runtime.status());
  }

  // -- runtime routing -----------------------------------------------------
  //
  // Every project-scoped operation resolves the project's own runtime first, so
  // a Mesh with N projects keeps N isolated control planes. The profile-level
  // managers remain only as the fallback for a pre-runtime (legacy) project.

  /** Runtime that owns one team, searching live runtimes before the legacy store. */
  #runtimeByTeam(teamId: string): ProjectRuntime | null {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.store.getGroup(teamId) !== undefined) return runtime;
    }
    if (this.#store !== null) {
      for (const project of this.#store.listProjects()) {
        const runtime = this.runtime(project.projectId);
        if (runtime.store.getGroup(teamId) !== undefined) return runtime;
      }
    }
    return null;
  }

  /** Teams manager for a project (runtime first, legacy fallback). */
  #teamsFor(projectId: string): TeamManager {
    try { return this.runtime(projectId).teams } catch { return this.#requireTeams() }
  }

  /** Teams manager that owns a team id. */
  #teamsByTeam(teamId: string): TeamManager {
    return this.#runtimeByTeam(teamId)?.teams ?? this.#requireTeams();
  }

  /** Workspace manager for a project. */
  #workspacesFor(projectId: string): WorkspaceManager {
    try { return this.runtime(projectId).workspaces } catch { return this.#requireWorkspaces() }
  }

  /** Workspace manager that owns a workspace id. */
  #workspacesByWorkspace(workspaceId: string): WorkspaceManager {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.store.getWorkspace(workspaceId) !== undefined) return runtime.workspaces;
    }
    if (this.#store !== null) {
      for (const project of this.#store.listProjects()) {
        const runtime = this.runtime(project.projectId);
        if (runtime.store.getWorkspace(workspaceId) !== undefined) return runtime.workspaces;
      }
    }
    return this.#requireWorkspaces();
  }

  /** Autonomy engine that owns one assignment. */
  #autonomyByAssignment(assignmentId: string): AutonomyEngine {
    for (const runtime of this.runtimes()) {
      if (runtime.autonomyStore.getAssignment(assignmentId) !== undefined) return runtime.autonomy;
    }
    return this.#requireAutonomy();
  }

  /** Autonomy engine for a project (runtime first, legacy fallback). */
  #autonomyFor(projectId: string): AutonomyEngine {
    try { return this.runtime(projectId).autonomy } catch { return this.#requireAutonomy() }
  }

  /** Scheduler for a project (runtime first, legacy fallback). */
  #schedulerFor(projectId: string): TaskScheduler {
    try { return this.runtime(projectId).scheduler } catch { return this.#requireScheduler() }
  }

  /** Job service for a project. */
  #jobsFor(projectId: string): ExperimentJobService {
    try { return this.runtime(projectId).jobs } catch { return this.#requireJobs() }
  }

  /** Runtime that owns a task id, if any. */
  #runtimeByTask(taskId: string): ProjectRuntime | null {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.store.getTaskMeta(taskId) !== undefined) return runtime;
    }
    if (this.#store !== null) {
      for (const project of this.#store.listProjects()) {
        const runtime = this.runtime(project.projectId);
        if (runtime.store.getTaskMeta(taskId) !== undefined) return runtime;
      }
    }
    return null;
  }

  /** Runtime that owns a job id, if any. */
  #runtimeByJob(jobId: string): ProjectRuntime | null {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.store.getJob(jobId) !== undefined) return runtime;
    }
    if (this.#store !== null) {
      for (const project of this.#store.listProjects()) {
        const runtime = this.runtime(project.projectId);
        if (runtime.store.getJob(jobId) !== undefined) return runtime;
      }
    }
    return null;
  }

  /** Runtime that owns a ticket id, if any. */
  #runtimeByTicket(ticketId: string): ProjectRuntime | null {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.autonomyStore.getTicket(ticketId) !== undefined) return runtime;
    }
    if (this.#store !== null) {
      for (const project of this.#store.listProjects()) {
        const runtime = this.runtime(project.projectId);
        if (runtime.autonomyStore.getTicket(ticketId) !== undefined) return runtime;
      }
    }
    return null;
  }

  // -- projects and sessions ------------------------------------------------


  createProject(input: CreateProjectInput): ProjectView {
    const project = this.#requireProjects().create(input);
    if (project.runnable) {
      try { this.runtime(project.projectId); } catch (error) {
        this.#logger.warn('project runtime initialization failed', { projectId: project.projectId, error: String(error) });
      }
    }
    if (project.runnable) {
      // Attaching the canonical project is the setup step: create the Mesh
      // control/worktree/artifact/store directories from runtime defaults.
      try { this.initializeProjectRuntime(input.repositoryRef); } catch (error) {
        this.#logger.warn('project runtime initialization failed', { projectId: project.projectId, error: String(error) });
      }
    }
    return project;
  }

  /**
   * Create the default Mesh directories for a runnable project. Never creates
   * RSI state or modifies the canonical checkout.
   * @param repositoryRef - project repository root.
   * @returns created/confirmed paths.
   */
  initializeProjectRuntime(repositoryRef: string): {
    readonly controlDir: string;
    readonly worktreesDir: string;
    readonly artifactsDir: string;
    readonly storeDir: string | null;
    readonly created: readonly string[];
  } {
    const inspection = this.#requireProjects().inspect(repositoryRef);
    if (!inspection.runnable) {
      throw new MeshError('CONFIG_INVALID', 'project is not runnable in this profile; use a web-<project> profile', {
        repositoryRef,
        configuredSourceDir: inspection.configuredSourceDir,
      });
    }
    const created: string[] = [];
    const ensure = (path: string): void => {
      if (!existsSync(path)) { mkdirSync(path, { recursive: true, mode: 0o700 }); created.push(path); }
    };
    ensure(inspection.controlDir);
    ensure(inspection.worktreesDir);
    const config = this.#config;
    ensure(config.artifactsDir);
    const storeDir = config.artifactsDir.endsWith('/mesh/artifacts')
      ? config.artifactsDir.slice(0, -'/mesh/artifacts'.length)
      : null;
    if (storeDir !== null) {
      for (const child of ['checkpoints', 'results', 'archive_code']) ensure(`${storeDir}/${child}`);
      ensure(`${storeDir}/mesh`);
    }
    return { controlDir: inspection.controlDir, worktreesDir: inspection.worktreesDir, artifactsDir: config.artifactsDir, storeDir, created };
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
      const runtime = this.#runtimes.get(project.projectId);
      const teams = runtime?.teams ?? this.#requireTeams();
      const store = runtime?.store ?? this.#requireStore();
      if (project.status === 'paused' || project.status === 'archived' || project.status === 'registered') {
        const active = teams.list(project.projectId).filter(team => team.status === 'active');
        store.recordProjectPauses(project.projectId, active.map(team => team.teamId));
        for (const team of active) teams.pause(team.teamId);
      } else if (project.status === 'active') {
        const parked = store.listProjectPauses(project.projectId);
        for (const teamId of parked) {
          const team = teams.list(project.projectId).find(candidate => candidate.teamId === teamId);
          if (team !== undefined && team.status === 'paused') teams.resume(teamId);
        }
        store.clearProjectPauses(project.projectId);
      }
    }
  }

  setProjectStatus(projectId: string, status: import('./storage/types.ts').MeshProjectStatus): ProjectView {
    const project = this.#requireProjects().setStatus(projectId, status);
    const statusRuntime = this.#runtimes.get(projectId);
    if (statusRuntime !== undefined) {
      try { statusRuntime.store.updateProject(projectId, { status, updatedAt: new Date().toISOString() }) } catch { /* mirror only */ }
    }
    // Pausing or archiving a project parks new claims through the groups that
    // were active. Running jobs are untouched. Only groups parked by the project
    // are restored on resume; a manually paused group stays paused.
    const runtime = this.#runtimes.get(projectId);
    const teams = runtime?.teams ?? this.#requireTeams();
    const store = runtime?.store ?? this.#requireStore();
    if (status === 'paused' || status === 'archived' || status === 'registered') {
      const active = teams.list(projectId).filter(team => team.status === 'active');
      store.recordProjectPauses(projectId, active.map(team => team.teamId));
      for (const team of active) teams.pause(team.teamId);
    } else if (status === 'active') {
      const parked = store.listProjectPauses(projectId);
      for (const teamId of parked) {
        const team = teams.list(projectId).find(candidate => candidate.teamId === teamId);
        if (team !== undefined && team.status === 'paused') teams.resume(teamId);
      }
      store.clearProjectPauses(projectId);
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
      // Prefer the deployment's default provider (API Pool) over an arbitrary
      // first catalog entry.
      const catalog = await this.#requireModels().listCatalog();
      const chosen = catalog.find(entry => entry.provider === this.#config.defaultProvider) ?? catalog[0];
      if (chosen !== undefined) { provider = chosen.provider; model = chosen.model }
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
    const runtime = this.runtime(projectId);
    for (const team of runtime.teams.list(projectId)) {
      if (team.status === 'destroyed') continue;
      const subagents = runtime.teams.listSubagents(team.teamId);
      const agentModels = subagents.map(subagent => runtime.store.getAgentModel(subagent.sessionId))
        .filter((record): record is import('./storage/types.ts').AgentModelRecord => record !== undefined);
      const rootModel = runtime.store.getAgentModel(team.rootSessionId);
      if (rootModel !== undefined) agentModels.unshift(rootModel);
      const liveStatus: Record<string, string | null> = {
        [team.rootSessionId]: this.#agents?.get?.(team.rootSessionId)?.status ?? null,
      };
      for (const subagent of subagents) liveStatus[subagent.sessionId] = this.#agents?.get?.(subagent.sessionId)?.status ?? null;
      const workspace = team.workspaceId === null ? null : runtime.store.getWorkspace(team.workspaceId) ?? null;
      groups.push({
        team,
        subagents,
        agentModels,
        tasks: runtime.scheduler.listByTeam(team.teamId),
        workspace,
        liveStatus,
      });
    }
    const jobs = runtime.jobs.list().filter(job => job.projectId === projectId);
    const leases = runtime.gpu.list();
    const rsi = this.#rsiSummary(project);
    const modelErrors = await this.modelSettingsDiagnostics();
    return {
      project,
      groups,
      jobs,
      gpuLeases: leases,
      recentEvents: runtime.store.listRecentEvents(30),
      rsi,
      rlp: await this.#rlpWorkbenchSummary(project),
      autonomy: this.autonomyStatus(projectId),
      tickets: runtime.autonomy.listTickets(projectId),
      triggers: runtime.autonomy.listTriggers(projectId, 20),
      modelErrors,
      worker: this.#requireWorker().status(),
      generatedAt: nowIso(),
    };
  }


  async #rlpWorkbenchSummary(project: ProjectView): Promise<import('./projects/workbench.ts').RlpSummary> {
    const status = this.rlpStatus();
    if (!status.available) {
      return {
        available: false, version: null, digest: null, skillPath: null,
        storageStatus: null, storageRoot: null, formalRunAllowed: false, reason: status.reason,
      };
    }
    try {
      const resolution = await this.#requireRlp().storage().resolve(project.repositoryRef);
      return {
        available: true,
        version: status.version,
        digest: status.digest,
        skillPath: status.skillPath,
        storageStatus: resolution.status,
        storageRoot: resolution.storageRoot,
        formalRunAllowed: resolution.formalRunAllowed,
        reason: resolution.runtimeReason,
      };
    } catch (error) {
      return {
        available: true, version: status.version, digest: status.digest, skillPath: status.skillPath,
        storageStatus: null, storageRoot: null, formalRunAllowed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
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
    const groups = this.#teamsFor(projectId).list(projectId);
    this.#assertProjectActive(projectId);
    const group = teamId === undefined
      ? groups.find(candidate => candidate.status === 'active')
      : groups.find(candidate => candidate.teamId === teamId);
    if (group === undefined) throw new MeshError('TEAM_NOT_FOUND', 'no active group is available for a local simulation', { projectId });
    const task = this.#schedulerFor(projectId).submit({
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
    const round = await this.runtime(projectId).worker.runOnce();
    return round.task?.taskId === task.taskId ? round.task : this.#schedulerFor(projectId).get(task.taskId);
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
    const team = this.#teamsByTeam(binding.groupId ?? '').get(binding.groupId ?? '');
    if (team === undefined) return undefined;
    if (binding.role === 'member') {
      return `Research Mesh: member sessions cannot delegate further (group ${team.name})`;
    }
    if (team.status !== 'active') {
      return `Research Mesh: group ${team.name} is ${team.status}; native delegation is disabled`;
    }
    {
      const teams = this.#teamsByTeam(team.teamId);
      const inTeam = teams.listSubagents(team.teamId).filter(member => member.status !== 'disposed').length;
      if (inTeam >= this.#config.limits.maxSubagentsPerTeam) {
        return `Research Mesh: group ${team.name} already has ${inTeam} subagents (limit ${this.#config.limits.maxSubagentsPerTeam})`;
      }
      const total = teams.totalSubagents();
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
    this.#assertRlpFormalRunSync();
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
    const team = await this.#teamsFor(input.projectId).createTeam(input);
    if (projects !== null && projects.list().some(project => project.projectId === input.projectId)) {
      try {
        projects.bind(input.projectId, team.rootSessionId, 'captain', team.teamId);
      } catch (error) {
        // A group without its captain binding would be unreachable from the
        // Workbench and would still consume a slot, so retire it immediately.
        try { await this.#teamsFor(input.projectId).destroy(team.teamId); } catch (cleanupError) {
          this.#logger.error('failed to retire group after captain binding failure', {
            teamId: team.teamId,
            error: String(cleanupError),
          });
        }
        if (team.workspaceId !== null) {
          try { await this.#workspacesFor(input.projectId).cleanup(team.workspaceId, { confirm: true, force: true }); } catch (cleanupError) {
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
    return this.#teamsByTeam(teamId).get(teamId);
  }

  /** Resume the persisted captain Session with the group's assigned model. */
  resumeRootSession(teamId: string): Promise<void> {
    return this.#teamsByTeam(teamId).resumeRootSession(teamId);
  }

  listTeams(projectId?: string): readonly TeamView[] {
    if (projectId !== undefined) return this.#teamsFor(projectId).list(projectId);
    const fromRuntimes = this.runtimes().flatMap(runtime => runtime.teams.list());
    const legacy = this.#teams?.list() ?? [];
    return [...legacy, ...fromRuntimes];
  }

  pauseTeam(teamId: string): TeamView {
    return this.#teamsByTeam(teamId).pause(teamId);
  }

  resumeTeam(teamId: string): TeamView {
    return this.#teamsByTeam(teamId).resume(teamId);
  }

  /**
   * Stop a group: park claims, cancel tasks that have not started, and retain
   * running tasks/jobs. Distinct from pause, which leaves queued work intact.
   * @param teamId - group identity.
   * @returns updated group and cancelled task ids.
   */
  stopTeam(teamId: string): { team: TeamView; cancelled: readonly string[] } {
    const runtime = this.#runtimeByTeam(teamId);
    const teams = runtime?.teams ?? this.#requireTeams();
    const scheduler = runtime?.scheduler ?? this.#requireScheduler();
    const team = teams.stop(teamId);
    const cancelled: string[] = [];
    for (const task of scheduler.listByTeam(teamId)) {
      if (task.status === 'PENDING' || task.status === 'READY') {
        try {
          scheduler.cancel(task.taskId, 'group stopped by operator');
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
    const runtime = this.#runtimeByTeam(teamId);
    const teams = runtime?.teams ?? this.#requireTeams();
    const team = teams.get(teamId);
    const destroyed = await teams.destroy(teamId);
    // Bindings are Mesh management state too; leaving them active would pin
    // the sessions to a destroyed group and block reuse.
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      this.#projects.detach(team.rootSessionId);
      for (const subagent of teams.listSubagents(teamId)) this.#projects.detach(subagent.sessionId);
    }
    return destroyed;
  }

  async registerSubagent(input: RegisterSubagentInput): Promise<SubagentView> {
    const teams = this.#teamsByTeam(input.teamId);
    const team = teams.get(input.teamId);
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      const project = this.#projects.get(team.researchProjectId);
      if (project.status !== 'active') {
        throw new MeshError('TEAM_STATE_INVALID', 'project is not active; cannot register a member', {
          projectId: project.projectId,
          status: project.status,
        });
      }
    }
    const subagent = await teams.registerSubagent(input);
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      try {
        this.#projects.bind(team.researchProjectId, subagent.sessionId, 'member', input.teamId);
      } catch (error) {
        // A partially registered member without a project binding is not a
        // usable Mesh identity; release it before surfacing the failure.
        try { teams.releaseSubagent(input.teamId, subagent.sessionId); } catch { /* retain original */ }
        throw error;
      }
    }
    return subagent;
  }

  releaseSubagent(teamId: string, sessionId: string): void {
    const teams = this.#teamsByTeam(teamId);
    const team = teams.get(teamId);
    teams.releaseSubagent(teamId, sessionId);
    // A released identity must not keep an active member binding, otherwise it
    // could never be re-registered in another group.
    if (this.#projects !== null && this.#projects.list().some(project => project.projectId === team.researchProjectId)) {
      this.#projects.detach(sessionId);
    }
  }

  listSubagents(teamId: string): readonly SubagentView[] {
    return this.#teamsByTeam(teamId).listSubagents(teamId);
  }

  /** Return the recorded provider/model for one agent identity. */
  agentModel(sessionId: string): import('./storage/types.ts').AgentModelRecord | undefined {
    const legacy = this.#store?.getAgentModel(sessionId);
    if (legacy !== undefined) return legacy;
    for (const runtime of this.runtimes()) {
      const record = runtime.store.getAgentModel(sessionId);
      if (record !== undefined) return record;
    }
    return undefined;
  }

  // -- workspaces ----------------------------------------------------------

  listWorkspaces(projectId?: string): readonly import('./storage/types.ts').MeshWorkspaceRecord[] {
    if (projectId !== undefined) return this.#workspacesFor(projectId).list(projectId);
    const fromRuntimes = this.runtimes().flatMap(runtime => runtime.workspaces.list());
    const legacy = this.#workspaces?.list() ?? [];
    return [...legacy, ...fromRuntimes];
  }

  inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection> {
    return this.#workspacesByWorkspace(workspaceId).inspect(workspaceId);
  }

  cleanupWorkspace(workspaceId: string, options: CleanupWorkspaceOptions): Promise<CleanupWorkspaceResult> {
    return this.#workspacesByWorkspace(workspaceId).cleanup(workspaceId, options);
  }

  /** Read a UTF-8 file through the workspace boundary. */
  readWorkspaceFile(workspaceId: string, path: string): string {
    return this.#workspacesByWorkspace(workspaceId).files(workspaceId).readText(path);
  }

  /** Atomically write a UTF-8 file through the workspace boundary. */
  writeWorkspaceFile(workspaceId: string, path: string, content: string): string {
    return this.#workspacesByWorkspace(workspaceId).files(workspaceId).writeText(path, content);
  }

  // -- tasks ---------------------------------------------------------------

  submitTask(input: SubmitTaskInput): { task: MeshTaskView; created: boolean } {
    this.#assertProjectActive(input.projectId);
    return this.#schedulerFor(input.projectId).submit(input);
  }

  submitExperimentTask(input: SubmitExperimentTaskInput): { task: MeshTaskView; created: boolean } {
    this.#assertProjectActive(input.projectId);
    this.#assertRlpFormalRunSync();
    const payload: import('./worker.ts').ExperimentTaskPayload = {
      workerId: input.workerId,
      gpuId: input.gpuId,
      rsi: input.rsi,
      ...(input.condaEnvironment === undefined ? {} : { condaEnvironment: input.condaEnvironment }),
      ...(input.artifactDestination === undefined ? {} : { artifactDestination: input.artifactDestination }),
      ...(input.requiredArtifacts === undefined ? {} : { requiredArtifacts: input.requiredArtifacts }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    };
    return this.#schedulerFor(input.projectId).submit({
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
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).get(taskId);
  }

  listTasksByTeam(teamId: string): readonly MeshTaskView[] {
    return (this.#runtimeByTeam(teamId)?.scheduler ?? this.#requireScheduler()).listByTeam(teamId);
  }

  listTasksByProject(projectId: string): readonly MeshTaskView[] {
    return this.#schedulerFor(projectId).listByProject(projectId);
  }

  claimNext(workerId?: string): ClaimedTask | undefined {
    const id = workerId ?? this.#requireWorkerId();
    for (const runtime of this.runtimes()) {
      const claimed = runtime.scheduler.claimNext(id);
      if (claimed !== undefined) return claimed;
    }
    return this.#requireScheduler().claimNext(id);
  }

  /** Claim one named task through the explicit scheduler path. */
  claimTask(taskId: string, workerId?: string): ClaimedTask {
    const scheduler = this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler();
    return scheduler.claimTask(taskId, workerId ?? this.#requireWorkerId());
  }

  startTask(taskId: string, workerId: string, attemptId: string): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).start(taskId, workerId, attemptId);
  }

  succeedTask(taskId: string, attemptId: string): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).succeed(taskId, attemptId);
  }

  failTask(taskId: string, attemptId: string, code: string, message: string, retryable = false): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).fail(taskId, attemptId, code, message, retryable);
  }

  heartbeatTask(taskId: string, attemptId: string): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).heartbeat(taskId, attemptId);
  }

  retryTask(taskId: string, options: { reason: string; extendAttempts?: boolean }): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).retry(taskId, options);
  }

  cancelTask(taskId: string, reason: string): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).cancel(taskId, reason);
  }

  blockTask(taskId: string, attemptId: string | null, code: string, message: string): MeshTaskView {
    return (this.#runtimeByTask(taskId)?.scheduler ?? this.#requireScheduler()).block(taskId, attemptId, code, message);
  }

  // -- worker and jobs -----------------------------------------------------

  async runWorkerOnce(options: { poll?: boolean } = {}): Promise<WorkerRoundResult> {
    // One round per project runtime, then the legacy worker for a profile-level
    // project that predates runtimes.
    let result: WorkerRoundResult = { task: null, collected: [] };
    for (const runtime of this.runtimes()) {
      try {
        await runtime.effects.tick();
        const round = await runtime.worker.runOnce(options);
        if (round.task !== null) result = round;
        await runtime.effects.tick();
      } catch (error) {
        this.#logger.warn('project runtime round failed', { projectId: runtime.project.projectId, error: String(error) });
      }
    }
    await this.#requireEffects().tick();
    const legacy = await this.#requireWorker().runOnce(options);
    if (legacy.task !== null) result = legacy;
    await this.#requireEffects().tick();
    return result;
  }

  /**
   * Record the durable Artifact event exactly once per job. Only a verified
   * ingestion calls this; a failed transfer never produces a success event.
   * @param result - ingestion result from the job executor.
   */
  #recordArtifactIngested(result: IngestionResult): void {
    try {
      const assignment = this.#autoStore?.findAssignmentByJob(result.jobId);
      this.#requireAutonomy().receiveTrigger({
        source: 'artifact',
        eventId: `artifact:${result.jobId}`,
        projectId: result.task.projectId,
        kind: 'artifact_ingested',
        dedupeKey: `artifact:${result.jobId}`,
        payload: {
          jobId: result.jobId,
          artifactManifestDigest: result.artifactManifestDigest,
          ...(assignment === undefined ? {} : { ticketId: assignment.ticketId }),
        },
        ...(assignment === undefined ? {} : { ticketId: assignment.ticketId }),
      });
    } catch (error) {
      this.#logger.warn('artifact wake-up trigger failed', { jobId: result.jobId, error: String(error) });
    }
  }

  /**
   * Drive the worker through the service so every ingestion produces its
   * Artifact event, rather than calling the worker loop directly.
   * @param maxRounds - safety bound.
   * @returns rounds executed.
   */
  async runUntilIdle(maxRounds = 50): Promise<number> {
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await this.runWorkerOnce();
      if (result.task === null) {
        if (this.listJobs(['submitted', 'submitted_unconfirmed', 'running', 'output_ready', 'reconcile_required']).length === 0) {
          return round + 1;
        }
      }
    }
    throw new MeshError('INTERNAL', 'worker did not reach idle within the round bound', { maxRounds });
  }

  startScheduler(): void {
    this.#requireWorker().start();
  }

  async stopScheduler(): Promise<void> {
    await this.#requireWorker().stop();
  }

  workerStatus(): WorkerStatus {
    return this.#requireWorker().status();
  }

  listJobs(statuses?: readonly MeshJobStatus[], projectId?: string): readonly MeshJobRecord[] {
    if (projectId !== undefined) return this.#jobsFor(projectId).list(statuses);
    const fromRuntimes = this.runtimes().flatMap(runtime => runtime.jobs.list(statuses));
    const legacy = this.#jobs?.list(statuses) ?? [];
    return [...legacy, ...fromRuntimes];
  }

  queryJob(jobId: string): Promise<MeshTaskView> {
    return (this.#runtimeByJob(jobId)?.jobs ?? this.#requireJobs()).query(jobId);
  }

  async reconcileJob(jobId: string): Promise<MeshTaskView> {
    const task = await (this.#runtimeByJob(jobId)?.jobs ?? this.#requireJobs()).reconcile(jobId);
    await this.#recordArtifactIfIngested(jobId);
    return task;
  }

  collectJob(jobId: string): Promise<IngestionResult> {
    // The job executor emits the Artifact event from collect(), so every
    // ingestion path (poll, consumed shim, manual collect) shares one source.
    return (this.#runtimeByJob(jobId)?.jobs ?? this.#requireJobs()).collect(jobId);
  }

  async #recordArtifactIfIngested(jobId: string): Promise<void> {
    const job = this.#requireStore().getJob(jobId);
    if (job === undefined) return;
    // Reconcile adopts remote state; collection stays an explicit verified step.
    // Only an already-ingested job produces an Artifact event here.
    if (job.status !== 'ingested') return;
    const artifacts = this.#requireStore().listArtifacts(jobId);
    this.#recordArtifactIngested({
      jobId,
      task: this.#requireScheduler().get(job.taskId),
      artifacts: artifacts.map(artifact => ({
        path: artifact.relativePath, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
      })),
      artifactManifestDigest: this.#requireStore().getOutcome(jobId)?.artifactManifestDigest ?? job.manifestDigest,
      outcomePath: null,
    });
  }

  abandonJob(jobId: string, reason: string): MeshTaskView {
    return (this.#runtimeByJob(jobId)?.jobs ?? this.#requireJobs()).abandon(jobId, reason);
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
    this.#markConsumedInterruptions();
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

  /**
   * Mark an interrupted consumed-ledger launch before scheduler recovery.
   *
   * The RSI receipt is spent before the Mesh job is submitted. If the process
   * dies in that window, ordinary task recovery would classify the task as a
   * lost local attempt and could retry it, spending a second receipt. A
   * journal + consume event instead pins it to RECONCILE_REQUIRED.
   * @returns number of tasks marked.
   */
  #markConsumedInterruptions(): number {
    const store = this.#requireStore();
    let marked = 0;
    for (const group of store.listGroups()) {
      for (const task of store.teamStore.listTasks(group.teamId)) {
        if (task.status !== 'claimed' && task.status !== 'running') continue;
        const meta = store.getTaskMeta(task.task_id);
        if (meta === undefined) continue;
        let payload: { rsi?: { shim?: { journalPath?: string }; ledgerPath?: string; experimentId?: string } };
        try { payload = JSON.parse(meta.payloadJson) as typeof payload; } catch { continue; }
        const journalPath = payload.rsi?.shim?.journalPath;
        if (typeof journalPath !== 'string' || !existsSync(journalPath)) continue;
        let journal: Record<string, unknown>;
        try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); } catch { continue; }
        const phase = journal.phase;
        if (phase !== 'launching' && phase !== 'consumed' && phase !== 'launch_failed') continue;
        const receiptId = typeof journal.receiptId === 'string' ? journal.receiptId : null;
        const experimentId = payload.rsi?.experimentId ?? (typeof journal.experimentId === 'string' ? journal.experimentId : null);
        const ledgerPath = payload.rsi?.ledgerPath ?? journalPath.replace(/\/[^/]+$/, '');
        if (receiptId === null || experimentId === null) continue;
        const consumed = findConsumeEvent(ledgerPath, receiptId, experimentId) !== undefined;
        if (!consumed) continue;
        // The attempt is spent. Do not let recover() turn it into a retryable failure.
        this.#requireStore().updateTaskMeta(task.task_id, {
          remoteStatus: 'RECONCILE_REQUIRED',
          errorCode: 'CONSUMED_RUN_INTERRUPTED',
          errorMessage: 'RSI receipt was consumed but the Mesh job was not confirmed; reconcile, never rerun',
          updatedAt: nowIso(),
        });
        this.#requireStore().appendEvent('task', task.task_id, 'consumed-run-interrupted', { receiptId, journalPhase: phase });
        marked += 1;
      }
    }
    return marked;
  }

  /** Public test/operator entry for the consumed interruption marker. */
  markConsumedInterruptions(): number {
    return this.#markConsumedInterruptions();
  }

  async #startupRecovery(): Promise<void> {

    try {
      this.reconcileProjectPauses();
      this.#markConsumedInterruptions();
      const scheduler = this.#requireScheduler().recover();
      const jobs = this.#requireJobs().recover();
      const gpu = this.#requireGpu().reconcile();
      const workspaces = await this.#requireWorkspaces().recover();
      // Re-establish the Artifact event for jobs that were already ingested when
      // the process stopped. The dedupe key makes this idempotent across restarts.
      for (const job of this.#requireJobs().list(['ingested'])) {
        await this.#recordArtifactIfIngested(job.jobId);
      }
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
