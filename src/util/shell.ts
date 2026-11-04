/**
 * Process and shell-boundary helpers.
 *
 * Local processes are spawned with `shell: false` and argument arrays. Remote
 * SSH commands are executed by a remote POSIX shell, so every argument is
 * single-quoted with {@link shellQuote}; no caller string is ever interpolated
 * as shell syntax.
 */

import { spawn } from 'node:child_process';
import { MeshError } from '../errors.ts';

/** Captured result of one child process. */
export interface ProcessResult {
  /** Exit code, or null when terminated by a signal. */
  code: number | null;
  /** Terminating signal, if any. */
  signal: NodeJS.Signals | null;
  /** UTF-8 stdout, truncated to the configured cap. */
  stdout: string;
  /** UTF-8 stderr, truncated to the configured cap. */
  stderr: string;
  /** Whether the executor killed the process at its timeout. */
  timedOut: boolean;
  /** Whether output exceeded the cap and was truncated. */
  truncated: boolean;
}

/** Options for one bounded local process. */
export interface RunProcessOptions {
  /** Executable path or name. */
  command: string;
  /** Argument array; never interpreted by a shell. */
  args: readonly string[];
  /** Working directory. */
  cwd?: string;
  /** Complete environment; omission inherits the parent environment. */
  env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Maximum captured bytes per stream. */
  maxOutputBytes?: number;
  /** Optional stdin text. */
  stdin?: string;
}

/**
 * Single-quote a value for a POSIX shell.
 * @param value - arbitrary text without NUL.
 * @returns a safely quoted token.
 */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new MeshError('INVALID_ARGUMENT', 'shell argument contains NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Quote an argv array into one POSIX shell command.
 * @param args - executable and arguments.
 * @returns a command string safe to pass as one remote-shell argument.
 */
export function quoteArgv(args: readonly string[]): string {
  if (args.length === 0) throw new MeshError('INVALID_ARGUMENT', 'argv must not be empty');
  return args.map(shellQuote).join(' ');
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate an SSH host or destination (no leading dash, no shell syntax).
 * @param host - host name or IP literal.
 * @returns the unchanged host.
 */
export function requireSshHost(host: string): string {
  if (host === '' || host.startsWith('-') || host.includes('@') || !HOST_RE.test(host)) {
    throw new MeshError('CONFIG_INVALID', 'SSH host must be a plain host name or IP literal', { host });
  }
  return host;
}

/**
 * Validate an SSH user name.
 * @param user - user name.
 * @returns the unchanged user.
 */
export function requireSshUser(user: string): string {
  if (!USER_RE.test(user) || user.startsWith('-')) {
    throw new MeshError('CONFIG_INVALID', 'SSH user contains unsupported characters', { user });
  }
  return user;
}

/**
 * Run one local child process with no shell and bounded output/time.
 * @param options - process input.
 * @returns captured result; a non-zero exit is data, not a thrown failure.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const max = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new MeshError('EXECUTOR_FAILED', `could not spawn ${options.command}`, {
        command: options.command,
        cause: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer): string => {
      const remaining = max - Buffer.byteLength(current, 'utf8');
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > remaining) {
        truncated = true;
        return current + chunk.subarray(0, remaining).toString('utf8');
      }
      return current + chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const kill = (reason: 'timeout' | 'abort'): void => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* process already exited; the exit event is the authority */ }
    };
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs ?? 60_000);
    const onAbort = (): void => kill('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    child.on('error', error => fail(new MeshError('EXECUTOR_FAILED', `process failed to start: ${options.command}`, {
      command: options.command,
      cause: error.message,
    })));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut, truncated }));
  });
}

/** Result of one git invocation. */
export interface GitResult {
  /** Exit code. */
  code: number | null;
  /** Trimmed stdout. */
  stdout: string;
  /** Trimmed stderr. */
  stderr: string;
}

/**
 * Run git with an argument array and return its exit status.
 * @param cwd - repository or worktree directory.
 * @param args - git arguments after the executable.
 * @param timeoutMs - command timeout.
 * @returns captured result.
 */
export async function runGit(cwd: string, args: readonly string[], timeoutMs = 30_000): Promise<GitResult> {
  const result = await runProcess({
    command: 'git',
    args: ['-C', cwd, ...args],
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  return {
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/**
 * Run git and fail with a typed error on a non-zero exit.
 * @param cwd - repository or worktree directory.
 * @param args - git arguments.
 * @param field - operation label for the failure.
 * @param timeoutMs - command timeout.
 * @returns trimmed stdout.
 */
export async function runGitOrThrow(
  cwd: string,
  args: readonly string[],
  field: string,
  timeoutMs = 30_000,
): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs);
  if (result.code !== 0) {
    throw new MeshError('GIT_COMMAND_FAILED', `git ${field} failed`, {
      field,
      code: result.code,
      stderr: result.stderr.slice(0, 2000),
    });
  }
  return result.stdout;
}

/**
 * Validate a git commit id accepted by manifests (full 40 or 64 hex commit).
 * @param value - candidate commit.
 * @returns the unchanged commit.
 */
export function requireGitCommit(value: string): string {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
    throw new MeshError('INVALID_ARGUMENT', 'code.commit must be a full git commit hash', { commit: value });
  }
  return value;
}
