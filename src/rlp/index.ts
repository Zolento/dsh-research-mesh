/**
 * RLP v2.2.0 integration surface.
 *
 * One `RlpRuntime` owns the discovered skill, the storage resolver and the
 * context/subagent adapters. Mesh services depend on this facade, never on the
 * Python CLI directly.
 */

import { MeshError } from '../errors.ts';
import { discoverRlpSkill, inspectRlpSkill, type RlpDiscoveryOptions } from './discovery.ts';
import { RlpStorageResolver } from './paths.ts';
import { RlpContextAdapter } from './context.ts';
import { RlpSubagentContext } from './subagent-context.ts';
import type { RlpSkill, RlpStorageResolution } from './types.ts';

export * from './types.ts';
export { discoverRlpSkill, inspectRlpSkill, defaultRlpCandidates, RLP_REQUIRED_FILES, RLP_SKILL_NAME } from './discovery.ts';
export { RlpStorageResolver, RLP_RUNTIME_ROOT, RLP_LEGACY_ROOT, RLP_STATE_FILE } from './paths.ts';
export { RlpContextAdapter } from './context.ts';
export { RlpSubagentContext, RLP_SUBAGENT_ROLES } from './subagent-context.ts';
export { runPython } from './python.ts';

/** Construction options for one RLP runtime. */
export interface RlpRuntimeOptions extends RlpDiscoveryOptions {
  /** Context/subagent process timeout. */
  readonly timeoutMs?: number;
  /** Skip discovery failure and construct a degraded runtime (`available=false`). */
  readonly optional?: boolean;
}

/** One usable RLP runtime. */
export class RlpRuntime {
  readonly #skill: RlpSkill | null;
  readonly #error: MeshError | null;
  readonly #resolver: RlpStorageResolver | null;
  readonly #context: RlpContextAdapter | null;
  readonly #subagents: RlpSubagentContext | null;

  private constructor(skill: RlpSkill | null, error: MeshError | null) {
    this.#skill = skill;
    this.#error = error;
    if (skill === null) {
      this.#resolver = null;
      this.#context = null;
      this.#subagents = null;
    } else {
      this.#resolver = new RlpStorageResolver(skill);
      this.#context = new RlpContextAdapter(skill);
      this.#subagents = new RlpSubagentContext(skill);
    }
  }

  /**
   * Discover and build the runtime.
   * @param options - explicit path, env override, timeout and optional mode.
   * @returns a runtime; `available` is false only in optional mode.
   * @throws MeshError when discovery fails and `optional` is not set.
   */
  static create(options: RlpRuntimeOptions = {}): RlpRuntime {
    try {
      return new RlpRuntime(discoverRlpSkill(options), null);
    } catch (error) {
      const meshError = error instanceof MeshError ? error : new MeshError('RLP_UNAVAILABLE', String(error));
      if (options.optional === true) return new RlpRuntime(null, meshError);
      throw meshError;
    }
  }

  /** A runtime that reports a deliberate unavailability, e.g. `rlp.enabled: false`. */
  static unavailable(reason: string): RlpRuntime {
    return new RlpRuntime(null, new MeshError('RLP_UNAVAILABLE', reason));
  }

  /** Build from an already-inspected skill (tests, isolated profiles). */
  static fromSkill(skill: RlpSkill): RlpRuntime {
    if (!skill.compatible) {
      throw new MeshError('RLP_VERSION_UNSUPPORTED', `RLP skill is not usable: ${skill.reason}`, { reason: skill.reason });
    }
    return new RlpRuntime(skill, null);
  }

  /** Whether a compatible installation was found. */
  get available(): boolean {
    return this.#skill !== null;
  }

  /** The discovered skill, or null in optional degraded mode. */
  get skill(): RlpSkill | null {
    return this.#skill;
  }

  /** Why discovery failed, when unavailable. */
  get discoveryError(): MeshError | null {
    return this.#error;
  }

  /** Compact status for diagnostics and the Workbench. */
  status(): {
    available: boolean;
    skillPath: string | null;
    version: string | null;
    digest: string | null;
    reason: string | null;
  } {
    return {
      available: this.available,
      skillPath: this.#skill?.skillPath ?? null,
      version: this.#skill?.version ?? null,
      digest: this.#skill?.digest ?? null,
      reason: this.#skill === null ? (this.#error?.message ?? 'not discovered') : null,
    };
  }

  /** Storage resolver; throws when the runtime is unavailable. */
  storage(): RlpStorageResolver {
    if (this.#resolver === null) throw this.#unavailable();
    return this.#resolver;
  }

  /** Context adapter; throws when the runtime is unavailable. */
  context(): RlpContextAdapter {
    if (this.#context === null) throw this.#unavailable();
    return this.#context;
  }

  /** Subagent context adapter; throws when the runtime is unavailable. */
  subagentContext(): RlpSubagentContext {
    if (this.#subagents === null) throw this.#unavailable();
    return this.#subagents;
  }

  /**
   * Resolve one project and assert that formal runs are allowed.
   * @param projectRoot - absolute project root.
   * @returns storage resolution.
   */
  async requireFormalRun(projectRoot: string): Promise<RlpStorageResolution> {
    const resolver = this.storage();
    return resolver.assertFormalRun(await resolver.resolve(projectRoot));
  }

  #unavailable(): MeshError {
    return this.#error ?? new MeshError('RLP_UNAVAILABLE', 'RLP runtime is unavailable');
  }
}
