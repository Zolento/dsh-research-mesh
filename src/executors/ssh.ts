/**
 * SSH transport for the production executor.
 *
 * The transport is inert unless the global SSH switch and the worker are both
 * enabled. Host-key verification is always on; `StrictHostKeyChecking=no` is
 * never generated. No private key, password or token is read or stored.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MeshError } from '../errors.ts';
import type { MeshConfig, WorkerConfig } from '../config/types.ts';
import { runProcess, shellQuote } from '../util/shell.ts';
import { requireSshHost, requireSshUser } from '../util/shell.ts';
import type { GpuAvailability, GpuProbe } from '../resources/gpu.ts';
import { requireRelativePath } from '../util/fs-safe.ts';
import {
  parseArtifactManifest,
  parseRemoteState,
  type JobTransport,
  type RemoteArtifactManifest,
  type RemoteJobState,
  type TransportFile,
} from './transport.ts';

/** SSH transport options. */
export interface SshTransportOptions {
  readonly config: MeshConfig;
}

/** Production SSH transport. */
export class SshTransport implements JobTransport {
  readonly kind = 'ssh' as const;
  readonly #config: MeshConfig;

  /**
   * @param options - resolved Mesh configuration.
   */
  constructor(options: SshTransportOptions) {
    this.#config = options.config;
  }

  jobDir(worker: WorkerConfig, jobId: string, attemptId: string): string {
    if (!worker.remoteRoot.startsWith('/')) {
      throw new MeshError('CONFIG_INVALID', 'ssh worker remoteRoot must be an absolute path', { workerId: worker.workerId });
    }
    const root = worker.remoteRoot.replace(/\/+$/, '');
    return `${root}/jobs/${jobId}/${attemptId}`;
  }

  async ensureJobDir(dir: string): Promise<void> {
    const worker = this.#workerFor(dir);
    await this.#ssh(worker, `mkdir -p ${shellQuote(dir)}/logs ${shellQuote(dir)}/state ${shellQuote(dir)}/source`, 30_000);
  }

