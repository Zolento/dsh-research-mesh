/** Real RLP decision gate for scientific completion (no mocked decision). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { buildCompletionFixture } from '../helpers/rlp-completion.ts';
import type { MeshError } from '../../src/errors.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';
const AVAILABLE = existsSync(join(SKILL, 'scripts', 'rlp_paths.py'));
const opts = { skip: AVAILABLE ? false : `RLP skill not installed at ${SKILL}` };

type Mode = 'pass' | 'needs_review' | 'fail' | 'stale';

async function serviceFor(mode: Mode): Promise<{
  service: import('../../src/service.ts').MeshService;
  ticketId: string;
  fixture: ReturnType<typeof buildCompletionFixture>;
  cleanup(): Promise<void>;
}> {
  const project = makeTempProject({ name: `rlp-done-${mode}` });
  const fixture = buildCompletionFixture(project, SKILL, mode);
  const { service } = await makeService(project, { config: { rlp: { enabled: true } } });
  const created = service.createProject({ name: 'rlp', rsiStateRef: fixture.state, repositoryRef: project.source });
  const received = service.recordTrigger({
    source: 'user', eventId: `evt-${mode}`, projectId: created.projectId, kind: 'user_request',
    explicit: true,
    payload: { routeId: 'A', title: 'run X1', kind: 'research', experimentId: 'X1' },
  });
  assert.ok(received.ticket);
  return {
    service, ticketId: received.ticket.ticketId, fixture,
    cleanup: async () => { await service.close(); project.cleanup(); },
  };
}

test('a real PASS decision completes the research ticket', opts, async () => {
  const { service, ticketId, fixture, cleanup } = await serviceFor('pass');
  try {
    assert.ok(fixture.assurance);
    const ended = await service.completeResearchTicket(ticketId, 'X1', fixture.assurance);
    assert.equal(ended.status, 'ended');
    assert.equal(ended.endReason, 'completed');
    assert.match(ended.outcomeRef ?? '', /^sha256:/);
  } finally { await cleanup(); }
});

test('NEEDS_REVIEW (no assurance) refuses completion', opts, async () => {
  const { service, ticketId, cleanup } = await serviceFor('needs_review');
  try {
    await assert.rejects(
      service.completeResearchTicket(ticketId, 'X1'),
      (error: MeshError) => error.code === 'RLP_GATE_HOLD',
    );
    assert.equal(service.getTicket(ticketId).status, 'open');
  } finally { await cleanup(); }
});

test('a FAIL assurance verdict refuses completion', opts, async () => {
  const { service, ticketId, fixture, cleanup } = await serviceFor('fail');
  try {
    await assert.rejects(
      service.completeResearchTicket(ticketId, 'X1', fixture.assurance ?? undefined),
      (error: MeshError) => error.code === 'RLP_GATE_HOLD',
    );
  } finally { await cleanup(); }
});

test('a stale assurance refuses completion', opts, async () => {
  const { service, ticketId, fixture, cleanup } = await serviceFor('stale');
  try {
    await assert.rejects(
      service.completeResearchTicket(ticketId, 'X1', fixture.assurance ?? undefined),
      (error: MeshError) => error.code === 'RLP_GATE_HOLD' || error.code === 'RLP_STATE_CHANGED',
    );
  } finally { await cleanup(); }
});

test('an unbound experiment id is refused before touching RLP', opts, async () => {
  const { service, ticketId, cleanup } = await serviceFor('pass');
  try {
    await assert.rejects(
      service.completeResearchTicket(ticketId, 'X2'),
      (error: MeshError) => error.code === 'MANDATE_SCOPE_VIOLATION',
    );
  } finally { await cleanup(); }
});
