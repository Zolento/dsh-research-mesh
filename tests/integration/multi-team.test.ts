/** Three concurrent groups: task binding, worktree isolation and GPU coordination. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { MeshError } from '../../src/errors.ts';

test('three groups submit concurrently, use their own worktrees and do not conflict', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const teams = await Promise.all(['group-a', 'group-b', 'group-c'].map(name =>
      service.createTeam({ projectId: 'proj-a', routeId: name, name, rootSessionId: `root-${name}` })));
    const tasks = await Promise.all(teams.map((team, index) => Promise.resolve(service.submitTask({
      projectId: 'proj-a',
      teamId: team.teamId,
      type: 'local',
      title: `team-${index + 1}`,
      payload: {
        entrypoint: 'python3',
        argv: ['-c', `open('team.txt','w').write('${team.name}')`],
      },
    }).task)));
    assert.equal(new Set(tasks.map(task => task.teamId)).size, 3);
    for (const [index, task] of tasks.entries()) {
      assert.equal(task.teamId, teams[index]?.teamId);
      assert.equal(task.workspaceId, teams[index]?.workspaceId);
    }
    await service.runUntilIdle(20);
    for (const [index, team] of teams.entries()) {
      const status = service.listTasksByTeam(team.teamId);
      assert.equal(status.length, 1);
      assert.equal(status[0]?.status, 'SUCCEEDED');
      const content = service.readWorkspaceFile(team.workspaceId as string, 'team.txt');
      assert.equal(content, team.name);
    }
    assert.equal(new Set(teams.map(team => team.workspacePath)).size, 3);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('GPU leases are coordinated across groups and the third exclusive request waits', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const teams = [];
    for (const name of ['group-a', 'group-b', 'group-c']) {
      teams.push(await service.createTeam({ projectId: 'proj-a', routeId: name, name, rootSessionId: `root-${name}` }));
    }
    const claims: { taskId: string; attemptId: string; teamId: string }[] = [];
    for (const [index, team] of teams.entries()) {
      const task = service.submitTask({
        projectId: 'proj-a', teamId: team.teamId, type: 'local', title: `holder-${index}`,
        payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
      }).task;
      const claim = service.claimNext();
      assert.ok(claim !== undefined);
      assert.equal(claim.task.teamId, team.teamId);
      claims.push({ taskId: task.taskId, attemptId: claim.attemptId, teamId: team.teamId });
    }
    const first = await service.acquireGpu({
      workerId: 'workstation', taskId: claims[0]?.taskId as string, jobId: 'job-a', attemptId: claims[0]?.attemptId as string, gpuId: 0,
    });
    const second = await service.acquireGpu({
      workerId: 'workstation', taskId: claims[1]?.taskId as string, jobId: 'job-b', attemptId: claims[1]?.attemptId as string, gpuId: 1,
    });
    assert.equal(first.lease.state, 'active');
    assert.equal(second.lease.state, 'active');
    await assert.rejects(
      () => service.acquireGpu({
        workerId: 'workstation', taskId: claims[2]?.taskId as string, jobId: 'job-c', attemptId: claims[2]?.attemptId as string,
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'GPU_UNAVAILABLE',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});
