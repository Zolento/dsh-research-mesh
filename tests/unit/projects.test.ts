/** Project registry, RSI validation and explicit session bindings. */

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { MeshError } from '../../src/errors.ts';

const SKILL = process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/rsi-pipeline';

function statePath(projectRoot: string): string {
  const dir = join(projectRoot, '.research-idea-pipeline', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), path);
  return path;
}

test('registers an RSI project, lists it and survives restart', async () => {
  const project = makeTempProject();
  const first = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = first.service.createProject({
      name: 'Wave-TOF study',
      description: 'A test research project',
      rsiStateRef: state,
      repositoryRef: project.source,
    });
    assert.equal(created.runnable, true);
    assert.equal(created.status, 'active');
    assert.equal(created.rsiReadable, true);
    assert.equal(first.service.listProjects().length, 1);
    await first.service.close();
    const second = await makeService(project);
    try {
      const restored = second.service.listProjects();
      assert.equal(restored.length, 1);
      assert.equal(restored[0]?.projectId, created.projectId);
      assert.equal(restored[0]?.name, 'Wave-TOF study');
      assert.equal(restored[0]?.rsiVersion, '0');
    } finally {
      await second.service.close();
    }
  } finally {
    project.cleanup();
  }
});

test('rejects a project without a canonical state_version and a missing repository', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const badState = join(project.root, 'bad-state.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(badState, JSON.stringify({ contract: { goal: 'x' } }));
    assert.throws(
      () => service.createProject({ name: 'bad', rsiStateRef: badState, repositoryRef: project.source }),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_INVALID',
    );
    const state = statePath(project.root);
    assert.throws(
      () => service.createProject({ name: 'bad repo', rsiStateRef: state, repositoryRef: join(project.root, 'missing') }),
      (error: unknown) => error instanceof MeshError && error.code === 'CONFIG_INVALID',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('derived RSI failure is shown without inventing a stage', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'readable', rsiStateRef: state, repositoryRef: project.source });
    const view = service.getProject(created.projectId);
    assert.equal(view.rsiReadable, true);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(state, '{ broken');
    const broken = service.getProject(created.projectId);
    assert.equal(broken.rsiReadable, false);
    assert.ok(broken.rsiError !== null);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('control sessions bind explicitly, conflict, detach and do not become captains', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: state, repositoryRef: project.source });
    const team = await service.createTeam({
      projectId: created.projectId,
      routeId: 'A',
      name: 'group-a',
      rootSessionId: 'root-captain',
    });
    const bindings = service.listSessionBindings(created.projectId);
    assert.equal(bindings.some(binding => binding.role === 'captain' && binding.groupId === team.teamId), true);
    assert.equal(bindings.some(binding => binding.role === 'control'), false);

    const control = await service.createControlSession(created.projectId);
    assert.equal(control.projectId, created.projectId);
    const controlBinding = service.sessionBinding(control.sessionId);
    assert.equal(controlBinding?.role, 'control');
    assert.equal(controlBinding?.groupId, null);

    const secondState = join(project.root, '.research-idea-pipeline', 'routes', 'B');
    mkdirSync(secondState, { recursive: true });
    const secondStatePath = join(secondState, 'research-state.json');
    copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), secondStatePath);
    const second = service.createProject({ name: 'second', rsiStateRef: secondStatePath, repositoryRef: project.source });
    await assert.rejects(
      () => Promise.resolve().then(() => service.attachSession(second.projectId, control.sessionId)),
      (error: unknown) => error instanceof MeshError && error.code === 'SESSION_BINDING_CONFLICT',
    );
    assert.equal(service.detachSession(control.sessionId), true);
    assert.equal(service.sessionBinding(control.sessionId), undefined);
    assert.equal(service.listProjects().length, 2, 'detaching a session never removes the project');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('pausing a project parks new work and resume restores it', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: state, repositoryRef: project.source });
    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    service.setProjectStatus(created.projectId, 'paused');
    assert.equal(service.getProject(created.projectId).status, 'paused');
    assert.equal(service.getTeam(team.teamId).status, 'paused');
    assert.throws(
      () => service.submitTask({
        projectId: created.projectId, teamId: team.teamId, type: 'local', title: 'blocked by pause',
        payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'TEAM_STATE_INVALID',
    );
    await assert.rejects(
      () => service.createTeam({ projectId: created.projectId, routeId: 'B', name: 'group-b', rootSessionId: 'root-b' }),
      (error: unknown) => error instanceof MeshError && error.code === 'TEAM_STATE_INVALID',
    );
    service.setProjectStatus(created.projectId, 'active');
    assert.equal(service.getTeam(team.teamId).status, 'active');
    const task = service.submitTask({
      projectId: created.projectId, teamId: team.teamId, type: 'local', title: 'after resume',
      payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
    });
    assert.equal(task.task.status, 'READY');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('member identity is bound to its group and project', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: state, repositoryRef: project.source });
    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const sub = await service.registerSubagent({ teamId: team.teamId, name: 'worker-1', role: 'experiment', sessionId: 'member-1' });
    const binding = service.sessionBinding(sub.sessionId);
    assert.equal(binding?.role, 'member');
    assert.equal(binding?.groupId, team.teamId);
    assert.equal(binding?.projectId, created.projectId);
  } finally {
    await service.close();
    project.cleanup();
  }
});
