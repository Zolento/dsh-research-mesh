/** One Mesh, several independent projects: each project owns its control plane. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeService, makeTempProject } from '../helpers/env.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';

function seedState(root: string): string {
  const dir = join(root, '.research-lifecycle-protocol', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), path);
  return path;
}

test('two independent repositories both become runnable projects with their own control dirs', async () => {
  const first = makeTempProject({ name: 'multi-a' });
  const second = makeTempProject({ name: 'multi-b' });
  const { service } = await makeService(first);
  try {
    const a = service.createProject({
      name: 'project-a', rsiStateRef: seedState(first.root), repositoryRef: first.source,
    });
    const b = service.createProject({
      name: 'project-b', rsiStateRef: seedState(second.root), repositoryRef: second.source,
    });

    assert.equal(a.runnable, true, 'a whole-repository project must be runnable');
    assert.equal(b.runnable, true, 'a second repository must also be runnable');
    assert.notEqual(a.controlDir, b.controlDir);
    assert.ok(a.controlDir !== null && a.controlDir.includes('projects'));
    assert.equal(a.sourceDir, first.source);
    assert.equal(b.sourceDir, second.source);

    // Each project can create its own group and worktree.
    const teamA = await service.createTeam({ projectId: a.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const teamB = await service.createTeam({ projectId: b.projectId, routeId: 'A', name: 'group-b', rootSessionId: 'root-b' });
    assert.equal(teamA.researchProjectId, a.projectId);
    assert.equal(teamB.researchProjectId, b.projectId);
    assert.notEqual(teamA.workspacePath, teamB.workspacePath);

    const listed = service.listProjects();
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map(p => p.status).sort(), ['active', 'active']);
    assert.equal(existsSync(join(first.root, '..')), true);
  } finally {
    await service.close();
    first.cleanup();
    second.cleanup();
  }
});

test('each project gets its own runtime: separate database, worker and control session', async () => {
  const first = makeTempProject({ name: 'rt-a' });
  const second = makeTempProject({ name: 'rt-b' });
  const { service, host } = await makeService(first, { groups: ['group-a'] });
  try {
    const a = service.createProject({ name: 'rt-a', rsiStateRef: seedState(first.root), repositoryRef: first.source });
    const b = service.createProject({ name: 'rt-b', rsiStateRef: seedState(second.root), repositoryRef: second.source });

    const runtimeA = service.runtime(a.projectId);
    const runtimeB = service.runtime(b.projectId);
    assert.notEqual(runtimeA.config.databasePath, runtimeB.config.databasePath);
    assert.notEqual(runtimeA.config.worktreesDir, runtimeB.config.worktreesDir);
    assert.equal(runtimeA.config.projectRoot, first.source);
    assert.equal(runtimeB.config.projectRoot, second.source);

    // A group and a ticket in A are invisible to B.
    const teamA = await runtimeA.teams.createTeam({ projectId: a.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    runtimeA.autonomy.receiveTrigger({
      source: 'user', eventId: 'evt-a', projectId: a.projectId, kind: 'user_request',
      explicit: true, payload: { routeId: 'A', title: 'work in A' },
    });
    assert.equal(runtimeA.autonomy.listTickets(a.projectId).length, 1);
    assert.equal(runtimeB.autonomy.listTickets(b.projectId).length, 0);
    assert.equal(runtimeA.teams.list(a.projectId).length, 1);

    // The resident control session is created once and then reused.
    const control = await service.ensureProjectControlSession(a.projectId);
    assert.match(control.sessionId, /^test-control-/);
    assert.equal(control.created, true);
    const again = await service.ensureProjectControlSession(a.projectId);
    assert.equal(again.sessionId, control.sessionId);
    assert.equal(service.runtime(a.projectId).controlSessionId, control.sessionId);
    assert.ok(host.roots.includes(control.sessionId));

    const status = service.runtimeStatus();
    assert.equal(status.length, 2);
    assert.ok(status.some(entry => entry.projectId === a.projectId && entry.tickets === 1));
    assert.ok(status.every(entry => entry.databasePath.endsWith('runtime.sqlite')));
    void teamA;
  } finally {
    await service.close();
    first.cleanup();
    second.cleanup();
  }
});

test('the resident control session prefers the deployment default provider', async () => {
  const project = makeTempProject({ name: 'rt-provider' });
  const { service } = await makeService(project, { groups: ['group-a'] });
  try {
    const created = service.createProject({ name: 'rt-provider', rsiStateRef: seedState(project.root), repositoryRef: project.source });
    assert.equal(service.config.defaultProvider, 'deepseek-pool');
    const runtime = service.runtime(created.projectId);
    // A catalog that advertises several providers must resolve to the default.
    const catalog = await runtime.models.listCatalog();
    assert.ok(catalog.length > 0);
    const control = await runtime.ensureControlSession();
    assert.match(control.sessionId, /^test-control-/);
  } finally {
    await service.close();
    project.cleanup();
  }
});
