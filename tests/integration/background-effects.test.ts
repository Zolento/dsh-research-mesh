/** Background scheduler loop drains durable effects without a second scheduler. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { makeService, makeTempProject } from '../helpers/env.ts';

test('start() drains observe-mode notices and stops cleanly', async () => {
  const project = makeTempProject({ name: 'bg-effects' });
  const { service } = await makeService(project, { config: { limits: { schedulerPollMs: 100 } } });
  try {
    const trigger = service.recordTrigger({
      source: 'compute_job', eventId: 'job-bg-1', projectId: 'proj-bg',
      kind: 'compute_job_completed', payload: { jobId: 'job-bg-1' },
    });
    assert.equal(trigger.disposition, 'candidate');
    assert.equal(service.listTriggers('proj-bg').length, 1);
    assert.ok(service.listEffects('pending').length >= 1, 'a notice must be queued');

    service.startScheduler();
    service.startScheduler(); // idempotent: a second start must not add a timer

    const deadline = Date.now() + 8_000;
    while (service.listEffects('pending').length > 0 && Date.now() < deadline) await delay(50);
    assert.equal(service.listEffects('pending').length, 0, 'background tick must drain the queue');
    assert.ok(service.listEffects('succeeded').some(row => row.kind === 'notice'));

    await service.stopScheduler();
  } finally {
    await service.close();
    project.cleanup();
  }
});
