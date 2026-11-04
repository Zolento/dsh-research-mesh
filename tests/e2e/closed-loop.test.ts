/** Complete local research-mesh loop and the two required fault injections. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeService, makeTempProject, type TempProject } from '../helpers/env.ts';
import { buildRsiFixture } from '../helpers/rsi.ts';
import { FakeTransport } from '../../src/executors/transport.ts';
import { MeshError } from '../../src/errors.ts';
import { sleep } from '../../src/util/time.ts';

const SKILL = process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/rsi-pipeline';

const EXPERIMENT_SCRIPT = `import json, os
out = os.environ["MESH_ARTIFACT_DIR"]
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "run.log"), "a", encoding="utf-8") as handle:
    handle.write(os.environ["MESH_JOB_ID"] + "\\n")
with open(os.path.join(out, "metrics.json"), "w", encoding="utf-8") as handle:
    json.dump({"accuracy": 0.931, "job": os.environ["MESH_JOB_ID"]}, handle)
print("experiment finished")
`;

interface Prepared {
  readonly project: TempProject;
  readonly service: import('../../src/service.ts').MeshService;
  readonly teamId: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly fixture: ReturnType<typeof buildRsiFixture>;
  readonly stateDigest: string;
}

async function prepare(options: {
  transport?: FakeTransport;
  tag: string;
}): Promise<Prepared> {
  const project = makeTempProject({ name: options.tag });
  const { service } = await makeService(project, {
    config: {
      rsi: { enabled: true, skillPath: SKILL, allowTestStub: true, pythonExecutable: 'python3' },
    },
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
  const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
  const workspacePath = team.workspacePath as string;
  service.writeWorkspaceFile(team.workspaceId as string, 'experiments/mesh_experiment.py', EXPERIMENT_SCRIPT);
  const fixture = buildRsiFixture(project.root, SKILL, false, {
    cwd: workspacePath,
    argv: ['python3', 'experiments/mesh_experiment.py'],
    extraCode: ['experiments/mesh_experiment.py'],
  });
  execFileSync('git', ['-C', workspacePath, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspacePath, 'commit', '-q', '-m', 'experiment fixture'], { stdio: 'ignore' });
  const stateDigest = createHash('sha256').update(readFileSync(fixture.state)).digest('hex');
  const task = service.submitExperimentTask({
    projectId: 'proj-a',
    teamId: team.teamId,
    workerId: 'workstation',
    gpuId: 0,
    requiredArtifacts: ['metrics.json', 'run.log'],
    rsi: {
      mode: 'preview',
      experimentId: 'X1',
      routeId: 'A',
      statePath: fixture.state,
      manifestPath: fixture.manifest,
      schedulerPath: fixture.scheduler,
      receiptPath: fixture.receipt,
      ledgerPath: fixture.ledger,
    },
  }).task;
  await service.runWorkerOnce({ poll: false });
  const jobs = service.listJobs();
  assert.equal(jobs.length, 1, 'one experiment job should be submitted');
  return {
    project,
    service,
    teamId: team.teamId,
    taskId: task.taskId,
    jobId: jobs[0]?.jobId as string,
    fixture,
    stateDigest,
  };
}

async function waitForTask(
  service: import('../../src/service.ts').MeshService,
  jobId: string,
  predicate: (task: import('../../src/scheduler/scheduler.ts').MeshTaskView) => boolean,
  timeoutMs = 15_000,
): Promise<import('../../src/scheduler/scheduler.ts').MeshTaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await service.queryJob(jobId);
    if (predicate(task)) return task;
    if (Date.now() > deadline) throw new Error(`timed out waiting for task state; last=${task.status}`);
    await sleep(100);
  }
}

test('closed loop: RSI preview -> manifest -> GPU lease -> fake SSH -> artifacts -> ASSURANCE_PENDING', async () => {
  const prepared = await prepare({ tag: 'e2e-main' });
  const { service, project, fixture } = prepared;
  try {
    const output = await waitForTask(service, prepared.jobId, task => task.status === 'OUTPUT_READY');
    assert.equal(output.status, 'OUTPUT_READY');
    const ingested = await service.collectJob(prepared.jobId);
    assert.equal(ingested.task.status, 'ASSURANCE_PENDING');
    assert.equal(ingested.artifacts.length, 2);
    assert.ok(ingested.artifacts.some(artifact => artifact.path === 'metrics.json'));
    assert.ok(ingested.artifacts.some(artifact => artifact.path === 'run.log'));
    for (const artifact of ingested.artifacts) {
      const path = join(project.root, '.research-mesh', 'artifacts', prepared.jobId, service.listJobs()[0]?.attemptId ?? '', artifact.path);
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), artifact.sha256);
    }
    assert.ok(ingested.outcomePath !== null);
    const outcome = JSON.parse(readFileSync(ingested.outcomePath, 'utf8')) as Record<string, unknown>;
    assert.equal(outcome.scientific_status, 'ASSURANCE_PENDING');
    assert.equal(outcome.experiment_id, 'X1');
    const task = service.getTask(prepared.taskId);
    assert.equal(task.status, 'ASSURANCE_PENDING');
    assert.equal(task.rsiStateVersion, fixture.stateVersion);
    assert.equal(task.receiptRef?.endsWith('receipt.json'), true);
    const jobs = service.listJobs();
    assert.equal(jobs[0]?.status, 'ingested');
    assert.equal(service.listGpuLeases().filter(lease => lease.state === 'active').length, 0);
    const manifestPath = join(project.root, '.research-mesh', 'manifests', `${prepared.jobId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const authorization = manifest.authorization as Record<string, unknown>;
    assert.equal(authorization.mode, 'test-stub');
    assert.equal(authorization.rsi_experiment_id, 'X1');
    assert.equal(authorization.research_state_version, fixture.stateVersion);
    assert.equal(createHash('sha256').update(readFileSync(fixture.state)).digest('hex'), prepared.stateDigest);
    assert.equal(service.agentModel('root-a')?.source, 'group-default');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('fault A: lost submit response is reconciled after restart without a duplicate run', async () => {
  // The transport root must equal the worker's fakeRemoteRoot, created by the fixture.
  const project = makeTempProject({ name: 'e2e-fault-a' });
  const faultTransport = new ((await import('../../src/executors/transport.ts')).FakeTransport)(project.fakeRemote, { dropSubmitResponse: true });
  const first = await makeService(project, {
    config: { rsi: { enabled: true, skillPath: SKILL, allowTestStub: true, pythonExecutable: 'python3' } },
    transport: faultTransport,
  });
  try {
    const team = await first.service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const workspacePath = team.workspacePath as string;
    first.service.writeWorkspaceFile(team.workspaceId as string, 'experiments/mesh_experiment.py', EXPERIMENT_SCRIPT);
    const fixture = buildRsiFixture(project.root, SKILL, false, { cwd: workspacePath, argv: ['python3', 'experiments/mesh_experiment.py'], extraCode: ['experiments/mesh_experiment.py'] });
    execFileSync('git', ['-C', workspacePath, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspacePath, 'commit', '-q', '-m', 'experiment fixture'], { stdio: 'ignore' });
    first.service.submitExperimentTask({
      projectId: 'proj-a', teamId: team.teamId, workerId: 'workstation', gpuId: 0,
      requiredArtifacts: ['metrics.json', 'run.log'],
      rsi: { mode: 'preview', experimentId: 'X1', routeId: 'A', statePath: fixture.state, manifestPath: fixture.manifest, schedulerPath: fixture.scheduler, receiptPath: fixture.receipt, ledgerPath: fixture.ledger },
    });
    const round = await first.service.runWorkerOnce({ poll: false });
    assert.equal(round.task?.status, 'RECONCILE_REQUIRED');
    const jobId = first.service.listJobs()[0]?.jobId as string;
    assert.equal(first.service.listJobs()[0]?.status, 'submitted_unconfirmed');
    // Let the detached fake-remote process finish, then restart the controller.
    await sleep(500);
    await first.service.close();

    const second = await makeService(project, {
      config: { rsi: { enabled: true, skillPath: SKILL, allowTestStub: true, pythonExecutable: 'python3' } },
    });
    try {
      const startupJob = second.service.listJobs()[0];
      assert.ok(['reconcile_required', 'submitted_unconfirmed'].includes(startupJob?.status ?? ''));
      const recovery = await second.service.recover();
      void recovery;
      const reconciled = await second.service.reconcileJob(jobId);
      assert.ok(['SUBMITTED', 'OUTPUT_READY', 'ASSURANCE_PENDING'].includes(reconciled.status));
      const ready = await waitForTask(second.service, jobId, task => task.status === 'OUTPUT_READY');
      assert.equal(ready.status, 'OUTPUT_READY');
      const ingested = await second.service.collectJob(jobId);
      assert.equal(ingested.task.status, 'ASSURANCE_PENDING');
      const attemptId = second.service.listJobs()[0]?.attemptId as string;
      const runLog = readFileSync(join(project.root, '.research-mesh', 'artifacts', jobId, attemptId, 'run.log'), 'utf8').trim().split('\n');
      assert.equal(runLog.length, 1, 'the experiment must run exactly once');
    } finally {
      await second.service.close();
    }
  } finally {
    await first.service.close();
    project.cleanup();
  }
});

test('fault B: partial artifact transfer retries without re-running the experiment', async () => {
  const project = makeTempProject({ name: 'e2e-fault-b' });
  const transport = new ((await import('../../src/executors/transport.ts')).FakeTransport)(
    project.fakeRemote,
    { partialDownloads: new Set(['metrics.json']) },
  );
  const { service } = await makeService(project, {
    config: { rsi: { enabled: true, skillPath: SKILL, allowTestStub: true, pythonExecutable: 'python3' } },
    transport,
  });
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const workspacePath = team.workspacePath as string;
    service.writeWorkspaceFile(team.workspaceId as string, 'experiments/mesh_experiment.py', EXPERIMENT_SCRIPT);
    const fixture = buildRsiFixture(project.root, SKILL, false, { cwd: workspacePath, argv: ['python3', 'experiments/mesh_experiment.py'], extraCode: ['experiments/mesh_experiment.py'] });
    execFileSync('git', ['-C', workspacePath, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspacePath, 'commit', '-q', '-m', 'experiment fixture'], { stdio: 'ignore' });
    service.submitExperimentTask({
      projectId: 'proj-a', teamId: team.teamId, workerId: 'workstation', gpuId: 0,
      requiredArtifacts: ['metrics.json', 'run.log'],
      rsi: { mode: 'preview', experimentId: 'X1', routeId: 'A', statePath: fixture.state, manifestPath: fixture.manifest, schedulerPath: fixture.scheduler, receiptPath: fixture.receipt, ledgerPath: fixture.ledger },
    });
    await service.runWorkerOnce({ poll: false });
    const jobId = service.listJobs()[0]?.jobId as string;
    await waitForTask(service, jobId, task => task.status === 'OUTPUT_READY');
    await assert.rejects(
      () => service.collectJob(jobId),
      (error: unknown) => error instanceof MeshError && error.code === 'ARTIFACT_CHECKSUM_MISMATCH',
    );
    assert.equal(service.getTask(service.listJobs()[0]?.taskId as string).status, 'OUTPUT_READY');
    const ingested = await service.collectJob(jobId);
    assert.equal(ingested.task.status, 'ASSURANCE_PENDING');
    const attemptId = service.listJobs()[0]?.attemptId as string;
    const runLog = readFileSync(join(project.root, '.research-mesh', 'artifacts', jobId, attemptId, 'run.log'), 'utf8').trim().split('\n');
    assert.equal(runLog.length, 1, 'partial transfer must not trigger a rerun');
  } finally {
    await service.close();
    project.cleanup();
  }
});
