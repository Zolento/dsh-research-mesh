/**
 * Project control-plane layout.
 *
 * The control directory holds execution state, manifests, logs, ingested
 * artifacts and research-state proposals. It is deliberately separate from the
 * source checkout and from every group worktree.
 */

import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from './errors.ts';
import type { MeshConfig } from './config/types.ts';

/** Absolute control paths created for one research project. */
export interface ProjectLayout {
  readonly root: string;
  readonly control: string;
  readonly sessions: string;
  readonly manifests: string;
  readonly logs: string;
  readonly artifacts: string;
  readonly proposals: string;
  readonly outcomes: string;
  readonly worktrees: string;
  readonly database: string;
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new MeshError('WORKSPACE_MISSING', `cannot create control directory: ${path}`, { path });
  }
  try { chmodSync(path, 0o700); } catch { /* mode is advisory on non-POSIX filesystems */ }
  return path;
}

/**
 * Create or reopen the control directories for a project.
 * Existing files are never deleted or overwritten.
 * @param config - resolved Mesh configuration.
 * @returns absolute layout paths.
 */
export function ensureProjectLayout(config: MeshConfig): ProjectLayout {
  const control = ensureDir(config.controlDir);
  const layout: ProjectLayout = {
    root: config.projectRoot,
    control,
    sessions: ensureDir(join(control, 'sessions')),
    manifests: ensureDir(join(control, 'manifests')),
    logs: ensureDir(join(control, 'logs')),
    artifacts: ensureDir(join(control, 'artifacts')),
    proposals: ensureDir(join(control, 'proposals')),
    outcomes: ensureDir(join(control, 'outcomes')),
    worktrees: ensureDir(config.worktreesDir),
    database: config.databasePath,
  };
  return layout;
}