  async writeFile(dir: string, relativePath: string, content: string): Promise<void> {
    const worker = this.#workerFor(dir);
    const target = `${dir}/${requireRelativePath(relativePath, 'job file')}`;
    const parent = target.slice(0, target.lastIndexOf('/'));
    await this.#ssh(
      worker,
      `mkdir -p ${shellQuote(parent)} && cat > ${shellQuote(target)}`,
      30_000,
      content,
    );
  }

  async stageArchive(dir: string, archivePath: string): Promise<void> {
    const worker = this.#workerFor(dir);
    const remoteArchive = `${dir}/source.tar`;
    await this.#scp(worker, archivePath, remoteArchive, 180_000);
    await this.#ssh(
      worker,
      `tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(`${dir}/source`)} && rm -f ${shellQuote(remoteArchive)}`,
      180_000,
    );
  }

  async submit(dir: string, wrapper: string, timeoutMs: number): Promise<{ readonly pid?: number }> {
    const worker = this.#workerFor(dir);
    const command = `cd ${shellQuote(dir)} && nohup bash ${shellQuote(wrapper)} >/dev/null 2>&1 < /dev/null & echo $!`;
    const result = await runProcess({
      command: 'ssh',
      args: [...this.#sshOptions(worker), `${worker.user ?? 'root'}@${this.#host(worker)}`, '--', command],
      timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (result.timedOut) {
      // The command may have started. Never retry automatically.
      throw new MeshError('SUBMIT_UNKNOWN', 'SSH submit timed out; remote state is unknown', {
        workerId: worker.workerId,
        jobDir: dir,
      });
    }
    if (result.code !== 0) {
      throw new MeshError('EXECUTOR_FAILED', 'SSH submit failed', {
        workerId: worker.workerId,
        code: result.code,
        stderr: result.stderr.slice(0, 2000),
      });
    }
    const pid = Number.parseInt(result.stdout.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : {};
  }

  async readState(dir: string): Promise<RemoteJobState | null> {
    const worker = this.#workerFor(dir);
    const raw = await this.#ssh(
      worker,
      `if [ -f ${shellQuote(`${dir}/state/job-state.json`)} ]; then cat ${shellQuote(`${dir}/state/job-state.json`)}; else printf '__MESH_MISSING__'; fi`,
      30_000,
    );
    if (raw.trim() === '__MESH_MISSING__') return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseRemoteState(raw, {
      jobId: String(parsed.job_id),
      attemptId: String(parsed.attempt_id),
      manifestDigest: String(parsed.manifest_sha256),
    });
  }

  async readArtifactManifest(dir: string, destination: string): Promise<RemoteArtifactManifest | null> {
    const worker = this.#workerFor(dir);
    const path = `${dir}/${requireRelativePath(destination, 'destination')}/artifact-manifest.json`;
    const raw = await this.#ssh(
      worker,
      `if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; else printf '__MESH_MISSING__'; fi`,
      30_000,
    );
    if (raw.trim() === '__MESH_MISSING__') return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseArtifactManifest(raw, {
      jobId: String(parsed.job_id),
      attemptId: String(parsed.attempt_id),
      manifestDigest: String(parsed.manifest_sha256),
    });
  }

  async listArtifactFiles(dir: string, destination: string): Promise<readonly TransportFile[]> {
    const worker = this.#workerFor(dir);
    const path = `${dir}/${requireRelativePath(destination, 'destination')}`;
    const raw = await this.#ssh(
      worker,
      `cd ${shellQuote(path)} 2>/dev/null || exit 3; find . -type f -printf '%P\\t%s\\n'`,
      60_000,
    );
    const files: TransportFile[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const [relative, sizeRaw] = line.split('\t');
      if (relative === undefined || sizeRaw === undefined) {
        throw new MeshError('ARTIFACT_INVALID', 'remote find returned an unexpected row', { line: line.slice(0, 200) });
      }
      if (relative === 'artifact-manifest.json') continue;
      const safe = requireRelativePath(relative, 'artifact path');
      const size = Number.parseInt(sizeRaw, 10);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new MeshError('ARTIFACT_INVALID', 'remote artifact size is invalid', { path: safe });
      }
      files.push({ path: safe, size });
    }
    return files;
  }

  async download(dir: string, relativePath: string, localPath: string): Promise<void> {
    const worker = this.#workerFor(dir);
    mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
    await this.#scp(worker, `${dir}/${requireRelativePath(relativePath, 'download path')}`, localPath, 600_000);
  }

  /**
   * Best-effort device check used before a real submission. This only proves
   * that `nvidia-smi` reports the device; it cannot prove exclusive OS use.
   * @param worker - SSH worker.
   * @param gpuId - device id.
   * @returns availability.
   */
  async probeGpu(worker: WorkerConfig, gpuId: number): Promise<GpuAvailability> {
    const command = `nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits`;
    const result = await runProcess({
      command: 'ssh',
      args: [...this.#sshOptions(worker), `${worker.user ?? 'root'}@${this.#host(worker)}`, '--', command],
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.timedOut || result.code !== 0) return 'unknown';
    for (const line of result.stdout.split('\n')) {
      const [indexRaw, usedRaw, totalRaw] = line.split(',').map(part => part.trim());
      if (indexRaw === undefined || usedRaw === undefined || totalRaw === undefined) continue;
      if (Number.parseInt(indexRaw, 10) !== gpuId) continue;
      const used = Number.parseInt(usedRaw, 10);
      const total = Number.parseInt(totalRaw, 10);
      if (!Number.isSafeInteger(used) || !Number.isSafeInteger(total) || total <= 0) return 'unknown';
      // Desktop/display memory is common; only a nearly full device is busy.
      // Compute contention is not observable from this query; see docs.
      return used / total >= 0.9 ? 'busy' : 'available';
    }
    return 'unknown';
  }

  #workerFor(dir: string): WorkerConfig {
    const worker = Object.values(this.#config.workers).find(candidate =>
      candidate.transport === 'ssh' && candidate.remoteRoot !== '' && dir.startsWith(candidate.remoteRoot.replace(/\/+$/, '') + '/'));
    if (worker === undefined) {
      throw new MeshError('CONFIG_INVALID', 'job directory is outside every configured SSH worker root', { dir });
    }
    if (!worker.enabled) throw new MeshError('EXECUTOR_DISABLED', `worker ${worker.workerId} is disabled`);
    if (!this.#config.ssh.enabled) throw new MeshError('EXECUTOR_DISABLED', 'SSH execution is disabled by configuration');
    return worker;
  }

  #host(worker: WorkerConfig): string {
    if (worker.host === undefined) throw new MeshError('CONFIG_INVALID', 'worker host is missing', { workerId: worker.workerId });
    return requireSshHost(worker.host);
  }

  #sshOptions(worker: WorkerConfig): readonly string[] {
    if (worker.user === undefined) throw new MeshError('CONFIG_INVALID', 'worker user is missing', { workerId: worker.workerId });
    requireSshUser(worker.user);
    const options = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `ConnectTimeout=${this.#config.ssh.connectTimeoutSec}`,
      '-o', `ServerAliveInterval=${this.#config.ssh.serverAliveIntervalSec}`,
      '-p', String(worker.port),
    ];
    if (this.#config.ssh.knownHostsFile !== undefined) {
      options.push('-o', `UserKnownHostsFile=${this.#config.ssh.knownHostsFile}`);
    }
    return options;
  }

  async #ssh(worker: WorkerConfig, command: string, timeoutMs: number, stdin?: string): Promise<string> {
    const result = await runProcess({
      command: 'ssh',
      args: [...this.#sshOptions(worker), `${worker.user ?? 'root'}@${this.#host(worker)}`, '--', command],
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (result.timedOut) {
      throw new MeshError('EXECUTOR_TIMEOUT', 'SSH command timed out', { workerId: worker.workerId, command: command.slice(0, 200) });
    }
    if (result.code !== 0) {
      throw new MeshError('EXECUTOR_FAILED', 'SSH command failed', {
        workerId: worker.workerId,
        code: result.code,
        stderr: result.stderr.slice(0, 2000),
      });
    }
    return result.stdout;
  }

  async #scp(worker: WorkerConfig, local: string, remote: string, timeoutMs: number): Promise<void> {
    const result = await runProcess({
      command: 'scp',
      args: [
        '-q',
        '-P', String(worker.port),
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        ...(this.#config.ssh.knownHostsFile === undefined ? [] : ['-o', `UserKnownHostsFile=${this.#config.ssh.knownHostsFile}`]),
        local,
        `${worker.user ?? 'root'}@${this.#host(worker)}:${remote}`,
      ],
      timeoutMs,
    });
    if (result.timedOut) {
      throw new MeshError('EXECUTOR_TIMEOUT', 'SCP transfer timed out', { workerId: worker.workerId, local, remote });
    }
    if (result.code !== 0) {
      throw new MeshError('ARTIFACT_TRANSFER_INCOMPLETE', 'SCP transfer failed', {
        workerId: worker.workerId,
        code: result.code,
        stderr: result.stderr.slice(0, 2000),
      });
    }
  }
}

/** Copy a local file into a transport directory helper (tests only). */
export function copyLocal(source: string, destination: string): void {
  copyFileSync(source, destination);
}


/** GPU probe backed by `nvidia-smi` over SSH. */
export class SshGpuProbe implements GpuProbe {
  readonly #transport: SshTransport;

  /**
   * @param transport - configured SSH transport.
   */
  constructor(transport: SshTransport) {
    this.#transport = transport;
  }

  async probe(worker: WorkerConfig, gpuId: number): Promise<GpuAvailability> {
    return this.#transport.probeGpu(worker, gpuId);
  }
}
