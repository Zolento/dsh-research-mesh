/** Group registry, quotas, lifecycle and manual model assignment. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeTempProject, makeService, MOCK_MODEL, MOCK_PROVIDER } from '../helpers/env.ts';
import { MeshError } from '../../src/errors.ts';

async function createExternalTeam(
  service: Awaited<ReturnType<typeof makeService>>['service'],
  name: string,
): Promise<string> {
  const team = await service.createTeam({
    projectId: 'proj-a',
    routeId: name.replace('group-', '').toUpperCase(),
    name,
    rootSessionId: `root-${name}`,
  });
  return team.teamId;
}

test('creates three groups and rejects the fourth', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const a = await createExternalTeam(service, 'group-a');
    const b = await createExternalTeam(service, 'group-b');
    const c = await createExternalTeam(service, 'group-c');
    assert.equal(service.listTeams().length, 3);
    assert.equal(new Set([a, b, c]).size, 3);
    await assert.rejects(
      () => createExternalTeam(service, 'group-d'),
      (error: unknown) => error instanceof MeshError && error.code === 'TEAM_LIMIT',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('registers four subagents per group and rejects the thirteenth', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const teams: string[] = [];
    for (const name of ['group-a', 'group-b', 'group-c']) {
      teams.push(await createExternalTeam(service, name));
    }
    for (const [teamIndex, teamId] of teams.entries()) {
      for (let slot = 1; slot <= 4; slot += 1) {
        await service.registerSubagent({
          teamId,
          name: `sub-${teamIndex + 1}-${slot}`,
          role: 'experiment',
          sessionId: `session-${teamIndex + 1}-${slot}`,
        });
      }
    }
    assert.equal(service.status().subagents, 12);
    await assert.rejects(
      () => service.registerSubagent({
        teamId: teams[0] as string,
        name: 'sub-1-5',
        role: 'experiment',
        sessionId: 'session-1-5',
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'SUBAGENT_LIMIT',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('pause and resume retain the registry and worktree', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const teamId = await createExternalTeam(service, 'group-a');
    const before = service.getTeam(teamId);
    assert.ok(before.workspacePath !== null);
    assert.equal(service.pauseTeam(teamId).status, 'paused');
    assert.equal(service.resumeTeam(teamId).status, 'active');
    const workspace = service.listWorkspaces()[0];
    assert.ok(workspace !== undefined);
    assert.equal(workspace.status, 'active');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('registry and worktrees survive a service restart', async () => {
  const project = makeTempProject();
  const first = await makeService(project);
  try {
    const teamId = await createExternalTeam(first.service, 'group-a');
    await first.service.registerSubagent({ teamId, name: 'worker-1', role: 'experiment', sessionId: 'sa-1' });
    await first.service.close();

    const second = await makeService(project);
    try {
      const restored = second.service.listTeams();
      assert.equal(restored.length, 1);
      assert.equal(restored[0]?.teamId, teamId);
      assert.deepEqual(restored[0]?.subagentSessionIds, ['sa-1']);
      assert.equal(second.service.listWorkspaces()[0]?.status, 'active');
    } finally {
      await second.service.close();
    }
  } finally {
    project.cleanup();
  }
});

test('manual model selection: group default, captain override, subagent override, inherit', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    await service.saveModelSettings({
      version: 2,
      groups: {
        'group-a': {
          default: { provider: MOCK_PROVIDER, model: MOCK_MODEL },
          captain: { provider: MOCK_PROVIDER, model: 'mock-pro' },
          subagents: {
            'worker-1': { provider: MOCK_PROVIDER, model: 'mock-pro' },
            'worker-2': 'inherit',
          },
        },
        'group-b': {
          default: { provider: MOCK_PROVIDER, model: MOCK_MODEL },
          captain: 'inherit',
          subagents: {},
        },
      },
    });
    const a = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    assert.equal(service.agentModel(a.rootSessionId)?.model, 'mock-pro');
    assert.equal(service.agentModel(a.rootSessionId)?.source, 'captain-override');
    await service.registerSubagent({ teamId: a.teamId, name: 'worker-1', role: 'experiment', sessionId: 'sa-1' });
    await service.registerSubagent({ teamId: a.teamId, name: 'worker-2', role: 'theory', sessionId: 'sa-2' });
    assert.equal(service.agentModel('sa-1')?.model, 'mock-pro');
    assert.equal(service.agentModel('sa-1')?.source, 'subagent-override');
    assert.equal(service.agentModel('sa-2')?.model, MOCK_MODEL);
    assert.equal(service.agentModel('sa-2')?.source, 'group-default');

    const b = await service.createTeam({ projectId: 'proj-a', routeId: 'B', name: 'group-b', rootSessionId: 'root-b' });
    assert.equal(service.agentModel(b.rootSessionId)?.model, MOCK_MODEL);
    assert.equal(service.agentModel(b.rootSessionId)?.source, 'group-default');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('invalid or deleted model is rejected and never silently inherited', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    await assert.rejects(
      () => service.saveModelSettings({
        version: 2,
        groups: { 'group-a': { default: { provider: MOCK_PROVIDER, model: 'deleted-model' } } },
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'MODEL_CONFIG_INVALID',
    );
    await assert.rejects(
      () => service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-unknown', rootSessionId: 'root-x' }),
      (error: unknown) => error instanceof MeshError && error.code === 'MODEL_CONFIG_INVALID',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});
