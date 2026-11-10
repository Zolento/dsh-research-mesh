/** Mesh service wired to RLP v2.2.0 and the autonomy layer. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeService, makeTempProject } from '../helpers/env.ts';
import type { MeshError } from '../../src/errors.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';
const AVAILABLE = existsSync(join(SKILL, 'scripts', 'rlp_paths.py'));
const opts = { skip: AVAILABLE ? false : `RLP v2.2.0 skill not installed at ${SKILL}` };

function seedRoute(root: string, version = 1): string {
  const dir = join(root, '.research-lifecycle-protocol', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), join(dir, 'research-state.json'));
  const statePath = join(dir, 'research-state.json');
  writeFileSync(statePath, JSON.stringify({
    schema: 'research-idea-pipeline/research-state@1',
    state_version: version,
    contract: { goal: 'test goal' },
    experiments: [],
    uncertainties: [],
  }));
  return statePath;
}

test('the service discovers RLP and reports the storage matrix', opts, async () => {
  const project = makeTempProject();
  const state = seedRoute(project.root);
  seedRoute(project.source);
  const { service } = await makeService(project, { config: { rlp: { enabled: true } } });
  try {
    const status = service.rlpStatus();
    assert.equal(status.available, true);
    assert.equal(status.version, '2.2.0');
    const storage = await service.rlpStorage();
    assert.equal(storage.status, 'READY');
    assert.equal(storage.formalRunAllowed, true);

    const created = service.createProject({ name: 'rlp', rsiStateRef: state, repositoryRef: project.source });
    assert.equal(created.status, 'active');
    const workbench = await service.projectWorkbench(created.projectId);
    assert.equal(workbench.rlp.available, true);
    assert.equal(workbench.rlp.storageStatus, 'READY');
    assert.equal(workbench.autonomy.mode, 'observe');
    assert.deepEqual(workbench.tickets, []);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('an explicit trigger creates a ticket that the workbench projects', opts, async () => {
  const project = makeTempProject();
  const state = seedRoute(project.root);
  seedRoute(project.source);
  const { service } = await makeService(project, { config: { rlp: { enabled: true } } });
  try {
    const created = service.createProject({ name: 'autonomy', rsiStateRef: state, repositoryRef: project.source });
    const received = service.recordTrigger({
      source: 'user',
      eventId: 'msg-1',
      projectId: created.projectId,
      kind: 'user_request',
      explicit: true,
      actor: 'alice',
      payload: { routeId: 'A', title: 'review the R8 evidence' },
    });
    assert.equal(received.disposition, 'accepted');
    assert.ok(received.ticket);
    const workbench = await service.projectWorkbench(created.projectId);
    assert.equal(workbench.tickets.length, 1);
    assert.equal(workbench.tickets[0]?.title, 'review the R8 evidence');
    assert.equal(workbench.autonomy.openTickets, 1);

    const group = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const assignment = service.assignTicket(received.ticket.ticketId, group.teamId);
    assert.equal(assignment.status, 'pending');
    const stopped = service.stopTicket(received.ticket.ticketId, 'operator stop');
    assert.equal(stopped.endReason, 'stopped');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('formal runs are refused on a legacy-only or ambiguous control root', opts, async () => {
  const legacyProject = makeTempProject();
  const legacyDir = join(legacyProject.root, '.research-idea-pipeline', 'routes', 'A');
  mkdirSync(legacyDir, { recursive: true });
  const legacyState = join(legacyDir, 'research-state.json');
  writeFileSync(legacyState, JSON.stringify({
    schema: 'research-idea-pipeline/research-state@1', state_version: 1, contract: { goal: 'g' },
    experiments: [], uncertainties: [],
  }));
  const legacy = await makeService(legacyProject, { config: { rlp: { enabled: true } } });
  try {
    const project = legacy.service.createProject({ name: 'legacy', rsiStateRef: legacyState, repositoryRef: legacyProject.source });
    await assert.rejects(
      legacy.service.createGroup({ projectId: project.projectId, routeId: 'A', name: 'group-a' }),
      (error: MeshError) => error.code === 'RLP_MIGRATION_REQUIRED',
    );
  } finally {
    await legacy.service.close();
    legacyProject.cleanup();
  }

  const ambiguousProject = makeTempProject();
  const ambiguousState = seedRoute(ambiguousProject.root);
  mkdirSync(join(ambiguousProject.root, '.research-idea-pipeline'), { recursive: true });
  const ambiguous = await makeService(ambiguousProject, { config: { rlp: { enabled: true } } });
  try {
    const project = ambiguous.service.createProject({ name: 'both', rsiStateRef: ambiguousState, repositoryRef: ambiguousProject.source });
    await assert.rejects(
      ambiguous.service.createGroup({ projectId: project.projectId, routeId: 'A', name: 'group-a' }),
      (error: MeshError) => error.code === 'RLP_AMBIGUOUS_STORAGE_ROOT',
    );
  } finally {
    await ambiguous.service.close();
    ambiguousProject.cleanup();
  }
});
