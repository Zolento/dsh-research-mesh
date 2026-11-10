/** Autonomy layer: Trigger idempotency, Gate, Tickets, Mandates and effects. */

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
import type { AutonomyPolicy, TriggerInput } from '../../src/autonomy/types.ts';
import type { MeshError } from '../../src/errors.ts';

interface Stack {
  readonly engine: AutonomyEngine;
  readonly effects: EffectsRunner;
  readonly store: AutonomyStore;
  readonly cleanup: () => void;
}

function makeStack(policy: Partial<AutonomyPolicy> = {}): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-autonomy-'));
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
  return {
    engine,
    effects,
    store,
    cleanup: () => { teamStore.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as MeshError).code;
  }
  return 'NO_ERROR';
}


const explicitInput = (eventId: string): TriggerInput => ({
  source: 'user',
  eventId,
  projectId: 'proj-1',
  kind: 'user_request',
  explicit: true,
  actor: 'alice',
  payload: { routeId: 'A', title: `work ${eventId}` },
});

test('the same event is recorded once and observe mode creates no ticket', () => {
  const stack = makeStack();
  try {
    const first = stack.engine.receiveTrigger(explicitInput('evt-1'));
    assert.equal(first.disposition, 'accepted');
    assert.ok(first.ticket);
    const replay = stack.engine.receiveTrigger(explicitInput('evt-1'));
    assert.equal(replay.disposition, 'duplicate');
    assert.equal(stack.engine.listTickets('proj-1').length, 1);

    const candidate = stack.engine.receiveTrigger({
      source: 'compute_job',
      eventId: 'job-9',
      projectId: 'proj-1',
      kind: 'compute_job_completed',
      payload: { jobId: 'job-9' },
    });
    assert.equal(candidate.disposition, 'candidate');
    assert.equal(candidate.ticket, null);
    assert.equal(stack.engine.listTickets('proj-1').length, 1);
    assert.equal(stack.effects.pending('notice'), true);
  } finally {
    stack.cleanup();
  }
});

test('an explicit mandate carries useful operations but no scientific write', () => {
  const stack = makeStack();
  try {
    const received = stack.engine.receiveTrigger(explicitInput('evt-2'));
    const ticket = received.ticket as NonNullable<typeof received.ticket>;
    const mandate = stack.engine.getMandate(ticket.ticketId);
    assert.ok(mandate);
    const operations = JSON.parse(mandate.operationsJson) as string[];
    assert.ok(operations.includes('compute.submit'));
    assert.ok(!operations.includes('rlp.state.write'));
    assert.equal(mandate.autonomous, false);
    assert.equal(mandate.policyVersion, DEFAULT_AUTONOMY_POLICY.version);
  } finally {
    stack.cleanup();
  }
});

test('auto mode creates a restricted autonomous ticket and never an experiment mandate', () => {
  const stack = makeStack({ mode: 'auto' });
  try {
    const received = stack.engine.receiveTrigger({
      source: 'team_task',
      eventId: 'task-1',
      projectId: 'proj-1',
      kind: 'team_task_completed',
      payload: { routeId: 'A', title: 'continue from task' },
    });
    assert.equal(received.disposition, 'accepted');
    const ticket = received.ticket as NonNullable<typeof received.ticket>;
    assert.equal(ticket.autonomous, true);
    const mandate = stack.engine.getMandate(ticket.ticketId);
    const operations = JSON.parse(mandate?.operationsJson ?? '[]') as string[];
    assert.ok(!operations.includes('compute.submit'));
    assert.ok(!operations.includes('rlp.state.write'));
    assert.equal(mandate?.rlpScope, 'discovery_only');
  } finally {
    stack.cleanup();
  }
});

test('a ticket has at most one active assignment', () => {
  const stack = makeStack();
  try {
    const ticket = stack.engine.receiveTrigger(explicitInput('evt-3')).ticket;
    assert.ok(ticket);
    stack.engine.assign(ticket.ticketId, 'team-a');
    assert.equal(codeOf(() => stack.engine.assign(ticket.ticketId, 'team-b')), 'TICKET_STATE_INVALID');
    assert.equal(stack.engine.listAssignments(ticket.ticketId).length, 1);
  } finally {
    stack.cleanup();
  }
});

