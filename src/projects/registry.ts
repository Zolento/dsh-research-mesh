/**
 * Research Project registry and session bindings.
 *
 * A project is a long-lived identity independent of any chat Session. Sessions
 * attach explicitly as `control`, `captain`, or `member`; nothing is inferred
 * from titles, working directories, or model text. Captain/member bindings are
 * created by the Team Manager when the corresponding Session exists.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isAbsolute, relative as relativePath, resolve } from 'node:path';
import { MeshError } from '../errors.ts';
import { detectStorageLayout } from '../bridge/adapters/research-pipeline.ts';
import type { MeshConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshProjectRecord, MeshProjectStatus, MeshSessionBinding, SessionRole } from '../storage/types.ts';
import type { MeshLogger } from '../util/logger.ts';
import { ID_PREFIX, newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';

/** Project creation input. */
export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  /** Absolute canonical `research-state.json` path. */
  readonly rsiStateRef: string;
  /** Absolute Git repository path. */
  readonly repositoryRef: string;
  /** Executable checkout; defaults to the repository itself (whole-repo project). */
  readonly sourceDir?: string;
  /** Per-project control directory; defaults to `<base controlDir>/projects/<id>`. */
  readonly controlDir?: string;
  readonly worktreesDir?: string;
  readonly artifactsDir?: string;
}

/** One RSI route state discovered in a repository. */
export interface RepositoryRouteState {
  readonly routeId: string;
  readonly statePath: string;
  readonly stateVersion: string | null;
  readonly valid: boolean;
  readonly error: string | null;
}

/** Read-only inspection used by the attach-project form. */
export interface RepositoryInspection {
  readonly repositoryRef: string;
  readonly suggestedName: string;
  readonly routes: readonly RepositoryRouteState[];
  readonly runnable: boolean;
  readonly configuredSourceDir: string;
  readonly controlDir: string;
  readonly worktreesDir: string;
  /** RLP control-root layout found in the repository. */
  readonly storageKind: 'new' | 'legacy' | 'ambiguous' | 'none';
  /** New root exists but carries no route state. */
  readonly newRootPresent: boolean;
  /** Legacy root exists and must migrate before formal runs. */
  readonly migrationRequired: boolean;
}

/** Project plus derived Workbench diagnostics. */
export interface ProjectView extends MeshProjectRecord {
  readonly groupCount: number;
  readonly activeGroupCount: number;
  readonly rsiReadable: boolean;
  readonly rsiVersion: string | null;
  readonly rsiError: string | null;
  readonly controlSessions: readonly string[];
  readonly captainSessions: readonly string[];
  readonly memberSessions: readonly string[];
}

function stateVersionOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).state_version;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

/** Durable project registry. */
export class ProjectRegistry {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #logger: MeshLogger;

  /** Group lookup used by bindings; a Mesh may keep groups in per-project runtimes. */
  #groupLookup: ((teamId: string) => { projectId: string; status: string } | undefined) | null;

  constructor(
    config: MeshConfig,
    store: MeshStore,
    logger: MeshLogger,
    groupLookup?: (teamId: string) => { projectId: string; status: string } | undefined,
  ) {
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
    this.#groupLookup = groupLookup ?? null;
  }

  /** Let the service attach its cross-runtime group lookup after construction. */
  setGroupLookup(lookup: (teamId: string) => { projectId: string; status: string } | undefined): void {
    this.#groupLookup = lookup;
  }

