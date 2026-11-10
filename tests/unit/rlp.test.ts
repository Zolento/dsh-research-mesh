/** RLP v2.2.0 adapter: discovery, storage matrix, context and subagent contracts. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RlpRuntime,
  discoverRlpSkill,
  inspectRlpSkill,
  RlpStorageResolver,
} from '../../src/rlp/index.ts';
import type { MeshError } from '../../src/errors.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';
const AVAILABLE = existsSync(join(SKILL, 'scripts', 'rlp_paths.py'));
const opts = { skip: AVAILABLE ? false : `RLP v2.2.0 skill not installed at ${SKILL}` };

function tempProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mesh-rlp-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedReady(root: string, version = 1): string {
  const dir = join(root, '.research-lifecycle-protocol', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  const state = join(dir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), state);
  const parsed = JSON.parse(JSON.stringify({ ok: true }));
  void parsed;
  writeFileSync(state, JSON.stringify({ schema: 'research-idea-pipeline/research-state@1', state_version: version, contract: { goal: 'g' }, experiments: [], uncertainties: [] }));
  return state;
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as MeshError).code; }
  return 'NO_ERROR';
}

test('discovers the installed RLP v2.2.0 skill and records its digest', opts, () => {
  const skill = discoverRlpSkill({ skillPath: SKILL });
  assert.equal(skill.name, 'research-lifecycle-protocol');
  assert.match(skill.version, /^2\./);
  assert.equal(skill.compatible, true);
  assert.match(skill.digest, /^[a-f0-9]{16}$/);
  assert.equal(skill.files['scripts/context_planner.py'], true);
});

test('a missing or stale skill path fails closed instead of falling back', opts, () => {
  const missing = inspectRlpSkill(join(tmpdir(), 'no-such-rlp-skill'));
  assert.equal(missing.compatible, false);
  assert.match(missing.reason ?? '', /not a directory/);
  assert.throws(() => discoverRlpSkill({ skillPath: join(tmpdir(), 'no-such-rlp-skill') }), /not usable/);
  // The legacy skill name is not an implicit fallback.
  const legacy = inspectRlpSkill('/home/lenovo/.agents/skills/rsi-pipeline');
  assert.equal(legacy.compatible, false);
});

test('storage matrix: NEW_PROJECT, READY, legacy and ambiguous roots', opts, async () => {
  const runtime = RlpRuntime.create({ skillPath: SKILL });
  const resolver = runtime.storage();
  const empty = tempProject();
  const legacy = tempProject();
  const both = tempProject();
  const broken = tempProject();
  try {
    assert.equal((await resolver.resolve(empty.root)).status, 'NEW_PROJECT');

    seedReady(both.root);
    mkdirSync(join(both.root, '.research-idea-pipeline'), { recursive: true });
    assert.equal((await resolver.resolve(both.root)).status, 'AMBIGUOUS_STORAGE_ROOT');

    mkdirSync(join(legacy.root, '.research-idea-pipeline', 'routes', 'A'), { recursive: true });
    writeFileSync(join(legacy.root, '.research-idea-pipeline', 'routes', 'A', 'research-state.json'), JSON.stringify({ state_version: 3 }));
    const legacyResolution = await resolver.resolve(legacy.root);
    assert.equal(legacyResolution.status, 'MIGRATION_REQUIRED');
    assert.equal(legacyResolution.formalRunAllowed, false);
    assert.equal(codeOf(() => resolver.assertFormalRun(legacyResolution)), 'RLP_MIGRATION_REQUIRED');

    // A new root is READY only when it carries recognized control content.
    seedReady(broken.root);
    const ready = await resolver.resolve(broken.root);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.formalRunAllowed, true);
    resolver.assertFormalRun(ready);
    assert.equal(resolver.statePath(ready, 'A'), join(broken.root, '.research-lifecycle-protocol', 'routes', 'A', 'research-state.json'));
  } finally {
    empty.cleanup(); legacy.cleanup(); both.cleanup(); broken.cleanup();
  }
});

test('context plan loads real bodies and keeps references separate', opts, async () => {
  const runtime = RlpRuntime.create({ skillPath: SKILL });
  const plan = await runtime.context().load({ preset: 'research-loop' });
  assert.equal(plan.canProceed, true);
  assert.equal(plan.status, 'PASS');
  const skillDoc = plan.loaded.find(doc => doc.path === 'SKILL.md');
  assert.ok(skillDoc);
  assert.ok(skillDoc.text.length > 5_000);
  assert.ok(plan.referenced.every(path => !plan.loaded.some(doc => doc.path === path)));
  const again = await runtime.context().load({ preset: 'research-loop' });
  assert.equal(again.planDigest, plan.planDigest);
});

test('an unknown preset blocks the plan instead of guessing', opts, async () => {
  const runtime = RlpRuntime.create({ skillPath: SKILL });
  await assert.rejects(
    runtime.context().load({ preset: 'no-such-preset' }),
    (error: MeshError) => error.code === 'RLP_CONTEXT_BLOCKED',
  );
});

test('a context packet is non-canonical and becomes stale when state moves', opts, async () => {
  const runtime = RlpRuntime.create({ skillPath: SKILL });
  const project = tempProject();
  try {
    const state = seedReady(project.root, 1);
    const packet = await runtime.context().buildPacket({ statePath: state, route: 'A', task: 'inspect' });
    assert.equal(packet.status, 'PASS');
    assert.equal(packet.isCanonicalState, false);
    assert.match(packet.canonicalDigest, /^sha256:/);
    writeFileSync(state, JSON.stringify({ schema: 'research-idea-pipeline/research-state@1', state_version: 2, contract: { goal: 'g' }, experiments: [], uncertainties: [] }));
    const verified = await runtime.context().verifyPacket({ packetPath: packet.packetPath, statePath: state });
    assert.equal(verified.status, 'STALE');
    assert.ok(verified.staleReasons.length > 0);
    // A rebuild reads the new state; the old packet is never silently reused.
    const rebuilt = await runtime.context().buildPacket({ statePath: state, route: 'A', task: 'inspect' });
    assert.equal(rebuilt.status, 'PASS');
    assert.notEqual(rebuilt.canonicalDigest, packet.canonicalDigest);
  } finally {
    project.cleanup();
  }
});

test('subagent contracts stay inside the parent permission envelope', opts, async () => {
  const runtime = RlpRuntime.create({ skillPath: SKILL });
  const experiment = await runtime.subagentContext().buildOrThrow({ role: 'experiment', task: 'run X1' });
  assert.equal(experiment.permits.executeExperiment, true);
  assert.equal(experiment.permits.writeCanonical, false);
  assert.equal(experiment.manifestRequired, true);
  assert.equal(experiment.approvalRequired, true);
  assert.ok(experiment.text.length > 100);

  const assurance = await runtime.subagentContext().buildOrThrow({ role: 'assurance', task: 'attack the claim' });
  assert.equal(assurance.permits.executeExperiment, false);
  assert.equal(assurance.manifestRequired, false);

  assert.throws(
    () => runtime.subagentContext().assertSubset(assurance.parentPermits, { ...assurance.permits, modifyAnchor: true }, 'assurance'),
    (error: MeshError) => error.code === 'RLP_PERMISSION_ESCALATION',
  );
});

test('the resolver is injectable and caches per project root', opts, async () => {
  const runtime = RlpRuntime.create({ skillPath: SKILL });
  const resolver = new RlpStorageResolver(runtime.skill!);
  const project = tempProject();
  try {
    seedReady(project.root);
    const first = await resolver.resolve(project.root);
    const second = await resolver.resolve(project.root);
    assert.equal(first.status, 'READY');
    assert.equal(second, first);
    resolver.invalidate(project.root);
    const third = await resolver.resolve(project.root);
    assert.notEqual(third, first);
  } finally {
    project.cleanup();
  }
});
