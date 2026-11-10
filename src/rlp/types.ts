/**
 * Public types for the Research Lifecycle Protocol (RLP) v2.2.0 adapter.
 *
 * These shapes mirror the machine output of the RLP scripts. Mesh never
 * re-implements a scientific rule; it normalizes what the skill returns and
 * fails closed when a required field is missing.
 */

/** Storage matrix status returned by `rlp_paths.py resolve`. */
export type RlpStorageStatus =
  | 'NEW_PROJECT'
  | 'READY'
  | 'MIGRATION_REQUIRED'
  | 'AMBIGUOUS_STORAGE_ROOT'
  | 'INVALID_STORAGE_ROOT';

/** One discovered RLP skill installation. */
export interface RlpSkill {
  /** Absolute skill root. */
  readonly skillPath: string;
  /** Frontmatter `name`; must be `research-lifecycle-protocol`. */
  readonly name: string;
  /** Frontmatter `metadata.version`. */
  readonly version: string;
  /** Historical skill name declared by the skill, if any. */
  readonly legacyName: string | null;
  /** 16-hex digest over SKILL.md + shared-contract.md + preset-registry.json. */
  readonly digest: string;
  /** Required files, relative to the skill root, and whether each exists. */
  readonly files: Readonly<Record<string, boolean>>;
  /** True only when every required file exists and the version is supported. */
  readonly compatible: boolean;
  /** Why discovery failed; null when compatible. */
  readonly reason: string | null;
  /** Python interpreter used to run the skill's scripts. */
  readonly python: string;
}

/** Normalized `rlp_paths.py resolve` result. */
export interface RlpStorageResolution {
  readonly projectRoot: string;
  readonly status: RlpStorageStatus;
  /** Absolute runtime control root chosen by RLP (new root when unresolved). */
  readonly storageRoot: string;
  /** `new`, `legacy` or `current` as reported by RLP. */
  readonly storageKind: string;
  readonly legacyRootPresent: boolean;
  readonly ambiguousReason: string | null;
  readonly runtimeReason: string | null;
  /** Frozen protocol namespace, e.g. `research-idea-pipeline`. */
  readonly schemaNamespace: string;
  /** True when formal research runs may execute here. */
  readonly formalRunAllowed: boolean;
  /** True when Mesh may write project/control state (never RLP state). */
  readonly writable: boolean;
}

/** One route discovered under the runtime root. */
export interface RlpRouteState {
  readonly routeId: string;
  readonly statePath: string;
  readonly stateVersion: string | null;
  readonly valid: boolean;
  readonly error: string | null;
}

/** One loaded context document; `text` must be the real body. */
export interface RlpLoadedDocument {
  readonly path: string;
  readonly layer: string;
  readonly chars: number;
  readonly digest: string;
  readonly text: string;
}

/** Plan/load result normalized from `context_planner.py`. */
export interface RlpContextPlan {
  readonly schema: string;
  readonly skillVersion: string;
  readonly entry: string | null;
  readonly presetId: string | null;
  readonly stage: string | null;
  readonly authorization: string;
  readonly domain: string | null;
  readonly status: 'PASS' | 'BLOCKED' | 'FAIL';
  readonly planDigest: string;
  readonly canProceed: boolean;
  readonly loaded: readonly RlpLoadedDocument[];
  readonly referenced: readonly string[];
  readonly blockedMissing: readonly string[];
  readonly problems: readonly string[];
  readonly loadedChars: number;
  readonly budget: Readonly<Record<string, unknown>>;
}

/** Verified packet build result. */
export interface RlpContextPacket {
  readonly schema: string;
  readonly route: string;
  readonly task: string;
  readonly stateVersion: string | null;
  readonly canonicalDigest: string;
  readonly packetDigest: string;
  readonly isCanonicalState: boolean;
  readonly stale: boolean;
  readonly staleReasons: readonly string[];
  readonly packetPath: string;
  readonly status: 'PASS' | 'STALE' | 'FAIL';
}

/** `subagent_context.py build` result. */
export interface RlpSubagentContract {
  readonly schema: string;
  readonly role: string;
  readonly purpose: string;
  readonly task: string;
  readonly authorization: string;
  readonly permits: RlpPermits;
  readonly parentPermits: RlpPermits;
  readonly manifestRequired: boolean;
  readonly approvalRequired: boolean;
  readonly mayWrite: readonly string[];
  readonly text: string;
  readonly canProceed: boolean;
  readonly status: 'PASS' | 'BLOCKED' | 'FAIL';
}

/** Permission bits RLP grants a role; child bits must never exceed the parent's. */
export interface RlpPermits {
  readonly writeCanonical: boolean;
  readonly modifyAnchor: boolean;
  readonly executeExperiment: boolean;
  readonly writeArtifacts: boolean;
}