test('execution success parks the ticket at waiting_evidence and never ends it', () => {
  const stack = makeStack();
  try {
    const ticket = stack.engine.receiveTrigger(explicitInput('evt-4')).ticket;
    assert.ok(ticket);
    const assignment = stack.engine.assign(ticket.ticketId, 'team-a');
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.finishAssignment(assignment.assignmentId, { ok: true });
    const after = stack.engine.getTicket(ticket.ticketId);
    assert.equal(after.status, 'waiting_evidence');
    assert.equal(after.endedAt, null);
    assert.equal(after.endReason, null);
  } finally {
    stack.cleanup();
  }
});

test('a human stop revokes the mandate and no later resume is allowed', () => {
  const stack = makeStack();
  try {
    const ticket = stack.engine.receiveTrigger(explicitInput('evt-5')).ticket;
    assert.ok(ticket);
    const stopped = stack.engine.stopTicket(ticket.ticketId, 'alice', 'no longer needed');
    assert.equal(stopped.status, 'ended');
    assert.equal(stopped.endReason, 'stopped');
    const mandate = stack.engine.getMandate(ticket.ticketId);
    assert.notEqual(mandate?.revokedAt, null);
    assert.equal(codeOf(() => stack.engine.resumeTicket(ticket.ticketId, { explicit: true })), 'MANDATE_REVOKED');
    assert.equal(stack.engine.getTicket(ticket.ticketId).status, 'ended');
  } finally {
    stack.cleanup();
  }
});

test('an autonomous ticket cannot resume after a policy change without explicit approval', () => {
  const stack = makeStack({ mode: 'auto' });
  try {
    const ticket = stack.engine.receiveTrigger({
      source: 'artifact',
      eventId: 'art-1',
      projectId: 'proj-1',
      kind: 'artifact_ingested',
      payload: { routeId: 'A', title: 'review artifact' },
    }).ticket;
    assert.ok(ticket);
    stack.engine.endTicket(ticket.ticketId, 'completed', 'system');
    stack.engine.setPolicy({ ...stack.engine.policy, version: 'policy-2' });
    assert.equal(codeOf(() => stack.engine.resumeTicket(ticket.ticketId, { explicit: false })), 'MANDATE_REVALIDATION_REQUIRED');
    const resumed = stack.engine.resumeTicket(ticket.ticketId, { explicit: true });
    assert.equal(resumed.status, 'open');
  } finally {
    stack.cleanup();
  }
});

test('a context-only subscription cannot originate work', () => {
  const stack = makeStack({ mode: 'off' });
  try {
    const ticket = stack.engine.receiveTrigger(explicitInput('evt-6')).ticket;
    assert.ok(ticket);
    stack.engine.subscribe(ticket.ticketId, 'thread-9', 'context');
    const received = stack.engine.receiveTrigger({
      source: 'session',
      eventId: 'msg-9',
      projectId: 'proj-1',
      kind: 'session_message',
      threadKey: 'thread-9',
    });
    assert.equal(received.disposition, 'ignored');
    assert.equal(stack.engine.listTickets('proj-1').length, 1);
  } finally {
    stack.cleanup();
  }
});

test('a disallowed actor is blocked before any ticket exists', () => {
  const stack = makeStack({ allowedActors: ['alice'] });
  try {
    const received = stack.engine.receiveTrigger({ ...explicitInput('evt-7'), actor: 'mallory' });
    assert.equal(received.disposition, 'blocked');
    assert.equal(stack.engine.listTickets('proj-1').length, 0);
  } finally {
    stack.cleanup();
  }
});

