/** P1 policy persistence: mode survives restarts and mandates stay bound. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTeamStore } from '../../src/bridge/runtime/persistence.ts';
import { MeshStore } from '../../src/storage/mesh-store.ts';
import { AutonomyStore } from '../../src/autonomy/store.ts';
import { EffectsRunner } from '../../src/autonomy/effects.ts';
import { AutonomyEngine, DEFAULT_AUTONOMY_POLICY } from '../../src/autonomy/engine.ts';
import { humanPrincipal } from '../../src/autonomy/principal.ts';

function openEngine(path: string): { engine: AutonomyEngine; teamStore: ReturnType<typeof openTeamStore> } {
  const teamStore = openTeamStore({ path });
  const store = new AutonomyStore(teamStore);
  const engine = new AutonomyEngine({
    store,
    effects: new EffectsRunner(store),
    meshStore: new MeshStore(teamStore),
    projectStatus: () => 'active',
    rlpFormalRun: () => true,
    groupFacts: teamId => ({ teamId, projectId: 'proj-1', status: 'active' }),
  });
  return { engine, teamStore };
}

test('observe -> auto -> restart restores the persisted mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-policy-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = openEngine(path);
    assert.equal(first.engine.policy.mode, 'observe');
    const stored = first.engine.setPolicy({ ...first.engine.policy, mode: 'auto' });
    first.teamStore.close();

    const second = openEngine(path);
    assert.equal(second.engine.policy.mode, 'auto');
    assert.equal(second.engine.policy.version, stored.version);
    assert.equal(second.engine.policy.digest, stored.digest);
    second.teamStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auto -> off -> restart stops creating autonomous tickets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-policy-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = openEngine(path);
    first.engine.setPolicy({ ...first.engine.policy, mode: 'auto' });
    first.teamStore.close();

    const second = openEngine(path);
    second.engine.setPolicy({ ...second.engine.policy, mode: 'off' });
    second.teamStore.close();

    const third = openEngine(path);
    assert.equal(third.engine.policy.mode, 'off');
    const event = third.engine.receiveTrigger({
      source: 'team_task', eventId: 'task-1', projectId: 'proj-1', kind: 'team_task_completed',
      payload: { routeId: 'A', title: 'autonomous work' },
    });
    assert.equal(event.disposition, 'ignored');
    assert.equal(third.engine.listTickets('proj-1').length, 0);
    third.teamStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a revoked mandate stays revoked across a restart and policy change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-policy-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = openEngine(path);
    const ticket = first.engine.receiveTrigger({
      source: 'user', eventId: 'evt-1', projectId: 'proj-1', kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'work' },
    }, humanPrincipal('alice')).ticket;
    assert.ok(ticket);
    first.engine.stopTicket(ticket.ticketId, 'alice', 'stop', humanPrincipal('alice'));
    first.engine.setPolicy({ ...first.engine.policy, mode: 'auto' });
    first.teamStore.close();

    const second = openEngine(path);
    try {
      second.engine.resumeTicket(ticket.ticketId, { explicit: true }, humanPrincipal('alice'));
      assert.fail('a revoked mandate must not resume');
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'MANDATE_REVOKED');
    }
    second.teamStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new mandates bind the persisted policy version and digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-policy-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = openEngine(path);
    const policy = first.engine.setPolicy({ ...first.engine.policy, mode: 'auto', rlpScope: 'strategy' });
    first.teamStore.close();

    const second = openEngine(path);
    const ticket = second.engine.receiveTrigger({
      source: 'artifact', eventId: 'art-1', projectId: 'proj-1', kind: 'artifact_ingested',
      payload: { routeId: 'A', title: 'review artifact' },
    }).ticket;
    assert.ok(ticket);
    const mandate = second.engine.getMandate(ticket.ticketId);
    assert.equal(mandate?.policyVersion, policy.version);
    assert.equal(mandate?.policyDigest, policy.digest);
    second.teamStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
