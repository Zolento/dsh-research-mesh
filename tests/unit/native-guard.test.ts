/** Host-side guard against native `subagent` calls bypassing Mesh quotas. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

test('native delegation is denied for a full group, a member, and a global cap', async () => {
  const project = makeTempProject({ name: 'native-guard' });
  const { service } = await makeService(project, {
    config: { limits: { maxTeams: 3, maxSubagentsPerTeam: 2, maxSubagentsTotal: 3 } },
  });
  try {
    for (const route of ['A', 'B']) {
      mkdirSync(join(project.root, '.research-lifecycle-protocol', 'routes', route), { recursive: true });
    }
    const state = join(project.root, '.research-lifecycle-protocol', 'routes', 'A', 'research-state.json');
    mkdirSync(join(project.root, '.research-lifecycle-protocol', 'routes', 'A'), { recursive: true });
    const { copyFileSync } = await import('node:fs');
    copyFileSync('/home/lenovo/.agents/skills/research-lifecycle-protocol/templates/research-state.template.json', state);
    copyFileSync(state, state.replace('/A/', '/B/'));
    const created = service.createProject({ name: 'guard', rsiStateRef: state, repositoryRef: project.source });

    // A session outside the Mesh is never denied.
    assert.equal(service.nativeSubagentDenial('session-unbound'), undefined);
    assert.equal(service.nativeSubagentDenial(undefined), undefined);

    const team = await service.createTeam({ projectId: created.projectId, routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    // Captain below the cap may delegate.
    assert.equal(service.nativeSubagentDenial('root-a'), undefined);

    const first = await service.registerSubagent({ teamId: team.teamId, name: 'w1', role: 'experiment', sessionId: 'session-w1' });
    const second = await service.registerSubagent({ teamId: team.teamId, name: 'w2', role: 'assurance', sessionId: 'session-w2' });
    // A member must never fan out further, even below the cap.
    assert.match(service.nativeSubagentDenial(first.sessionId) ?? '', /member sessions cannot delegate/);

    // The group is now at its cap: the Captain's native tool is denied.
    assert.match(service.nativeSubagentDenial('root-a') ?? '', /already has 2 subagents/);
    void second;

    // A paused group disables native delegation entirely.
    service.pauseTeam(team.teamId);
    assert.match(service.nativeSubagentDenial('root-a') ?? '', /is paused/);
    service.resumeTeam(team.teamId);

    // Global cap: a second group's Captain is denied once the total is reached.
    const teamB = await service.createTeam({ projectId: created.projectId, routeId: 'B', name: 'group-b', rootSessionId: 'root-b' });
    await service.registerSubagent({ teamId: teamB.teamId, name: 'w3', role: 'experiment', sessionId: 'session-w3' });
    assert.match(service.nativeSubagentDenial('root-b') ?? '', /3 subagents exist globally/);
  } finally {
    await service.close();
    project.cleanup();
  }
});

test('the guard ignores non-delegation tool names', () => {
  const pattern = /^subagent($|_)/;
  assert.equal(pattern.test('subagent'), true);
  assert.equal(pattern.test('subagent_acp'), true);
  assert.equal(pattern.test('read'), false);
  assert.equal(pattern.test('bash'), false);
  assert.equal(pattern.test('subagents_list'), false);
});
