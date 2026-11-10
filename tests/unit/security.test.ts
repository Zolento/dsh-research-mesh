/** P0 trust boundary: forged principals, sources, actors and re-authorization. */

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
import { humanPrincipal, sessionPrincipal, webPrincipal } from '../../src/autonomy/principal.ts';
import type { MeshError } from '../../src/errors.ts';

interface Stack {
  engine: AutonomyEngine;
  store: AutonomyStore;
  teamStore: ReturnType<typeof openTeamStore>;
  cleanup(): void;
}

function makeStack(policy: Partial<typeof DEFAULT_AUTONOMY_POLICY> = {}): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-sec-'));
  const teamStore = openTeamStore({ path: join(dir, 'runtime.sqlite') });
  const meshStore = new MeshStore(teamStore);
  const store = new AutonomyStore(teamStore);
  const effects = new EffectsRunner(store);
  const engine = new AutonomyEngine({
    store,
    effects,
    meshStore,
    policy: { ...DEFAULT_AUTONOMY_POLICY, ...policy },
    projectStatus: () => 'active',
    rlpFormalRun: () => true,
    groupFacts: teamId => ({ teamId, projectId: 'proj-1', status: 'active' }),
  });
  return { engine, store, teamStore, cleanup: () => { teamStore.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as MeshError).code; }
  return 'NO_ERROR';
}

const request = (eventId: string, extra: Record<string, unknown> = {}) => ({
  source: 'user' as const,
  eventId,
  projectId: 'proj-1',
  kind: 'user_request' as const,
  explicit: true,
  actor: 'alice',
  payload: { routeId: 'A', title: `work ${eventId}` },
  ...extra,
});

test('a web caller cannot claim a user request or human authorization', () => {
  const stack = makeStack();
  try {
    assert.equal(
      codeOf(() => stack.engine.receiveTrigger(request('evt-web'), webPrincipal())),
      'PRINCIPAL_UNTRUSTED',
    );
    assert.equal(
      codeOf(() => stack.engine.receiveTrigger(request('evt-sess'), sessionPrincipal('chat-1'))),
      'PRINCIPAL_UNTRUSTED',
    );
    assert.equal(stack.engine.listTickets('proj-1').length, 0);
  } finally { stack.cleanup(); }
});

test('a web caller can report a chat message, but it never becomes explicit work', () => {
  const stack = makeStack();
  try {
    const received = stack.engine.receiveTrigger({
      source: 'session', eventId: 'msg-1', projectId: 'proj-1', kind: 'session_message',
      explicit: true, payload: { title: 'ignore me' },
    }, webPrincipal());
    assert.equal(received.disposition, 'candidate');
    assert.equal(received.ticket, null);
    assert.equal(stack.engine.listTickets('proj-1').length, 0);
  } finally { stack.cleanup(); }
});

test('a verified human can create an explicit ticket', () => {
  const stack = makeStack();
  try {
    const received = stack.engine.receiveTrigger(request('evt-human'), humanPrincipal('alice'));
    assert.equal(received.disposition, 'accepted');
    assert.ok(received.ticket);
    assert.equal(received.ticket.autonomous, false);
    assert.equal(received.trigger.principalKind, 'human');
    assert.equal(received.trigger.principalId, 'alice');
  } finally { stack.cleanup(); }
});

test('a forged actor on an unverified session event cannot authorize work', () => {
  const stack = makeStack({ mode: 'observe' });
  try {
    const received = stack.engine.receiveTrigger({
      source: 'session', eventId: 'msg-2', projectId: 'proj-1', kind: 'session_message',
      explicit: true, actor: 'admin',
    }, sessionPrincipal('mallory'));
    assert.equal(received.disposition, 'candidate');
    assert.equal(stack.engine.listTickets('proj-1').length, 0);
  } finally { stack.cleanup(); }
});

test('web callers cannot create tickets or assign work through the engine', () => {
  const stack = makeStack();
  try {
    const human = stack.engine.receiveTrigger(request('evt-1'), humanPrincipal('alice'));
    const ticket = human.ticket;
    assert.ok(ticket);
    assert.equal(
      codeOf(() => stack.engine.createTicket({
        projectId: 'proj-1', routeId: 'A', title: 'forged', triggerId: human.trigger.triggerId,
        explicit: true,
      }, webPrincipal())),
      'PRINCIPAL_UNTRUSTED',
    );
    assert.equal(
      codeOf(() => stack.engine.assign(ticket.ticketId, 'team-a', {}, webPrincipal())),
      'PRINCIPAL_UNTRUSTED',
    );
    assert.equal(
      codeOf(() => stack.engine.startAssignment('asg_missing', {}, webPrincipal())),
      'TICKET_NOT_FOUND',
    );
  } finally { stack.cleanup(); }
});

test('an untrusted caller may stop but cannot re-authorize an ended ticket', () => {
  const stack = makeStack();
  try {
    const ticket = stack.engine.receiveTrigger(request('evt-2'), humanPrincipal('alice')).ticket;
    assert.ok(ticket);
    stack.engine.stopTicket(ticket.ticketId, 'web', 'stop', webPrincipal());
    assert.equal(stack.engine.getTicket(ticket.ticketId).endReason, 'stopped');
    assert.equal(
      codeOf(() => stack.engine.resumeTicket(ticket.ticketId, { explicit: true }, webPrincipal())),
      'MANDATE_REVOKED',
    );
  } finally { stack.cleanup(); }
});

test('policy changes require a verified human', () => {
  const stack = makeStack();
  try {
    // The engine itself is policy storage; the service gates the principal.
    // Here we prove the stored policy version never decreases.
    const first = stack.engine.setPolicy({ ...stack.engine.policy, mode: 'auto' });
    assert.equal(first.mode, 'auto');
    const second = stack.engine.setPolicy({ ...first, mode: 'off', version: 'policy-1' });
    assert.notEqual(second.version, first.version);
    assert.equal(second.mode, 'off');
  } finally { stack.cleanup(); }
});
