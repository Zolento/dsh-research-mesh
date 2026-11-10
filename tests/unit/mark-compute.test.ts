/** Post-bound compute jobs: terminal handling, idempotency and compensation. */

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

interface Job { status: string; projectId: string; teamId: string; taskId?: string; manifestJson?: string }
interface Stack {
  engine: AutonomyEngine;
  store: AutonomyStore;
  meshStore: MeshStore;
  teamStore: ReturnType<typeof openTeamStore>;
  jobs: Map<string, Job>;
  cleanup(): void;
}

const manifest = JSON.stringify({ authorization: { rsi_experiment_id: 'X1' } });

function makeStack(): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-mc-'));
  const teamStore = openTeamStore({ path: join(dir, 'runtime.sqlite') });
  const meshStore = new MeshStore(teamStore);
  const store = new AutonomyStore(teamStore);
  const jobs = new Map<string, Job>();
  const engine = new AutonomyEngine({
    store,
    effects: new EffectsRunner(store),
    meshStore,
    policy: { ...DEFAULT_AUTONOMY_POLICY, mode: 'auto' },
    projectStatus: () => 'active',
    rlpFormalRun: () => true,
    groupFacts: teamId => ({ teamId, projectId: 'proj-1', routeId: 'A', status: 'active' }),
    jobFacts: jobId => jobs.get(jobId),
  });
  return { engine, store, meshStore, teamStore, jobs, cleanup: () => { teamStore.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function ticketWithAssignment(stack: Stack): { ticketId: string; assignmentId: string } {
  const received = stack.engine.receiveTrigger({
    source: 'user', eventId: `evt-${stack.jobs.size}`, projectId: 'proj-1', kind: 'user_request',
    explicit: true, payload: { routeId: 'A', title: 'experiment' },
  });
  assert.ok(received.ticket);
  const assignment = stack.engine.assign(received.ticket.ticketId, 'team-a', { taskId: 'task-1' });
  return { ticketId: received.ticket.ticketId, assignmentId: assignment.assignmentId };
}

function eventCount(stack: Stack, kind: string): number {
  return stack.store.transaction(db => Number((db.prepare(
    "SELECT COUNT(*) AS n FROM mesh_events WHERE kind = ?",
  ).get(kind) as { n: number }).n));
}

test('a running job parks the ticket and the operation is idempotent', () => {
  const stack = makeStack();
  try {
    stack.jobs.set('job-1', { status: 'running', projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest });
    const { ticketId, assignmentId } = ticketWithAssignment(stack);
    const parked = stack.engine.markCompute(ticketId, 'job-1', assignmentId);
    assert.equal(parked.status, 'waiting_compute');
    assert.equal(parked.experimentId, 'X1');
    const assignment = stack.engine.listAssignments(ticketId)[0];
    assert.equal(assignment?.status, 'ended');
    assert.equal(assignment?.jobId, 'job-1');
    assert.equal(eventCount(stack, 'waiting-compute'), 1);
    const again = stack.engine.markCompute(ticketId, 'job-1', assignmentId);
    assert.equal(again.status, 'waiting_compute');
    assert.equal(eventCount(stack, 'waiting-compute'), 1);
  } finally { stack.cleanup(); }
});

test('an already ingested job parks at waiting_evidence with a compensation event', () => {
  const stack = makeStack();
  try {
    stack.jobs.set('job-2', { status: 'ingested', projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest });
    const { ticketId, assignmentId } = ticketWithAssignment(stack);
    const parked = stack.engine.markCompute(ticketId, 'job-2', assignmentId);
    assert.equal(parked.status, 'waiting_evidence');
    assert.equal(eventCount(stack, 'compute-bound-after-ingestion'), 1);
    const again = stack.engine.markCompute(ticketId, 'job-2', assignmentId);
    assert.equal(again.status, 'waiting_evidence');
    assert.equal(eventCount(stack, 'compute-bound-after-ingestion'), 1);
  } finally { stack.cleanup(); }
});

test('a failed or cancelled job waits for a human', () => {
  const stack = makeStack();
  try {
    for (const [index, status] of ['failed', 'cancelled'].entries()) {
      stack.jobs.set(`job-f${index}`, { status, projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest });
      const { ticketId, assignmentId } = ticketWithAssignment(stack);
      const parked = stack.engine.markCompute(ticketId, `job-f${index}`, assignmentId);
      assert.equal(parked.status, 'waiting_human');
    }
  } finally { stack.cleanup(); }
});

test('the post-compute state survives a restart and stays idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-mc-restart-'));
  const dbPath = join(dir, 'runtime.sqlite');
  let teamStore = openTeamStore({ path: dbPath });
  try {
    const jobs = new Map<string, Job>([['job-r', { status: 'ingested', projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest }]]);
    const build = (store: AutonomyStore): AutonomyEngine => new AutonomyEngine({
      store,
      effects: new EffectsRunner(store),
      meshStore: new MeshStore(teamStore),
      policy: { ...DEFAULT_AUTONOMY_POLICY, mode: 'auto' },
      projectStatus: () => 'active',
      rlpFormalRun: () => true,
      groupFacts: teamId => ({ teamId, projectId: 'proj-1', routeId: 'A', status: 'active' }),
      jobFacts: jobId => jobs.get(jobId),
    });
    let store = new AutonomyStore(teamStore);
    let engine = build(store);
    const received = engine.receiveTrigger({
      source: 'user', eventId: 'evt-r', projectId: 'proj-1', kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'experiment' },
    });
    assert.ok(received.ticket);
    const assignment = engine.assign(received.ticket.ticketId, 'team-a', { taskId: 'task-1' });
    engine.markCompute(received.ticket.ticketId, 'job-r', assignment.assignmentId);
    teamStore.close();

    teamStore = openTeamStore({ path: dbPath });
    store = new AutonomyStore(teamStore);
    engine = build(store);
    const after = engine.getTicket(received.ticket.ticketId);
    assert.equal(after.status, 'waiting_evidence');
    assert.equal(after.experimentId, 'X1');
    const again = engine.markCompute(received.ticket.ticketId, 'job-r', assignment.assignmentId);
    assert.equal(again.status, 'waiting_evidence');
  } finally {
    try { teamStore.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a compute completion event wakes a bound waiting ticket', () => {
  const stack = makeStack();
  try {
    stack.jobs.set('job-w', { status: 'running', projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest });
    const { ticketId, assignmentId } = ticketWithAssignment(stack);
    stack.engine.markCompute(ticketId, 'job-w', assignmentId);
    stack.jobs.set('job-w', { status: 'ingested', projectId: 'proj-1', teamId: 'team-a', taskId: 'task-1', manifestJson: manifest });
    stack.engine.receiveTrigger({
      source: 'compute_job', eventId: 'job-w-done', projectId: 'proj-1', kind: 'compute_job_completed',
      ticketId, payload: { jobId: 'job-w' },
    });
    assert.equal(stack.engine.getTicket(ticketId).status, 'open');
  } finally { stack.cleanup(); }
});
