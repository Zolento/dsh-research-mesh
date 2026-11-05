/**
 * Coordinate one RSI consumed-ledger run with one Mesh experiment.
 *
 * RSI's `run --execute` appends the consume event and then blocks in the
 * generated shim. This coordinator waits for that event, verifies the receipt,
 * hands control to the Mesh launcher, and only then publishes the shim result so
 * RSI can return. It never starts the experiment itself.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshError } from '../errors.ts';
import type { RsiAuthorization } from './adapter.ts';
import { publishShimResult, SHIM_RESULT_SCHEMA, SHIM_SPEC_SCHEMA, type ShimSpec } from './blocking-shim.ts';

/** Command and paths needed to start RSI's blocking `run --execute`. */
export interface ConsumedRsiRunSpec {
  readonly python: string;
  readonly script: string;
  readonly statePath: string;
  readonly manifestPath: string;
  readonly schedulerPath: string;
  readonly receiptPath: string;
  readonly ledgerPath: string;
  readonly experimentId: string;
  readonly shimSpecPath: string;
  readonly shimResultPath: string;
  readonly timeoutMs: number;
  readonly journalPath?: string;
}

/** Callbacks the Mesh supplies while RSI is blocked in the shim. */
export interface ConsumedRsiCallbacks {
  /** Read the receipt id before the run starts. */
  receiptId(): string;
  /** Verify the now-consumed receipt under RSI's lock-free read path. */
  verify(): RsiAuthorization;
  /**
   * Launch and await the real Mesh experiment.
   * @param authorization - verified receipt.
   * @returns exit code to mirror to RSI (0 only for a completed experiment).
   */
  onConsumed(authorization: RsiAuthorization): Promise<number>;
}

/** Result of a coordinated run. */
export interface ConsumedRsiRunResult {
  readonly exitCode: number;
  readonly authorization: RsiAuthorization;
  readonly consumed: boolean;
}

interface ConsumeEvent {
  readonly kind?: unknown;
  readonly receipt_id?: unknown;
  readonly experiment_id?: unknown;
  readonly dry_run?: unknown;
}

/**
 * Read the RSI execution ledger and find the consume event for this receipt.
 * @param ledgerPath - `.execution` directory.
 * @param receiptId - receipt identity.
 * @param experimentId - experiment identity.
 * @returns the consume event, or undefined.
 */
export function findConsumeEvent(
  ledgerPath: string,
  receiptId: string,
  experimentId: string,
): ConsumeEvent | undefined {
  const eventsPath = join(ledgerPath, 'events.jsonl');
  if (!existsSync(eventsPath)) return undefined;
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.kind === 'consume'
      && record.receipt_id === receiptId
      && record.experiment_id === experimentId
      && record.dry_run === false) {
      return record as ConsumeEvent;
    }
  }
  return undefined;
}

/**
 * Run RSI and the Mesh experiment under one rendezvous.
 * @param spec - RSI command and ledger paths.
 * @param callbacks - verification and Mesh launch hooks.
 * @returns final RSI exit code and authorization.
 */
