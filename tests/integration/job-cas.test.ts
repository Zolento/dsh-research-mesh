/**
 * Durable single-launch guarantee for one job across independent controllers.
 *
 * Two `MeshStore` handles model two processes sharing one SQLite database. The
 * `prepared -> submitting` transition is the only launch permission, so the
 * losing controller returns without staging, submitting, or taking a GPU lease.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeConfig, makeTempProject } from '../helpers/env.ts';
import { openTeamStore } from '../../src/bridge/runtime/persistence.ts';
import { ensureProjectLayout } from '../../src/project.ts';
import { MeshStore } from '../../src/storage/mesh-store.ts';
import { TaskScheduler } from '../../src/scheduler/scheduler.ts';
import { GpuLeaseManager, StaticGpuProbe } from '../../src/resources/gpu.ts';
import { RemoteJobExecutor } from '../../src/executors/remote.ts';
import type { JobManifest } from '../../src/executors/manifest.ts';
import type { JobTransport, RemoteArtifactManifest, RemoteJobState, TransportFile } from '../../src/executors/transport.ts';
import type { WorkerConfig } from '../../src/config/types.ts';
import type { MeshJobRecord, MeshJobStatus } from '../../src/storage/types.ts';
import { createLogger } from '../../src/util/logger.ts';
import { nowIso } from '../../src/util/time.ts';

/** Transport that records launches and never touches the filesystem. */
class RecordingTransport implements JobTransport {
  readonly kind = 'fake-ssh' as const;
  readonly launches: string[] = [];
  readonly #root: string;

