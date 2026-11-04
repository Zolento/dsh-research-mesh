/**
 * Worktree isolation manager.
 *
 * One research group owns one branch and one worktree. Creation is explicit,
 * deletion requires an explicit cleanup call, and the manager never runs
 * `git clean`, never removes a directory it did not create, and never treats a
 * group worktree as a security sandbox.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '../errors.ts';
import type { MeshConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { MeshWorkspaceRecord, MeshWorkspaceStatus } from '../storage/types.ts';
import type { MeshLogger } from '../util/logger.ts';
import { ID_PREFIX, newId, requireSlug } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { PathBoundary, atomicWriteText, readTextFileLimited, requireRelativePath } from '../util/fs-safe.ts';
import {
  addWorktree,
  currentHead,
  deleteBranch,
  dirtyEntries,
  isWorktreeRoot,
  removeWorktree,
  resolveCommit,
} from './git.ts';

/** Input for creating one group worktree. */
export interface CreateWorkspaceInput {
  readonly projectId: string;
  readonly teamId?: string;
  /** Human-readable group name; used as the worktree directory slug. */
  readonly name: string;
  /** Base ref; defaults to the source checkout's HEAD. */
  readonly baseRef?: string;
  /** Explicit base commit; wins over `baseRef`. */
  readonly baseCommit?: string;
  /** Branch prefix; defaults to `mesh/`. */
  readonly branchPrefix?: string;
  readonly workspaceId?: string;
}

/** Live inspection of one registered workspace. */
export interface WorkspaceInspection {
  readonly record: MeshWorkspaceRecord;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly dirty: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly changes: readonly string[];
  readonly error: string | null;
}

/** Cleanup options; the operation is never implicit. */
export interface CleanupWorkspaceOptions {
  readonly confirm: true;
  /** Required to remove a dirty worktree or one used by an active group. */
  readonly force?: boolean;
  /** Delete the Mesh-created branch after removing the worktree. */
  readonly deleteBranch?: boolean;
}

/** Result of a cleanup. */
export interface CleanupWorkspaceResult {
  readonly workspaceId: string;
  readonly removed: boolean;
  readonly branchDeleted: boolean;
}

/** Workspace manager over one project. */
export class WorkspaceManager {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #logger: MeshLogger;
  readonly #worktreeBoundary: PathBoundary;

  /**
   * @param config - resolved Mesh configuration.
   * @param store - Mesh metadata store.
   * @param logger - structured logger.
   */
  constructor(config: MeshConfig, store: MeshStore, logger: MeshLogger) {
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
    mkdirSync(config.worktreesDir, { recursive: true, mode: 0o700 });
    this.#worktreeBoundary = new PathBoundary(config.worktreesDir);
  }

  /** Canonical worktrees root. */
  get worktreesRoot(): string {
    return this.#worktreeBoundary.root;
  }

