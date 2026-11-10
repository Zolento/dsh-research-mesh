/** A consumed receipt without a Mesh job must reconcile, never retry. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { buildRsiFixture } from '../helpers/rsi.ts';
import { readFileSync } from 'node:fs';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';

test('an interrupted consumed run is marked reconcile-required and is not retried', async () => {
  const project = makeTempProject({ name: 'consumed-recovery' });
  const { service } = await makeService(project);
  const root = mkdtempSync(join(tmpdir(), 'mesh-consumed-journal-'));
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const ledger = join(root, 'ledger');
    mkdirSync(ledger);
    writeFileSync(join(ledger, 'events.jsonl'), `${JSON.stringify({
      kind: 'consume', receipt_id: 'receipt-journal', experiment_id: 'X1', dry_run: false,
    })}\n`);
    const journal = join(root, 'journal.json');
    writeFileSync(journal, JSON.stringify({
      phase: 'consumed', receiptId: 'receipt-journal', experimentId: 'X1',
    }));
    const submitted = service.submitExperimentTask({
      projectId: 'proj-a', teamId: team.teamId, workerId: 'workstation', gpuId: 0,
      rsi: {
        mode: 'consumed', experimentId: 'X1', routeId: 'A',
        statePath: join(project.root, '.research-lifecycle-protocol/routes/A/research-state.json'),
        manifestPath: join(project.root, '.research-lifecycle-protocol/routes/A/rsi-manifest.json'),
        schedulerPath: join(project.root, '.research-lifecycle-protocol/routes/A/scheduler.json'),
        receiptPath: join(project.root, '.research-lifecycle-protocol/routes/A/receipt.json'),
        ledgerPath: ledger,
        shim: { specPath: join(root, 'spec.json'), resultPath: join(root, 'result.json'), journalPath: journal, timeoutMs: 1000 },
      },
    }).task;
    const claim = service.claimNext('worker-cas');
    assert.ok(claim !== undefined);
    service.startTask(submitted.taskId, 'worker-cas', claim.attemptId);
    assert.equal(service.markConsumedInterruptions(), 1);
    assert.equal(service.getTask(submitted.taskId).status, 'RECONCILE_REQUIRED');
    await service.recoverAt(Date.now() + 60 * 60 * 1000);
    assert.equal(service.getTask(submitted.taskId).status, 'RECONCILE_REQUIRED');
    assert.equal(service.listJobs().length, 0);
  } finally {
    await service.close();
    project.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task whose receipt was consumed parks for reconciliation, never retries', async () => {
  const project = makeTempProject({ name: 'consumed-guard' });
  const { service } = await makeService(project, {
    config: { rsi: { enabled: true, skillPath: SKILL, allowTestStub: true, pythonExecutable: 'python3' } },
  });
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const workspace = team.workspacePath as string;
    service.writeWorkspaceFile(team.workspaceId as string, 'experiments/e.py', 'print("x")\n');
    // A fixture builds a real receipt; we then consume it without a Mesh job so
    // the verification failure happens after the spend.
    const fixture = buildRsiFixture(project.root, SKILL, true, { cwd: workspace, argv: ['python3', '-c', 'print(1)'] });
    const task = service.submitExperimentTask({
      projectId: 'proj-a', teamId: team.teamId, workerId: 'workstation', gpuId: 0,
      rsi: { mode: 'consumed', experimentId: 'X1', routeId: 'A', statePath: fixture.state,
             manifestPath: fixture.manifest, schedulerPath: fixture.scheduler,
             receiptPath: fixture.receipt, ledgerPath: fixture.ledger },
    }).task;
    // Corrupt the canonical state so verification fails after the consume.
    writeFileSync(fixture.state, readFileSync(fixture.state, 'utf8').replace('"state_version":', '"state_version": '));
    await service.runWorkerOnce({ poll: false });
    const after = service.getTask(task.taskId);
    assert.equal(after.status, 'RECONCILE_REQUIRED');
    assert.match(after.errorMessage ?? '', /already consumed|reconcile/i);
  } finally {
    await service.close();
    project.cleanup();
  }
});
