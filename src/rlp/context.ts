/**
 * RLP context adapter (L0 / L1 / L2).
 *
 * Mesh never copies the protocol into a prompt. It calls
 * `context_planner.py load` for the exact documents a task needs and
 * `context_packet.py` for a verified, non-canonical research digest.
 *
 * Invariants enforced here:
 * - `loaded` means the body text was actually read; a path-only entry is invalid;
 * - `referenced` is reported separately and never counted as loaded;
 * - `blocked_missing` makes the plan unusable (`RLP_CONTEXT_BLOCKED`);
 * - a stale packet is reported as `STALE`, never silently reused;
 * - a packet is never canonical state.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshError } from '../errors.ts';
import { runPython } from './python.ts';
import type { RlpContextPacket, RlpContextPlan, RlpLoadedDocument, RlpSkill } from './types.ts';

/** Input for one context plan/load. */
export interface RlpContextInput {
  /** Semantic entry, e.g. `continue-research` or `audit`. */
  readonly entry?: string;
  /** Preset id selected by the caller; at most one is loaded. */
  readonly preset?: string;
  /** RLP stage hint (R0–R14), advisory to the planner only. */
  readonly stage?: string;
  /** `read_only`, `plan_only`, `execute`; RLP applies its own policy. */
  readonly authorization?: string;
  /** Domain profile, e.g. `mri-reconstruction`. */
  readonly domain?: string;
  /** Known blocking signal for the planner. */
  readonly blocker?: string;
}

/** Input for a research context packet. */
export interface RlpPacketInput {
  readonly statePath: string;
  readonly route: string;
  readonly task: 'continue_method' | 'review_paper' | 'audit_evidence' | 'discover' | 'inspect';
  readonly authorization?: string;
  readonly domain?: string;
  readonly budget?: number;
}

interface PlanJson {
  schema?: unknown;
  skill_version?: unknown;
  entry?: unknown;
  preset_id?: unknown;
  stage?: unknown;
  authorization?: unknown;
  domain?: unknown;
  status?: unknown;
  plan_digest?: unknown;
  can_proceed?: unknown;
  loaded?: unknown;
  referenced?: unknown;
  blocked_missing?: unknown;
  problems?: unknown;
  loaded_chars?: unknown;
  budget?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function normalizeLoaded(raw: unknown): RlpLoadedDocument[] {
  if (!Array.isArray(raw)) return [];
  const loaded: RlpLoadedDocument[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = text(record.path);
    const body = text(record.text);
    if (path === null || body === null) {
      throw new MeshError('RLP_INVALID', 'context planner reported a loaded document without its body', {
        path, hasText: body !== null,
      });
    }
    loaded.push({
      path,
      layer: text(record.layer) ?? 'L1',
      chars: typeof record.chars === 'number' ? record.chars : body.length,
      digest: text(record.digest) ?? '',
      text: body,
    });
  }
  return loaded;
}

function normalizePlan(json: unknown): RlpContextPlan {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new MeshError('RLP_INVALID', 'context planner did not return a JSON object');
  }
  const record = json as PlanJson;
  if (typeof record.schema !== 'string' || !record.schema.startsWith('research-idea-pipeline/context-plan@')) {
    throw new MeshError('RLP_INVALID', 'unexpected context plan schema', { schema: record.schema });
  }
  const loaded = normalizeLoaded(record.loaded);
  const referenced = Array.isArray(record.referenced)
    ? record.referenced.flatMap(item => {
      if (typeof item === 'string') return [item];
      if (typeof item === 'object' && item !== null) {
        const path = (item as Record<string, unknown>).path;
        return typeof path === 'string' ? [path] : [];
      }
      return [];
    })
    : [];
  const blockedMissing = Array.isArray(record.blocked_missing)
    ? record.blocked_missing.filter((item): item is string => typeof item === 'string')
    : [];
  const problems = Array.isArray(record.problems)
    ? record.problems.map(item => typeof item === 'string' ? item : JSON.stringify(item))
    : [];
  const status = record.status === 'PASS' || record.status === 'BLOCKED' || record.status === 'FAIL'
    ? record.status
    : 'FAIL';
  const plan: RlpContextPlan = {
    schema: record.schema,
    skillVersion: text(record.skill_version) ?? '',
    entry: text(record.entry),
    presetId: text(record.preset_id),
    stage: text(record.stage),
    authorization: text(record.authorization) ?? 'read_only',
    domain: text(record.domain),
    status,
    planDigest: text(record.plan_digest) ?? '',
    canProceed: record.can_proceed === true && blockedMissing.length === 0,
    loaded,
    referenced,
    blockedMissing,
    problems,
    loadedChars: typeof record.loaded_chars === 'number' ? record.loaded_chars : loaded.reduce((total, doc) => total + doc.text.length, 0),
    budget: typeof record.budget === 'object' && record.budget !== null
      ? record.budget as Record<string, unknown>
      : {},
  };
  if (plan.loaded.length === 0 && plan.canProceed) {
    throw new MeshError('RLP_INVALID', 'context plan says it can proceed but loaded no document body');
  }
  return plan;
}

