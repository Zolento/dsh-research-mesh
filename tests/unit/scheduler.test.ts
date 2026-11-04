/** Deterministic scheduler: priority/FIFO, DAG, idempotency, claims, recovery. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { MeshError } from '../../src/errors.ts';

async function team(project: Parameters<typeof makeService>[0]): Promise<{ service: Awaited<ReturnType<typeof makeService>>['service']; teamId: string }> {
  const { service } = await makeService(project);
  const t = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
  return { service, teamId: t.teamId };
}

function local(teamId: string, title: string, priority = 0, dependencies: readonly string[] = []): Parameters<Awaited<ReturnType<typeof makeService>>['service']['submitTask']>[0] {
  return {
    projectId: 'proj-a',
    teamId,
    type: 'local',
    title,
    priority,
    dependencies,
    payload: { entrypoint: 'python3', argv: ['-c', 'print("ok")'] },
  };
}

test('priority then FIFO controls claim order', async () => {
  const project = makeTempProject();
  const { service, teamId } = await team(project);
  try {
    service.submitTask(local(teamId, 'first', 0));
    service.submitTask(local(teamId, 'second', 0));
    service.submitTask(local(teamId, 'urgent', 10));
    const first = service.claimNext();
    assert.equal(first?.task.title, 'urgent');
    service.cancelTask(first?.task.taskId as string, 'test');
    const second = service.claimNext();
    assert.equal(second?.task.title, 'first');
    service.cancelTask(second?.task.taskId as string, 'test');
    const third = service.claimNext();
    assert.equal(third?.task.title, 'second');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('a dependency blocks execution until its parent succeeds', async () => {
  const project = makeTempProject();
  const { service, teamId } = await team(project);
  try {
    const parent = service.submitTask(local(teamId, 'parent')).task;
    const child = service.submitTask(local(teamId, 'child', 0, [parent.taskId])).task;
    assert.equal(child.status, 'PENDING');
    const round = await service.runWorkerOnce();
    assert.equal(round.task?.taskId, parent.taskId);
    assert.equal(round.task?.status, 'SUCCEEDED');
    const childAfter = service.getTask(child.taskId);
    assert.equal(childAfter.status, 'READY');
    const next = await service.runWorkerOnce();
    assert.equal(next.task?.taskId, child.taskId);
    assert.equal(next.task?.status, 'SUCCEEDED');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('two schedulers cannot claim the same task', async () => {
  const project = makeTempProject();
  const first = await makeService(project);
  const second = await makeService(project);
  try {
    const a = await first.service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    first.service.submitTask(local(a.teamId, 'only'));
    const [left, right] = await Promise.all([first.service.claimNext(), second.service.claimNext()]);
    assert.equal([left, right].filter(Boolean).length, 1);
    const claimed = first.service.listTasksByTeam(a.teamId)[0];
    assert.equal(claimed?.status, 'CLAIMED');
  } finally {
    await second.service.close();
    await first.service.close();
    project.cleanup();
  }
});

test('repeated submit is idempotent', async () => {
  const project = makeTempProject();
  const { service, teamId } = await team(project);
  try {
    const one = service.submitTask({ ...local(teamId, 'same'), idempotencyKey: 'key-1' });
    const two = service.submitTask({ ...local(teamId, 'same'), idempotencyKey: 'key-1' });
    assert.equal(one.created, true);
    assert.equal(two.created, false);
    assert.equal(one.task.taskId, two.task.taskId);
    assert.equal(service.listTasksByTeam(teamId).length, 1);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('task state survives restart and invalid transitions are refused', async () => {
  const project = makeTempProject();
  const first = await makeService(project);
  let teamId = '';
  let taskId = '';
  try {
    const t = await first.service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    teamId = t.teamId;
    taskId = first.service.submitTask(local(teamId, 'persisted')).task.taskId;
    assert.throws(
      () => first.service.succeedTask(taskId, 'attempt_missing'),
      (error: unknown) => error instanceof MeshError && error.code === 'TASK_STATE_INVALID',
    );
    await first.service.close();
    const second = await makeService(project);
    try {
      const restored = second.service.getTask(taskId);
      assert.equal(restored.status, 'READY');
      assert.equal(restored.teamId, teamId);
      assert.equal(restored.projectId, 'proj-a');
    } finally {
      await second.service.close();
    }
  } finally {
    project.cleanup();
  }
});

test('blocked and failed tasks can be retried or cancelled explicitly', async () => {
  const project = makeTempProject();
  const { service, teamId } = await team(project);
  try {
    const task = service.submitTask(local(teamId, 'retry-me')).task;
    service.blockTask(task.taskId, null, 'WAITING', 'external resource');
    assert.equal(service.getTask(task.taskId).status, 'BLOCKED');
    service.retryTask(task.taskId, { reason: 'resource available' });
    assert.equal(service.getTask(task.taskId).status, 'READY');
    service.cancelTask(task.taskId, 'not needed');
    assert.equal(service.getTask(task.taskId).status, 'CANCELLED');
    assert.throws(
      () => service.retryTask(task.taskId, { reason: 'cannot revive cancelled' }),
      (error: unknown) => error instanceof MeshError && error.code === 'TASK_STATE_INVALID',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('a finished task leaves no stale current-task pointer on its group', async () => {
  const project = makeTempProject();
  const { service, teamId } = await team(project);
  try {
    const task = service.submitTask(local(teamId, 'tracked')).task;
    assert.equal(service.getTeam(teamId).currentTaskId, null);
    const round = await service.runWorkerOnce();
    assert.equal(round.task?.status, 'SUCCEEDED');
    assert.equal(service.getTeam(teamId).currentTaskId, null);
    const cancelled = service.submitTask(local(teamId, 'cancel-me')).task;
    service.cancelTask(cancelled.taskId, 'test');
    assert.equal(service.getTeam(teamId).currentTaskId, null);
    void task;
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('direct claim honours the per-team concurrency limit', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project, {
    config: { limits: { maxConcurrentTasksPerTeam: 1, maxConcurrentTasks: 4 } },
  });
  const teamId = (await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' })).teamId;
  try {
    const first = service.submitTask(local(teamId, 'first')).task;
    const second = service.submitTask(local(teamId, 'second')).task;
    assert.equal(service.claimNext()?.task.taskId, first.taskId);
    assert.throws(
      () => service.claimTask(second.taskId),
      (error: unknown) => error instanceof MeshError && error.code === 'TASK_NOT_CLAIMABLE',
    );
    assert.equal(service.getTask(second.taskId).status, 'READY');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('expired local leases are failed, never replayed silently', async () => {
  const project = makeTempProject();
  const { service, teamId } = await team(project);
  try {
    const task = service.submitTask(local(teamId, 'crashy')).task;
    const claim = service.claimNext();
    assert.ok(claim !== undefined);
    const report = await service.recoverAt(Date.now() + 10 * 60 * 1000);
    assert.deepEqual(report.scheduler.failedLocal, [task.taskId]);
    const recovered = service.getTask(task.taskId);
    assert.equal(recovered.status, 'FAILED');
    assert.equal(recovered.errorCode, 'WORKER_LOST');
    // No automatic retry happened.
    assert.equal(service.claimNext(), undefined);
    await service.close();
  } finally {
    project.cleanup();
  }
});