export async function runConsumedShim(
  spec: ConsumedRsiRunSpec,
  callbacks: ConsumedRsiCallbacks,
): Promise<ConsumedRsiRunResult> {
  const shimSpec = readShimSpec(spec.shimSpecPath);
  if (shimSpec.schema !== SHIM_SPEC_SCHEMA) {
    throw new MeshError('RSI_INVALID', 'authorization shim spec has an unsupported schema');
  }
  if (shimSpec.mode === 'exit') {
    throw new MeshError('RSI_INVALID', 'the blocking coordinator requires a wait-mode shim spec');
  }
  const receiptId = callbacks.receiptId();
  writeJournal(spec.journalPath, { phase: 'launching', receiptId, experimentId: spec.experimentId });

  const child = spawn(spec.python, [
    spec.script,
    'run',
    '--state', spec.statePath,
    '--experiment', spec.experimentId,
    '--manifest', spec.manifestPath,
    '--scheduler', spec.schedulerPath,
    '--receipt', spec.receiptPath,
    '--ledger', spec.ledgerPath,
    '--execute',
  ], {
    cwd: dirname(spec.statePath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? -1));
  });

  const deadline = Date.now() + spec.timeoutMs;
  let consume: ConsumeEvent | undefined;
  while (Date.now() < deadline) {
    consume = findConsumeEvent(spec.ledgerPath, receiptId, spec.experimentId);
    if (consume !== undefined) break;
    if (child.exitCode !== null) {
      throw new MeshError('RSI_CONSUME_MISSING', 'RSI exited before appending the consume event', {
        exitCode: child.exitCode,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
      });
    }
    await delay(100);
  }
  if (consume === undefined) {
    child.kill('SIGTERM');
    await exited.catch(() => {});
    throw new MeshError('RSI_CONSUME_TIMEOUT', 'RSI did not consume the receipt before the shim deadline', {
      receiptId,
      experimentId: spec.experimentId,
      timeoutMs: spec.timeoutMs,
    });
  }

  writeJournal(spec.journalPath, { phase: 'consumed', receiptId, experimentId: spec.experimentId });
  let exitCode: number;
  let authorization: RsiAuthorization;
  try {
    authorization = callbacks.verify();
    exitCode = await callbacks.onConsumed(authorization);
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new MeshError('INVALID_ARGUMENT', 'Mesh launch returned an invalid shim exit code', { exitCode });
    }
  } catch (error) {
    // The receipt is already spent; a failed launch must still release RSI with
    // a non-zero status instead of leaving the shim blocked until timeout.
    publishShimResult(
      { dir: dirname(spec.shimResultPath), specPath: spec.shimSpecPath, resultPath: spec.shimResultPath, scriptPath: '' },
      {
        schema: SHIM_RESULT_SCHEMA,
        job_id: shimSpec.job_id,
        attempt_id: shimSpec.attempt_id,
        exit_code: 1,
        finished_at: new Date().toISOString(),
      },
    );
    writeJournal(spec.journalPath, { phase: 'launch_failed', receiptId, experimentId: spec.experimentId, error: String(error) });
    await waitForExit(exited, 30_000);
    throw error;
  }

  publishShimResult(
    { dir: dirname(spec.shimResultPath), specPath: spec.shimSpecPath, resultPath: spec.shimResultPath, scriptPath: '' },
    {
      schema: SHIM_RESULT_SCHEMA,
      job_id: shimSpec.job_id,
      attempt_id: shimSpec.attempt_id,
      exit_code: exitCode,
      finished_at: new Date().toISOString(),
    },
  );
  writeJournal(spec.journalPath, { phase: 'completed', receiptId, experimentId: spec.experimentId, exitCode });
  const rsiExit = await waitForExit(exited, 30_000);
  if (rsiExit !== 0) {
    throw new MeshError('RSI_RUN_FAILED', `RSI run --execute did not accept the completed shim (exit ${rsiExit}): ${stderr.slice(0, 800)}`, {
      exitCode: rsiExit,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000),
    });
  }
  return { exitCode, authorization, consumed: true };
}

function readShimSpec(path: string): ShimSpec {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new MeshError('RSI_INVALID', 'authorization shim spec is not valid JSON', { path });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MeshError('RSI_INVALID', 'authorization shim spec is not an object');
  }
  return parsed as ShimSpec;
}

function writeJournal(path: string | undefined, value: Record<string, unknown>): void {
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ schema: 'dsh-research-mesh/consumed-run-journal@1', at: new Date().toISOString(), ...value }, null, 2)}\n`, { mode: 0o600 });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExit(promise: Promise<number>, timeoutMs: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MeshError('RSI_RUN_TIMEOUT', 'RSI run did not exit after the shim result'));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
