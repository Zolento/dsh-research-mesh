/**
 * Execution transports.
 *
 * A transport moves one immutable job directory to an execution host and reads
 * its state back. `FakeTransport` runs the same wrapper locally and is the only
 * transport exercised by the test suite; `SSHTransport` is the production
 * implementation and is disabled unless both the SSH switch and worker are
 * explicitly enabled.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { MeshError } from '../errors.ts';
import type { WorkerConfig } from '../config/types.ts';
import { atomicWriteText, requireRelativePath } from '../util/fs-safe.ts';
import { nowIso } from '../util/time.ts';
import { runProcess } from '../util/shell.ts';
import { sha256Bytes } from '../util/hash.ts';

/** One file exposed by a remote artifact destination. */
export interface TransportFile {
  readonly path: string;
  readonly size: number;
}

/** Remote job state file. */
export interface RemoteJobState {
  readonly schema: 'dsh-research-mesh/remote-state@1';
  readonly job_id: string;
  readonly attempt_id: string;
  readonly manifest_sha256: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly exit_code: number | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly error?: string;
}

/** One file in a remote artifact manifest. */
export interface RemoteArtifactFile {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

/** Remote artifact manifest. */
export interface RemoteArtifactManifest {
  readonly schema: 'dsh-research-mesh/artifact-manifest@1';
  readonly job_id: string;
  readonly attempt_id: string;
  readonly manifest_sha256: string;
  readonly status: 'complete';
  readonly created_at: string;
  readonly files: readonly RemoteArtifactFile[];
  readonly total_bytes: number;
}

/** Transport seam shared by fake, local and SSH execution. */
export interface JobTransport {
  /** Stable transport label for logs and job rows. */
  readonly kind: 'fake-ssh' | 'local' | 'ssh';

  /**
   * Absolute job directory on the execution host.
   * @param worker - worker configuration.
   * @param jobId - job identity.
   * @param attemptId - attempt identity.
   * @returns path.
   */
  jobDir(worker: WorkerConfig, jobId: string, attemptId: string): string;

  /**
   * Create the job directory and its fixed subdirectories.
   * @param dir - absolute job directory.
   */
  ensureJobDir(dir: string): Promise<void>;

  /**
   * Write one controller-authored file into the job directory.
   * @param dir - absolute job directory.
   * @param relativePath - path relative to the job directory.
   * @param content - UTF-8 text.
   */
  writeFile(dir: string, relativePath: string, content: string): Promise<void>;

  /**
   * Copy a local Git archive to the job directory and extract it under `source`.
   * @param dir - absolute job directory.
   * @param archivePath - local archive path.
   */
  stageArchive(dir: string, archivePath: string): Promise<void>;

  /**
   * Start the wrapper.
   * @param dir - absolute job directory.
   * @param wrapper - absolute wrapper path.
   * @param timeoutMs - transport command timeout.
   * @returns optional remote pid.
   */
  submit(dir: string, wrapper: string, timeoutMs: number): Promise<{ readonly pid?: number }>;

  /**
   * Read the remote job state, or null when the state file is absent.
   * @param dir - absolute job directory.
   * @returns parsed state.
   */
  readState(dir: string): Promise<RemoteJobState | null>;

  /**
   * Read the remote artifact manifest, or null when absent.
   * @param dir - absolute job directory.
   * @param destination - artifact destination relative to the job directory.
   * @returns parsed manifest.
   */
  readArtifactManifest(dir: string, destination: string): Promise<RemoteArtifactManifest | null>;

  /**
   * List regular files under an artifact destination.
   * @param dir - absolute job directory.
   * @param destination - artifact destination.
   * @returns file entries.
   */
  listArtifactFiles(dir: string, destination: string): Promise<readonly TransportFile[]>;