  /**
   * Create a new isolated worktree.
   * @param input - project, group name and optional base commit.
   * @returns the registered workspace.
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<MeshWorkspaceRecord> {
    const slug = requireSlug(input.name, 'workspace name');
    const workspaceId = input.workspaceId ?? newId(ID_PREFIX.workspace);
    const branchPrefix = input.branchPrefix === undefined ? 'mesh' : requireSlug(input.branchPrefix, 'branchPrefix');
    const branch = `${branchPrefix}/${slug}`;
    const baseCommit = input.baseCommit === undefined
      ? await resolveCommit(this.#config.sourceDir, input.baseRef ?? 'HEAD')
      : input.baseCommit;
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) {
      throw new MeshError('INVALID_ARGUMENT', 'workspace baseCommit must be a full commit hash', { baseCommit });
    }
    const target = this.#worktreeBoundary.resolve(slug, 'worktree path');

    if (existsSync(target)) {
      throw new MeshError('WORKSPACE_EXISTS', `worktree path already exists; refusing to overwrite it: ${target}`, {
        path: target,
      });
    }
    const registered = this.#store.getWorkspaceByPath(target);
    if (registered !== undefined && registered.status !== 'removed') {
      throw new MeshError('PATH_CONFLICT', 'worktree path is already registered', {
        path: target,
        workspaceId: registered.workspaceId,
      });
    }
    if (input.teamId !== undefined) {
      const teamWorkspace = this.#store.listWorkspaces().find(
        workspace => workspace.teamId === input.teamId && workspace.status !== 'removed',
      );
      if (teamWorkspace !== undefined) {
        throw new MeshError('PATH_CONFLICT', 'team already owns a workspace', {
          teamId: input.teamId,
          workspaceId: teamWorkspace.workspaceId,
        });
      }
    }

    this.#logger.info('creating group worktree', {
      workspaceId,
      teamId: input.teamId,
      branch,
      baseCommit,
      path: target,
    });
    await addWorktree(this.#config.sourceDir, target, branch, baseCommit);
    const createdAt = nowIso();
    const record: MeshWorkspaceRecord = {
      workspaceId,
      projectId: input.projectId,
      teamId: input.teamId ?? null,
      path: target,
      branch,
      baseCommit,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    };
    try {
      this.#store.insertWorkspace(record);
      if (input.teamId !== undefined) this.#store.updateWorkspace(workspaceId, { teamId: input.teamId });
    } catch (error) {
      // Only the worktree this call just created is cleaned up; an existing
      // user directory was rejected above and can never reach this branch.
      this.#logger.error('workspace registration failed; removing the worktree just created', { workspaceId, error: String(error) });
      try { await removeWorktree(this.#config.sourceDir, target, false); } catch { /* retain the original registration failure */ }
      try { await deleteBranch(this.#config.sourceDir, branch); } catch { /* best-effort cleanup of our own branch */ }
      throw error;
    }
    this.#store.appendEvent('workspace', workspaceId, 'created', {
      projectId: input.projectId,
      teamId: input.teamId ?? null,
      branch,
      baseCommit,
      path: target,
    });
    return record;
  }

  /**
   * Register an already existing Mesh-created worktree after a restart.
   * This never creates a directory and never adopts an unknown path silently.
   * @param input - existing record inputs.
   */
  adoptWorkspace(input: {
    workspaceId: string;
    projectId: string;
    teamId?: string;
    /** Workspace-relative directory name under the configured worktrees root. */
    path: string;
    branch: string;
    baseCommit: string;
  }): MeshWorkspaceRecord {
    const absolute = this.#worktreeBoundary.resolve(input.path, 'adopted worktree path');
    if (!existsSync(absolute)) {
      throw new MeshError('WORKSPACE_MISSING', 'cannot adopt a missing worktree', { path: absolute });
    }
    const createdAt = nowIso();
    const record: MeshWorkspaceRecord = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      teamId: input.teamId ?? null,
      path: absolute,
      branch: input.branch,
      baseCommit: input.baseCommit,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    };
    this.#store.insertWorkspace(record);
    return record;
  }

  /**
   * Get one workspace record.
   * @param workspaceId - workspace identity.
   * @returns record.
   */
  get(workspaceId: string): MeshWorkspaceRecord {
    const record = this.#store.getWorkspace(workspaceId);
    if (record === undefined) {
      throw new MeshError('WORKSPACE_MISSING', `unknown workspace ${workspaceId}`, { workspaceId });
    }
    return record;
  }

  /**
   * List registered workspaces for a project.
   * @param projectId - optional project filter.
   * @returns records.
   */
  list(projectId?: string): readonly MeshWorkspaceRecord[] {
    return this.#store.listWorkspaces(projectId);
  }

  /**
   * Inspect a worktree without mutating it.
   * @param workspaceId - workspace identity.
   * @returns live state.
   */
  async inspect(workspaceId: string): Promise<WorkspaceInspection> {
    const record = this.get(workspaceId);
    if (!existsSync(record.path)) {
      return { record, exists: false, valid: false, dirty: false, head: null, branch: null, changes: [], error: 'path is missing' };
    }
    const stat = lstatSync(record.path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      return { record, exists: true, valid: false, dirty: false, head: null, branch: null, changes: [], error: 'path is not a directory' };
    }
    const valid = await isWorktreeRoot(record.path);
    if (!valid) {
      return { record, exists: true, valid: false, dirty: false, head: null, branch: null, changes: [], error: 'path is not a valid worktree root' };
    }
    try {
      const [head, changes] = await Promise.all([currentHead(record.path), dirtyEntries(record.path)]);
      return {
        record,
        exists: true,
        valid: true,
        dirty: changes.length > 0,
        head,
        branch: record.branch,
        changes,
        error: null,
      };
    } catch (error) {
      return {
        record,
        exists: true,
        valid: false,
        dirty: false,
        head: null,
        branch: null,
        changes: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Reconcile persisted workspace status with the filesystem after a restart.
   * @returns inspection results.
   */
  async recover(): Promise<readonly WorkspaceInspection[]> {
    const results: WorkspaceInspection[] = [];
    for (const record of this.#store.listWorkspaces()) {
      if (record.status === 'removed') continue;
      const inspection = await this.inspect(record.workspaceId);
      const status: MeshWorkspaceStatus = !inspection.exists
        ? 'missing'
        : inspection.valid ? 'active' : 'broken';
      if (status !== record.status) {
        this.#store.updateWorkspace(record.workspaceId, { status });
        this.#logger.warn('workspace status reconciled', { workspaceId: record.workspaceId, status, error: inspection.error });
      }
      results.push(inspection);
    }
    return results;
  }

  /**
   * Explicitly remove a Mesh-created worktree.
   * @param workspaceId - workspace identity.
   * @param options - must include `confirm: true`.
   * @returns cleanup result.
   */
  async cleanup(workspaceId: string, options: CleanupWorkspaceOptions): Promise<CleanupWorkspaceResult> {
    if (options.confirm !== true) {
      throw new MeshError('WORKSPACE_CLEANUP_REFUSED', 'workspace cleanup requires explicit confirmation', { workspaceId });
    }
    const record = this.get(workspaceId);
    if (record.status === 'removed') {
      return { workspaceId, removed: false, branchDeleted: false };
    }
    if (record.teamId !== null) {
      const team = this.#store.teamStore.getTeam(record.teamId);
      if (team !== undefined && team.status === 'active' && options.force !== true) {
        throw new MeshError('WORKSPACE_CLEANUP_REFUSED', 'active group still owns this workspace; pass force to override', {
          workspaceId,
          teamId: record.teamId,
        });
      }
    }
    if (existsSync(record.path)) {
      const valid = await isWorktreeRoot(record.path);
      if (!valid) {
        throw new MeshError('WORKSPACE_CLEANUP_REFUSED', 'path is not a registered worktree root; refusing to delete it', {
          workspaceId,
          path: record.path,
        });
      }
      const changes = await dirtyEntries(record.path);
      if (changes.length > 0 && options.force !== true) {
        throw new MeshError('WORKSPACE_DIRTY', 'worktree has uncommitted changes; pass force after reviewing them', {
          workspaceId,
          changes,
        });
      }
      await removeWorktree(this.#config.sourceDir, record.path, options.force === true);
    }
    let branchDeleted = false;
    if (options.deleteBranch === true && record.branch.startsWith('mesh/')) {
      try {
        await deleteBranch(this.#config.sourceDir, record.branch);
        branchDeleted = true;
      } catch (error) {
        this.#logger.warn('worktree removed but branch deletion failed', { workspaceId, branch: record.branch, error: String(error) });
      }
    }
    this.#store.updateWorkspace(workspaceId, { status: 'removed' });
    this.#store.appendEvent('workspace', workspaceId, 'removed', {
      path: record.path,
      branchDeleted,
      forced: options.force === true,
    });
    return { workspaceId, removed: true, branchDeleted };
  }

  /**
   * Return a boundary-bound filesystem API for one workspace.
   * @param workspaceId - workspace identity.
   * @returns reader/writer scoped to the worktree.
   */
  files(workspaceId: string): WorkspaceFiles {
    const record = this.get(workspaceId);
    if (!existsSync(record.path)) {
      throw new MeshError('WORKSPACE_MISSING', 'workspace path is missing', { workspaceId, path: record.path });
    }
    return new WorkspaceFiles(record.workspaceId, new PathBoundary(record.path));
  }

  /**
   * Assert that a team's writable workspace is the one named by the caller.
   * @param workspaceId - workspace identity.
   * @param teamId - owning team.
   * @returns the record.
   */
  assertTeamWorkspace(workspaceId: string, teamId: string): MeshWorkspaceRecord {
    const record = this.get(workspaceId);
    if (record.teamId !== teamId) {
      throw new MeshError('PATH_CONFLICT', 'workspace does not belong to this team', { workspaceId, teamId });
    }
    if (record.status !== 'active') {
      throw new MeshError('WORKSPACE_MISSING', 'workspace is not active', { workspaceId, status: record.status });
    }
    return record;
  }
}

/** Boundary-bound file operations for one worktree. */
export class WorkspaceFiles {
  readonly workspaceId: string;
  readonly #boundary: PathBoundary;

  /**
   * @param workspaceId - workspace identity.
   * @param boundary - canonical worktree root.
   */
  constructor(workspaceId: string, boundary: PathBoundary) {
    this.workspaceId = workspaceId;
    this.#boundary = boundary;
  }

  /** Canonical root. */
  get root(): string {
    return this.#boundary.root;
  }

  /**
   * Resolve a workspace-relative path.
   * @param path - relative path.
   * @returns absolute path.
   */
  resolve(path: string): string {
    return this.#boundary.resolve(path);
  }

  /**
   * Read a file inside the workspace.
   * @param path - relative path.
   * @returns UTF-8 text.
   */
  readText(path: string): string {
    return readTextFileLimited(this.#boundary.resolveExisting(path, 'workspace file'));
  }

  /**
   * Atomically write a file inside the workspace, creating parent directories.
   * @param path - relative path.
   * @param content - UTF-8 text.
   * @returns absolute path.
   */
  writeText(path: string, content: string): string {
    const relative = requireRelativePath(path, 'workspace file');
    const target = this.#boundary.resolve(relative, 'workspace file');
    const parent = join(target, '..');
    if (parent !== this.#boundary.root) {
      this.#boundary.ensureDir(this.#boundary.relative(parent));
    }
    atomicWriteText(target, content);
    return target;
  }

  /**
   * Delete one file inside the workspace (never a directory).
   * @param path - relative path.
   */
  removeFile(path: string): void {
    const target = this.#boundary.resolveExisting(path, 'workspace file');
    const stat = lstatSync(target);
    if (stat.isDirectory()) {
      throw new MeshError('INVALID_ARGUMENT', 'removeFile refuses directories', { path });
    }
    if (stat.isSymbolicLink()) {
      throw new MeshError('PATH_ESCAPE', 'removeFile refuses symlinks', { path });
    }
    unlinkSync(target);
  }

  /** Canonical realpath of the root, proving it exists. */
  canonicalRoot(): string {
    return realpathSync(this.#boundary.root);
  }
}