  constructor(root: string) { this.#root = root; }

  jobDir(worker: WorkerConfig, jobId: string, attemptId: string): string {
    void worker;
    return join(this.#root, jobId, attemptId);
  }

  async ensureJobDir(dir: string): Promise<void> { mkdirSync(dir, { recursive: true }); }

  async writeFile(): Promise<void> {}

  async stageArchive(): Promise<void> {}

  async submit(dir: string): Promise<{ pid?: number }> {
    this.launches.push(dir);
    return { pid: 4242 };
  }

  async readState(): Promise<RemoteJobState | null> { return null; }

  async readArtifactManifest(): Promise<RemoteArtifactManifest | null> { return null; }

  async listArtifactFiles(): Promise<readonly TransportFile[]> { return []; }

  async download(): Promise<void> { throw new Error('download is not used by this fixture'); }
}

function seedTeam(store: MeshStore, projectRoot: string): void {
  assert.ok(projectRoot.length > 0);
  store.teamStore.upsertTeam({
    teamId: 'team-cas',
    title: 'group-a',
    objective: 'cas fixture',
    stateVersionAtStart: '0',
    captainAgentId: 'root-cas',
    projectRoot,
    researchStatePath: null,
    pipelineRoot: null,
    budget: { maxConcurrentAgents: 4, maxTaskAttempts: 3, maxMessagesPerTask: 50, maxExperimentRuns: 10, maxWallClockMs: 600_000 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'active',
    revision: 1,
  });
  store.insertGroup({
    teamId: 'team-cas',
    projectId: 'proj-a',
    routeId: 'A',
    workspaceId: null,
    rootSessionId: 'root-cas',
    currentTaskId: null,
    status: 'active',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

function jobRow(status: MeshJobStatus, attemptId: string, commit: string, taskId: string): MeshJobRecord {
  const manifest = {
    schema: 'dsh-research-mesh/job-manifest@1',
    job_id: 'job_cas_1',
    attempt_id: attemptId,
    project_id: 'proj-a',
    team_id: 'team-cas',
    workspace_id: null,
    code: { commit },
    execution: { entrypoint: 'python3', argv: ['-c', 'print(1)'], working_directory: '.', conda_environment: 'mesh-test' },
    resources: { worker_id: 'workstation', gpu_id: 0 },
    artifacts: { destination: 'artifacts' },
    authorization: { mode: 'none', rsi_receipt_ref: null, research_state_version: null },
    created_at: nowIso(),
  };
  return {
    jobId: 'job_cas_1',
    taskId,
    attemptId,
    projectId: 'proj-a',
    teamId: 'team-cas',
    workerId: 'workstation',
    gpuId: 0,
    manifestJson: JSON.stringify(manifest),
    manifestDigest: 'a'.repeat(64),
    status,
    remoteDir: '/tmp/unused',
    submittedAt: null,
    updatedAt: nowIso(),
    errorCode: null,
    errorMessage: null,
  };
}

/** Create one RUNNING experiment task through the real scheduler. */
function seedRunningTask(store: MeshStore, config: import('../../src/config/types.ts').MeshConfig): string {
  const scheduler = new TaskScheduler(config, store, createLogger('error'));
  const submitted = scheduler.submit({
    projectId: 'proj-a',
    teamId: 'team-cas',
    type: 'experiment',
    title: 'cas task',
  }).task;
  const claim = scheduler.claimNext('worker-cas');
  assert.ok(claim !== undefined, 'the seeded task must be claimable');
  scheduler.start(submitted.taskId, 'worker-cas', claim.attemptId);
  return claim.attemptId;
}

test('only one controller may claim a prepared job for launch', () => {
  const project = makeTempProject({ name: 'job-cas-store' });
  const config = makeConfig(project);
  ensureProjectLayout(config);
  const firstStore = openTeamStore({ path: config.databasePath });
  const secondStore = openTeamStore({ path: config.databasePath });
  try {
    const first = new MeshStore(firstStore);
    const second = new MeshStore(secondStore);
    seedTeam(first, project.root);
    const attemptId = seedRunningTask(first, config);
    const taskId = first.teamStore.listTasks('team-cas')[0]?.task_id;
    assert.ok(taskId !== undefined);
    first.insertJob(jobRow('prepared', attemptId, project.commit, taskId));
    assert.equal(first.claimJobSubmission('job_cas_1'), true, 'the first controller wins');
    assert.equal(second.claimJobSubmission('job_cas_1'), false, 'the second controller is refused');
    assert.equal(second.getJob('job_cas_1')?.status, 'submitting');
    assert.equal(first.claimJobSubmission('job_cas_1'), false, 'a claim is single-use');
  } finally {
    secondStore.close();
    firstStore.close();
    project.cleanup();
  }
});

test('a controller that loses the claim never launches or takes a GPU lease', async () => {
  const project = makeTempProject({ name: 'job-cas-exec' });
  const config = makeConfig(project);
  ensureProjectLayout(config);
  const teamStore = openTeamStore({ path: config.databasePath });
  const logger = createLogger('error');
  try {
    const store = new MeshStore(teamStore);
    const scheduler = new TaskScheduler(config, store, logger);
    const gpu = new GpuLeaseManager(config, store, new StaticGpuProbe({ 'workstation:0': 'available' }), logger);
    const transport = new RecordingTransport(join(project.root, 'remote'));
    const executor = new RemoteJobExecutor({
      config,
      store,
      scheduler,
      gpu,
      transport,
      artifactsRoot: join(project.root, '.research-mesh', 'artifacts'),
      manifestsRoot: join(project.root, '.research-mesh', 'manifests'),
      outcomesRoot: join(project.root, '.research-mesh', 'outcomes'),
      logger,
    });
    seedTeam(store, project.root);
    const attemptId = seedRunningTask(store, config);
    const taskId = store.teamStore.listTasks('team-cas')[0]?.task_id;
    assert.ok(taskId !== undefined);
    const row = jobRow('submitting', attemptId, project.commit, taskId);
    // Another controller already owns this job's launch.
    store.insertJob(row);

    const manifest: JobManifest = {
      schema: 'dsh-research-mesh/job-manifest@1',
      job_id: 'job_cas_1',
      attempt_id: attemptId,
      project_id: 'proj-a',
      team_id: 'team-cas',
      workspace_id: null,
      code: { commit: project.commit },
      execution: { entrypoint: 'python3', argv: ['-c', 'print(1)'], working_directory: '.', conda_environment: 'mesh-test' },
      resources: { worker_id: 'workstation', gpu_id: 0 },
      artifacts: { destination: 'artifacts' },
      authorization: { mode: 'none', rsi_receipt_ref: null, research_state_version: null },
      created_at: nowIso(),
    };
    const result = await executor.submit(scheduler.get(row.taskId), manifest);
    assert.equal(result.status, 'submitting');
    assert.equal(result.reconcileRequired, true);
    assert.equal(transport.launches.length, 0, 'the losing controller must not launch');
    assert.equal(store.getJob('job_cas_1')?.status, 'submitting');
    assert.deepEqual(gpu.list(), [], 'the losing controller must not take a GPU lease');
  } finally {
    teamStore.close();
    project.cleanup();
  }
});
