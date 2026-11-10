/**
 * RLP skill discovery.
 *
 * Discovery is explicit and fail-closed: an installation is usable only when
 * its frontmatter says `research-lifecycle-protocol`, its version is in the
 * supported range, and every required script/reference exists. A stale
 * `rsi-pipeline` install is never selected implicitly; a legacy path is used
 * only when the operator points the configuration at it on purpose.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MeshError } from '../errors.ts';
import type { RlpSkill } from './types.ts';

/** Skill name a usable installation must declare. */
export const RLP_SKILL_NAME = 'research-lifecycle-protocol';
/** Oldest accepted protocol version. */
export const RLP_MIN_VERSION = '2.2.0';
/** Newest excluded major. */
export const RLP_MAX_MAJOR = 3;

/** Files an installation must provide for Mesh integration. */
export const RLP_REQUIRED_FILES: readonly string[] = [
  'SKILL.md',
  'shared-contract.md',
  'preset-registry.json',
  'scripts/rlp_paths.py',
  'scripts/context_planner.py',
  'scripts/context_packet.py',
  'scripts/subagent_context.py',
  'scripts/preset_router.py',
  'scripts/experiment_execute.py',
  'scripts/evidence_outcome.py',
  'scripts/operational_reconcile.py',
  'schemas/execution-manifest.schema.json',
  'references/subagent-context.md',
];

/** Default install locations, in priority order (no legacy path). */
export function defaultRlpCandidates(home = process.env.HOME ?? homedir()): readonly string[] {
  return [join(home, '.agents', 'skills', 'research-lifecycle-protocol')];
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const meta: Record<string, unknown> = {};
  let nested: Record<string, unknown> | null = null;
  for (const line of block.split('\n')) {
    const indented = /^\s{2,}(\S[^:]*):\s*(.*)$/.exec(line);
    if (indented !== null && nested !== null) {
      nested[indented[1].trim()] = indented[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const top = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (top === null) continue;
    const key = top[1];
    const value = top[2].trim();
    if (value === '') {
      nested = {};
      meta[key] = nested;
    } else {
      nested = null;
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split(/[.+-]/).slice(0, 3).map(part => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function digestOf(files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    if (!existsSync(file)) continue;
    hash.update(file);
    hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Inspect one candidate path without asserting it is usable.
 * @param skillPath - absolute candidate.
 * @param python - interpreter used for its scripts.
 * @returns the discovered skill; `compatible` is false with a reason when unusable.
 */
export function inspectRlpSkill(skillPath: string, python = 'python3'): RlpSkill {
  const root = resolve(skillPath);
  const stat = statSync(root, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    return {
      skillPath: root, name: '', version: '', legacyName: null, digest: '', files: {},
      compatible: false, reason: 'skill path is not a directory', python,
    };
  }
  const files: Record<string, boolean> = {};
  for (const relative of RLP_REQUIRED_FILES) files[relative] = existsSync(join(root, relative));
  const skillFile = join(root, 'SKILL.md');
  if (files['SKILL.md'] !== true) {
    return {
      skillPath: root, name: '', version: '', legacyName: null,
      digest: '', files, compatible: false, reason: 'SKILL.md is missing', python,
    };
  }
  const frontmatter = parseFrontmatter(readFileSync(skillFile, 'utf8'));
  const metadata = typeof frontmatter.metadata === 'object' && frontmatter.metadata !== null
    ? frontmatter.metadata as Record<string, unknown>
    : (frontmatter.metadata as Record<string, unknown> | undefined) ?? {};
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : '';
  const version = metadata.version !== undefined ? String(metadata.version) : '';
  const legacyName = metadata['legacy-name'] !== undefined ? String(metadata['legacy-name']) : null;
  const digest = digestOf([join(root, 'SKILL.md'), join(root, 'shared-contract.md'), join(root, 'preset-registry.json')]);
  const missing = RLP_REQUIRED_FILES.filter(relative => files[relative] !== true);
  let reason: string | null = null;
  if (name !== RLP_SKILL_NAME) reason = `frontmatter name is ${name === '' ? 'missing' : name}`;
  else if (version === '') reason = 'metadata.version is missing';
  else if (compareVersions(version, RLP_MIN_VERSION) < 0) reason = `version ${version} is older than ${RLP_MIN_VERSION}`;
  else if (compareVersions(version, `${RLP_MAX_MAJOR}.0.0`) >= 0) reason = `version ${version} is outside the supported major`;
  else if (missing.length > 0) reason = `missing required files: ${missing.join(', ')}`;
  return {
    skillPath: root, name, version, legacyName, digest, files,
    compatible: reason === null, reason, python,
  };
}

/** Discovery options; tests inject a home directory or an explicit path. */
export interface RlpDiscoveryOptions {
  /** Explicit path from configuration; wins over every candidate. */
  readonly skillPath?: string;
  /** Environment override, primarily for tests and isolated profiles. */
  readonly envPath?: string;
  /** Home directory used for the default candidate. */
  readonly home?: string;
  /** Python interpreter for the skill scripts. */
  readonly python?: string;
}

/**
 * Discover a usable RLP installation.
 * @param options - explicit path, env override and interpreter.
 * @returns the first compatible installation.
 * @throws MeshError `RLP_UNAVAILABLE` or `RLP_VERSION_UNSUPPORTED` when none is usable.
 */
export function discoverRlpSkill(options: RlpDiscoveryOptions = {}): RlpSkill {
  const python = options.python ?? process.env.RLP_PYTHON ?? 'python3';
  const explicit = options.skillPath ?? options.envPath;
  if (explicit !== undefined && explicit.trim() !== '') {
    const skill = inspectRlpSkill(explicit, python);
    if (!skill.compatible) {
      throw new MeshError('RLP_VERSION_UNSUPPORTED', `configured RLP skill is not usable: ${skill.reason}`, {
        skillPath: skill.skillPath, reason: skill.reason, version: skill.version,
      });
    }
    return skill;
  }
  const attempts: { path: string; reason: string }[] = [];
  for (const candidate of defaultRlpCandidates(options.home)) {
    const skill = inspectRlpSkill(candidate, python);
    if (skill.compatible) return skill;
    attempts.push({ path: candidate, reason: skill.reason ?? 'unusable' });
  }
  throw new MeshError('RLP_UNAVAILABLE', 'no compatible research-lifecycle-protocol installation was found', { attempts });
}
