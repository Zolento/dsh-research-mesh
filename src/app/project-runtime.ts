/**
 * One project's SuperAgent runtime.
 *
 * A Mesh hosts many projects; each project owns its own control plane instead of
 * sharing one global one:
 *  - its own SQLite database (`<controlDir>/runtime.sqlite`),
 *  - its own worktree root, artifact store, manifests and logs,
 *  - its own scheduler, worker, effects queue and autonomy engine,
 *  - its own RLP resolver rooted at that project,
 *  - one resident DSH control session (`项目主控`) bound to the project.
 *
 * Nothing here reads another project's state, so a runtime cannot act outside
 * its own project.
 */

import { join } from 'node:path';
import { MeshError } from '../errors.ts';
import type { MeshConfig } from '../config/types.ts';
import { ensureProjectLayout, type ProjectLayout } from '../project.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshProjectRecord } from '../storage/types.ts';
import { openTeamStore, type SqliteTeamStore } from '../bridge/runtime/persistence.ts';
import { AutonomyStore } from '../autonomy/store.ts';
import { EffectsRunner } from '../autonomy/effects.ts';
import { AutonomyEngine, DEFAULT_AUTONOMY_POLICY } from '../autonomy/engine.ts';
import { WorkspaceManager } from '../workspaces/manager.ts';
import { TeamManager } from '../teams/manager.ts';
import { TaskScheduler } from '../scheduler/scheduler.ts';
import { GpuLeaseManager, type GpuProbe, UnknownGpuProbe } from '../resources/gpu.ts';
import { ExperimentJobService } from '../executors/job-service.ts';
import { RemoteJobExecutor } from '../executors/remote.ts';
import { LocalExecutor } from '../executors/local.ts';
import { MeshWorker } from '../worker.ts';
import { RsiAdapter } from '../rsi/adapter.ts';
import { RlpRuntime } from '../rlp/index.ts';
import { SshTransport } from '../executors/ssh.ts';
import { FakeTransport } from '../executors/transport.ts';
import type { ModelCatalog, ModelSettingsStore, ModelResolver } from '../teams/models.ts';
import { ModelResolver as Resolver } from '../teams/models.ts';
import type { SessionHost } from '../teams/session-host.ts';
import type { MeshLogger } from '../util/logger.ts';
import { newWorkerId } from '../util/ids.ts';
import type { IngestionResult } from '../executors/remote.ts';
import type { JobTransport } from '../executors/transport.ts';

/** Effective configuration for one project (base config + project layout). */
export function projectConfig(base: MeshConfig, project: MeshProjectRecord): MeshConfig {
  const sourceDir = project.sourceDir ?? project.repositoryRef;
  const controlDir = project.controlDir ?? join(base.controlDir, 'projects', project.projectId);
  return Object.freeze({
    ...base,
    projectRoot: sourceDir,
    sourceDir,
    controlDir,
    worktreesDir: project.worktreesDir ?? join(controlDir, 'worktrees'),
    artifactsDir: project.artifactsDir ?? join(controlDir, 'artifacts'),
    databasePath: join(controlDir, 'runtime.sqlite'),
  });
}

/** Dependencies shared across project runtimes. */
export interface ProjectRuntimeDeps {
  readonly baseConfig: MeshConfig;
  readonly logger: MeshLogger;
  readonly sessionHost: SessionHost;
  readonly settings: ModelSettingsStore;
  readonly catalog: ModelCatalog;
  readonly transport?: JobTransport;
  readonly gpuProbe?: GpuProbe;
  readonly onIngested?: (result: IngestionResult) => void;
}

/** One project's isolated runtime. */
export class ProjectRuntime {
  readonly project: MeshProjectRecord;
  readonly config: MeshConfig;
  readonly layout: ProjectLayout;
  readonly store: MeshStore;
  readonly teamStore: SqliteTeamStore;
  readonly autonomyStore: AutonomyStore;
  readonly effects: EffectsRunner;
  readonly autonomy: AutonomyEngine;
  readonly workspaces: WorkspaceManager;
  readonly teams: TeamManager;
  readonly scheduler: TaskScheduler;
  readonly gpu: GpuLeaseManager;
  readonly jobs: ExperimentJobService;
  readonly worker: MeshWorker;
  readonly rsi: RsiAdapter;
  readonly rlp: RlpRuntime;
  readonly models: ModelResolver;
  readonly workerId: string;
  readonly #deps: ProjectRuntimeDeps;
  #controlSessionId: string | null;
  #rlpReady: boolean;
  #closed = false;