  /**
   * Inspect an existing repository without registering it.
   *
   * The form uses this to derive the RSI state path and to explain when a
   * repository has not been bootstrapped by the RSI skill yet. It never creates
   * state or modifies the checkout.
   * @param repositoryRef - absolute Git checkout path.
   * @returns routes and runtime capabilities.
   */
  inspect(repositoryRef: string): RepositoryInspection {
    if (!isAbsolute(repositoryRef)) {
      throw new MeshError('INVALID_ARGUMENT', 'repository path must be absolute');
    }
    const root = resolve(repositoryRef);
    if (!existsSync(resolve(root, '.git'))) {
      throw new MeshError('CONFIG_INVALID', 'repository path is not a Git checkout', { repositoryRef: root });
    }
    const layout = detectStorageLayout(root);
    // The new runtime root wins; a legacy-only checkout is reported as
    // MIGRATION_REQUIRED instead of being treated as the current root.
    const routesRoot = join(layout.kind === 'legacy' ? layout.legacyRoot : layout.newRoot, 'routes');
    const routes: RepositoryRouteState[] = [];
    if (existsSync(routesRoot)) {
      for (const entry of readdirSync(routesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const statePath = join(routesRoot, entry.name, 'research-state.json');
        if (!existsSync(statePath)) continue;
        try {
          const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
          const version = stateVersionOf(parsed);
          routes.push({
            routeId: entry.name,
            statePath,
            stateVersion: version,
            valid: version !== null,
            error: version === null ? 'research-state.json has no state_version' : null,
          });
        } catch (error) {
          routes.push({
            routeId: entry.name,
            statePath,
            stateVersion: null,
            valid: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    routes.sort((a, b) => a.routeId.localeCompare(b.routeId));
    let runnable = false;
    try { runnable = realpathSync(root) === realpathSync(this.#config.sourceDir); } catch { runnable = false; }
    return {
      repositoryRef: root,
      suggestedName: basename(root),
      routes,
      runnable,
      configuredSourceDir: this.#config.sourceDir,
      controlDir: this.#config.controlDir,
      worktreesDir: this.#config.worktreesDir,
      storageKind: layout.kind,
      newRootPresent: layout.kind === 'new' || layout.kind === 'ambiguous',
      migrationRequired: layout.kind === 'legacy',
    };
  }

  /**
   * Register an existing RSI project. The state must exist and carry a
   * `state_version`; a project outside this runtime's source root is registered
   * read-only (`registered`) and cannot create groups here.
   */
  create(input: CreateProjectInput): ProjectView {
    const name = input.name.trim();
    if (name === '' || name.length > 200) throw new MeshError('INVALID_ARGUMENT', 'project name must be 1-200 characters');
    const description = (input.description ?? '').trim().slice(0, 2000);
    if (!isAbsolute(input.rsiStateRef) || !isAbsolute(input.repositoryRef)) {
      throw new MeshError('INVALID_ARGUMENT', 'RSI state and repository paths must be absolute');
    }
    const rsiStateRef = resolve(input.rsiStateRef);
    const repositoryRef = resolve(input.repositoryRef);
    const stateStat = statSync(rsiStateRef, { throwIfNoEntry: false });
    if (stateStat === undefined || !stateStat.isFile()) {
      throw new MeshError('RSI_STATE_UNAVAILABLE', 'RSI state file does not exist', { rsiStateRef });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(rsiStateRef, 'utf8')); } catch {
      throw new MeshError('RSI_INVALID', 'RSI state file is not valid JSON', { rsiStateRef });
    }
    if (stateVersionOf(parsed) === null) {
      throw new MeshError('RSI_INVALID', 'RSI state has no state_version; refusing to register an unsubstantiated project', { rsiStateRef });
    }
    if (!existsSync(resolve(repositoryRef, '.git'))) {
      throw new MeshError('CONFIG_INVALID', 'repositoryRef must be an existing Git checkout', { repositoryRef });
    }
    const existing = this.#store.getProjectByState(rsiStateRef);
    if (existing !== undefined) return this.view(existing);
    let stateInsideRuntime = false;
    try {
      const relativeState = relativePath(realpathSync(this.#config.projectRoot), realpathSync(rsiStateRef));
      stateInsideRuntime = !relativeState.startsWith('..') && !isAbsolute(relativeState);
    } catch {
      stateInsideRuntime = false;
    }
    // A project is runnable when its own checkout is the executable source.
    // Whole-repository projects default to the repository itself, so a Mesh can
    // host many independent projects instead of one pinned checkout.
    const sourceDir = resolve(input.sourceDir ?? repositoryRef);
    let runnable = false;
    try {
      runnable = realpathSync(sourceDir) === realpathSync(repositoryRef);
    } catch {
      runnable = false;
    }
    const now = nowIso();
    const projectId = newId(ID_PREFIX.project);
    const controlDir = resolve(input.controlDir ?? join(this.#config.controlDir, 'projects', projectId));
    const record: MeshProjectRecord = {
      projectId,
      name,
      description,
      rsiStateRef,
      repositoryRef,
      status: runnable ? 'active' : 'registered',
      runnable,
      sourceDir: resolve(input.sourceDir ?? repositoryRef),
      controlDir,
      worktreesDir: resolve(input.worktreesDir ?? join(controlDir, 'worktrees')),
      artifactsDir: resolve(input.artifactsDir ?? join(controlDir, 'artifacts')),
      controlSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.insertProject(record);
    this.#store.appendEvent('project', record.projectId, 'registered', {
      rsiStateRef, repositoryRef, runnable, sourceDir: record.sourceDir, controlDir: record.controlDir,
    });
    this.#logger.info('research project registered', { projectId: record.projectId, runnable });
    return this.view(record);
  }

  get(projectId: string): ProjectView {
    const record = this.#store.getProject(projectId);
    if (record === undefined) throw new MeshError('PROJECT_NOT_FOUND', `unknown project ${projectId}`, { projectId });
    return this.view(record);
  }

  list(): readonly ProjectView[] {
    return this.#store.listProjects().map(record => this.view(record));
  }

  setStatus(projectId: string, status: MeshProjectStatus): ProjectView {
    const record = this.#store.getProject(projectId);
    if (record === undefined) throw new MeshError('PROJECT_NOT_FOUND', `unknown project ${projectId}`, { projectId });
    if (status === 'active' && !record.runnable) {
      throw new MeshError('INVALID_ARGUMENT', 'this runtime cannot activate a project outside its configured source root', { projectId });
    }
    if (status === 'active' && !this.view(record).rsiReadable) {
      throw new MeshError('RSI_STATE_UNAVAILABLE', 'the project RSI state is not readable; cannot activate it', { projectId });
    }
    this.#store.updateProject(projectId, { status, updatedAt: nowIso() });
    return this.get(projectId);
  }

  assertRunnable(projectId: string): MeshProjectRecord {
    const record = this.#store.getProject(projectId);
    if (record === undefined) throw new MeshError('PROJECT_NOT_FOUND', `unknown project ${projectId}`, { projectId });
    if (!record.runnable) throw new MeshError('INVALID_ARGUMENT', 'project is registered but not runnable in this runtime', { projectId });
    if (record.status === 'archived') throw new MeshError('INVALID_ARGUMENT', 'archived projects cannot create groups', { projectId });
    return record;
  }

  ensureDefault(input: { projectId?: string; name: string; rsiStateRef: string; repositoryRef: string }): ProjectView {
    const existing = input.projectId === undefined ? undefined : this.#store.getProject(input.projectId);
    if (existing !== undefined) return this.view(existing);
    return this.create({ name: input.name, rsiStateRef: input.rsiStateRef, repositoryRef: input.repositoryRef });
  }

  bind(projectId: string, sessionId: string, role: SessionRole, groupId: string | null = null): MeshSessionBinding {
    if (this.#store.getProject(projectId) === undefined) {
      throw new MeshError('PROJECT_NOT_FOUND', `unknown project ${projectId}`, { projectId });
    }
    if (sessionId.trim() === '') throw new MeshError('INVALID_ARGUMENT', 'sessionId must not be empty');
    if ((role === 'captain' || role === 'member') && (groupId === null || groupId.trim() === '')) {
      throw new MeshError('INVALID_ARGUMENT', `${role} bindings require a groupId`);
    }
    const existing = this.#store.getActiveBinding(sessionId);
    if (existing !== undefined) {
      if (existing.projectId === projectId && existing.role === role && existing.groupId === groupId) return existing;
      throw new MeshError('SESSION_BINDING_CONFLICT', 'session already has an active project binding', {
        sessionId, projectId: existing.projectId, role: existing.role,
      });
    }
    if ((role === 'captain' || role === 'member') && groupId !== null) {
      const group = this.#store.getGroup(groupId) ?? this.#groupLookup?.(groupId);
      if (group === undefined || group.projectId !== projectId) {
        throw new MeshError('TEAM_NOT_FOUND', `${role} binding names a group outside this project`, { projectId, groupId });
      }
      if (group.status === 'destroyed') {
        throw new MeshError('TEAM_STATE_INVALID', 'cannot bind a session to a destroyed group', { projectId, groupId });
      }
    }
    const binding: MeshSessionBinding = {
      bindingId: newId(ID_PREFIX.binding),
      projectId, sessionId, role, groupId,
      attachedAt: nowIso(),
      detachedAt: null,
    };
    this.#store.insertBinding(binding);
    this.#store.appendEvent('project', projectId, 'session-attached', { sessionId, role, groupId });
    return binding;
  }

  detach(sessionId: string): boolean {
    const detached = this.#store.detachBinding(sessionId, nowIso());
    if (detached) this.#store.appendEvent('session', sessionId, 'project-detached', {});
    return detached;
  }

  bindings(projectId: string): readonly MeshSessionBinding[] {
    return this.#store.listBindings(projectId, true);
  }

  activeBinding(sessionId: string): MeshSessionBinding | undefined {
    return this.#store.getActiveBinding(sessionId);
  }

  view(record: MeshProjectRecord): ProjectView {
    const groups = this.#store.listGroups(record.projectId);
    const bindings = this.#store.listBindings(record.projectId, true);
    let rsiReadable = false;
    let rsiVersion: string | null = null;
    let rsiError: string | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(record.rsiStateRef, 'utf8'));
      rsiVersion = stateVersionOf(parsed);
      rsiReadable = rsiVersion !== null;
      if (!rsiReadable) rsiError = 'state_version is missing';
    } catch (error) {
      rsiError = error instanceof Error ? error.message : String(error);
    }
    return {
      ...record,
      groupCount: groups.filter(group => group.status !== 'destroyed').length,
      activeGroupCount: groups.filter(group => group.status === 'active').length,
      rsiReadable,
      rsiVersion,
      rsiError,
      controlSessions: bindings.filter(binding => binding.role === 'control').map(binding => binding.sessionId),
      captainSessions: bindings.filter(binding => binding.role === 'captain').map(binding => binding.sessionId),
      memberSessions: bindings.filter(binding => binding.role === 'member').map(binding => binding.sessionId),
    };
  }
}
