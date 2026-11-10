/**
 * Child-process runner for RLP scripts.
 *
 * RLP owns every scientific rule; Mesh only invokes its documented CLIs and
 * reads their JSON. The runner captures stdout/stderr even on a non-zero exit
 * because several RLP commands signal a decision through the exit code
 * (`rlp_paths.py resolve` uses 3 for a storage-layout failure).
 */

import { spawn } from 'node:child_process';
import { MeshError } from '../errors.ts';

/** Options for one Python invocation. */
export interface PythonRunOptions {
  readonly python: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly cwd?: string;
}

/** Captured result of one Python invocation. */
export interface PythonRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: unknown;
  readonly timedOut: boolean;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try { return JSON.parse(trimmed); } catch { /* try the last JSON line below */ }
  const lines = trimmed.split('\n').reverse();
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try { return JSON.parse(candidate); } catch { /* keep looking */ }
  }
  return undefined;
}

/**
 * Run one RLP script and capture its output.
 * @param options - interpreter, script, args and timeout.
 * @returns exit code, streams and parsed JSON when present.
 * @throws MeshError `RLP_UNAVAILABLE` when the interpreter or script cannot start.
 */
export async function runPython(options: PythonRunOptions): Promise<PythonRunResult> {
  return await new Promise<PythonRunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(options.python, [options.script, ...options.args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new MeshError('RLP_UNAVAILABLE', `cannot run ${options.script}: ${error.message}`, {
        python: options.python,
        script: options.script,
      }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, json: parseJson(stdout), timedOut });
    });
  });
}
