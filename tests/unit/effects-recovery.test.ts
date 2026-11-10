/** P1 effect claims: crashes, leases, double workers and reconcile-only parking. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTeamStore } from '../../src/bridge/runtime/persistence.ts';
import { AutonomyStore } from '../../src/autonomy/store.ts';
import { EffectsRunner } from '../../src/autonomy/effects.ts';

function makeStore(): { store: AutonomyStore; close(): void; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-eff-'));
  const teamStore = openTeamStore({ path: join(dir, 'db.sqlite') });
  return { store: new AutonomyStore(teamStore), close: () => teamStore.close(), dir };
}

function expiredClaim(store: AutonomyStore, effectId: string): void {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(store.claimEffect(effectId, 'dead-owner', 1_000, past), true);
}

test('an expired claim before the handler runs is replayed exactly once', async () => {
  const { store, close, dir } = makeStore();
  try {
    let runs = 0;
    const first = new EffectsRunner(store);
    first.register('safe-work', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    first.enqueue('safe-work', 'k1', {});
    const row = first.list()[0];
    assert.ok(row);
    expiredClaim(store, row.effectId);

    const second = new EffectsRunner(store);
    second.register('safe-work', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    const tick = await second.tick();
    assert.equal(tick.recovered, 1);
    assert.equal(runs, 1);
    assert.equal(second.list()[0]?.status, 'succeeded');
    // A second restart sees nothing to replay.
    const third = new EffectsRunner(store);
    third.register('safe-work', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    await third.tick();
    assert.equal(runs, 1);
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an expired claim on an external side effect is parked, never replayed', async () => {
  const { store, close, dir } = makeStore();
  try {
    let runs = 0;
    const first = new EffectsRunner(store);
    first.register('remote-submit', { retry: 'reconcile-only', run: async () => { runs += 1; return 'done'; } });
    first.enqueue('remote-submit', 'job-1', {});
    const row = first.list()[0];
    assert.ok(row);
    expiredClaim(store, row.effectId);

    const second = new EffectsRunner(store);
    second.register('remote-submit', { retry: 'reconcile-only', run: async () => { runs += 1; return 'done'; } });
    const tick = await second.tick();
    assert.equal(tick.recovered, 1);
    assert.equal(runs, 0, 'an unknown remote outcome must not be re-executed');
    const parked = second.list()[0];
    assert.equal(parked?.status, 'failed');
    assert.match(parked?.lastError ?? '', /RECONCILE_REQUIRED/);
    await second.tick();
    assert.equal(second.list()[0]?.status, 'failed');
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two workers ticking at once run an effect once', async () => {
  const { store, close, dir } = makeStore();
  try {
    let runs = 0;
    const a = new EffectsRunner(store, { owner: 'worker-a' });
    const b = new EffectsRunner(store, { owner: 'worker-b' });
    for (const runner of [a, b]) {
      runner.register('safe-work', { retry: 'safe', run: async () => { runs += 1; await new Promise(r => setTimeout(r, 10)); return 'done'; } });
    }
    a.enqueue('safe-work', 'k1', {});
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(runs, 1);
    assert.equal(a.list()[0]?.status, 'succeeded');
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a handler that fails normally is retried with backoff, not recovered twice', async () => {
  const { store, close, dir } = makeStore();
  try {
    let now = Date.now();
    let runs = 0;
    const runner = new EffectsRunner(store, { now: () => now, baseDelayMs: 100, maxAttempts: 2 });
    runner.register('safe-work', { retry: 'safe', run: async () => { runs += 1; throw new Error('boom'); } });
    runner.enqueue('safe-work', 'k1', {});
    now += 10_000;
    await runner.tick();
    let row = runner.list()[0];
    assert.equal(row?.status, 'pending');
    assert.equal(row?.attempts, 1);
    now += 10_000;
    await runner.tick();
    row = runner.list()[0];
    assert.equal(row?.status, 'dead');
    assert.equal(runs, 2);
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a second restart after an expired claim does not duplicate the effect', async () => {
  const { store, close, dir } = makeStore();
  try {
    let runs = 0;
    const first = new EffectsRunner(store);
    first.register('safe-work', { retry: 'safe', run: async () => { runs += 1; throw new Error('crash'); } });
    first.enqueue('safe-work', 'k1', {});
    const row = first.list()[0];
    assert.ok(row);
    expiredClaim(store, row.effectId);

    const second = new EffectsRunner(store);
    second.register('safe-work', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    await second.tick();
    assert.equal(runs, 1);
    const third = new EffectsRunner(store);
    third.register('safe-work', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    await third.tick();
    assert.equal(runs, 1);
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});
