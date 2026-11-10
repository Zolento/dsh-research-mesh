/** Host HTTP API over the real Mesh service, with a real loopback server. */

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { createMeshApiHandler } from '../../src/host/web-api.ts';

const SKILL = process.env.RLP_SKILL_PATH ?? process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/research-lifecycle-protocol';
const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

function statePath(root: string): string {
  const dir = join(root, '.research-lifecycle-protocol', 'routes', 'A');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), path);
  return path;
}

async function baseUrl(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void handler(req, res) });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

test('bootstrap, project creation, workbench and same-origin mutation protection', async () => {
  const project = makeTempProject({ name: 'web-api' });
  const { service } = await makeService(project);
  try {
    const base = await baseUrl(createMeshApiHandler(service));
    const bootstrap = await (await fetch(`${base}/dsh-research-mesh/api/bootstrap`)).json() as { ok: boolean; value: { projects: unknown[] } };
    assert.equal(bootstrap.ok, true);
    assert.deepEqual(bootstrap.value.projects, []);

    const state = statePath(project.root);
    const createdResponse = await fetch(`${base}/dsh-research-mesh/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Web API project', description: 'fixture', rsiStateRef: state, repositoryRef: project.source }),
    });
    const created = await createdResponse.json() as { ok: boolean; value: { projectId: string } };
    assert.equal(created.ok, true);
    assert.equal(created.value.projectId.length > 0, true);

    const unknownGroup = await fetch(`${base}/dsh-research-mesh/api/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj_missing', routeId: 'A', name: 'orphan' }),
    });
    assert.equal(unknownGroup.status, 404);
    const team = await service.createTeam({ projectId: created.value.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    for (const [action, status] of [['pause', 'paused'], ['stop', 'stopped'], ['resume', 'active']] as const) {
      const response = await fetch(`${base}/dsh-research-mesh/api/groups/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: team.teamId, action }),
      });
      const payload = await response.json() as { ok: boolean; value: { team: { status: string } } };
      assert.equal(response.status, 200);
      assert.equal(payload.value.team.status, status);
    }
    const destroyNoConfirm = await fetch(`${base}/dsh-research-mesh/api/groups/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: team.teamId, action: 'destroy' }),
    });
    assert.equal(destroyNoConfirm.status, 400);
    const workbenchResponse = await (await fetch(`${base}/dsh-research-mesh/api/workbench?projectId=${created.value.projectId}`)).json() as { ok: boolean; value: { project: { name: string }; groups: unknown[]; rsi: { available: boolean } } };
    assert.equal(workbenchResponse.ok, true);
    assert.equal(workbenchResponse.value.project.name, 'Web API project');
    assert.equal(workbenchResponse.value.groups.length, 1);
    assert.equal(workbenchResponse.value.rsi.available, true);

    const crossOrigin = await fetch(`${base}/dsh-research-mesh/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);

    const wrongType = await fetch(`${base}/dsh-research-mesh/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(wrongType.status, 415);

    const simulation = await (await fetch(`${base}/dsh-research-mesh/api/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.value.projectId, teamId: team.teamId }),
    })).json() as { ok: boolean; value: { status: string } };
    assert.equal(simulation.ok, true);
    assert.equal(simulation.value.status, 'SUCCEEDED');
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('model settings route validates against the live catalog and never returns a key', async () => {
  const project = makeTempProject({ name: 'web-api-models' });
  const { service } = await makeService(project);
  try {
    const base = await baseUrl(createMeshApiHandler(service));
    const settings = await (await fetch(`${base}/dsh-research-mesh/api/model-settings`)).json() as {
      ok: boolean;
      value: { document: unknown; catalog: { provider: string; model: string }[]; errors: unknown[] };
    };
    assert.equal(settings.ok, true);
    assert.equal(settings.value.catalog.length >= 2, true);
    assert.equal(JSON.stringify(settings).includes('apiKey'), false);
    assert.equal(JSON.stringify(settings).includes('secret'), false);

    const saved = await (await fetch(`${base}/dsh-research-mesh/api/model-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        document: {
          version: 1,
          groups: {
            'group-a': { default: { provider: 'mock', model: 'mock-flash' }, captain: 'inherit', subagents: {} },
          },
        },
      }),
    })).json() as { ok: boolean; value: { document: { version: number } } };
    assert.equal(saved.ok, true);
    assert.ok(saved.value.document.version > 1);

    const invalid = await fetch(`${base}/dsh-research-mesh/api/model-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        document: { version: 3, groups: { 'group-a': { default: { provider: 'mock', model: 'deleted' } } } },
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await service.close();
    project.cleanup();
  }
});

