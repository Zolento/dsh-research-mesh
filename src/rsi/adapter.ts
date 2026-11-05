/**
 * Research Idea Pipeline runtime adapter.
 *
 * The adapter reads canonical research state, runs only the pipeline's own
 * read-only validators, and verifies an existing execution receipt. It never
 * mints a receipt, never consumes budget, never writes canonical state and never
 * converts execution success into a scientific verdict.
 *
 * Two authorization modes exist:
 * - `consumed`: the receipt already has a real `consume` ledger event. This is
 *   the production shim path (RSI `run --execute` launches a blocking Mesh shim);
 * - `preview`: RSI's dry-run gate validates the receipt but does not consume it.
 *   Dispatching from this mode bypasses RSI budget consumption, so it is
 *   permitted only when `rsi.allowTestStub` is explicitly enabled and every job
 *   is labelled `test-stub`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative as relativePath } from 'node:path';
import { MeshError } from '../errors.ts';
import type { MeshConfig } from '../config/types.ts';
import type { MeshLogger } from '../util/logger.ts';
import { PathBoundary, readJsonObjectFile } from '../util/fs-safe.ts';
import { requireRelativePath } from '../util/fs-safe.ts';
import { sha256Text } from '../util/hash.ts';
import { nowIso } from '../util/time.ts';
import { canonicalJson, type CanonicalValue } from '../util/canonical-json.ts';
import { requireSlug } from '../util/ids.ts';
import {
  ResearchPipelineAdapter,
  canonicalStatePath,
  classifyExit,
  type PipelineCommandResult,
  type PipelineProbe,
} from '../bridge/adapters/research-pipeline.ts';

/** Result of discovering one RSI skill tree. */
export interface RsiDiscovery {
  readonly available: boolean;
  readonly skillPath: string | null;
  readonly files: Readonly<Record<string, boolean>>;
  readonly digests: Readonly<Record<string, string>>;
  readonly error: string | null;
}

/** Canonical state snapshot. */
export interface RsiStateSnapshot {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
  readonly json: Readonly<Record<string, unknown>>;
}

/** Result of a read-only state check. */
export interface RsiStateCheck {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly status: string;
  readonly violations: readonly unknown[];
  readonly raw: PipelineCommandResult;
}

/** Authorization produced by one successful receipt check. */
export interface RsiAuthorization {
  readonly mode: 'rsi-receipt' | 'test-stub';
  readonly receiptRef: string;
  readonly receiptDigest: string;
  readonly experimentId: string;
  readonly stateVersion: string;
  readonly rsiManifestDigest: string;
  readonly verifiedBy: string;
  readonly verifiedAt: string;
  readonly consumedLedgerEventSeal?: string;
}

/** Input for receipt verification. */
export interface RsiVerifyInput {
  readonly projectId: string;
  readonly routeId: string;
  readonly experimentId: string;
  readonly statePath: string;
  readonly manifestPath: string;
  readonly schedulerPath: string;
  readonly receiptPath: string;
  readonly ledgerPath?: string;
}

/** Official discovery candidates, in priority order. */
export const DEFAULT_RSI_PATHS: readonly string[] = [
  join(process.env.HOME ?? '', '.agents', 'skills', 'rsi-pipeline'),
  join(process.env.HOME ?? '', 'code', 'myproj', 'skills-dev', 'research-idea-pipeline', 'skill-rsi-dev', 'research-idea-pipeline'),
];

const REQUIRED_FILES: readonly string[] = [
  'SKILL.md',
  'shared-contract.md',
  'scripts/state_check.py',
  'scripts/experiment_execute.py',
  'scripts/execution_gate.py',
  'scripts/evidence_outcome.py',
  'scripts/preset_router.py',
  'schemas/execution-manifest.schema.json',
];

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rsiDigest(value: unknown): string {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return sha256Text(canonicalJson(plain as CanonicalValue));
}

