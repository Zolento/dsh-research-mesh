/**
 * RLP storage-root resolution.
 *
 * The matrix is owned by `scripts/rlp_paths.py`; Mesh asks it and never guesses.
 * `MIGRATION_REQUIRED`, `AMBIGUOUS_STORAGE_ROOT` and `INVALID_STORAGE_ROOT` are
 * fail-closed for formal research runs: Mesh may register, inspect and show the
 * project, but it must not dispatch an experiment, write an outcome or rebuild
 * a control root.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '../errors.ts';
import { runPython } from './python.ts';
import type { RlpRouteState, RlpSkill, RlpStorageResolution, RlpStorageStatus } from './types.ts';

/** Runtime root used for new projects. */
export const RLP_RUNTIME_ROOT = '.research-lifecycle-protocol';
/** Legacy root kept read-only for audit and migration. */
export const RLP_LEGACY_ROOT = '.research-idea-pipeline';
/** Canonical state file name inside one route. */
export const RLP_STATE_FILE = 'research-state.json';

interface ResolveJson {
  runtime_status?: unknown;
  storage_root?: unknown;
  storage_kind?: unknown;
  legacy_root_present?: unknown;
  ambiguous_reason?: unknown;
  runtime_reason?: unknown;
  schema_namespace?: unknown;
  project_root?: unknown;
}

function isStatus(value: unknown): value is RlpStorageStatus {
  return value === 'NEW_PROJECT' || value === 'READY' || value === 'MIGRATION_REQUIRED'
    || value === 'AMBIGUOUS_STORAGE_ROOT' || value === 'INVALID_STORAGE_ROOT';
}

/** Resolve one project's runtime root through RLP. */
export class RlpStorageResolver {
  readonly #skill: RlpSkill;
  readonly #timeoutMs: number;
  #cache: Map<string, RlpStorageResolution> = new Map();

  /**
   * @param skill - discovered RLP skill.
   * @param timeoutMs - resolver process timeout.
   */
  constructor(skill: RlpSkill, timeoutMs = 20_000) {
    this.#skill = skill;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Resolve a project root. Cached per root for the lifetime of the resolver.
   * @param projectRoot - absolute project root.
   * @returns normalized resolution.
   */
  async resolve(projectRoot: string): Promise<RlpStorageResolution> {
    const cached = this.#cache.get(projectRoot);
    if (cached !== undefined) return cached;
    const result = await runPython({
      python: this.#skill.python,
      script: join(this.#skill.skillPath, 'scripts', 'rlp_paths.py'),
      args: ['resolve', '--project', projectRoot],
      timeoutMs: this.#timeoutMs,
    });
    if (result.code === 4) {
      throw new MeshError('RLP_STORAGE_INVALID', 'RLP storage resolver failed in its environment', {
        exitCode: result.code, stderr: result.stderr.slice(0, 2000),
      });
    }
    const json = result.json;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new MeshError('RLP_INVALID', 'RLP storage resolver did not return a JSON object', {
        exitCode: result.code, stdout: result.stdout.slice(0, 2000),
      });
    }
    const record = json as ResolveJson;
    if (!isStatus(record.runtime_status)) {
      throw new MeshError('RLP_INVALID', 'RLP storage resolver returned an unknown status', { status: record.runtime_status });
    }
    const status = record.runtime_status;
    const storeRootRaw = typeof record.storage_root === 'string' ? record.storage_root : join(projectRoot, RLP_RUNTIME_ROOT);
    const resolution: RlpStorageResolution = {
      projectRoot,
      status,
      storageRoot: storeRootRaw,
      storageKind: typeof record.storage_kind === 'string' ? record.storage_kind : 'new',
      legacyRootPresent: record.legacy_root_present === true,
      ambiguousReason: typeof record.ambiguous_reason === 'string' ? record.ambiguous_reason : null,
      runtimeReason: typeof record.runtime_reason === 'string' ? record.runtime_reason : null,
      schemaNamespace: typeof record.schema_namespace === 'string' ? record.schema_namespace : 'research-idea-pipeline',
      formalRunAllowed: status === 'READY',
      writable: status === 'READY' || status === 'NEW_PROJECT',
    };
    this.#cache.set(projectRoot, resolution);
    return resolution;
  }

  /** Drop the cached resolution, e.g. after an explicit migration by the operator. */
  invalidate(projectRoot?: string): void {
    if (projectRoot === undefined) this.#cache.clear();
    else this.#cache.delete(projectRoot);
  }

  /**
   * Throw when formal research runs are not allowed on this project.
   * @param resolution - storage resolution.
   * @returns the resolution when allowed.
   */
  assertFormalRun(resolution: RlpStorageResolution): RlpStorageResolution {
    if (resolution.status === 'MIGRATION_REQUIRED') {
      throw new MeshError('RLP_MIGRATION_REQUIRED', 'RLP legacy root only; migrate before formal runs', {
        projectRoot: resolution.projectRoot,
        migration: 'python3 scripts/migrate_project_root.py inspect --project <project>',
      });
    }
    if (resolution.status === 'AMBIGUOUS_STORAGE_ROOT') {
      throw new MeshError('RLP_AMBIGUOUS_STORAGE_ROOT', 'both RLP storage roots exist; resolve manually', {
        projectRoot: resolution.projectRoot,
        reason: resolution.ambiguousReason,
      });
    }
    if (resolution.status === 'INVALID_STORAGE_ROOT') {
      throw new MeshError('RLP_STORAGE_INVALID', 'RLP storage root is invalid; it will not be rebuilt automatically', {
        projectRoot: resolution.projectRoot,
        reason: resolution.runtimeReason,
      });
    }
    if (resolution.status !== 'READY') {
      throw new MeshError('RLP_GATE_HOLD', 'project has no bootstrapped RLP research state', {
        projectRoot: resolution.projectRoot,
        status: resolution.status,
      });
    }
    return resolution;
  }

  /**
   * Canonical state path for one route under the resolved root.
   * @param resolution - storage resolution.
   * @param routeId - route name.
   * @returns absolute path.
   */
  statePath(resolution: RlpStorageResolution, routeId: string): string {
    return join(resolution.storageRoot, 'routes', routeId, RLP_STATE_FILE);
  }

  /**
   * List routes that carry a canonical state file.
   * @param resolution - storage resolution.
   * @returns route metadata, sorted by route id.
   */
  routes(resolution: RlpStorageResolution): readonly RlpRouteState[] {
    const root = join(resolution.storageRoot, 'routes');
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch {
      return [];
    }
    const routes: RlpRouteState[] = [];
    for (const routeId of entries) {
      const statePath = join(root, routeId, RLP_STATE_FILE);
      const stat = statSync(statePath, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) continue;
      let version: string | null = null;
      let error: string | null = null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
        const raw = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).state_version
          : undefined;
        version = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : null;
        if (version === null) error = 'state_version is missing';
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      routes.push({ routeId, statePath, stateVersion: version, valid: version !== null, error });
    }
    return routes;
  }
}
