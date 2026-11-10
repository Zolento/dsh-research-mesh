/**
 * RLP scientific-completion verifier.
 *
 * Mesh does not re-implement Evidence Qualification. It asks the protocol's own
 * `evidence_outcome.py decision` entry and accepts only a PASS decision that is
 * bound to the current canonical state digest. HOLD/FAIL, a stale digest or an
 * RLP runtime error all refuse completion.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '../errors.ts';
import type { RlpSkill } from './types.ts';
import { runPython } from './python.ts';

/** One completion verification result. */
export interface ScientificCompletion {
  readonly status: 'PASS' | 'HOLD' | 'FAIL';
  readonly experimentId: string;
  readonly stateVersion: string;
  readonly stateDigest: string;
  readonly decision: string;
  readonly proofDigest: string;
  readonly errors: readonly string[];
}

/** Optional seam so tests can exercise the engine without a live RLP state. */
export interface CompletionVerifier {
  verify(input: { statePath: string; experimentId: string }): Promise<ScientificCompletion>;
}

function stateVersionOf(json: unknown): string {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'unknown';
  const raw = (json as Record<string, unknown>).state_version;
  return typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : 'unknown';
}

/** RLP-backed verifier over one discovered skill. */
export class RlpCompletionVerifier implements CompletionVerifier {
  readonly #skill: RlpSkill;
  readonly #timeoutMs: number;

  /**
   * @param skill - discovered RLP installation.
   * @param timeoutMs - decision process timeout.
   */
  constructor(skill: RlpSkill, timeoutMs = 60_000) {
    this.#skill = skill;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Verify one experiment's committed outcome.
   * @param input - canonical state path and experiment id.
   * @returns PASS only when RLP returns a PASS decision for the current state.
   */
  async verify(input: { statePath: string; experimentId: string }): Promise<ScientificCompletion> {
    const stat = statSync(input.statePath, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) {
      return {
        status: 'HOLD', experimentId: input.experimentId, stateVersion: 'unknown', stateDigest: '',
        decision: '', proofDigest: '', errors: ['canonical research state is missing'],
      };
    }
    const raw = readFileSync(input.statePath);
    const stateDigest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch {
      return {
        status: 'FAIL', experimentId: input.experimentId, stateVersion: 'unknown', stateDigest,
        decision: '', proofDigest: '', errors: ['canonical research state is not valid JSON'],
      };
    }
    const stateVersion = stateVersionOf(parsed);
    const result = await runPython({
      python: this.#skill.python,
      script: join(this.#skill.skillPath, 'scripts', 'evidence_outcome.py'),
      args: ['decision', '--state', input.statePath, '--experiment', input.experimentId],
      timeoutMs: this.#timeoutMs,
      cwd: this.#skill.skillPath,
    });
    const record = typeof result.json === 'object' && result.json !== null && !Array.isArray(result.json)
      ? result.json as Record<string, unknown>
      : {};
    const status = record.status === 'PASS' ? 'PASS' : record.status === 'FAIL' ? 'FAIL' : 'HOLD';
    const errors = Array.isArray(record.errors)
      ? record.errors.filter((item): item is string => typeof item === 'string')
      : result.code === 0 ? [] : [`RLP decision exited ${result.code}`];
    const decision = JSON.stringify(record.decision ?? record.outcome ?? record.status ?? '');
    const proofDigest = `sha256:${createHash('sha256')
      .update(`${stateDigest}\u0000${input.experimentId}\u0000${status}\u0000${decision}`)
      .digest('hex')}`;
    if (status === 'PASS' && result.code !== 0) {
      // A non-zero exit can never be a scientific PASS.
      return { status: 'HOLD', experimentId: input.experimentId, stateVersion, stateDigest, decision, proofDigest, errors };
    }
    return { status, experimentId: input.experimentId, stateVersion, stateDigest, decision, proofDigest, errors };
  }
}

/**
 * Assert that a completion may be recorded; throws on HOLD/FAIL.
 * @param completion - verifier result.
 * @returns the completion when PASS.
 */
export function requireScientificPass(completion: ScientificCompletion): ScientificCompletion {
  if (completion.status !== 'PASS') {
    throw new MeshError('RLP_GATE_HOLD', 'RLP did not authorize scientific completion', {
      experimentId: completion.experimentId,
      status: completion.status,
      errors: completion.errors,
    });
  }
  return completion;
}