  /**
   * @param deps - shared dependencies (session host, settings, catalog).
   * @param project - the registry row this runtime serves.
   */
  constructor(deps: ProjectRuntimeDeps, project: MeshProjectRecord) {
    this.#deps = deps;
    this.project = project;
    this.config = projectConfig(deps.baseConfig, project);
    this.layout = ensureProjectLayout(this.config);
    this.teamStore = openTeamStore({ path: this.config.databasePath });
    this.store = new MeshStore(this.teamStore);
    this.autonomyStore = new AutonomyStore(this.teamStore);
    this.effects = new EffectsRunner(this.autonomyStore);
    this.models = new Resolver(deps.settings, deps.catalog, this.config.agent);
    this.autonomy = new AutonomyEngine({
      store: this.autonomyStore,
      effects: this.effects,
      meshStore: this.store,
      policy: { ...DEFAULT_AUTONOMY_POLICY, version: this.config.rlp.autonomyPolicyVersion, mode: this.config.rlp.autonomyMode },
      projectStatus: () => {
        try { return this.store.getProject(project.projectId)?.status ?? 'active' } catch { return 'active' }
      },
      rlpFormalRun: () => this.#rlpReady,
      groupFacts: teamId => this.autonomyStore.groupFacts(teamId),
    });
    this.workspaces = new WorkspaceManager(this.config, this.store, deps.logger);
    this.teams = new TeamManager(this.config, this.store, deps.sessionHost, this.workspaces, deps.logger, this.models);
    this.scheduler = new TaskScheduler(this.config, this.store, deps.logger);
    const transport = deps.transport ?? this.#createTransport();
    this.gpu = new GpuLeaseManager(this.config, this.store, deps.gpuProbe ?? new UnknownGpuProbe(), deps.logger);
    this.rsi = new RsiAdapter(this.config, deps.logger);
    this.rlp = RlpRuntime.create({
      ...(this.config.rlp.skillPath === undefined ? {} : { skillPath: this.config.rlp.skillPath }),
      python: this.config.rlp.pythonExecutable,
      timeoutMs: this.config.rlp.timeoutMs,
      optional: true,
    });
    const local = new LocalExecutor(this.config.conda, this.layout.logs, deps.logger);
    const executor = new RemoteJobExecutor({
      config: this.config,
      store: this.store,
      scheduler: this.scheduler,
      gpu: this.gpu,
      transport,
      artifactsRoot: this.layout.artifacts,
      manifestsRoot: this.layout.manifests,
      outcomesRoot: this.layout.outcomes,
      logger: deps.logger,
      ...(deps.onIngested === undefined ? {} : { onIngested: deps.onIngested }),
    });
    this.jobs = new ExperimentJobService(this.config, this.store, this.scheduler, this.workspaces, executor, this.layout.manifests, deps.logger);
    this.workerId = newWorkerId();
    this.worker = new MeshWorker({
      config: this.config,
      store: this.store,
      scheduler: this.scheduler,
      teams: this.teams,
      workspaces: this.workspaces,
      local,
      jobs: this.jobs,
      rsi: this.rsi,
      logger: deps.logger,
      workerId: this.workerId,
      effects: this.effects,
    });
    const existing = this.store.getProject(project.projectId);
    this.#controlSessionId = existing?.controlSessionId ?? null;
    // Without an RLP runtime the project is a plain engineering project; with
    // one, readiness is established by primeRlp() before formal runs.
    this.#rlpReady = !this.config.rlp.enabled;
  }

  /**
   * Resolve the project's RLP storage once and remember whether formal runs are
   * allowed. Safe to call repeatedly; failures leave the runtime not-ready.
   */
  async primeRlp(): Promise<boolean> {
    if (!this.rlp.available) {
      this.#rlpReady = !this.config.rlp.enabled;
      return this.#rlpReady;
    }
    try {
      const resolution = await this.rlp.storage().resolve(this.config.projectRoot);
      this.#rlpReady = resolution.formalRunAllowed;
    } catch {
      this.#rlpReady = false;
    }
    return this.#rlpReady;
  }