function extractStateVersion(json: Readonly<Record<string, unknown>>): string | null {
  const raw = json.state_version;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

/** Runtime adapter over one installed RSI skill. */
export class RsiAdapter {
  readonly #config: MeshConfig;
  readonly #logger: MeshLogger;
  readonly #boundary: PathBoundary;
  #pipeline: ResearchPipelineAdapter | null = null;
  #discovery: RsiDiscovery | null = null;

  /**
   * @param config - resolved Mesh configuration.
   * @param logger - structured logger.
   */
  constructor(config: MeshConfig, logger: MeshLogger) {
    this.#config = config;
    this.#logger = logger;
    this.#boundary = new PathBoundary(config.projectRoot);
  }

  /** Discover the configured or installed skill tree. */
  discover(): RsiDiscovery {
    if (this.#discovery !== null) return this.#discovery;
    if (!this.#config.rsi.enabled) {
      this.#discovery = { available: false, skillPath: null, files: {}, digests: {}, error: 'rsi.enabled is false' };
      return this.#discovery;
    }
    const explicit = this.#config.rsi.skillPath;
    const candidates = explicit === undefined
      ? [process.env.DSH_RSI_SKILL_PATH, ...DEFAULT_RSI_PATHS].filter((entry): entry is string => entry !== undefined && entry !== '')
      : [explicit];
    for (const candidate of candidates) {
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
      const files: Record<string, boolean> = {};
      const digests: Record<string, string> = {};
      for (const relative of REQUIRED_FILES) {
        const path = join(candidate, relative);
        files[relative] = existsSync(path);
        if (existsSync(path)) {
          try { digests[relative] = fileSha256(path).slice(0, 16); } catch { files[relative] = false; }
        }
      }
      const missing = REQUIRED_FILES.filter(relative => files[relative] !== true);
      if (missing.length > 0) {
        this.#discovery = {
          available: false,
          skillPath: candidate,
          files,
          digests,
          error: `RSI skill is missing required files: ${missing.join(', ')}`,
        };
        return this.#discovery;
      }
      this.#discovery = { available: true, skillPath: candidate, files, digests, error: null };
      this.#pipeline = new ResearchPipelineAdapter({
        pipelineRoot: candidate,
        python: this.#config.rsi.pythonExecutable,
        timeoutMs: Math.max(this.#config.rsi.stateCheckTimeoutMs, this.#config.rsi.gateTimeoutMs),
        enabled: true,
      });
      return this.#discovery;
    }
    this.#discovery = { available: false, skillPath: null, files: {}, digests: {}, error: 'no RSI skill tree found' };
    return this.#discovery;
  }

  /** Probe the installed pipeline without running an experiment. */
  async probe(): Promise<PipelineProbe> {
    const discovery = this.discover();
    if (!discovery.available || this.#pipeline === null) {
      throw new MeshError('RSI_UNAVAILABLE', discovery.error ?? 'RSI skill is unavailable', { discovery });
    }
    return this.#pipeline.probe();
  }

  /**
   * Return the bridge pipeline adapter for the state gate.
   * @returns the adapter, or null when no skill is available.
   */
  pipelineAdapter(): ResearchPipelineAdapter | null {
    return this.discover().available ? this.#pipeline : null;
  }

  /**
   * Canonical state path for a route; always under the project root.
   * @param routeId - research route.
   * @returns absolute path.
   */
  statePath(routeId: string): string {
    const route = requireSlug(routeId, 'routeId');
    const path = canonicalStatePath(this.#config.projectRoot, route);
    this.#boundary.relative(path);
    return path;
  }

  /**
   * Read canonical state without writing it.
   * @param path - canonical state path.
   * @returns snapshot.
   */
  readState(path: string): RsiStateSnapshot {
    const absolute = this.#projectFile(path, 'statePath', true);
    const raw = readFileSync(absolute);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch {
      throw new MeshError('RSI_INVALID', 'canonical research state is not valid JSON', { path: absolute });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new MeshError('RSI_INVALID', 'canonical research state must be an object', { path: absolute });
    }
    const json = parsed as Record<string, unknown>;
    const version = extractStateVersion(json);
    if (version === null) {
      throw new MeshError('RSI_INVALID', 'canonical research state has no state_version', { path: absolute });
    }
    return {
      path: absolute,
      version,
      sha256: createHash('sha256').update(raw).digest('hex'),
      json,
    };
  }

  /**
   * Run `state_check.py --check --json` (read-only).
   * @param statePath - canonical state path.
   * @returns validator result.
   */
  async checkState(statePath: string): Promise<RsiStateCheck> {
    const pipeline = this.#pipelineOrThrow();
    const snapshot = this.readState(statePath);
    const result = await pipeline.runValidator('state_check', ['--check', '--json', snapshot.path]);
    const json = result.json;
    const record = typeof json === 'object' && json !== null && !Array.isArray(json)
      ? json as Record<string, unknown>
      : {};
    const violations = Array.isArray(record.violations) ? record.violations : [];
    return {
      ok: result.exitCode === 0 && record.ok !== false,
      exitCode: result.exitCode,
      status: classifyExit(result.exitCode),
      violations,
      raw: result,
    };
  }

  /**
   * Run `experiment_execute.py scheduler-check` (read-only).
   * @param statePath - canonical state path.
   * @param schedulerPath - scheduler JSON path.
   * @returns validator result.
   */
  async checkScheduler(statePath: string, schedulerPath: string): Promise<PipelineCommandResult> {
    const pipeline = this.#pipelineOrThrow();
    const state = this.#projectFile(statePath, 'statePath', true);
    const scheduler = this.#projectFile(schedulerPath, 'schedulerPath', true);
    return pipeline.runValidator('experiment_execute', [
      'scheduler-check',
      '--state', state,
      '--scheduler', scheduler,
    ]);
  }

  /**
   * Return the executable command for `experiment_execute.py`.
   * @returns python executable and script path.
   */
  runner(): { readonly python: string; readonly script: string } {
    const discovery = this.discover();
    if (!discovery.available || discovery.skillPath === null) {
      throw new MeshError('RSI_UNAVAILABLE', discovery.error ?? 'RSI skill is unavailable', { discovery });
    }
    return {
      python: this.#config.rsi.pythonExecutable,
      script: join(discovery.skillPath, 'scripts/experiment_execute.py'),
    };
  }

  /**
   * Verify a receipt that RSI's own `run --execute` has already consumed.
   * This is the production path used by the blocking Mesh shim.
   * @param input - receipt, manifest, scheduler and ledger paths.
   * @returns authorization bound to the current state content.
   */
  verifyConsumed(input: RsiVerifyInput): RsiAuthorization {
    const pipeline = this.#pipelineOrThrow();
    if (!pipeline.available()) throw new MeshError('RSI_UNAVAILABLE', 'RSI pipeline is unavailable');
    const statePath = this.#projectFile(input.statePath, 'statePath', true);
    const manifestPath = this.#projectFile(input.manifestPath, 'manifestPath', true);
    const schedulerPath = this.#projectFile(input.schedulerPath, 'schedulerPath', true);
    const receiptPath = this.#projectFile(input.receiptPath, 'receiptPath', true);
    const state = this.readState(statePath);
    const receiptRaw = readFileSync(receiptPath);
    const receipt = this.#readObject(receiptPath, 'receipt');
    if (receipt.schema !== 'execution-receipt@1') {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt schema is not execution-receipt@1');
    }
    if (receipt.permission !== 'PASS' && receipt.permission !== 'PILOT_ONLY') {
      throw new MeshError('RSI_GATE_HOLD', 'receipt is not an execution permission', { permission: receipt.permission });
    }
    const receiptId = typeof receipt.id === 'string' ? receipt.id : '';
    if (receiptId === '') throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt has no id');
    const manifest = this.#readObject(manifestPath, 'manifest');
    const manifestDigest = rsiDigest(manifest);
    const binding = receipt.binding;
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt has no binding');
    }
    const bindingRecord = binding as Record<string, unknown>;
    if (bindingRecord.manifest_digest !== manifestDigest) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt manifest digest does not match the manifest', {
        expected: bindingRecord.manifest_digest,
        actual: manifestDigest,
      });
    }
    if (bindingRecord.state_digest !== rsiDigest(state.json)) {
      throw new MeshError('RSI_STATE_CHANGED', 'canonical state changed since the receipt was issued', {
        receiptStateDigest: bindingRecord.state_digest,
        currentStateDigest: rsiDigest(state.json),
      });
    }
    this.#verifyBoundFiles(manifest, bindingRecord);
    const ledgerDir = input.ledgerPath === undefined
      ? join(statePath.slice(0, statePath.lastIndexOf('/')), '.execution')
      : this.#projectFile(input.ledgerPath, 'ledgerPath', true, 'directory');
    const eventsPath = join(ledgerDir, 'events.jsonl');
    if (!existsSync(eventsPath)) {
      throw new MeshError('RSI_AUTHORIZATION_MISSING', 'RSI execution ledger is missing', { ledgerDir });
    }
    const events = readFileSync(eventsPath, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch {
        throw new MeshError('RSI_INVALID', 'RSI execution ledger contains invalid JSON');
      }
    });
    const issued = events.find(event => event.kind === 'issue'
      && typeof event.receipt === 'object' && event.receipt !== null
      && (event.receipt as Record<string, unknown>).id === receiptId);
    if (issued === undefined) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt is not registered in the execution ledger');
    }
    const consume = events.find(event => event.kind === 'consume'
      && event.receipt_id === receiptId
      && event.dry_run === false
      && event.experiment_id === input.experimentId);
    if (consume === undefined) {
      throw new MeshError('RSI_AUTHORIZATION_MISSING', 'receipt has no consumed execution event for this experiment', {
        receiptId,
        experimentId: input.experimentId,
      });
    }
    const issuedAt = typeof receipt.issued_at === 'number' ? receipt.issued_at : NaN;
    const expiresAt = typeof receipt.expires_at === 'number' ? receipt.expires_at : NaN;
    const consumedAt = typeof consume.timestamp === 'number' ? consume.timestamp : NaN;
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(consumedAt)) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt or consume timestamps are invalid');
    }
    if (consumedAt < issuedAt || consumedAt >= expiresAt) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt was consumed outside its validity window', {
        issuedAt,
        expiresAt,
        consumedAt,
      });
    }
    // Verify the scheduler content that the receipt bound.
    const scheduler = this.#readObject(schedulerPath, 'scheduler');
    if (receipt.scheduler_digest !== undefined && receipt.scheduler_digest !== rsiDigest(scheduler)) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'scheduler content changed since the receipt was issued');
    }
    this.#logger.info('RSI consumed receipt verified', { receiptId, experimentId: input.experimentId, stateVersion: state.version });
    return {
      mode: 'rsi-receipt',
      receiptRef: relativePath(this.#config.projectRoot, receiptPath).split('\\').join('/'),
      receiptDigest: createHash('sha256').update(receiptRaw).digest('hex'),
      experimentId: input.experimentId,
      stateVersion: state.version,
      rsiManifestDigest: manifestDigest,
      verifiedBy: 'rsi.execution-ledger.consume',
      verifiedAt: nowIso(),
      ...(typeof consume.seal === 'string' ? { consumedLedgerEventSeal: consume.seal } : {}),
    };
  }

  /**
   * Verify a receipt through RSI's dry-run gate. This does not consume budget;
   * it exists only to exercise the execution layer in tests and is forbidden
   * unless `rsi.allowTestStub` is true.
   * @param input - receipt, manifest, scheduler and ledger paths.
   * @returns a `test-stub` authorization.
   */
  async verifyPreview(input: RsiVerifyInput): Promise<RsiAuthorization> {
    if (!this.#config.rsi.allowTestStub) {
      throw new MeshError('RSI_TEST_STUB_FORBIDDEN', 'preview authorization is test-only; enable rsi.allowTestStub explicitly');
    }
    const pipeline = this.#pipelineOrThrow();
    const statePath = this.#projectFile(input.statePath, 'statePath', true);
    const manifestPath = this.#projectFile(input.manifestPath, 'manifestPath', true);
    const schedulerPath = this.#projectFile(input.schedulerPath, 'schedulerPath', true);
    const receiptPath = this.#projectFile(input.receiptPath, 'receiptPath', true);
    const ledgerDir = input.ledgerPath === undefined
      ? join(statePath.slice(0, statePath.lastIndexOf('/')), '.execution')
      : this.#projectFile(input.ledgerPath, 'ledgerPath', true, 'directory');
    for (const needed of ['events.jsonl', 'key', 'head']) {
      if (!existsSync(join(ledgerDir, needed))) {
        throw new MeshError('RSI_AUTHORIZATION_MISSING', `RSI ledger file is missing: ${needed}`, { ledgerDir });
      }
    }
    const before = this.readState(statePath);
    const result = await pipeline.runValidator('experiment_execute', [
      'run',
      '--state', statePath,
      '--experiment', input.experimentId,
      '--manifest', manifestPath,
      '--scheduler', schedulerPath,
      '--receipt', receiptPath,
      '--ledger', ledgerDir,
    ]);
    if (result.exitCode !== 0) {
      throw new MeshError('RSI_GATE_HOLD', 'RSI preview gate rejected the execution', {
        exitCode: result.exitCode,
        status: classifyExit(result.exitCode),
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000),
      });
    }
    const json = result.json;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new MeshError('RSI_INVALID', 'RSI preview did not return a JSON object', { stdout: result.stdout.slice(0, 4000) });
    }
    const record = json as Record<string, unknown>;
    if (record.status !== 'PASS' && record.status !== 'PILOT_ONLY') {
      throw new MeshError('RSI_GATE_HOLD', 'RSI preview did not authorize execution', { status: record.status });
    }
    const executionRecord = record.execution_record;
    if (typeof executionRecord !== 'object' || executionRecord === null
      || (executionRecord as Record<string, unknown>).dry_run !== true) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'RSI preview was not a dry run', { status: record.status });
    }
    const after = this.readState(statePath);
    if (before.sha256 !== after.sha256 || before.version !== after.version) {
      throw new MeshError('RSI_STATE_CHANGED', 'canonical state changed during preview verification');
    }
    const receiptRaw = readFileSync(receiptPath);
    return {
      mode: 'test-stub',
      receiptRef: relativePath(this.#config.projectRoot, receiptPath).split('\\').join('/'),
      receiptDigest: createHash('sha256').update(receiptRaw).digest('hex'),
      experimentId: input.experimentId,
      stateVersion: after.version,
      rsiManifestDigest: rsiDigest(this.#readObject(manifestPath, 'manifest')),
      verifiedBy: 'rsi.experiment_execute.run.preview(test-only)',
      verifiedAt: nowIso(),
    };
  }

  // -- internals -----------------------------------------------------------

  #pipelineOrThrow(): ResearchPipelineAdapter {
    const discovery = this.discover();
    if (!discovery.available || this.#pipeline === null) {
      throw new MeshError('RSI_UNAVAILABLE', discovery.error ?? 'RSI skill is unavailable', { discovery });
    }
    return this.#pipeline;
  }

  #projectFile(input: string, field: string, mustExist: boolean, kind: 'file' | 'directory' = 'file'): string {
    let absolute: string;
    try {
      if (isAbsolute(input)) {
        const relative = relativePath(this.#config.projectRoot, input);
        if (relative.startsWith('..') || isAbsolute(relative)) {
          throw new Error('outside the project root');
        }
        absolute = this.#boundary.resolve(relative, field);
      } else {
        absolute = this.#boundary.resolve(input, field);
      }
    } catch (error) {
      throw new MeshError('PATH_ESCAPE', `${field} escapes the project root`, {
        field,
        input,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (mustExist) {
      const stat = statSync(absolute, { throwIfNoEntry: false });
      const valid = stat !== undefined && (kind === 'file' ? stat.isFile() : stat.isDirectory());
      if (!valid) {
        throw new MeshError('RSI_STATE_UNAVAILABLE', `${field} does not exist`, { field, path: absolute, kind });
      }
    }
    return absolute;
  }

  #readObject(path: string, field: string): Record<string, unknown> {
    try {
      return readJsonObjectFile(path, field);
    } catch (error) {
      throw new MeshError('RSI_INVALID', `${field} is not a valid JSON object`, {
        field,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #verifyBoundFiles(manifest: Record<string, unknown>, binding: Record<string, unknown>): void {
    const files = manifest.files;
    if (!Array.isArray(files)) throw new MeshError('RSI_AUTHORIZATION_INVALID', 'manifest has no files binding');
    const cwd = typeof manifest.cwd === 'string' ? manifest.cwd : '';
    if (cwd === '') throw new MeshError('RSI_AUTHORIZATION_INVALID', 'manifest has no cwd');
    const bound = Array.isArray(binding.files) ? binding.files : [];
    if (!Array.isArray(bound) || bound.length !== files.length) {
      throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt file binding does not match the manifest');
    }
    for (const entry of bound) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt file entry is invalid');
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== 'string' || typeof record.sha256 !== 'string') {
        throw new MeshError('RSI_AUTHORIZATION_INVALID', 'receipt file entry lacks path/sha256');
      }
      const absolute = isAbsolute(record.path) ? record.path : join(cwd, record.path);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new MeshError('RSI_AUTHORIZATION_INVALID', 'bound file is missing', { path: absolute });
      }
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      if (digest !== record.sha256) {
        throw new MeshError('RSI_AUTHORIZATION_INVALID', 'bound file content changed', { path: absolute });
      }
    }
  }
}

/**
 * Validate a caller-supplied RSI skill path without constructing a runtime.
 * @param path - candidate skill root.
 * @returns discovery result.
 */
export function discoverRsiSkill(path: string): RsiDiscovery {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return { available: false, skillPath: path, files: {}, digests: {}, error: 'skill path is not a directory' };
  }
  const files: Record<string, boolean> = {};
  const digests: Record<string, string> = {};
  for (const relative of REQUIRED_FILES) {
    const full = join(path, relative);
    files[relative] = existsSync(full);
    if (files[relative]) digests[relative] = fileSha256(full).slice(0, 16);
  }
  const missing = REQUIRED_FILES.filter(relative => files[relative] !== true);
  return {
    available: missing.length === 0,
    skillPath: path,
    files,
    digests,
    error: missing.length === 0 ? null : `missing: ${missing.join(', ')}`,
  };
}

/**
 * Normalize a project-relative path for a manifest reference.
 * @param projectRoot - absolute project root.
 * @param absolute - absolute path.
 * @returns `/`-separated relative path.
 */
export function projectRelative(projectRoot: string, absolute: string): string {
  const relative = relativePath(projectRoot, absolute);
  if (relative.startsWith('..') || isAbsolute(relative)) {
    throw new MeshError('PATH_ESCAPE', 'path is outside the project root', { absolute, projectRoot });
  }
  return requireRelativePath(relative, 'path');
}