interface PacketJson {
  schema?: unknown;
  route?: unknown;
  task?: unknown;
  state_version?: unknown;
  canonical_digest?: unknown;
  is_canonical_state?: unknown;
  stale?: unknown;
  stale_reasons?: unknown;
  status?: unknown;
}

function normalizePacket(json: unknown, packetPath: string, stale: boolean, staleReasons: readonly string[]): RlpContextPacket {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new MeshError('RLP_PACKET_INVALID', 'context packet script did not return a JSON object');
  }
  const verifyRecord = json as PacketJson;
  const raw = readFileSync(packetPath);
  let packetRecord: PacketJson = {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) packetRecord = parsed as PacketJson;
  } catch {
    throw new MeshError('RLP_PACKET_INVALID', 'context packet file is not valid JSON', { packetPath });
  }
  if (packetRecord.is_canonical_state !== false) {
    throw new MeshError('RLP_PACKET_INVALID', 'context packet must never claim canonical-state status');
  }
  const packetDigest = createHash('sha256').update(raw).digest('hex');
  return {
    schema: text(packetRecord.schema) ?? text(verifyRecord.schema) ?? '',
    route: text(packetRecord.route) ?? text(verifyRecord.route) ?? '',
    task: text(packetRecord.task) ?? text(verifyRecord.task) ?? '',
    stateVersion: typeof packetRecord.state_version === 'number'
      ? String(packetRecord.state_version)
      : text(packetRecord.state_version) ?? (typeof verifyRecord.state_version === 'number' ? String(verifyRecord.state_version) : text(verifyRecord.state_version)),
    canonicalDigest: text(packetRecord.canonical_digest) ?? text(verifyRecord.canonical_digest) ?? '',
    packetDigest,
    isCanonicalState: false,
    stale,
    staleReasons,
    packetPath,
    status: stale ? 'STALE' : (verifyRecord.status === 'FAIL' ? 'FAIL' : 'PASS'),
  };
}

/** Adapter over one discovered RLP installation. */
export class RlpContextAdapter {
  readonly #skill: RlpSkill;
  readonly #timeoutMs: number;

