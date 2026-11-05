/**
 * RSI blocking shim: the rendezvous between RSI's blocking `run --execute` and
 * the Mesh job lifecycle.
 *
 * RSI consumes a receipt and then launches the execution manifest's `argv`
 * synchronously. The Mesh already owns staging, GPU leases, transports and
 * artifact ingestion, so it must launch the real wrapper itself. The shim lets
 * both hold: RSI consumes exactly once and blocks on a child that waits for the
 * Mesh job, while the Mesh runs the wrapper and reports the exit code back.
 *
 * The shim never shells out and never reads project state: it only polls one
 * result file that the Mesh side writes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshError } from '../errors.ts';

/** Schema of the rendezvous spec the Mesh side writes. */
export const SHIM_SPEC_SCHEMA = 'dsh-research-mesh/rsi-blocking-shim-spec@1';
/** Schema of the result document the shim returns after the job settles. */
export const SHIM_RESULT_SCHEMA = 'dsh-research-mesh/rsi-blocking-shim-result@1';
/** Exit code reported when the Mesh side never delivered a result. */
export const SHIM_TIMEOUT_EXIT = 124;
/** Files created inside one rendezvous directory. */
export const SHIM_SPEC_FILE = 'shim-spec.json';
export const SHIM_RESULT_FILE = 'shim-result.json';
export const SHIM_SCRIPT_FILE = 'rsi_blocking_shim.py';

/** One rendezvous directory layout. */
export interface ShimPaths {
  readonly dir: string;
  readonly specPath: string;
  readonly resultPath: string;
  readonly scriptPath: string;
}

/**
 * Resolve the rendezvous paths for one job attempt.
 * @param root - Mesh-owned shim root.
 * @param jobId - job identity.
 * @param attemptId - attempt identity.
 * @returns absolute paths.
 */
export function shimPaths(root: string, jobId: string, attemptId: string): ShimPaths {
  const dir = join(root, jobId, attemptId);
  return {
    dir,
    specPath: join(dir, SHIM_SPEC_FILE),
    resultPath: join(dir, SHIM_RESULT_FILE),
    scriptPath: join(dir, SHIM_SCRIPT_FILE),
  };
}

/** Spec written before RSI launches the shim. */
export interface ShimSpec {
  readonly schema: typeof SHIM_SPEC_SCHEMA;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly timeout_seconds: number;
  readonly poll_ms: number;
  /**
   * `wait` (default) blocks for the Mesh result. `exit` consumes the receipt
   * and returns immediately; the operator then submits the Mesh task, whose
   * `executionManifestPath` carries the real wrapper.
   */
  readonly mode?: 'wait' | 'exit';
}

/**
 * Write the shim script, the spec and their directory.
 * @param paths - rendezvous paths.
 * @param spec - job identity and wait policy.
 * @returns the spec file path to put first in the RSI execution manifest argv.
 */
export function prepareShim(paths: ShimPaths, spec: ShimSpec): string {
  if (!Number.isFinite(spec.timeout_seconds) || spec.timeout_seconds <= 0) {
    throw new MeshError('INVALID_ARGUMENT', 'shim timeout must be a positive number of seconds');
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.scriptPath, buildShimScript(), { encoding: 'utf8', mode: 0o700 });
  writeFileSync(paths.specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return paths.specPath;
}

/**
 * Build the argv RSI's execution manifest must carry so that `run --execute`
 * consumes the receipt and then blocks in the shim.
 * @param python - python executable for the shim.
 * @param paths - rendezvous paths.
 * @returns argv safe to place in `execution-manifest@1`.
 */
export function shimArgv(python: string, paths: ShimPaths): readonly string[] {
  return [python, paths.scriptPath, paths.specPath];
}

/** Result document the Mesh side writes when the job settles. */
export interface ShimResult {
  readonly schema: typeof SHIM_RESULT_SCHEMA;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly exit_code: number;
  readonly finished_at: string;
}

/**
 * Publish the Mesh job outcome to the waiting shim.
 * @param paths - rendezvous paths.
 * @param result - job outcome; `exit_code` becomes the shim's exit status.
 * @returns the result file path.
 */
export function publishShimResult(paths: ShimPaths, result: ShimResult): string {
  if (!Number.isSafeInteger(result.exit_code) || result.exit_code < 0 || result.exit_code > 255) {
    throw new MeshError('INVALID_ARGUMENT', 'shim exit code must be an integer in [0, 255]', { exitCode: result.exit_code });
  }
  mkdirSync(dirname(paths.resultPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return paths.resultPath;
}

/**
 * Read the shim result, when the Mesh side already published one.
 * @param paths - rendezvous paths.
 * @returns the parsed result, or undefined when absent.
 */
export function readShimResult(paths: ShimPaths): ShimResult | undefined {
  if (!existsSync(paths.resultPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.resultPath, 'utf8'));
  } catch {
    throw new MeshError('RSI_INVALID', 'shim result is not valid JSON', { path: paths.resultPath });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MeshError('RSI_INVALID', 'shim result is not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== SHIM_RESULT_SCHEMA) {
    throw new MeshError('RSI_INVALID', 'shim result schema is unsupported', { schema: record.schema });
  }
  if (typeof record.exit_code !== 'number' || !Number.isSafeInteger(record.exit_code)) {
    throw new MeshError('RSI_INVALID', 'shim result has no integer exit_code');
  }
  return record as unknown as ShimResult;
}

/**
 * The generated shim. It polls one result file and exits with its code; it
 * never executes anything itself, so the Mesh remains the only launcher.
 * @returns Python source.
 */
export function buildShimScript(): string {
  return `#!/usr/bin/env python3
"""Research Mesh RSI blocking shim (generated; do not edit in place).

RSI's managed execution consumes a receipt and then blocks on this process.
This process only waits for the Mesh controller to publish the job outcome and
mirrors that exit code, so exactly one component ever starts the real command.
"""
import json
import os
import sys
import time

TIMEOUT_EXIT = ${SHIM_TIMEOUT_EXIT}


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: rsi_blocking_shim.py <spec.json>\\n")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    if spec.get("schema") != ${JSON.stringify(SHIM_SPEC_SCHEMA)}:
        sys.stderr.write("unsupported shim spec schema\\n")
        return 2
    if spec.get("mode") == "exit":
        # RSI appended the consume event before this process starts. The Mesh
        # verifies that event and launches the real execution manifest.
        sys.stdout.write("mesh receipt consumed; execution is delegated to the controller\\n")
        return 0
    if spec.get("mode") not in (None, "wait"):
        sys.stderr.write("unsupported shim mode\\n")
        return 2
    # The result lives beside the spec: the RSI manifest only binds this one path.
    result_path = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), ${JSON.stringify(SHIM_RESULT_FILE)})
    deadline = time.monotonic() + float(spec["timeout_seconds"])
    poll_ms = max(1, int(spec.get("poll_ms") or 50))
    while True:
        try:
            with open(result_path, "r", encoding="utf-8") as handle:
                result = json.load(handle)
        except FileNotFoundError:
            result = None
        except ValueError:
            result = None
        if isinstance(result, dict):
            code = result.get("exit_code")
            if isinstance(code, int) and 0 <= code <= 255:
                sys.stdout.write("mesh job settled with exit code %d\\n" % code)
                return code
            sys.stderr.write("invalid exit_code in shim result\\n")
            return 2
        if time.monotonic() >= deadline:
            sys.stderr.write("timed out waiting for the Mesh job result\\n")
            return TIMEOUT_EXIT
        time.sleep(poll_ms / 1000.0)


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
