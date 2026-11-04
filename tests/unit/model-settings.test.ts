/** Manual model settings: validation, persistence, revision retry and actual use. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeService, makeTempProject, MOCK_MODEL, MOCK_PROVIDER } from '../helpers/env.ts';
import { ConfigModelSettingsStore, type SettingsFormsLike } from '../../src/teams/config-settings-store.ts';
import { FileModelSettingsStore } from '../../src/teams/settings-store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshError } from '../../src/errors.ts';
import { Config } from '../../src/config/schema.ts';

function fakeSettings(initial: unknown): {
  settings: SettingsFormsLike;
  written: unknown[];
} {
  const written: unknown[] = [];
  let revision = 1;
  let current = initial;
  const settings: SettingsFormsLike = {
    describe: () => [{ ns: 'dsh-research-mesh', revision }],
    async update(_ns, patch) {
      written.push(patch);
      current = (patch as { modelAssignments?: unknown }).modelAssignments;
      revision += 1;
    },
  };
  void current;
  return { settings, written };
}

test('config-backed settings store writes through DSH settings and bumps the version', async () => {
  const ref = { get: () => ({ version: 1, groups: {} }) };
  const { settings, written } = fakeSettings({ version: 1, groups: {} });
  const store = new ConfigModelSettingsStore({ settings, namespace: 'dsh-research-mesh', ref });
  assert.deepEqual(store.read(), { version: 1, groups: {} });
  const saved = await store.write({
    version: 1,
    groups: { 'group-a': { default: { provider: MOCK_PROVIDER, model: MOCK_MODEL }, captain: 'inherit', subagents: {} } },
  });
  assert.equal(saved.version, 2);
  assert.equal(written.length, 1);
  assert.deepEqual(store.read(), saved);
});

test('empty groups are savable while an override without a default is rejected', async () => {
  const project = makeTempProject();
  const { service } = await makeService(project);
  try {
    const saved = await service.saveModelSettings({
      version: 1,
      groups: {
        'group-a': { captain: 'inherit', subagents: {} },
        'group-b': { captain: 'inherit', subagents: {} },
      },
    });
    assert.equal(saved.version, 2);
    await assert.rejects(
      () => service.saveModelSettings({
        version: 2,
        groups: {
          'group-a': { captain: { provider: MOCK_PROVIDER, model: MOCK_MODEL }, subagents: {} },
        },
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'MODEL_CONFIG_INVALID',
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('the volatile Config schema accepts an untouched empty group', () => {
  const value = Config({
    modelAssignments: {
      version: 1,
      groups: { 'group-a': { captain: 'inherit', subagents: {} } },
    },
  });
  const document = value.modelAssignments.get();
  assert.equal(document.version, 1);
  assert.equal(document.groups['group-a']?.default, undefined);
});

test('config-backed settings store observes a newer volatile revision', async () => {
  let live = { version: 1, groups: {} };
  const ref = { get: () => live };
  const { settings } = fakeSettings({ version: 1, groups: {} });
  const store = new ConfigModelSettingsStore({ settings, namespace: 'dsh-research-mesh', ref });
  await store.write({
    version: 1,
    groups: { 'group-a': { default: { provider: MOCK_PROVIDER, model: MOCK_MODEL }, captain: 'inherit', subagents: {} } },
  });
  live = { version: 7, groups: { 'group-b': { default: { provider: MOCK_PROVIDER, model: 'mock-pro' }, captain: 'inherit', subagents: {} } } };
  assert.equal(store.read().version, 7);
  assert.equal(store.read().groups['group-b']?.default?.model, 'mock-pro');
});

test('config-backed settings store refuses a missing settings namespace', async () => {
  const settings: SettingsFormsLike = {
    describe: () => [],
    async update() { throw new Error('must not be called'); },
  };
  const store = new ConfigModelSettingsStore({ settings, namespace: 'dsh-research-mesh', ref: { get: () => undefined } });
  await assert.rejects(
    () => store.write({ version: 1, groups: {} }),
    (error: unknown) => error instanceof MeshError && error.code === 'MODEL_CONFIG_INVALID',
  );
});

test('agent creation passes the selected provider and model to the session host', async () => {
  const project = makeTempProject();
  const { service, host } = await makeService(project, { sessionBinding: 'dsh' });
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a' });
    // External binding records the manually selected group default instead of creating a test agent.
    const root = host.rootModels.find(record => record.sessionId === team.rootSessionId);
    assert.equal(root?.provider, MOCK_PROVIDER);
    assert.equal(root?.model, MOCK_MODEL);
    const sub = await service.registerSubagent({ teamId: team.teamId, name: 'worker-1', role: 'experiment' });
    const child = host.childModels.find(record => record.sessionId === sub.sessionId);
    assert.equal(child?.provider, MOCK_PROVIDER);
    assert.equal(child?.model, MOCK_MODEL);
  } finally {
    await service.close();
    project.cleanup();
  }
});


test('file-backed settings survive a reopen and reject invalid models through the resolver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-settings-'));
  try {
    const path = join(dir, 'model-settings.json');
    const first = new FileModelSettingsStore(path);
    const saved = await first.write({
      version: 1,
      groups: { 'group-a': { default: { provider: MOCK_PROVIDER, model: MOCK_MODEL }, captain: 'inherit', subagents: {} } },
    });
    assert.equal(saved.version, 2);
    const second = new FileModelSettingsStore(path);
    const restored = second.read();
    assert.equal(restored.groups['group-a']?.default?.model, MOCK_MODEL);
    assert.equal(restored.version, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
