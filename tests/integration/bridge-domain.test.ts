/** Integration of the copied bridge artifacts/state gate into the Mesh service. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeService, makeTempProject } from '../helpers/env.ts';
import { emptyCanonicalRefs } from '../../src/bridge/research/artifacts.ts';
import { MeshError } from '../../src/errors.ts';

const SKILL = process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/rsi-pipeline';

test('canonical state stays unchanged while proposals are staged and gated', async () => {
  const project = makeTempProject();
  const routeDir = join(project.root, '.research-idea-pipeline', 'routes', 'A');
  mkdirSync(routeDir, { recursive: true });
  const statePath = join(routeDir, 'research-state.json');
  copyFileSync(join(SKILL, 'templates', 'research-state.template.json'), statePath);
  const before = createHash('sha256').update(readFileSync(statePath)).digest('hex');
  const { service } = await makeService(project, { config: { rsi: { enabled: true, skillPath: SKILL, allowTestStub: true, pythonExecutable: 'python3' } } });
  try {
    const team = await service.createTeam({ projectId: 'proj-a', routeId: 'A', name: 'group-a', rootSessionId: 'root-a' });
    const task = service.submitTask({
      projectId: 'proj-a', teamId: team.teamId, type: 'local', title: 'artifact host',
      payload: { entrypoint: 'python3', argv: ['-c', 'print(1)'] },
    }).task;
    const hypothesis = service.stageResearchArtifact(team.teamId, {
      kind: 'hypothesis_proposal',
      teamId: team.teamId,
      taskId: task.taskId,
      attemptId: null,
      producerAgentId: 'agent-discovery',
      producerRole: 'discovery',
      researchRoute: 'R3',
      stateVersion: '0',
      refs: emptyCanonicalRefs(),
      evidenceRefs: [],
      content: {
        statement: 'A matched-capacity adapter explains the cross-centre gap',
        mechanismSketch: 'Measure a covariance correction under matched capacity',
        falsifier: 'Gap remains after the covariance correction',
        islandId: 'P1',
      },
      provenance: { messageIds: [], attemptIds: [], sources: [], executed: false, verdicts: [] },
    });
    const verdict = service.stageResearchArtifact(team.teamId, {
      kind: 'assurance_verdict',
      teamId: team.teamId,
      taskId: task.taskId,
      attemptId: null,
      producerAgentId: 'agent-assurance',
      producerRole: 'assurance',
      researchRoute: 'R7',
      stateVersion: '0',
      refs: emptyCanonicalRefs(),
      evidenceRefs: [],
      content: { targetArtifacts: [hypothesis.artifact_id], verdict: 'pass', reasons: ['independent review'], evidenceValid: true },
      provenance: { messageIds: [], attemptIds: [], sources: [], executed: false, verdicts: [] },
    });
    const proposal = {
      proposal_id: 'prop_mesh_1',
      team_id: team.teamId,
      question: 'which mechanism explains the gap?',
      competingMechanisms: ['capacity', 'covariance'],
      positions: [{
        role: 'discovery' as const, agentId: 'agent-discovery', stance: 'support' as const,
        reason: 'matched capacity isolates the mechanism', messageIds: [],
      }],
      discriminatingPredictions: ['gap falls after covariance correction'],
      evidenceValid: true,
      evidenceRefs: [{
        objectId: 'E1', collection: 'evidence' as const, tier: 'raw_observation' as const,
        source: { kind: 'file' as const, locator: 'runs/x1/summary.json' },
      }],
      cheapestNextIntervention: 'rerun with covariance correction',
      stagnationTriggered: false,
      paradigmEscapeTriggered: false,
      requestedStateChanges: [{
        operation: 'update' as const, collection: 'evidence' as const, objectId: 'E1',
        summary: 'attach outcome', payload: { scope: 'fixture' },
      }],
      artifactRefs: [
        { artifactId: hypothesis.artifact_id, kind: 'hypothesis_proposal' as const },
        { artifactId: verdict.artifact_id, kind: 'assurance_verdict' as const },
      ],
      baseStateVersion: '0',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const staged = await service.stageResearchProposal(team.teamId, proposal);
    assert.ok(staged.stagedPath.includes('rtb-staged'));
    assert.ok(staged.staged.artifact_id.length > 0);
    const evaluated = await service.evaluateResearchProposal(team.teamId, proposal);
    assert.equal(evaluated.outcome, 'hold');
    assert.ok(['NO_LEGAL_WRITER', 'MISSING_ASSURANCE_VERDICT', 'OK'].includes(evaluated.code));
    assert.equal(createHash('sha256').update(readFileSync(statePath)).digest('hex'), before, 'canonical state must not change');
    assert.throws(
      () => service.stageResearchArtifact(team.teamId, {
        kind: 'experiment_result',
        teamId: team.teamId,
        taskId: task.taskId,
        attemptId: null,
        producerAgentId: 'agent-discovery',
        producerRole: 'discovery',
        researchRoute: 'R3',
        stateVersion: '0',
        refs: emptyCanonicalRefs(),
        evidenceRefs: [],
        content: {},
        provenance: { messageIds: [], attemptIds: [], sources: [], executed: false, verdicts: [] },
      }),
      (error: unknown) => error instanceof Error && /may not produce/.test(error.message),
    );
  } finally {
    await service.close();
    project.cleanup();
  }
});
