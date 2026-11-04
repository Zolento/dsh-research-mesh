/** Git worktree isolation, path boundaries and explicit cleanup. */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { MeshError } from '../../src/errors.ts';

test('three groups get independent worktrees and cannot pollute the source baseline', async () => {
  const project = makeTempProject({ files: { 'experiments/shared.txt': 'baseline\n' } });
  const { service } = await makeService(project);
  try {
    const teams = [];
    for (const name of ['group-a', 'group-b', 'group-c']) {
      teams.push(await service.createTeam({ projectId: 'proj-a', routeId: name, name, rootSessionId: `root-${name}` }));
    }
    assert.equal(new Set(teams.map(team => team.workspacePath)).size, 3);
    const [a, b] = teams;
    assert.ok(a?.workspaceId !== null && b?.workspaceId !== null);
    service.writeWorkspaceFile(a.workspaceId as string, 'experiments/shared.txt', 'group a\n');
    service.writeWorkspaceFile(b.workspaceId as string, 'experiments/shared.txt', 'group b\n');
    assert.equal(service.readWorkspaceFile(a.workspaceId as string, 'experiments/shared.txt'), 'group a\n');
    assert.equal(service.readWorkspaceFile(b.workspaceId as string, 'experiments/shared.txt'), 'group b\n');
    assert.equal(readFileSync(join(project.source, 'experiments/shared.txt'), 'utf8'), 'baseline\n');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('rejects an existing worktree directory instead of overwriting it', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    mkdirSync(join(project.root, 'worktrees', 'group-x'), { recursive: true });
    writeFileSync(join(project.root, 'worktrees', 'group-x', 'user.txt'), 'keep me\n');
    await assert.rejects(
      () => service.createTeam({ projectId: 'proj-a', routeId: 'X', name: 'group-x', rootSessionId: 'root-x' }),
      (error: unknown) => error instanceof MeshError && error.code === 'WORKSPACE_EXISTS',
    );
    assert.equal(readFileSync(join(project.root, 'worktrees', 'group-x', 'user.txt'), 'utf8'), 'keep me\n');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('path traversal and symlink escape are refused', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const workspaceId = team.workspaceId as string;
    assert.throws(
      () => service.writeWorkspaceFile(workspaceId, '../escaped.txt', 'no'),
      (error: unknown) => error instanceof MeshError && error.code === 'PATH_ESCAPE',
    );
    assert.throws(
      () => service.writeWorkspaceFile(workspaceId, '/tmp/escaped.txt', 'no'),
      (error: unknown) => error instanceof MeshError && error.code === 'PATH_ESCAPE',
    );
    const link = join(team.workspacePath as string, 'outside-link');
    symlinkSync(join(project.source, 'experiments', 'metrics.py'), link);
    assert.throws(
      () => service.writeWorkspaceFile(workspaceId, 'outside-link', 'overwritten'),
      (error: unknown) => error instanceof MeshError && error.code === 'PATH_ESCAPE',
    );
    assert.equal(existsSync(join(project.source, 'escaped.txt')), false);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('cleanup requires confirmation and refuses a dirty worktree without force', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const workspaceId = team.workspaceId as string;
    service.writeWorkspaceFile(workspaceId, 'experiments/metrics.py', '# dirty\n');
    await assert.rejects(
      () => service.cleanupWorkspace(workspaceId, { confirm: true }),
      (error: unknown) => error instanceof MeshError && error.code === 'WORKSPACE_CLEANUP_REFUSED',
    );
    await service.destroyTeam(team.teamId);
    await assert.rejects(
      () => service.cleanupWorkspace(workspaceId, { confirm: true }),
      (error: unknown) => error instanceof MeshError && error.code === 'WORKSPACE_DIRTY',
    );
    assert.ok(existsSync(team.workspacePath as string));
    const result = await service.cleanupWorkspace(workspaceId, { confirm: true, force: true });
    assert.equal(result.removed, true);
    assert.equal(existsSync(team.workspacePath as string), false);
    assert.ok(existsSync(project.source));
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('unknown workspace cleanup is refused and a reopened service recognises worktrees', async () => {
  const project = makeTempProject();
  const first = await makeService(project);
  let workspaceId = '';
  try {
    const team = await first.service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    workspaceId = team.workspaceId as string;
    await assert.rejects(
      () => first.service.cleanupWorkspace('ws_missing', { confirm: true }),
      (error: unknown) => error instanceof MeshError && error.code === 'WORKSPACE_MISSING',
    );
    await first.service.close();
    const second = await makeService(project);
    try {
      const inspection = await second.service.inspectWorkspace(workspaceId);
      assert.equal(inspection.valid, true);
      assert.equal(inspection.exists, true);
      assert.equal(inspection.record.status, 'active');
    } finally {
      await second.service.close();
    }
  } finally {
    project.cleanup();
  }
});
