/** RSI blocking shim: rendezvous protocol, exit-code mirroring and timeout. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SHIM_RESULT_SCHEMA,
  SHIM_SPEC_SCHEMA,
  SHIM_TIMEOUT_EXIT,
  prepareShim,
  publishShimResult,
  readShimResult,
  shimArgv,
  shimPaths,
} from '../../src/rsi/blocking-shim.ts';
import { MeshError } from '../../src/errors.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mesh-shim-'));
  return { root, paths: shimPaths(root, 'job-shim', 'attempt-shim') };
}

test('the shim mirrors the Mesh exit code once the result is published', () => {
  const { root, paths } = fixture();
  try {
    prepareShim(paths, {
      schema: SHIM_SPEC_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      timeout_seconds: 30,
      poll_ms: 20,
    });
    const argv = shimArgv('python3', paths);
    assert.deepEqual(argv, ['python3', paths.scriptPath, paths.specPath]);

    // Publish before launch: the shim must still observe it.
    publishShimResult(paths, {
      schema: SHIM_RESULT_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      exit_code: 0,
      finished_at: new Date().toISOString(),
    });
    const output = execFileSync(argv[0] as string, argv.slice(1), { encoding: 'utf8' });
    assert.match(output, /settled with exit code 0/);
    assert.equal(readShimResult(paths)?.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shim exits with a non-zero job code and with the timeout code', () => {
  const { root, paths } = fixture();
  try {
    prepareShim(paths, {
      schema: SHIM_SPEC_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      timeout_seconds: 5,
      poll_ms: 10,
    });
    publishShimResult(paths, {
      schema: SHIM_RESULT_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      exit_code: 7,
      finished_at: new Date().toISOString(),
    });
    const failure = (() => {
      try {
        execFileSync('python3', [paths.scriptPath, paths.specPath], { stdio: 'ignore' });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    })();
    assert.equal(failure, 7);

    // No result and a short deadline: the shim must not hang RSI forever.
    rmSync(paths.resultPath, { force: true });
    prepareShim(paths, {
      schema: SHIM_SPEC_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      timeout_seconds: 0.2,
      poll_ms: 20,
    });
    const timedOut = (() => {
      try {
        execFileSync('python3', [paths.scriptPath, paths.specPath], { stdio: 'ignore' });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    })();
    assert.equal(timedOut, SHIM_TIMEOUT_EXIT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shim rejects an unsupported spec and an out-of-range exit code', () => {
  const { root, paths } = fixture();
  try {
    prepareShim(paths, {
      schema: SHIM_SPEC_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      timeout_seconds: 5,
      poll_ms: 10,
    });
    writeFileSync(paths.specPath, JSON.stringify({ schema: 'other@1' }));
    const status = (() => {
      try {
        execFileSync('python3', [paths.scriptPath, paths.specPath], { stdio: 'ignore' });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    })();
    assert.equal(status, 2);

    assert.throws(
      () => publishShimResult(paths, {
        schema: SHIM_RESULT_SCHEMA,
        job_id: 'job-shim',
        attempt_id: 'attempt-shim',
        exit_code: 300,
        finished_at: new Date().toISOString(),
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => prepareShim(paths, {
        schema: SHIM_SPEC_SCHEMA,
        job_id: 'job-shim',
        attempt_id: 'attempt-shim',
        timeout_seconds: 0,
        poll_ms: 10,
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consume-only mode exits zero without waiting for a result', () => {
  const { root, paths } = fixture();
  try {
    prepareShim(paths, {
      schema: SHIM_SPEC_SCHEMA,
      job_id: 'job-shim',
      attempt_id: 'attempt-shim',
      timeout_seconds: 30,
      poll_ms: 20,
      mode: 'exit',
    });
    const output = execFileSync('python3', [paths.scriptPath, paths.specPath], { encoding: 'utf8' });
    assert.match(output, /delegated to the controller/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