  /**
   * Download one file.
   * @param dir - absolute job directory.
   * @param relativePath - path relative to the job directory.
   * @param localPath - local destination.
   */
  download(dir: string, relativePath: string, localPath: string): Promise<void>;
}

/**
 * Parse and validate a remote state document.
 * @param raw - JSON text.
 * @param expected - expected job/attempt/digest.
 * @returns parsed state.
 */
export function parseRemoteState(
  raw: string,
  expected: { jobId: string; attemptId: string; manifestDigest: string },
): RemoteJobState {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new MeshError('EXECUTOR_FAILED', 'remote state is not valid JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MeshError('EXECUTOR_FAILED', 'remote state is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 'dsh-research-mesh/remote-state@1') {
    throw new MeshError('EXECUTOR_FAILED', 'remote state schema is unsupported', { schema: record.schema });
  }
  if (record.job_id !== expected.jobId || record.attempt_id !== expected.attemptId) {
    throw new MeshError('EXECUTOR_FAILED', 'remote state belongs to a different job/attempt', {
      expected,
      actual: { jobId: record.job_id, attemptId: record.attempt_id },
    });
  }
  if (record.manifest_sha256 !== expected.manifestDigest) {
    throw new MeshError('MANIFEST_MISMATCH', 'remote state manifest digest does not match', {
      expected: expected.manifestDigest,
      actual: record.manifest_sha256,
    });
  }
  if (record.status !== 'running' && record.status !== 'succeeded' && record.status !== 'failed') {
    throw new MeshError('EXECUTOR_FAILED', 'remote state status is unsupported', { status: record.status });
  }
  if (typeof record.started_at !== 'string') throw new MeshError('EXECUTOR_FAILED', 'remote state lacks started_at');
  const exitCode = record.exit_code;
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) {
    throw new MeshError('EXECUTOR_FAILED', 'remote state exit_code is invalid');
  }
  return {
    schema: 'dsh-research-mesh/remote-state@1',
    job_id: expected.jobId,
    attempt_id: expected.attemptId,
    manifest_sha256: expected.manifestDigest,
    status: record.status,
    exit_code: exitCode,
    started_at: record.started_at,
    finished_at: typeof record.finished_at === 'string' ? record.finished_at : null,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

/**
 * Parse and validate an artifact manifest.
 * @param raw - JSON text.
 * @param expected - expected job/attempt/digest.
 * @returns parsed manifest.
 */
export function parseArtifactManifest(
  raw: string,
  expected: { jobId: string; attemptId: string; manifestDigest: string },
): RemoteArtifactManifest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new MeshError('ARTIFACT_INVALID', 'artifact manifest is not valid JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MeshError('ARTIFACT_INVALID', 'artifact manifest is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 'dsh-research-mesh/artifact-manifest@1' || record.status !== 'complete') {
    throw new MeshError('ARTIFACT_INVALID', 'artifact manifest schema/status is unsupported');
  }
  if (record.job_id !== expected.jobId || record.attempt_id !== expected.attemptId) {
    throw new MeshError('ARTIFACT_INVALID', 'artifact manifest belongs to a different job/attempt');
  }
  if (record.manifest_sha256 !== expected.manifestDigest) {
    throw new MeshError('MANIFEST_MISMATCH', 'artifact manifest job digest does not match');
  }
  if (!Array.isArray(record.files)) throw new MeshError('ARTIFACT_INVALID', 'artifact manifest files is not an array');
  const files: RemoteArtifactFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of record.files) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest file entry is not an object');
    }
    const file = entry as Record<string, unknown>;
    const path = requireRelativePath(String(file.path ?? ''), 'artifact path');
    if (seen.has(path)) throw new MeshError('ARTIFACT_INVALID', 'artifact manifest contains a duplicate path', { path });
    seen.add(path);
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest sha256 is invalid', { path });
    }
    if (typeof file.size_bytes !== 'number' || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) {
      throw new MeshError('ARTIFACT_INVALID', 'artifact manifest size is invalid', { path });
    }
    files.push({ path, sha256: file.sha256, size_bytes: file.size_bytes });
    total += file.size_bytes;
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: 'dsh-research-mesh/artifact-manifest@1',
    job_id: expected.jobId,
    attempt_id: expected.attemptId,
    manifest_sha256: expected.manifestDigest,
    status: 'complete',
    created_at: typeof record.created_at === 'string' ? record.created_at : nowIso(),
    files,
    total_bytes: total,
  };
}

/** Fault-injection hooks for the fake transport. */
export interface FakeTransportHooks {
  /** Start the job, then throw a submit-unknown error instead of confirming. */
  readonly dropSubmitResponse?: boolean;
  /** Truncate these artifact paths on their first download. */
  readonly partialDownloads?: ReadonlySet<string>;
  /** Return a corrupted state document once. */
  readonly corruptStateOnce?: boolean;
}

/** Local-filesystem transport that runs the real wrapper without SSH. */
export class FakeTransport implements JobTransport {
  readonly kind = 'fake-ssh' as const;
  readonly #root: string;
  readonly #hooks: FakeTransportHooks;
  readonly #submitCounts = new Map<string, number>();
  readonly #downloadCounts = new Map<string, number>();
  #corruptedState = false;

