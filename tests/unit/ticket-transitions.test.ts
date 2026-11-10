/** Irreversible Ticket states: ended tickets and revoked mandates cannot revive. */

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
import type { MeshError } from '../../src/errors.ts';

interface Stack { engine: AutonomyEngine; cleanup(): void }
const manifest = JSON.stringify({ authorization: { rsi_experiment_id: 'X1' } });

function makeStack(): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-tr-'));
  const teamStore = openTeamStore({ path: join(dir, 'runtime.sqlite') });
  const store = new AutonomyStore(teamStore);
  const jobs = new Map([['job-1', { status: 'running' as const, projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest }]]);
  const engine = new AutonomyEngine({
    store,
    effects: new EffectsRunner(store),
    meshStore: new MeshStore(teamStore),
    policy: { ...DEFAULT_AUTONOMY_POLICY, mode: 'auto' },
    projectStatus: () => 'active',
    rlpFormalRun: () => true,
    groupFacts: teamId => ({ teamId, projectId: 'proj-1', routeId: 'A', status: 'active' }),
    jobFacts: jobId => jobs.get(jobId),
  });
  return { engine, cleanup: () => { teamStore.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as MeshError).code; }
  return 'NO_ERROR';
}

function ticket(engine: AutonomyEngine): string {
  const received = engine.receiveTrigger({
    source: 'user', eventId: `evt-${Date.now()}-${Math.random()}`, projectId: 'proj-1',
    kind: 'user_request', explicit: true, payload: { routeId: 'A', title: 'work' },
  });
  assert.ok(received.ticket);
  return received.ticket.ticketId;
}

test('a stopped ticket refuses compute binding, assignment and revival', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack.engine);
    const assignment = stack.engine.assign(ticketId, 'team-a', { taskId: 'task-1' });
    stack.engine.stopTicket(ticketId, 'alice', 'stop');
    assert.equal(codeOf(() => stack.engine.markCompute(ticketId, 'job-1', assignment.assignmentId)), 'TICKET_STATE_INVALID');
    assert.equal(codeOf(() => stack.engine.assign(ticketId, 'team-a')), 'TICKET_STATE_INVALID');
    assert.equal(codeOf(() => stack.engine.startAssignment(assignment.assignmentId)), 'TICKET_STATE_INVALID');
    assert.equal(codeOf(() => stack.engine.resumeTicket(ticketId, { explicit: true })), 'MANDATE_REVOKED');
    stack.engine.receiveTrigger({
      source: 'compute_job', eventId: 'job-1-done', projectId: 'proj-1',
      kind: 'compute_job_completed', ticketId, payload: { jobId: 'job-1' },
    });
    assert.equal(stack.engine.getTicket(ticketId).status, 'ended');
    assert.equal(stack.engine.getTicket(ticketId).endReason, 'stopped');
  } finally { stack.cleanup(); }
});

test('a completed ticket is not reopened by an old assignment or job event', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack.engine);
    const assignment = stack.engine.assign(ticketId, 'team-a', { taskId: 'task-1' });
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.endTicket(ticketId, 'completed', 'alice');
    assert.equal(codeOf(() => stack.engine.finishAssignment(assignment.assignmentId, { ok: true })), 'TICKET_STATE_INVALID');
    assert.equal(codeOf(() => stack.engine.markCompute(ticketId, 'job-1', assignment.assignmentId)), 'TICKET_STATE_INVALID');
    stack.engine.receiveTrigger({
      source: 'compute_job', eventId: 'job-1-late', projectId: 'proj-1',
      kind: 'compute_job_completed', ticketId, payload: { jobId: 'job-1' },
    });
    assert.equal(stack.engine.getTicket(ticketId).status, 'ended');
  } finally { stack.cleanup(); }
});

test('finishing an assignment cannot overwrite an ended ticket', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack.engine);
    const assignment = stack.engine.assign(ticketId, 'team-a', { taskId: 'task-1' });
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.endTicket(ticketId, 'cancelled', 'alice');
    assert.equal(codeOf(() => stack.engine.finishAssignment(assignment.assignmentId, { ok: false, errorCode: 'X' })), 'TICKET_STATE_INVALID');
    assert.equal(stack.engine.getTicket(ticketId).endReason, 'cancelled');
  } finally { stack.cleanup(); }
});

test('revoked mandates cannot be reused for assignment or compute', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack.engine);
    stack.engine.assign(ticketId, 'team-a');
    stack.engine.stopTicket(ticketId, 'alice', 'revoke');
    assert.equal(codeOf(() => stack.engine.assign(ticketId, 'team-a')), 'TICKET_STATE_INVALID');
    assert.equal(codeOf(() => stack.engine.markCompute(ticketId, 'job-1')), 'TICKET_STATE_INVALID');
  } finally { stack.cleanup(); }
});

test('the open ticket transitions that remain legal still work', () => {
  const stack = makeStack();
  try {
    const ticketId = ticket(stack.engine);
    const assignment = stack.engine.assign(ticketId, 'team-a', { taskId: 'task-1' });
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.finishAssignment(assignment.assignmentId, { ok: true });
    assert.equal(stack.engine.getTicket(ticketId).status, 'waiting_evidence');

    const second = ticket(stack.engine);
    const failed = stack.engine.assign(second, 'team-a', { taskId: 'task-2' });
    stack.engine.startAssignment(failed.assignmentId);
    stack.engine.finishAssignment(failed.assignmentId, { ok: false, errorCode: 'X' });
    assert.equal(stack.engine.getTicket(second).status, 'waiting_human');
    stack.engine.resumeTicket(second, { explicit: true });
    assert.equal(stack.engine.getTicket(second).status, 'open');
  } finally { stack.cleanup(); }
});
