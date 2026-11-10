/** Real consumed-ledger loop: RSI run --execute -> blocking shim -> Mesh wrapper. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { buildRsiFixture } from '../helpers/rsi.ts';
import { prepareShim, shimPaths, SHIM_SPEC_SCHEMA } from '../../src/rsi/blocking-shim.ts';
import { findConsumeEvent } from '../../src/rsi/consumed-run.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';
const EXPERIMENT = `import json, os
out = os.environ["MESH_ARTIFACT_DIR"]
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "run.log"), "w", encoding="utf-8") as handle:
    handle.write(os.environ["MESH_JOB_ID"] + "\\n")
with open(os.path.join(out, "metrics.json"), "w", encoding="utf-8") as handle:
    json.dump({"accuracy": 0.5, "job": os.environ["MESH_JOB_ID"]}, handle)
print("consumed experiment finished")
`;

test('consumed ledger: RSI consumes once, shim blocks, Mesh launches once and ingests', async () => {
  const project = makeTempProject({ name: 'e2e-consumed' });
  const { service } = await makeService(project, {
    config: { rsi: { enabled: true, skillPath: SKILL, allowTestStub: false, pythonExecutable: 'python3' } },
  });
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const workspace = team.workspacePath as string;
    service.writeWorkspaceFile(team.workspaceId as string, 'experiments/mesh_experiment.py', EXPERIMENT);

    const shimRel = '.mesh-shim/consumed-job/consumed-attempt';
    const paths = shimPaths(join(workspace, '.mesh-shim'), 'consumed-job', 'consumed-attempt');
    prepareShim(paths, {
      schema: SHIM_SPEC_SCHEMA,
      job_id: 'consumed-job',
      attempt_id: 'consumed-attempt',
      timeout_seconds: 120,
      poll_ms: 25,
      mode: 'wait',
    });
    execFileSync('git', ['-C', workspace, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'commit', '-q', '-m', 'consumed fixture'], { stdio: 'ignore' });

    const fixture = buildRsiFixture(project.root, SKILL, false, {
      cwd: workspace,
      argv: ['python3', `${shimRel}/rsi_blocking_shim.py`, `${shimRel}/shim-spec.json`],
      extraCode: [
        'experiments/mesh_experiment.py',
        `${shimRel}/rsi_blocking_shim.py`,
        `${shimRel}/shim-spec.json`,
      ],
    });
    const stateDigest = createHash('sha256').update(readFileSync(fixture.state)).digest('hex');
    const authManifest = JSON.parse(readFileSync(fixture.manifest, 'utf8')) as Record<string, unknown>;
    const executionManifestPath = join(project.root, '.research-lifecycle-protocol', 'routes', 'A', 'execution-manifest.json');
    writeFileSync(executionManifestPath, `${JSON.stringify({
      ...authManifest,
      argv: ['python3', 'experiments/mesh_experiment.py'],
    }, null, 2)}\n`);
    execFileSync('git', ['-C', workspace, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'commit', '-q', '-m', 'consumed execution manifest'], { stdio: 'ignore' });

    const task = service.submitExperimentTask({
      projectId: 'proj-a',
      teamId: team.teamId,
      workerId: 'workstation',
      gpuId: 0,
      requiredArtifacts: ['metrics.json', 'run.log'],
      rsi: {
        mode: 'consumed',
        experimentId: 'X1',
        routeId: 'A',
        statePath: fixture.state,
        manifestPath: fixture.manifest,
        executionManifestPath,
        schedulerPath: fixture.scheduler,
        receiptPath: fixture.receipt,
        ledgerPath: fixture.ledger,
        shim: {
          specPath: paths.specPath,
          resultPath: paths.resultPath,
          journalPath: join(project.root, '.research-mesh', 'consumed-journal.json'),
          timeoutMs: 120_000,
        },
      },
    }).task;
    await service.runWorkerOnce({ poll: false });

    let final = service.getTask(task.taskId);
    const deadline = Date.now() + 30_000;
    while (final.status !== 'ASSURANCE_PENDING' && Date.now() < deadline) {
      if (final.status === 'FAILED') break;
      await new Promise(resolve => setTimeout(resolve, 50));
      final = service.getTask(task.taskId);
    }
    assert.equal(final.status, 'ASSURANCE_PENDING', final.errorMessage ?? '');
    const job = service.listJobs()[0];
    assert.equal(job?.status, 'ingested');
    // The consumed-shim collect path must emit the same Artifact event as polling.
    const triggers = service.listTriggers('proj-a');
    assert.ok(
      triggers.some(trigger => trigger.dedupeKey === `artifact:${job?.jobId}`),
      'consumed ingestion must emit one Artifact event',
    );
    const manifest = JSON.parse(readFileSync(join(project.root, '.research-mesh', 'manifests', `${job?.jobId}.json`), 'utf8')) as {
      authorization: { mode: string; verified_by: string };
    };
    assert.equal(manifest.authorization.mode, 'rsi-receipt');
    assert.match(manifest.authorization.verified_by, /execution-ledger\.consume/);
    assert.equal(findConsumeEvent(fixture.ledger, JSON.parse(readFileSync(fixture.receipt, 'utf8')).id, 'X1') !== undefined, true);
    const shim = JSON.parse(readFileSync(paths.resultPath, 'utf8')) as { exit_code: number };
    assert.equal(shim.exit_code, 0);
    const journal = JSON.parse(readFileSync(join(project.root, '.research-mesh', 'consumed-journal.json'), 'utf8')) as { phase: string };
    assert.equal(journal.phase, 'completed');
    assert.equal(createHash('sha256').update(readFileSync(fixture.state)).digest('hex'), stateDigest);
  } finally {
    await service.close();
    project.cleanup();
  }
});
