/** Additive autonomy schema: upgrade, rollback and re-upgrade keep rows. */

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

test('v2 schema upgrades, rolls back and upgrades again without losing rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-mig-'));
  const path = join(dir, 'db.sqlite');
  try {
    const teamStore = openTeamStore({ path });
    const store = new AutonomyStore(teamStore);
    assert.equal(store.schemaVersion(), 2);
    const engine = new AutonomyEngine({
      store,
      effects: new EffectsRunner(store),
      meshStore: new MeshStore(teamStore),
      policy: { ...DEFAULT_AUTONOMY_POLICY, mode: 'auto' },
      projectStatus: () => 'active',
      rlpFormalRun: () => true,
      groupFacts: teamId => ({ teamId, projectId: 'proj-1', routeId: 'A', status: 'active' }),
    });
    const ticket = engine.receiveTrigger({
      source: 'user', eventId: 'evt-1', projectId: 'proj-1', kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'work' },
    }).ticket;
    assert.ok(ticket);
    engine.setPolicy({ ...engine.policy, mode: 'off' });

    store.transaction(db => store.rollbackToV1(db));
    assert.equal(store.schemaVersion(), 1);
    teamStore.close();

    const reopened = openTeamStore({ path });
    const upgraded = new AutonomyStore(reopened);
    assert.equal(upgraded.schemaVersion(), 2);
    const row = upgraded.getTicket(ticket.ticketId);
    assert.ok(row);
    assert.equal(row.kind, 'engineering');
    // A rollback drops v2-only tables by design; the next engine seeds a fresh
    // default policy rather than resurrecting one that was rolled back.
    assert.equal(upgraded.loadPolicy(), undefined);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
