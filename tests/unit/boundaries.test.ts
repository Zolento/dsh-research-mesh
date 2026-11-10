/** P0 project/route boundaries: no cross-project ticket, team or thread. */

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
import type { MeshError } from '../../src/errors.ts';

interface Stack {
  engine: AutonomyEngine;
  store: AutonomyStore;
  cleanup(): void;
}

function makeStack(): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-bound-'));
  const teamStore = openTeamStore({ path: join(dir, 'db.sqlite') });
  const store = new AutonomyStore(teamStore);
  const engine = new AutonomyEngine({
    store,
    effects: new EffectsRunner(store),
    meshStore: new MeshStore(teamStore),
    policy: { ...DEFAULT_AUTONOMY_POLICY, mode: 'auto' },
    projectStatus: () => 'active',
    rlpFormalRun: () => true,
    groupFacts: teamId => ({
      teamId,
      projectId: teamId === 'team-other' ? 'proj-2' : 'proj-1',
      status: 'active',
    }),
  });
  return { engine, store, cleanup: () => { teamStore.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as MeshError).code; }
  return 'NO_ERROR';
}

function ticket(stack: Stack, projectId = 'proj-1'): string {
  const received = stack.engine.receiveTrigger({
    source: 'user', eventId: `evt-${projectId}`, projectId, kind: 'user_request',
    explicit: true, payload: { routeId: 'A', title: 'work' },
  }, humanPrincipal('alice'));
  assert.ok(received.ticket);
  return received.ticket.ticketId;
}

test('a Trigger cannot attach to a Ticket of another project', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack);
    const received = stack.engine.receiveTrigger({
      source: 'compute_job', eventId: 'job-1', projectId: 'proj-2', kind: 'compute_job_completed',
      ticketId, payload: { jobId: 'job-1' },
    });
    assert.equal(received.disposition, 'blocked');
    assert.match(received.reason ?? '', /different projects/);
  } finally { stack.cleanup(); }
});

test('a Ticket cannot be assigned to a group of another project', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack);
    assert.equal(
      codeOf(() => stack.engine.assign(ticketId, 'team-other')),
      'POLICY_BLOCKED',
    );
    assert.equal(stack.engine.listAssignments(ticketId).length, 0);
  } finally { stack.cleanup(); }
});

test('a Ticket cannot subscribe to a thread owned by another project', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack);
    stack.store.upsertThread('thread-foreign', 'proj-2');
    assert.equal(
      codeOf(() => stack.engine.subscribe(ticketId, 'thread-foreign', 'context', humanPrincipal('alice'))),
      'POLICY_BLOCKED',
    );
  } finally { stack.cleanup(); }
});

test('a context subscription cannot be upgraded to an owned one', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack);
    stack.engine.subscribe(ticketId, 'thread-1', 'context', humanPrincipal('alice'));
    assert.equal(
      codeOf(() => stack.engine.subscribe(ticketId, 'thread-1', 'owned', humanPrincipal('alice'))),
      'POLICY_BLOCKED',
    );
    const upgraded = stack.store.listSubscriptions(ticketId).find(row => row.threadKey === 'thread-1');
    assert.equal(upgraded?.mode, 'context');
  } finally { stack.cleanup(); }
});

test('a mandate whose route differs from its ticket is refused', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack);
    const record = stack.store.requireTicket(ticketId);
    // Simulate a corrupted/mismatched row: same mandate row, different route.
    stack.store.transaction(db => {
      db.prepare("UPDATE mesh_mandates SET route_id = 'B' WHERE mandate_id = ?").run(record.mandateId);
    });
    assert.equal(
      codeOf(() => stack.engine.assign(ticketId, 'team-a', {}, humanPrincipal('alice'))),
      'MANDATE_SCOPE_VIOLATION',
    );
  } finally { stack.cleanup(); }
});
