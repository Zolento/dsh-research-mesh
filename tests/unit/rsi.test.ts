/** RSI adapter: discovery, read-only validators, receipt preview and consume proof. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeConfig, makeTempProject } from '../helpers/env.ts';
import { buildRsiFixture } from '../helpers/rsi.ts';
import { MeshError } from '../../src/errors.ts';
import { sha256Text } from '../../src/util/hash.ts';
import { canonicalJson } from '../../src/util/canonical-json.ts';
import { discoverRsiSkill } from '../../src/rsi/adapter.ts';
import { RsiAdapter } from '../../src/rsi/adapter.ts';
import { createLogger } from '../../src/util/logger.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';

function adapterFor(projectRoot: string, allowTestStub = true): RsiAdapter {
  const config = makeConfig({ root: projectRoot, source: join(projectRoot, 'source'), fakeRemote: join(projectRoot, 'fake'), conda: '/bin/true', commit: '', cleanup: () => {} }, {
    rsi: { enabled: true, skillPath: SKILL, allowTestStub, pythonExecutable: 'python3' },
  });
  return new RsiAdapter(config, createLogger('error'));
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('discovers the installed skill and runs state_check read-only', async () => {
  const project = makeTempProject();
  try {
    const fixture = buildRsiFixture(project.root, SKILL, false);
    const adapter = adapterFor(project.root);
    const discovery = adapter.discover();
    assert.equal(discovery.available, true);
    assert.equal(discovery.files['scripts/state_check.py'], true);
    const state = adapter.readState(join(project.root, '.research-lifecycle-protocol', 'routes', 'A', 'research-state.json'));
    assert.equal(state.version, fixture.stateVersion);
    const check = await adapter.checkState(state.path);
    assert.equal(check.ok, true, JSON.stringify(check.raw.stdout).slice(0, 1000));
    const scheduler = await adapter.checkScheduler(state.path, fixture.scheduler);
    assert.equal(scheduler.exitCode, 0);
  } finally {
    project.cleanup();
  }
});

test('previews a real RSI receipt without consuming budget or changing state', async () => {
  const project = makeTempProject();
  try {
    const fixture = buildRsiFixture(project.root, SKILL, false);
    const adapter = adapterFor(project.root);
    const before = digest(fixture.state);
    const authorization = await adapter.verifyPreview({
      projectId: 'proj-a',
      routeId: 'A',
      experimentId: 'X1',
      statePath: fixture.state,
      manifestPath: fixture.manifest,
      schedulerPath: fixture.scheduler,
      receiptPath: fixture.receipt,
      ledgerPath: fixture.ledger,
    });
    assert.equal(authorization.mode, 'test-stub');
    assert.equal(authorization.experimentId, 'X1');
    assert.equal(authorization.stateVersion, fixture.stateVersion);
    assert.equal(digest(fixture.state), before);
  } finally {
    project.cleanup();
  }
});

test('verifies a genuinely consumed receipt through the ledger', async () => {
  const project = makeTempProject();
  try {
    const fixture = buildRsiFixture(project.root, SKILL, true);
    assert.equal(fixture.consumed, 'PASS');
    const adapter = adapterFor(project.root);
    const authorization = adapter.verifyConsumed({
      projectId: 'proj-a',
      routeId: 'A',
      experimentId: 'X1',
      statePath: fixture.state,
      manifestPath: fixture.manifest,
      schedulerPath: fixture.scheduler,
      receiptPath: fixture.receipt,
      ledgerPath: fixture.ledger,
    });
    assert.equal(authorization.mode, 'rsi-receipt');
    assert.equal(authorization.verifiedBy, 'rsi.execution-ledger.consume');
    assert.ok(authorization.consumedLedgerEventSeal !== undefined);
  } finally {
    project.cleanup();
  }
});

test('rejects a receipt after canonical state changes', async () => {
  const project = makeTempProject();
  try {
    const fixture = buildRsiFixture(project.root, SKILL, true);
    const adapter = adapterFor(project.root);
    const state = JSON.parse(readFileSync(fixture.state, 'utf8')) as Record<string, unknown>;
    state.state_version = Number(state.state_version) + 1;
    writeFileSync(fixture.state, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(
      () => adapter.verifyConsumed({
        projectId: 'proj-a',
        routeId: 'A',
        experimentId: 'X1',
        statePath: fixture.state,
        manifestPath: fixture.manifest,
        schedulerPath: fixture.scheduler,
        receiptPath: fixture.receipt,
        ledgerPath: fixture.ledger,
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_STATE_CHANGED',
    );
  } finally {
    project.cleanup();
  }
});

test('preview is forbidden unless the test stub flag is explicit', async () => {
  const project = makeTempProject();
  try {
    const fixture = buildRsiFixture(project.root, SKILL, false);
    const adapter = adapterFor(project.root, false);
    await assert.rejects(
      () => adapter.verifyPreview({
        projectId: 'proj-a',
        routeId: 'A',
        experimentId: 'X1',
        statePath: fixture.state,
        manifestPath: fixture.manifest,
        schedulerPath: fixture.scheduler,
        receiptPath: fixture.receipt,
        ledgerPath: fixture.ledger,
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_TEST_STUB_FORBIDDEN',
    );
  } finally {
    project.cleanup();
  }
});

test('the receipt digest is computed by RLP, not by a local re-serialisation', () => {
  // RLP seals receipts with Python's json.dumps float formatting (`1e-09`);
  // JavaScript would write `1e-9` and produce a different sha256. The adapter
  // must therefore obtain the digest from the skill itself.
  const value = { lr: 1e-9, nested: { a: [1.5e-7, 2] }, text: 'x' };
  const skill = discoverRsiSkill(SKILL);
  const python = process.env.RLP_PYTHON ?? 'python3';
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(SKILL, 'scripts'))})`,
    'import evidence_outcome as eo',
    'print(eo.digest(json.load(sys.stdin)))',
  ].join('\n');
  const expected = (execFileSync(python, ['-c', script], { input: JSON.stringify(value), encoding: 'utf8' })).trim();
  const local = (() => {
    const plain = JSON.parse(JSON.stringify(value));
    return sha256Text(canonicalJson(plain as never));
  })();
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.notEqual(expected, local, 'the two serialisations must be shown to differ for 1e-9');
  assert.equal(skill.available, true);
});
