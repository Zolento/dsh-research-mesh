/** Git operations used by worktree isolation. All calls use argument arrays. */

import { existsSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MeshError } from '../errors.ts';
import { runGit, runGitOrThrow } from '../util/shell.ts';

/** One worktree entry reported by `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
}

/**
 * Require a directory to be a Git worktree root.
 * @param path - candidate directory.
 * @returns canonical path.
 */
export function requireGitCheckout(path: string): string {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new MeshError('GIT_COMMAND_FAILED', `not a directory: ${path}`, { path });
  }
  if (!existsSync(resolve(path, '.git'))) {
    throw new MeshError('GIT_COMMAND_FAILED', `not a Git checkout: ${path}`, { path });
  }
  return realpathSync(path);
}

/**
 * Resolve a ref to a full commit hash and prove it exists.
 * @param repo - Git repository.
 * @param ref - branch, tag, HEAD or commit.
 * @returns full commit hash.
 */
export async function resolveCommit(repo: string, ref = 'HEAD'): Promise<string> {
  const result = await runGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.code !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout)) {
    throw new MeshError('GIT_COMMAND_FAILED', `cannot resolve Git commit ${ref}`, {
      repo,
      ref,
      stderr: result.stderr.slice(0, 1000),
    });
  }
  return result.stdout;
}

/**
 * Read the current HEAD commit of a worktree.
 * @param path - worktree path.
 * @returns full commit hash.
 */
export async function currentHead(path: string): Promise<string> {
  return resolveCommit(path, 'HEAD');
}

/**
 * List uncommitted changes in a worktree.
 * @param path - worktree path.
 * @returns `/`-separated status lines; empty when clean.
 */
export async function dirtyEntries(path: string): Promise<readonly string[]> {
  const output = await runGitOrThrow(path, ['status', '--porcelain=1', '--untracked-files=normal'], 'status');
  return output === '' ? [] : output.split('\n').filter(line => line.trim() !== '');
}

/**
 * List worktrees registered for a repository.
 * @param repo - repository root.
 * @returns parsed entries.
 */
export async function listWorktrees(repo: string): Promise<readonly GitWorktreeEntry[]> {
  const output = await runGitOrThrow(repo, ['worktree', 'list', '--porcelain'], 'worktree list');
  const entries: GitWorktreeEntry[] = [];
  let current: { path?: string; head?: string | null; branch?: string | null; bare?: boolean; detached?: boolean } = {};
  const flush = (): void => {
    if (current.path === undefined) return;
    entries.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      bare: current.bare === true,
      detached: current.detached === true,
    });
    current = {};
  };
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length);
      continue;
    }
    if (line === 'bare') current.bare = true;
    if (line === 'detached') current.detached = true;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
  }
  flush();
  return entries;
}

/**
 * Test whether a local branch exists.
 * @param repo - repository root.
 * @param branch - short branch name.
 * @returns true when `refs/heads/<branch>` exists.
 */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.code === 0;
}

/**
 * Create a branch-backed worktree at an immutable commit.
 * @param repo - source repository.
 * @param path - absolute worktree path that must not exist.
 * @param branch - new local branch.
 * @param commit - full commit hash.
 */
export async function addWorktree(repo: string, path: string, branch: string, commit: string): Promise<void> {
  if (!isAbsolute(path)) throw new MeshError('INVALID_ARGUMENT', 'worktree path must be absolute', { path });
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new MeshError('INVALID_ARGUMENT', 'worktree base must be a full commit hash', { commit });
  }
  if (await branchExists(repo, branch)) {
    throw new MeshError('WORKSPACE_EXISTS', `branch ${branch} already exists`, { branch });
  }
  const result = await runGit(repo, ['worktree', 'add', '-b', branch, path, commit], 120_000);
  if (result.code !== 0) {
    throw new MeshError('GIT_COMMAND_FAILED', 'git worktree add failed', {
      branch,
      path,
      commit,
      stderr: result.stderr.slice(0, 2000),
    });
  }
}

/**
 * Remove a registered worktree without `git clean` or broad deletion.
 * @param repo - source repository.
 * @param path - worktree path.
 * @param force - passed only after explicit user confirmation.
 */
export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  const args = force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path];
  const result = await runGit(repo, args, 120_000);
  if (result.code !== 0) {
    throw new MeshError('WORKSPACE_CLEANUP_REFUSED', 'git worktree remove refused the cleanup', {
      path,
      force,
      stderr: result.stderr.slice(0, 2000),
    });
  }
}

/**
 * Delete one local branch that Mesh created.
 * @param repo - source repository.
 * @param branch - branch name.
 */
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  const result = await runGit(repo, ['branch', '-D', branch]);
  if (result.code !== 0) {
    throw new MeshError('GIT_COMMAND_FAILED', 'git branch -D failed', {
      branch,
      stderr: result.stderr.slice(0, 1000),
    });
  }
}

/**
 * Export one commit to a tar archive without touching the working tree.
 * @param repo - source repository.
 * @param commit - full commit hash.
 * @param output - absolute archive path.
 */
export async function archiveCommit(repo: string, commit: string, output: string): Promise<void> {
  const result = await runGit(repo, ['archive', '--format=tar', `--output=${output}`, commit], 120_000);
  if (result.code !== 0) {
    throw new MeshError('GIT_COMMAND_FAILED', 'git archive failed', {
      commit,
      output,
      stderr: result.stderr.slice(0, 2000),
    });
  }
}

/**
 * Prove a worktree path is the worktree root for that checkout.
 * @param path - candidate.
 * @returns true when `git rev-parse --show-toplevel` equals the canonical path.
 */
export async function isWorktreeRoot(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const result = await runGit(path, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) return false;
  try {
    return realpathSync(result.stdout) === realpathSync(path);
  } catch {
    return false;
  }
}
