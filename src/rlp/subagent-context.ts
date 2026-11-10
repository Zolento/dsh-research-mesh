/**
 * RLP subagent context and permission adapter.
 *
 * Each research role gets its own minimal task contract from
 * `subagent_context.py`. Mesh enforces the mechanical part of the contract:
 * a child's permission bits must be a subset of its parent's, an experiment
 * role must carry a manifest and an approval flag, and a blocked contract
 * cannot start work.
 */

import { join } from 'node:path';
import { MeshError } from '../errors.ts';
import { runPython } from './python.ts';
import type { RlpPermits, RlpSkill, RlpSubagentContract } from './types.ts';

/** Roles the RLP runtime supports for Mesh members. */
export const RLP_SUBAGENT_ROLES = ['literature', 'theory', 'experiment', 'assurance', 'discovery'] as const;
/** One supported role. */
export type RlpSubagentRole = typeof RLP_SUBAGENT_ROLES[number];

/** Build input for one subagent contract. */
export interface RlpSubagentInput {
  readonly role: RlpSubagentRole;
  readonly task: string;
  readonly authorization?: string;
  readonly stage?: string;
}

interface ContractJson {
  schema?: unknown;
  role?: unknown;
  purpose?: unknown;
  task?: unknown;
  authorization?: unknown;
  permits?: unknown;
  parent_permits?: unknown;
  manifest_required?: unknown;
  approval_required?: unknown;
  may_write?: unknown;
  text?: unknown;
  can_proceed?: unknown;
  status?: unknown;
}

function permitsOf(raw: unknown, field: string): RlpPermits {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MeshError('RLP_INVALID', `subagent contract lacks ${field}`, { field });
  }
  const record = raw as Record<string, unknown>;
  return {
    writeCanonical: record.write_canonical === true,
    modifyAnchor: record.modify_anchor === true,
    executeExperiment: record.execute_experiment === true,
    writeArtifacts: record.write_artifacts === true,
  };
}

/** RLP subagent contract adapter. */
export class RlpSubagentContext {
  readonly #skill: RlpSkill;
  readonly #timeoutMs: number;

  /**
   * @param skill - discovered RLP skill.
   * @param timeoutMs - per-invocation timeout.
   */
  constructor(skill: RlpSkill, timeoutMs = 20_000) {
    this.#skill = skill;
    this.#timeoutMs = timeoutMs;
  }

  /** Supported roles. */
  roles(): readonly RlpSubagentRole[] {
    return RLP_SUBAGENT_ROLES;
  }

  /**
   * Build one role's minimal context.
   * @param input - role, task and optional authorization/stage.
   * @returns normalized contract.
   */
  async build(input: RlpSubagentInput): Promise<RlpSubagentContract> {
    const args = ['build', '--role', input.role, '--task', input.task, '--json'];
    if (input.authorization !== undefined) args.push('--authorization', input.authorization);
    if (input.stage !== undefined) args.push('--stage', input.stage);
    const result = await runPython({
      python: this.#skill.python,
      script: join(this.#skill.skillPath, 'scripts', 'subagent_context.py'),
      args,
      timeoutMs: this.#timeoutMs,
      cwd: this.#skill.skillPath,
    });
    if (typeof result.json !== 'object' || result.json === null || Array.isArray(result.json)) {
      throw new MeshError('RLP_INVALID', 'subagent context script did not return a JSON object', {
        exitCode: result.code, stderr: result.stderr.slice(0, 2000),
      });
    }
    const record = result.json as ContractJson;
    if (typeof record.schema !== 'string' || !record.schema.startsWith('research-idea-pipeline/subagent-contract@')) {
      throw new MeshError('RLP_INVALID', 'unexpected subagent contract schema', { schema: record.schema });
    }
    const body = typeof record.text === 'string' ? record.text : '';
    if (body === '') throw new MeshError('RLP_INVALID', 'subagent contract has no context text');
    const permits = permitsOf(record.permits, 'permits');
    const parentPermits = permitsOf(record.parent_permits, 'parent_permits');
    this.assertSubset(parentPermits, permits, String(record.role ?? input.role));
    const contract: RlpSubagentContract = {
      schema: record.schema,
      role: String(record.role ?? input.role),
      purpose: typeof record.purpose === 'string' ? record.purpose : '',
      task: typeof record.task === 'string' ? record.task : input.task,
      authorization: typeof record.authorization === 'string' ? record.authorization : 'read_only',
      permits,
      parentPermits,
      manifestRequired: record.manifest_required === true,
      approvalRequired: record.approval_required === true,
      mayWrite: Array.isArray(record.may_write) ? record.may_write.filter((item): item is string => typeof item === 'string') : [],
      text: body,
      canProceed: record.can_proceed === true,
      status: record.status === 'PASS' || record.status === 'BLOCKED' || record.status === 'FAIL' ? record.status : 'FAIL',
    };
    return contract;
  }

  /**
   * Throwing form of {@link build}: a blocked or escalating contract stops work.
   * @param input - role, task and optional authorization/stage.
   * @returns the usable contract.
   */
  async buildOrThrow(input: RlpSubagentInput): Promise<RlpSubagentContract> {
    const contract = await this.build(input);
    if (!contract.canProceed || contract.status !== 'PASS') {
      throw new MeshError('RLP_CONTEXT_BLOCKED', `RLP blocked the ${input.role} subagent contract`, {
        role: input.role, status: contract.status,
      });
    }
    if (contract.role === 'experiment' && (!contract.manifestRequired || !contract.approvalRequired)) {
      throw new MeshError('RLP_GATE_HOLD', 'experiment role must require a manifest and approval', {
        manifestRequired: contract.manifestRequired, approvalRequired: contract.approvalRequired,
      });
    }
    return contract;
  }

  /**
   * Prove that a child's permissions never exceed its parent's.
   * @param parent - parent (captain/control) permits.
   * @param child - child permits.
   * @param role - role name for diagnostics.
   */
  assertSubset(parent: RlpPermits, child: RlpPermits, role: string): void {
    const bits: readonly (keyof RlpPermits)[] = ['writeCanonical', 'modifyAnchor', 'executeExperiment', 'writeArtifacts'];
    const escalated = bits.filter(bit => child[bit] && !parent[bit]);
    if (escalated.length > 0) {
      throw new MeshError('RLP_PERMISSION_ESCALATION', `role ${role} would exceed its parent's permissions`, {
        role, escalated,
      });
    }
  }
}