  /**
   * @param skill - discovered RLP skill.
   * @param timeoutMs - per-invocation timeout.
   */
  constructor(skill: RlpSkill, timeoutMs = 30_000) {
    this.#skill = skill;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Ask the planner what this task must load and read the required bodies.
   * @param input - entry/preset/stage/authorization/domain.
   * @returns normalized plan.
   */
  async load(input: RlpContextInput = {}): Promise<RlpContextPlan> {
    const args = ['load', '--json', '--root', this.#skill.skillPath];
    if (input.preset !== undefined) args.push('--preset', input.preset);
    if (input.entry !== undefined) args.push('--entry', input.entry);
    if (input.stage !== undefined) args.push('--stage', input.stage);
    if (input.authorization !== undefined) args.push('--authorization', input.authorization);
    if (input.domain !== undefined) args.push('--domain', input.domain);
    if (input.blocker !== undefined) args.push('--blocker', input.blocker);
    const result = await runPython({
      python: this.#skill.python,
      script: join(this.#skill.skillPath, 'scripts', 'context_planner.py'),
      args,
      timeoutMs: this.#timeoutMs,
      cwd: this.#skill.skillPath,
    });
    if (result.timedOut) throw new MeshError('RLP_UNAVAILABLE', 'context planner timed out', { timeoutMs: this.#timeoutMs });
    if (result.json === undefined) {
      // A failed plan is a gate, not an internal fault: report the planner's own
      // reason so the caller can show what is missing instead of guessing.
      throw new MeshError('RLP_CONTEXT_BLOCKED', 'RLP context planner could not produce a plan', {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 2000),
        args: [input.preset ?? input.entry ?? 'default'],
      });
    }
    return normalizePlan(result.json);
  }

  /**
   * Throw unless the plan is complete enough to continue.
   * @param plan - normalized plan.
   * @returns the plan when usable.
   */
  assertProceed(plan: RlpContextPlan): RlpContextPlan {
    if (!plan.canProceed) {
      throw new MeshError('RLP_CONTEXT_BLOCKED', 'required RLP context is missing or the plan failed', {
        status: plan.status,
        blockedMissing: plan.blockedMissing,
        problems: plan.problems,
        planDigest: plan.planDigest,
      });
    }
    return plan;
  }

  /**
   * Build and verify a research context packet for one state version.
   * @param input - state path, route, task and optional budget.
   * @returns verified packet metadata; `status` is `STALE` when state moved.
   */
  async buildPacket(input: RlpPacketInput): Promise<RlpContextPacket> {
    const outDir = mkdtempSync(join(tmpdir(), 'mesh-rlp-packet-'));
    const packetPath = join(outDir, `packet-${input.task}.json`);
    const args = [
      'build', '--state', input.statePath, '--route', input.route, '--task', input.task,
      '--json', '--out', packetPath, '--root', this.#skill.skillPath,
    ];
    if (input.authorization !== undefined) args.push('--authorization', input.authorization);
    if (input.domain !== undefined) args.push('--domain', input.domain);
    if (input.budget !== undefined) args.push('--budget', String(input.budget));
    const build = await runPython({
      python: this.#skill.python,
      script: join(this.#skill.skillPath, 'scripts', 'context_packet.py'),
      args,
      timeoutMs: this.#timeoutMs,
      cwd: this.#skill.skillPath,
    });
    if (build.code !== 0) {
      throw new MeshError('RLP_PACKET_INVALID', 'context packet build failed', {
        exitCode: build.code, stderr: build.stderr.slice(0, 2000),
      });
    }
    const verified = await this.verifyPacket({ packetPath, statePath: input.statePath });
    if (verified.status === 'STALE') {
      throw new MeshError('RLP_CONTEXT_STALE', 'research context packet is stale; rebuild before continuing', {
        reasons: verified.staleReasons,
      });
    }
    return verified;
  }

  /**
   * Verify an existing packet against current state.
   * @param input - packet path and canonical state path.
   * @returns normalized verification result.
   */
  async verifyPacket(input: { packetPath: string; statePath: string }): Promise<RlpContextPacket> {
    const result = await runPython({
      python: this.#skill.python,
      script: join(this.#skill.skillPath, 'scripts', 'context_packet.py'),
      args: ['verify', '--packet', input.packetPath, '--state', input.statePath, '--json', '--root', this.#skill.skillPath],
      timeoutMs: this.#timeoutMs,
      cwd: this.#skill.skillPath,
    });
    const record = typeof result.json === 'object' && result.json !== null && !Array.isArray(result.json)
      ? result.json as PacketJson
      : {};
    const stale = record.stale === true || result.code === 4;
    const reasons = Array.isArray(record.stale_reasons)
      ? record.stale_reasons.filter((item): item is string => typeof item === 'string')
      : [];
    return normalizePacket(result.json, input.packetPath, stale, reasons);
  }
}
