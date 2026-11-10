/** P0 scientific-completion gate: no RLP proof, no completed research ticket. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTeamStore } from '../../src/bridge/runtime/persistence.ts';
import { MeshStore } from '../../src/storage/mesh-store.ts';
import { AutonomyStore } from '../../src/autonomy/store.ts';
import { EffectsRunner } from '../../src/autonomy/effects.ts';
import { AutonomyEngine, DEFAULT_AUTONOMY_POLICY } from '../../src/autonomy/engine.ts';
import { makeService, makeTempProject } from '../helpers/env.ts';
import type { MeshError } from '../../src/errors.ts';
import type { ScientificCompletion } from '../../src/rlp/outcome.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';
const AVAILABLE = existsSync(join(SKILL, 'scripts', 'rlp_paths.py'));
const opts = { skip: AVAILABLE ? false : 'RLP skill not installed' };

interface Stack {
  engine: AutonomyEngine;
  cleanup(): void;
}

function makeStack(): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-done-'));
  const teamStore = openTeamStore({ path: join(dir, 'runtime.sqlite') });
  const meshStore = new MeshStore(teamStore);
  const store = new AutonomyStore(teamStore);
  const effects = new EffectsRunner(store);
  const engine = new AutonomyEngine({
    store, effects, meshStore,
    policy: { ...DEFAULT_AUTONOMY_POLICY, mode: 'auto' },
    projectStatus: () => 'active',
    rlpFormalRun: () => true,
    groupFacts: teamId => ({ teamId, projectId: 'proj-1', routeId: 'A', status: 'active' }),
  });
  return { engine, cleanup: () => { teamStore.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function researchTicket(engine: AutonomyEngine): string {
  const received = engine.receiveTrigger({
    source: 'user', eventId: 'evt-r', projectId: 'proj-1', kind: 'user_request',
    explicit: true, payload: { routeId: 'A', title: 'run X1', kind: 'research', experimentId: 'X1' },
  });
  assert.ok(received.ticket);
  return received.ticket.ticketId;
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as MeshError).code; }
  return 'NO_ERROR';
}

const PROOF = {
  ticketId: '',
  experimentId: 'X1',
  stateVersion: '3',
  stateDigest: 'sha256:abc',
  decision: '{"decision":"continue"}',
  verifiedAt: new Date().toISOString(),
  proofDigest: 'sha256:proof',
};

test('a successful execution leaves a research ticket waiting for evidence', () => {
  const stack = makeStack();
  try {
    const ticketId = researchTicket(stack.engine);
    assert.equal(stack.engine.getTicket(ticketId).kind, 'research');
    const assignment = stack.engine.assign(ticketId, 'team-a');
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.finishAssignment(assignment.assignmentId, { ok: true });
    const ticket = stack.engine.getTicket(ticketId);
    assert.equal(ticket.status, 'waiting_evidence');
    assert.equal(ticket.outcomeRef, null);
  } finally { stack.cleanup(); }
});

test('waiting_evidence cannot be turned into scientific completion without a proof', () => {
  const stack = makeStack();
  try {
    const ticketId = researchTicket(stack.engine);
    const assignment = stack.engine.assign(ticketId, 'team-a');
    stack.engine.startAssignment(assignment.assignmentId);
    stack.engine.finishAssignment(assignment.assignmentId, { ok: true });
    assert.equal(
      codeOf(() => stack.engine.endTicket(ticketId, 'completed', 'alice')),
      'RLP_GATE_HOLD',
    );
    assert.equal(stack.engine.getTicket(ticketId).status, 'waiting_evidence');
  } finally { stack.cleanup(); }
});

test('a verified RLP proof records the completion and its digest', () => {
  const stack = makeStack();
  try {
    const ticketId = researchTicket(stack.engine);
    const proof = { ...PROOF, ticketId };
    const ended = stack.engine.endTicket(ticketId, 'completed', 'alice', proof);
    assert.equal(ended.status, 'ended');
    assert.equal(ended.endReason, 'completed');
    assert.equal(ended.outcomeRef, proof.proofDigest);
  } finally { stack.cleanup(); }
});

test('engineering tickets and cancellations do not need a scientific proof', () => {
  const stack = makeStack();
  try {
    const received = stack.engine.receiveTrigger({
      source: 'user', eventId: 'evt-e', projectId: 'proj-1', kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'fix the build' },
    });
    const ticket = received.ticket;
    assert.ok(ticket);
    assert.equal(ticket.kind, 'engineering');
    assert.equal(stack.engine.endTicket(ticket.ticketId, 'completed', 'alice').endReason, 'completed');

    const other = stack.engine.receiveTrigger({
      source: 'user', eventId: 'evt-c', projectId: 'proj-1', kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'cancel me' },
    }).ticket;
    assert.ok(other);
    assert.equal(stack.engine.endTicket(other.ticketId, 'cancelled', 'alice').endReason, 'cancelled');
  } finally { stack.cleanup(); }
});

function seedReady(root: string): string {
  const dir = join(root, '.research-lifecycle-protocol', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), statePath);
  writeFileSync(statePath, JSON.stringify({
    schema: 'research-idea-pipeline/research-state@1',
    state_version: 3,
    contract: { goal: 'test' },
    experiments: [{ id: 'X1', status: 'done' }],
    uncertainties: [],
  }));
  return statePath;
}

function passCompletionFor(statePath: string): ScientificCompletion {
  const digest = createHash('sha256').update(readFileSync(statePath)).digest('hex');
  return {
    status: 'PASS', experimentId: 'X1', stateVersion: '3', stateDigest: `sha256:${digest}`,
    decision: '{"decision":"continue"}', proofDigest: 'sha256:pass', errors: [],
  };
}

test('the service verifies completion through the injected RLP verifier', opts, async () => {
  const project = makeTempProject();
  const state = seedReady(project.root);
  const { service } = await makeService(project, {
    config: { rlp: { enabled: true } },
    completionVerifier: { verify: async input => passCompletionFor(input.statePath) },
  });
  try {
    const created = service.createProject({ name: 'p', rsiStateRef: state, repositoryRef: project.source });
    const group = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const received = service.recordTrigger({
      source: 'user', eventId: 'evt-s', projectId: created.projectId, kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'run X1', kind: 'research', experimentId: 'X1' },
    });
    assert.ok(received.ticket);
    const assignment = service.assignTicket(received.ticket.ticketId, group.teamId, {});
    service.startTicketAssignment(assignment.assignmentId, {});
    service.finishTicketAssignment(assignment.assignmentId, { ok: true });
    const ended = await service.completeResearchTicket(received.ticket.ticketId, 'X1', 'A');
    assert.equal(ended.status, 'ended');
    assert.equal(ended.outcomeRef, 'sha256:pass');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('the service refuses completion when RLP returns HOLD', opts, async () => {
  const project = makeTempProject();
  const state = seedReady(project.root);
  const { service } = await makeService(project, {
    config: { rlp: { enabled: true } },
    completionVerifier: { verify: async input => ({ ...passCompletionFor(input.statePath), status: 'HOLD', errors: ['evidence missing'] }) },
  });
  try {
    const created = service.createProject({ name: 'p', rsiStateRef: state, repositoryRef: project.source });
    const received = service.recordTrigger({
      source: 'user', eventId: 'evt-h', projectId: created.projectId, kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'run X1', kind: 'research', experimentId: 'X1' },
    });
    assert.ok(received.ticket);
    await assert.rejects(
      service.completeResearchTicket(received.ticket.ticketId, 'X1', 'A'),
      (error: MeshError) => error.code === 'RLP_GATE_HOLD',
    );
    assert.equal(service.getTicket(received.ticket.ticketId).status, 'open');
  } finally {
    await service.close();
    project.cleanup();
  }
});