  /**
   * @param root - local directory representing the remote host.
   * @param hooks - fault-injection controls.
   */
  constructor(root: string, hooks: FakeTransportHooks = {}) {
    this.#root = root;
    this.#hooks = hooks;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /** Number of times a job directory was submitted. */
  submitCount(jobDir: string): number {
    return this.#submitCounts.get(jobDir) ?? 0;
  }

  jobDir(worker: WorkerConfig, jobId: string, attemptId: string): string {
    if (worker.fakeRemoteRoot === undefined) {
      throw new MeshError('CONFIG_INVALID', 'fake transport needs worker.fakeRemoteRoot');
    }
    return join(worker.fakeRemoteRoot, 'jobs', jobId, attemptId);
  }

  async ensureJobDir(dir: string): Promise<void> {
    mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'state'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'source'), { recursive: true, mode: 0o700 });
  }

  async writeFile(dir: string, relativePath: string, content: string): Promise<void> {
    const target = join(dir, requireRelativePath(relativePath, 'job file'));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    atomicWriteText(target, content);
  }

  async stageArchive(dir: string, archivePath: string): Promise<void> {
    const target = join(dir, 'source.tar');
    copyFileSync(archivePath, target);
    const result = await runProcess({
      command: 'tar',
      args: ['-xf', target, '-C', join(dir, 'source')],
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      throw new MeshError('EXECUTOR_FAILED', 'fake transport could not extract the archive', {
        stderr: result.stderr.slice(0, 2000),
      });
    }
  }

  async submit(dir: string, wrapper: string, _timeoutMs: number): Promise<{ readonly pid?: number }> {
    const count = (this.#submitCounts.get(dir) ?? 0) + 1;
    this.#submitCounts.set(dir, count);
    const child = spawn('bash', [wrapper], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    child.unref();
    if (this.#hooks.dropSubmitResponse === true) {
      throw new MeshError('SUBMIT_UNKNOWN', 'fake transport started the job but lost the submit response', {
        jobDir: dir,
        pid: child.pid,
      });
    }
    return child.pid === undefined ? {} : { pid: child.pid };
  }

  async readState(dir: string): Promise<RemoteJobState | null> {
    const path = join(dir, 'state', 'job-state.json');
    if (!existsSync(path)) return null;
    if (this.#hooks.corruptStateOnce === true && !this.#corruptedState) {
      this.#corruptedState = true;
      return parseRemoteState('{"schema":"broken"}', { jobId: 'x', attemptId: 'x', manifestDigest: 'x' });
    }
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseRemoteState(raw, {
      jobId: String(parsed.job_id),
      attemptId: String(parsed.attempt_id),
      manifestDigest: String(parsed.manifest_sha256),
    });
  }

  async readArtifactManifest(dir: string, destination: string): Promise<RemoteArtifactManifest | null> {
    const path = join(dir, requireRelativePath(destination, 'destination'), 'artifact-manifest.json');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseArtifactManifest(raw, {
      jobId: String(parsed.job_id),
      attemptId: String(parsed.attempt_id),
      manifestDigest: String(parsed.manifest_sha256),
    });
  }

  async listArtifactFiles(dir: string, destination: string): Promise<readonly TransportFile[]> {
    const root = join(dir, requireRelativePath(destination, 'destination'));
    const output: TransportFile[] = [];
    const walk = (current: string): void => {
      if (!existsSync(current)) return;
      const { readdirSync, lstatSync } = fsModule;
      for (const name of readdirSync(current)) {
        const full = join(current, name);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) throw new MeshError('ARTIFACT_INVALID', 'artifact destination contains a symlink', { path: full });
        if (stat.isDirectory()) walk(full);
        else if (stat.isFile()) {
          const relative = full.slice(root.length + 1).split('\\').join('/');
          if (relative === 'artifact-manifest.json') continue;
          output.push({ path: relative, size: stat.size });
        }
      }
    };
    walk(root);
    return output;
  }

  async download(dir: string, relativePath: string, localPath: string): Promise<void> {
    const source = join(dir, requireRelativePath(relativePath, 'download path'));
    mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
    const count = (this.#downloadCounts.get(source) ?? 0) + 1;
    this.#downloadCounts.set(source, count);
    const partial = this.#hooks.partialDownloads;
    const fileName = relativePath.split('/').at(-1) ?? relativePath;
    if (partial !== undefined && (partial.has(relativePath) || partial.has(fileName)) && count === 1) {
      const data = readFileSync(source);
      writeFileSync(localPath, data.subarray(0, Math.max(0, Math.floor(data.length / 2))));
      return;
    }
    copyFileSync(source, localPath);
  }
}

import * as fsModule from 'node:fs';
