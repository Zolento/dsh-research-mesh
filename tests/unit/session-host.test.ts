/** Controller-backed session creation for the group harness. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DshSessionHost, type DshSessionControllerLike, type DshWorkspaceControllerLike } from '../../src/teams/session-host.ts';

function fakeController(): { controller: DshSessionControllerLike; calls: unknown[] } {
  const calls: unknown[] = [];
  let next = 0;
  return {
    calls,
    controller: {
      async create(request) {
        calls.push({ method: 'create', request });
        next += 1;
        return { sessionId: `session-${next}` };
      },
      async selectModel(request) {
        calls.push({ method: 'selectModel', request });
        return {};
      },
    },
  };
}

function fakeWorkspace(): { workspace: DshWorkspaceControllerLike; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    workspace: {
      async create(request) {
        calls.push({ method: 'create', request });
        return { workspace: { workspaceId: 'workspace-1' } };
      },
    },
  };
}

test('a member session can be created through the controller without a live Captain', async () => {
  const { controller, calls } = fakeController();
  const { workspace } = fakeWorkspace();
  const host = new DshSessionHost({ sessionController: controller, workspaceController: workspace });
  const created = await host.createSubagent({
    teamId: 'team-1',
    rootSessionId: 'session-captain',
    name: 'worker-1',
    role: 'experiment',
    cwd: '/tmp/group-a-worktree',
    provider: 'mock',
    model: 'mock-flash',
  });
  assert.equal(created.sessionId, 'session-1');
  assert.deepEqual(calls, [
    { method: 'create', request: { workspaceId: 'workspace-1' } },
    { method: 'selectModel', request: { sessionId: 'session-1', provider: 'mock', model: 'mock-flash' } },
  ]);
});

test('a model-selection failure discards the controller session instead of leaving an orphan', async () => {
  const cancelled: string[] = [];
  const controller: DshSessionControllerLike = {
    async create() { return { sessionId: 'session-bad' }; },
    async selectModel() { throw new Error('model route rejected'); },
  };
  const host = new DshSessionHost({
    sessionController: controller,
    agents: {
      async create() { throw new Error('not used'); },
      async resume() { throw new Error('not used'); },
      get(id: string) { return { id, cancel() { cancelled.push(id); } }; },
    },
  });
  await assert.rejects(
    () => host.createRoot({
      teamId: 'team-1', projectId: 'proj-1', name: 'group-a', cwd: '/tmp/group-a', title: 'group-a',
      provider: 'mock', model: 'missing',
    }),
    /model route rejected/,
  );
  assert.deepEqual(cancelled, ['session-bad']);
});

test('late Attached AgentRegistry is used when the host activates it after the plugin', async () => {
  const created: unknown[] = [];
  const agents = {
    async create(options: unknown) {
      created.push(options);
      return { agent: { id: 'session-child' }, dispose: async () => {} };
    },
    async resume() { return { agent: { id: 'session-child' }, dispose: async () => {} }; },
    get(id: string) { return { id }; },
  };
  const host = new DshSessionHost({});
  host.attachAgents(agents);
  const child = await host.createSubagent({
    teamId: 'team-1', rootSessionId: 'session-captain', name: 'worker-1', role: 'experiment',
    cwd: '/tmp/group-a-worktree', provider: 'mock', model: 'mock-flash',
  });
  assert.ok(child.sessionId.startsWith('mesh-worker-1-'));
  assert.equal(created.length, 1);
});