test('effects retry with backoff and die after the attempt bound', async () => {
  const stack = makeStack();
  try {
    let now = Date.now();
    const store = new AutonomyStore(openTeamStore({ path: join(mkdtempSync(join(tmpdir(), 'mesh-fx-')), 'db.sqlite') }));
    const runner = new EffectsRunner(store, { now: () => now, baseDelayMs: 100, maxAttempts: 2 });
    runner.register('flaky', { retry: 'safe', run: async () => { throw new Error('boom'); } });
    runner.enqueue('flaky', 'k1', {});
    now += 10_000;
    await runner.tick();
    let row = runner.list()[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    now += 1_000;
    await runner.tick();
    row = runner.list()[0];
    assert.equal(row.status, 'dead');
    assert.equal(row.attempts, 2);
  } finally {
    stack.cleanup();
  }
});

test('a reconcile-only effect is parked, never retried', async () => {
  const stack = makeStack();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-fx2-'));
    const teamStore = openTeamStore({ path: join(dir, 'db.sqlite') });
    const store = new AutonomyStore(teamStore);
    const runner = new EffectsRunner(store, { baseDelayMs: 1, maxAttempts: 5 });
    runner.register('remote-submit', { retry: 'reconcile-only', run: async () => { throw new Error('submit unknown'); } });
    runner.enqueue('remote-submit', 'job-1', {});
    await runner.tick();
    await runner.tick();
    const row = runner.list()[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    teamStore.close();
  } finally {
    stack.cleanup();
  }
});

test('a compute-completion event wakes a waiting ticket without ending it', () => {
  const stack = makeStack();
  try {
    const ticket = stack.engine.receiveTrigger(explicitInput('evt-8')).ticket;
    assert.ok(ticket);
    const assignment = stack.engine.assign(ticket.ticketId, 'team-a');
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.markCompute(ticket.ticketId, 'job-8', assignment.assignmentId);
    assert.equal(stack.engine.getTicket(ticket.ticketId).status, 'waiting_compute');
    const wake = stack.engine.receiveTrigger({
      source: 'compute_job',
      eventId: 'job-8-done',
      projectId: 'proj-1',
      kind: 'compute_job_completed',
      threadKey: 'compute:job-8',
      ticketId: ticket.ticketId,
      payload: { jobId: 'job-8' },
    });
    assert.equal(wake.disposition, 'attached');
    const after = stack.engine.getTicket(ticket.ticketId);
    assert.equal(after.status, 'open');
    assert.equal(after.endedAt, null);
  } finally {
    stack.cleanup();
  }
});

test('a queued effect survives a restart and runs once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-fx3-'));
  const dbPath = join(dir, 'db.sqlite');
  let teamStore = openTeamStore({ path: dbPath });
  try {
    let runs = 0;
    let store = new AutonomyStore(teamStore);
    let runner = new EffectsRunner(store);
    runner.register('notice', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    runner.enqueue('notice', 'restart-1', {});
    teamStore.close();

    teamStore = openTeamStore({ path: dbPath });
    store = new AutonomyStore(teamStore);
    runner = new EffectsRunner(store);
    runner.register('notice', { retry: 'safe', run: async () => { runs += 1; return 'done'; } });
    await runner.tick();
    assert.equal(runs, 1);
    assert.equal(runner.list()[0]?.status, 'succeeded');
  } finally {
    try { teamStore.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stopped ticket is not reopened by an autonomous event', () => {
  const stack = makeStack({ mode: 'auto' });
  try {
    const ticket = stack.engine.receiveTrigger(explicitInput('evt-9')).ticket;
    assert.ok(ticket);
    stack.engine.stopTicket(ticket.ticketId, 'alice', 'stop');
    const event = stack.engine.receiveTrigger({
      source: 'compute_job',
      eventId: 'job-9-done',
      projectId: 'proj-1',
      kind: 'compute_job_completed',
      ticketId: ticket.ticketId,
      threadKey: 'compute:job-9',
      payload: { jobId: 'job-9' },
    });
    assert.equal(event.disposition, 'blocked');
    const after = stack.engine.getTicket(ticket.ticketId);
    assert.equal(after.status, 'ended');
    assert.equal(after.endReason, 'stopped');
  } finally {
    stack.cleanup();
  }
});
