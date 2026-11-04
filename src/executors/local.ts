/**
 * Local executor for controller-side research tasks.
 *
 * Commands run through Conda with `shell: false` and an argument array. A local
 * task never claims a GPU lease and never produces a remote job manifest; the
 * remote experiment path is the shared `RemoteJobExecutor`.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { MeshError } from '../errors.ts';
import type { CondaConfig } from '../config/types.ts';
import { requireRelativePath } from '../util/fs-safe.ts';
import { runProcess } from '../util/shell.ts';
import { nowIso } from '../util/time.ts';
import type { MeshLogger } from '../util/logger.ts';
import { buildCondaArgv } from './wrapper.ts';

/** One local execution request. */
export interface LocalRunInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspacePath: string;
  readonly entrypoint: string;
  readonly argv: readonly string[];
  readonly condaEnvironment: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** One local execution result. */
export interface LocalRunResult {
  readonly status: 'succeeded' | 'failed';
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly logDir: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly durationMs: number;
}

const CONDA_ENV = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN_ENV = new Set(['CUDA_VISIBLE_DEVICES', 'BASH_ENV', 'ENV', 'LD_PRELOAD']);

/** Validate local execution input at the boundary. */
function validateInput(input: LocalRunInput): void {
  if (!isAbsolute(input.workspacePath)) {
    throw new MeshError('INVALID_ARGUMENT', 'local workspace path must be absolute');
  }
  const stat = statSync(input.workspacePath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new MeshError('WORKSPACE_MISSING', 'local workspace does not exist', { path: input.workspacePath });
  }
  if (!CONDA_ENV.test(input.condaEnvironment)) {
    throw new MeshError('INVALID_ARGUMENT', 'conda environment is not a safe name', { condaEnvironment: input.condaEnvironment });
  }
  if (input.entrypoint.length === 0 || input.entrypoint.includes('\0') || input.entrypoint.startsWith('-')) {
    throw new MeshError('INVALID_ARGUMENT', 'invalid local entrypoint', { entrypoint: input.entrypoint });
  }
  if (input.entrypoint.includes('/')) requireRelativePath(input.entrypoint, 'entrypoint');
  for (const [index, arg] of input.argv.entries()) {
    if (arg.includes('\0')) throw new MeshError('INVALID_ARGUMENT', `argv[${index}] contains NUL`);
  }
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    if (!ENV_KEY.test(key)) throw new MeshError('INVALID_ARGUMENT', `environment key is invalid: ${key}`);
    if (FORBIDDEN_ENV.has(key)) throw new MeshError('INVALID_ARGUMENT', `environment key is controlled: ${key}`);
    if (value.includes('\0')) throw new MeshError('INVALID_ARGUMENT', `environment value contains NUL: ${key}`);
  }
}

/** Local Conda executor. */
export class LocalExecutor {
  readonly #conda: CondaConfig;
  readonly #logsRoot: string;
  readonly #logger: MeshLogger;

  /**
   * @param conda - conda executable policy.
   * @param logsRoot - absolute directory for local task logs.
   * @param logger - structured logger.
   */
  constructor(conda: CondaConfig, logsRoot: string, logger: MeshLogger) {
    this.#conda = conda;
    this.#logsRoot = logsRoot;
    this.#logger = logger;
  }

  /**
   * Run one local task through Conda.
   * @param input - workspace, entrypoint and argv.
   * @returns execution result.
   */
  async run(input: LocalRunInput): Promise<LocalRunResult> {
    validateInput(input);
    const logDir = join(this.#logsRoot, input.taskId, input.attemptId);
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const stdoutPath = join(logDir, 'stdout.log');
    const stderrPath = join(logDir, 'stderr.log');
    const started = Date.now();
    const argv = buildCondaArgv(this.#conda, input.condaEnvironment, input.entrypoint, input.argv);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...input.environment,
      MESH_TASK_ID: input.taskId,
      MESH_ATTEMPT_ID: input.attemptId,
    };
    const result = await runProcess({
      command: argv[0] ?? this.#conda.executable,
      args: argv.slice(1),
      cwd: input.workspacePath,
      env: environment,
      timeoutMs: input.timeoutMs ?? 60 * 60 * 1000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    writeFileSync(stdoutPath, result.stdout, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(stderrPath, result.stderr, { encoding: 'utf8', mode: 0o600 });
    const durationMs = Date.now() - started;
    const status = result.code === 0 && !result.timedOut ? 'succeeded' : 'failed';
    this.#logger.info('local task finished', {
      taskId: input.taskId,
      attemptId: input.attemptId,
      status,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs,
    });
    return {
      status,
      exitCode: result.code,
      timedOut: result.timedOut,
      logDir,
      stdoutPath,
      stderrPath,
      durationMs,
    };
  }
}

/**
 * Ensure a local log directory exists and return a marker file path.
 * @param root - logs root.
 * @param taskId - task identity.
 * @param attemptId - attempt identity.
 * @returns marker path.
 */
export function localMarkerPath(root: string, taskId: string, attemptId: string): string {
  const path = join(root, taskId, attemptId, 'finished.json');
  if (!existsSync(join(root, taskId, attemptId))) mkdirSync(join(root, taskId, attemptId), { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Current ISO timestamp helper for local records.
 * @returns ISO timestamp.
 */
export function localNow(): string {
  return nowIso();
}
