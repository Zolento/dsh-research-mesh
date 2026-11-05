/** Static GPU lease exclusivity, fail-closed probing and reconciliation. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { StaticGpuProbe } from '../../src/resources/gpu.ts';
import { MeshError } from '../../src/errors.ts';

async function fixture(probe?: InstanceType<typeof StaticGpuProbe>) {
  const project = makeTempProject();
  const { service } = await makeService(project, probe === undefined ? {} : { gpuProbe: probe });
  const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
  const task = service.submitTask({
    projectId: 'proj-a',
    teamId: team.teamId,
    type: 'local',
    title: 'gpu-holder',
    payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
  }).task;
  const claim = service.claimNext();
  assert.ok(claim !== undefined);
  return { project, service, task, attemptId: claim.attemptId };
}

test('two tasks lease GPU 0 and GPU 1 independently', async () => {
  const { project, service, task, attemptId } = await fixture();
  try {
    const secondTask = service.submitTask({
      projectId: 'proj-a', teamId: task.teamId, type: 'local', title: 'gpu-holder-2',
      payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
    }).task;
    const secondClaim = service.claimNext();
    assert.ok(secondClaim !== undefined);
    const first = await service.acquireGpu({
      workerId: 'workstation', taskId: task.taskId, jobId: 'job-1', attemptId, gpuId: 0,
    });
    const second = await service.acquireGpu({
      workerId: 'workstation', taskId: secondTask.taskId, jobId: 'job-2', attemptId: secondClaim.attemptId, gpuId: 1,
    });
    assert.equal(first.lease.gpuId, 0);
    assert.equal(second.lease.gpuId, 1);
    assert.equal(service.listGpuLeases('workstation').filter(lease => lease.state === 'active').length, 2);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('one task can never hold two GPU leases', async () => {
  const { project, service, task, attemptId } = await fixture();
  try {
    await service.acquireGpu({ workerId: 'workstation', taskId: task.taskId, jobId: 'job-1', attemptId, gpuId: 0 });
    await assert.rejects(
      () => service.acquireGpu({ workerId: 'workstation', taskId: task.taskId, jobId: 'job-2', attemptId, gpuId: 1 }),
      (error: unknown) => error instanceof MeshError && error.code === 'GPU_LEASE_CONFLICT',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('the same GPU cannot be double-leased', async () => {
  const { project, service, task, attemptId } = await fixture();
  try {
    await service.acquireGpu({ workerId: 'workstation', taskId: task.taskId, jobId: 'job-1', attemptId, gpuId: 0 });
    await assert.rejects(
      () => service.acquireGpu({ workerId: 'workstation', taskId: task.taskId, jobId: 'job-2', attemptId, gpuId: 0 }),
      (error: unknown) => error instanceof MeshError && error.code === 'GPU_LEASE_CONFLICT',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('an unverifiable GPU blocks acquisition instead of assuming it is free', async () => {
  const probe = new StaticGpuProbe({ 'workstation:0': 'unknown', 'workstation:1': 'busy' });
  const { project, service, task, attemptId } = await fixture(probe);
  try {
    await assert.rejects(
      () => service.acquireGpu({ workerId: 'workstation', taskId: task.taskId, jobId: 'job-1', attemptId, gpuId: 0 }),
      (error: unknown) => error instanceof MeshError && error.code === 'GPU_AVAILABILITY_UNKNOWN',
    );
    await assert.rejects(
      () => service.acquireGpu({ workerId: 'workstation', taskId: task.taskId, jobId: 'job-2', attemptId, gpuId: 1 }),
      (error: unknown) => error instanceof MeshError && error.code === 'GPU_UNAVAILABLE',
    );
    assert.equal(service.listGpuLeases().filter(lease => lease.state !== 'released').length, 0);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('recovery releases leases for terminal tasks before reassignment', async () => {
  const { project, service, task, attemptId } = await fixture();
  try {
    const lease = await service.acquireGpu({
      workerId: 'workstation', taskId: task.taskId, jobId: 'job-1', attemptId, gpuId: 0,
    });
    service.cancelTask(task.taskId, 'test cleanup');
    const result = service.reconcileGpu();
    assert.ok(result.released >= 1);
    assert.equal(service.listGpuLeases('workstation').find(item => item.leaseId === lease.lease.leaseId)?.state, 'released');
    const reacquired = await service.acquireGpu({
      workerId: 'workstation', taskId: task.taskId, jobId: 'job-2', attemptId, gpuId: 0,
    });
    assert.equal(reacquired.lease.state, 'active');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('local GPU probe parses nvidia-smi and fails closed on missing devices or tools', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LocalGpuProbe } = await import('../../src/resources/gpu.ts');
  const dir = mkdtempSync(join(tmpdir(), 'mesh-gpu-probe-'));
  try {
    const free = join(dir, 'free-smi');
    writeFileSync(free, '#!/bin/sh\nprintf "0, 200, 16000\\n"\n');
    chmodSync(free, 0o700);
    const probe = new LocalGpuProbe(free);
    const worker = {
      workerId: 'workstation', transport: 'fake', enabled: true, gpuIds: [0, 1], maxGpuJobs: 1,
      condaEnvironment: 'research', fakeRemoteRoot: dir,
    } as const;
    assert.equal(await probe.probe(worker as never, 0), 'available');
    assert.equal(await probe.probe(worker as never, 1), 'unknown');
    const busy = join(dir, 'busy-smi');
    writeFileSync(busy, '#!/bin/sh\nprintf "0, 15000, 16000\\n"\n');
    chmodSync(busy, 0o700);
    assert.equal(await new LocalGpuProbe(busy).probe(worker as never, 0), 'busy');
    assert.equal(await new LocalGpuProbe(join(dir, 'missing-smi')).probe(worker as never, 0), 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
