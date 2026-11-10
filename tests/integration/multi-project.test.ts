/** One Mesh, several independent projects: each project owns its control plane. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeService, makeTempProject } from '../helpers/env.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH
  ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';

function seedState(root: string): string {
  const dir = join(root, '.research-lifecycle-protocol', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), path);
  return path;
}

test('two independent repositories both become runnable projects with their own control dirs', async () => {
  const first = makeTempProject({ name: 'multi-a' });
  const second = makeTempProject({ name: 'multi-b' });
  const { service } = await makeService(first);
  try {
    const a = service.createProject({
      name: 'project-a', rsiStateRef: seedState(first.root), repositoryRef: first.source,
    });
    const b = service.createProject({
      name: 'project-b', rsiStateRef: seedState(second.root), repositoryRef: second.source,
    });

    assert.equal(a.runnable, true, 'a whole-repository project must be runnable');
    assert.equal(b.runnable, true, 'a second repository must also be runnable');
    assert.notEqual(a.controlDir, b.controlDir);
    assert.ok(a.controlDir !== null && a.controlDir.includes('projects'));
    assert.equal(a.sourceDir, first.source);
    assert.equal(b.sourceDir, second.source);

    // Each project can create its own group and worktree.
    const teamA = await service.createTeam({ projectId: a.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const teamB = await service.createTeam({ projectId: b.projectId, routeId: 'A', name: 'group-b', rootSessionId: 'root-b' });
    assert.equal(teamA.researchProjectId, a.projectId);
    assert.equal(teamB.researchProjectId, b.projectId);
    assert.notEqual(teamA.workspacePath, teamB.workspacePath);

    const listed = service.listProjects();
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map(p => p.status).sort(), ['active', 'active']);
    assert.equal(existsSync(join(first.root, '..')), true);
  } finally {
    await service.close();
    first.cleanup();
    second.cleanup();
  }
});
