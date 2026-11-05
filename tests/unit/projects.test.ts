/** Project registry, RSI validation and explicit session bindings. */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
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

test('project pause preserves a manually paused group and archive parks active groups', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: state, repositoryRef: project.source });
    const teams: import('../../src/teams/manager.ts').TeamView[] = [];
    for (const [name, route] of [['group-a', 'A'], ['group-b', 'B'], ['group-c', 'C']]) {
      teams.push(await service.createTeam({ projectId: created.projectId, routeId: route, name, rootSessionId: `root-${name}` }));
    }
    service.pauseTeam(teams[1]?.teamId as string);
    const queued = service.submitTask({
      projectId: created.projectId, teamId: teams[0]?.teamId as string, type: 'local', title: 'queued-before-pause',
      payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
    }).task;
    service.setProjectStatus(created.projectId, 'paused');
    assert.equal(service.getTeam(teams[0]?.teamId as string).status, 'paused');
    assert.equal(service.getTeam(teams[1]?.teamId as string).status, 'paused');
    assert.equal(service.getTeam(teams[2]?.teamId as string).status, 'paused');
    // Even if a group drifts back to active while its project is paused, the
    // scheduler must not claim new work.
    service.resumeTeam(teams[0]?.teamId as string);
    assert.equal(service.claimNext(), undefined);
    assert.throws(
      () => service.claimTask(queued.taskId),
      (error: unknown) => error instanceof MeshError && error.code === 'TASK_NOT_CLAIMABLE',
    );
    service.setProjectStatus(created.projectId, 'active');
    assert.equal(service.getTeam(teams[0]?.teamId as string).status, 'active');
    assert.equal(service.getTeam(teams[1]?.teamId as string).status, 'paused', 'manual pause must survive project resume');
    const claimed = service.claimNext();
    assert.equal(claimed?.task.taskId, queued.taskId);
    assert.equal(service.getTeam(teams[2]?.teamId as string).status, 'active');

    service.setProjectStatus(created.projectId, 'archived');
    assert.equal(service.getTeam(teams[0]?.teamId as string).status, 'paused');
    assert.throws(
      () => service.submitTask({
        projectId: created.projectId, teamId: teams[0]?.teamId as string, type: 'local', title: 'archived',
        payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'TEAM_STATE_INVALID',
    );
    service.setProjectStatus(created.projectId, 'active');
    assert.equal(service.getTeam(teams[0]?.teamId as string).status, 'active');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('startup reconciliation re-parks a group that drifted out of a paused project', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const created = service.createProject({ name: 'research', rsiStateRef: statePath(project.root), repositoryRef: project.source });
    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    service.setProjectStatus(created.projectId, 'paused');
    service.resumeTeam(team.teamId);
    assert.equal(service.getTeam(team.teamId).status, 'active');
    service.reconcileProjectPauses();
    assert.equal(service.getTeam(team.teamId).status, 'paused');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('a project whose RSI state disappeared cannot create an orphan group', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: state, repositoryRef: project.source });
    unlinkSync(state);
    await assert.rejects(
      () => service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' }),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_STATE_UNAVAILABLE',
    );
    assert.equal(service.listTeams(created.projectId).length, 0);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('API group creation requires a readable RSI state for its research route', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const stateA = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: stateA, repositoryRef: project.source });
    await assert.rejects(
      () => service.createGroup({ projectId: created.projectId, routeId: 'B', name: 'group-b' }),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_STATE_UNAVAILABLE',
    );
    assert.equal(service.listTeams(created.projectId).length, 0);
    const routeB = join(project.root, '.research-idea-pipeline', 'routes', 'B');
    mkdirSync(routeB, { recursive: true });
    copyFileSync(stateA, join(routeB, 'research-state.json'));
    const groupB = await service.createGroup({ projectId: created.projectId, routeId: 'B', name: 'group-b', rootSessionId: 'root-b' });
    assert.equal(groupB.name, 'group-b');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('a group whose Captain binding fails is retired, not left half-bound', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project, { sessionBinding: 'external' });
  try {
    const created = service.createProject({ name: 'research', rsiStateRef: statePath(project.root), repositoryRef: project.source });
    service.attachSession(created.projectId, 'root-collision');
    await assert.rejects(
      () => service.createTeam({
        projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-collision',
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'SESSION_BINDING_CONFLICT',
    );
    const groups = service.listTeams(created.projectId);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.status, 'destroyed');
    assert.equal(service.getProject(created.projectId).captainSessions.length, 0);
    const workspace = service.listWorkspaces(created.projectId)[0];
    assert.ok(workspace !== undefined);
    assert.equal(existsSync(workspace.path), false, 'failed group creation must remove its worktree');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('member binding cannot name a group from another project', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const stateA = statePath(project.root);
    const routeB = join(project.root, '.research-idea-pipeline', 'routes', 'B');
    mkdirSync(routeB, { recursive: true });
    const stateB = join(routeB, 'research-state.json');
    copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), stateB);
    const a = service.createProject({ name: 'A', rsiStateRef: stateA, repositoryRef: project.source });
    const b = service.createProject({ name: 'B', rsiStateRef: stateB, repositoryRef: project.source });
    const teamA = await service.createTeam({ projectId: a.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    assert.throws(
      () => service.attachMemberSession(b.projectId, teamA.teamId, 'member-x'),
      (error: unknown) => error instanceof MeshError && error.code === 'TEAM_NOT_FOUND',
    );
    const bound = service.attachMemberSession(a.projectId, teamA.teamId, 'member-x');
    assert.equal(bound.role, 'member');
    assert.equal(bound.groupId, teamA.teamId);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('a task project id must match the group project', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const created = service.createProject({ name: 'research', rsiStateRef: statePath(project.root), repositoryRef: project.source });
    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    assert.throws(
      () => service.submitTask({
        projectId: 'proj_other', teamId: team.teamId, type: 'local', title: 'cross-project',
        payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'TEAM_NOT_FOUND',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('member identity is bound to its group and project', async () => {
  const project = makeTempProject();
  const { service, host } = await makeService(project, { sessionBinding: 'dsh' });
  try {
    const state = statePath(project.root);
    const created = service.createProject({ name: 'research', rsiStateRef: state, repositoryRef: project.source });
    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    await assert.rejects(
      () => service.registerSubagent({ teamId: team.teamId, name: 'bad-member', role: 'experiment', sessionId: team.rootSessionId }),
      (error: unknown) => error instanceof MeshError && error.code === 'SUBAGENT_DUPLICATE',
    );
    const sub = await service.registerSubagent({ teamId: team.teamId, name: 'worker-1', role: 'experiment', sessionId: 'member-1' });
    const binding = service.sessionBinding(sub.sessionId);
    assert.equal(binding?.role, 'member');
    assert.equal(binding?.groupId, team.teamId);
    assert.equal(binding?.projectId, created.projectId);
    service.releaseSubagent(team.teamId, sub.sessionId);
    assert.equal(service.sessionBinding(sub.sessionId), undefined);
    const rebound = service.attachMemberSession(created.projectId, team.teamId, sub.sessionId);
    assert.equal(rebound.role, 'member');
    const reRegistered = await service.registerSubagent({
      teamId: team.teamId, name: 'worker-1-reborn', role: 'experiment', sessionId: sub.sessionId,
    });
    assert.equal(reRegistered.sessionId, sub.sessionId);
    assert.equal(service.agentModel(sub.sessionId)?.name, 'worker-1-reborn');
    await service.destroyTeam(team.teamId);
    assert.equal(service.sessionBinding(sub.sessionId), undefined);
    assert.equal(service.sessionBinding(team.rootSessionId), undefined);
    assert.equal(service.getProject(created.projectId).captainSessions.length, 0);
    assert.equal(host.disposed.includes(sub.sessionId), true);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('a disposed control session detaches its binding but a group session does not', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const created = service.createProject({ name: 'research', rsiStateRef: statePath(project.root), repositoryRef: project.source });
    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    service.attachSession(created.projectId, 'session-control');
    assert.equal(service.sessionBinding('session-control')?.role, 'control');

    // Disposing a Captain or member session must not retire the group binding.
    assert.equal(service.onSessionDisposed(team.rootSessionId), false);
    assert.equal(service.sessionBinding(team.rootSessionId)?.role, 'captain');
    assert.equal(service.onSessionDisposed('session-unknown'), false);

    // A control chat that disappears takes its binding with it.
    assert.equal(service.onSessionDisposed('session-control'), true);
    assert.equal(service.sessionBinding('session-control'), undefined);
    assert.equal(service.getProject(created.projectId).controlSessions.length, 0);
    // Idempotent: a second disposal is a no-op.
    assert.equal(service.onSessionDisposed('session-control'), false);
    // The project itself is untouched.
    assert.equal(service.getProject(created.projectId).status, 'active');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('shutdown disposal never detaches durable bindings', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const created = service.createProject({ name: 'research', rsiStateRef: statePath(project.root), repositoryRef: project.source });
    service.attachSession(created.projectId, 'session-control');
    await service.close();
    // Simulate the Host disposing sessions during shutdown.
    const detached = service.onSessionDisposed('session-control');
    assert.equal(detached, false);
  } finally {
    project.cleanup();
  }
});