  /** Cached RLP readiness for synchronous guards. */
  get rlpReady(): boolean {
    return this.#rlpReady;
  }

  #createTransport(): JobTransport {
    const workers = Object.values(this.config.workers);
    const primary = workers.find(worker => worker.enabled) ?? workers[0];
    if (primary === undefined) throw new MeshError('CONFIG_INVALID', 'no worker is configured');
    if (primary.transport === 'fake') {
      if (primary.fakeRemoteRoot === undefined) throw new MeshError('CONFIG_INVALID', 'fake worker lacks fakeRemoteRoot');
      return new FakeTransport(primary.fakeRemoteRoot);
    }
    return new SshTransport({ config: this.config });
  }

  /** Resident control session bound to this project, when one exists. */
  get controlSessionId(): string | null {
    return this.#controlSessionId;
  }

  /**
   * Ensure the project has exactly one resident control session (项目主控).
   * Reuses the recorded session when it still exists, otherwise creates it.
   * @returns the session id and whether it was created now.
   */
  async ensureControlSession(options: { provider?: string; model?: string; title?: string } = {}): Promise<{ sessionId: string; created: boolean }> {
    const recorded = this.#controlSessionId ?? this.store.getProject(this.project.projectId)?.controlSessionId ?? null;
    if (recorded !== null) {
      try {
        await this.#deps.sessionHost.resumeRoot(recorded, options.provider, options.model);
        return { sessionId: recorded, created: false };
      } catch {
        // The session is gone; fall through and create a fresh control session.
      }
    }
    let provider = options.provider ?? this.config.agent?.provider;
    let model = options.model ?? this.config.agent?.model;
    if (provider === undefined || model === undefined) {
      // Fall back to the first registered route so the project still gets its
      // resident control session; an explicit route always wins.
      try {
        const catalog = await this.models.listCatalog();
        // The deployment declares a preferred provider (API Pool by default), so
        // a project control session does not silently land on another vendor.
        const preferred = catalog.find(entry => entry.provider === this.config.defaultProvider);
        const chosen = preferred ?? catalog[0];
        if (chosen !== undefined) { provider = provider ?? chosen.provider; model = model ?? chosen.model }
      } catch { /* fall through to the explicit failure below */ }
    }
    if (provider === undefined || model === undefined) {
      throw new MeshError('MODEL_CONFIG_INVALID', 'a control session needs a configured provider/model', {
        projectId: this.project.projectId,
      });
    }
    const created = await this.#deps.sessionHost.createControl({
      teamId: `control-${this.project.projectId}`,
      projectId: this.project.projectId,
      name: this.project.name,
      cwd: this.config.sourceDir,
      title: options.title ?? `${this.project.name} · 项目主控`,
      provider,
      model,
    });
    this.store.setProjectControlSession(this.project.projectId, created.sessionId);
    this.#controlSessionId = created.sessionId;
    this.store.appendEvent('project', this.project.projectId, 'control-session-ensured', { sessionId: created.sessionId });
    return { sessionId: created.sessionId, created: true };
  }

  /** Start the background loop (scheduler + effects) for this project. */
  start(): void {
    this.worker.start();
  }

  /** Stop the loop and close this project's database. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.worker.stop(); } catch { /* already stopped */ }
    try { this.teamStore.close(); } catch { /* already closed */ }
  }

  /** Compact status for the control plane. */
  status(): {
    projectId: string;
    controlDir: string;
    databasePath: string;
    worker: { running: boolean; workerId: string; lastError: string | null };
    rlp: { available: boolean; ready: boolean };
    controlSessionId: string | null;
    tickets: number;
    jobs: number;
  } {
    return {
      projectId: this.project.projectId,
      controlDir: this.config.controlDir,
      databasePath: this.config.databasePath,
      worker: this.worker.status(),
      rlp: { available: this.rlp.available, ready: this.#rlpReady },
      controlSessionId: this.#controlSessionId,
      tickets: this.autonomy.listTickets(this.project.projectId).length,
      jobs: this.jobs.list().length,
    };
  }
}
