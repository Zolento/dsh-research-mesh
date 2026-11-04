/** Manifest validation, Conda argv, shell safety and artifact-manifest parsing. */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeConfig, makeTempProject } from '../helpers/env.ts';
import { MeshError } from '../../src/errors.ts';
import { validateManifest, type JobManifest } from '../../src/executors/manifest.ts';
import { buildCondaArgv, buildWrapperScript, ARTIFACT_MANIFEST_PY } from '../../src/executors/wrapper.ts';
import { parseArtifactManifest } from '../../src/executors/transport.ts';
import { runProcess } from '../../src/util/shell.ts';

function baseManifest(project: ReturnType<typeof makeTempProject>, overrides: Partial<JobManifest> = {}): JobManifest {
  return {
    schema: 'dsh-research-mesh/job-manifest@1',
    job_id: 'job_test_1',
    attempt_id: 'attempt_test_1',
    project_id: 'proj-a',
    team_id: 'team-a',
    workspace_id: 'ws-a',
    code: { commit: project.commit },
    execution: {
      entrypoint: 'python3',
      argv: ['-c', 'print("ok")'],
      working_directory: '.',
      conda_environment: 'mesh-test',
    },
    resources: { worker_id: 'workstation', gpu_id: 0 },
    artifacts: { destination: 'artifacts' },
    authorization: {
      mode: 'none',
      rsi_receipt_ref: null,
      research_state_version: null,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('Conda launch argv is exact and shell-free', () => {
  assert.deepEqual(
    buildCondaArgv({ executable: '/opt/conda/bin/conda', defaultEnvironment: 'x' }, 'research', 'python', ['a b', '$(x)']),
    ['/opt/conda/bin/conda', 'run', '-n', 'research', '--no-capture-output', 'python', 'a b', '$(x)'],
  );
});

test('manifest validation rejects traversal, absolute entrypoints and forged digests', () => {
  const project = makeTempProject();
  const config = makeConfig(project);
  try {
    assert.throws(
      () => validateManifest({
        ...baseManifest(project),
        execution: { entrypoint: '../../evil', argv: [], working_directory: '.', conda_environment: 'x' },
      }, config),
      (error: unknown) => error instanceof MeshError && error.code === 'MANIFEST_INVALID',
    );
    assert.throws(
      () => validateManifest({
        ...baseManifest(project),
        execution: { entrypoint: '/usr/bin/python3', argv: [], working_directory: '.', conda_environment: 'x' },
      }, config),
      (error: unknown) => error instanceof MeshError && error.code === 'MANIFEST_INVALID',
    );
    assert.throws(
      () => validateManifest({
        ...baseManifest(project),
        resources: { worker_id: 'workstation', gpu_id: 9 },
      }, config),
      (error: unknown) => error instanceof MeshError && error.code === 'MANIFEST_INVALID',
    );
    assert.throws(
      () => validateManifest({ ...baseManifest(project), manifest_sha256: '0'.repeat(64) }, config),
      (error: unknown) => error instanceof MeshError && error.code === 'MANIFEST_INVALID',
    );
  } finally {
    project.cleanup();
  }
});

test('test-stub authorization is refused unless explicitly enabled', () => {
  const project = makeTempProject();
  const config = makeConfig(project, { rsi: { enabled: false, allowTestStub: false } });
  try {
    assert.throws(
      () => validateManifest({
        ...baseManifest(project),
        authorization: {
          mode: 'test-stub',
          rsi_receipt_ref: 'receipts/r.json',
          research_state_version: '1',
          rsi_receipt_digest: 'a'.repeat(64),
        },
      }, config),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_TEST_STUB_FORBIDDEN',
    );
  } finally {
    project.cleanup();
  }
});

test('the generated wrapper quotes hostile argv and produces a verified artifact manifest', async () => {
  const project = makeTempProject();
  const config = makeConfig(project);
  const marker = join(project.root, 'pwned');
  const jobDir = join(project.root, 'job');
  mkdirSync(join(jobDir, 'source'), { recursive: true });
  mkdirSync(join(jobDir, 'artifact'), { recursive: true });
  try {
    const payload = `import os,sys\nopen(os.path.join(os.environ["MESH_ARTIFACT_DIR"],"args.txt"),"w").write(repr(sys.argv[1:]))\n`;
    const manifest = validateManifest(baseManifest(project, {
      execution: { entrypoint: 'python3', argv: ['-c', payload, `$(touch ${marker})`], working_directory: '.', conda_environment: 'mesh-test' },
    }), config);
    const wrapper = buildWrapperScript({ manifest, jobDir, conda: config.conda, gpuId: 0 });
    writeFileSync(join(jobDir, 'run.sh'), wrapper, { mode: 0o700 });
    chmodSync(join(jobDir, 'run.sh'), 0o700);
    writeFileSync(join(jobDir, 'artifact_manifest.py'), ARTIFACT_MANIFEST_PY);
    const result = await runProcess({ command: 'bash', args: [join(jobDir, 'run.sh')], cwd: jobDir, timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(marker), false, 'argv must never be evaluated as shell code');
    const state = JSON.parse(readFileSync(join(jobDir, 'state', 'job-state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(state.status, 'succeeded');
    assert.equal(state.exit_code, 0);
    const manifestRaw = readFileSync(join(jobDir, 'artifacts', 'artifact-manifest.json'), 'utf8');
    const parsed = JSON.parse(manifestRaw) as Record<string, unknown>;
    const artifact = parseArtifactManifest(manifestRaw, {
      jobId: manifest.job_id,
      attemptId: manifest.attempt_id,
      manifestDigest: manifest.manifest_sha256 as string,
    });
    assert.ok(artifact.files.some(file => file.path === 'args.txt'));
    const args = readFileSync(join(jobDir, 'artifacts', 'args.txt'), 'utf8');
    assert.ok(args.includes('$(touch'), 'the argument is data, not shell syntax');
    assert.equal(parsed.status, 'complete');
  } finally {
    project.cleanup();
  }
});

test('artifact manifests reject path escape, duplicate paths and invalid hashes', () => {
  const good = {
    schema: 'dsh-research-mesh/artifact-manifest@1',
    job_id: 'job-1',
    attempt_id: 'attempt-1',
    manifest_sha256: 'a'.repeat(64),
    status: 'complete',
    created_at: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'metrics.json', sha256: 'b'.repeat(64), size_bytes: 2 }],
    total_bytes: 2,
  };
  const expected = { jobId: 'job-1', attemptId: 'attempt-1', manifestDigest: 'a'.repeat(64) };
  assert.equal(parseArtifactManifest(JSON.stringify(good), expected).files.length, 1);
  assert.throws(
    () => parseArtifactManifest(JSON.stringify({ ...good, files: [{ path: '../escape', sha256: 'b'.repeat(64), size_bytes: 1 }] }), expected),
    (error: unknown) => error instanceof MeshError && error.code === 'PATH_ESCAPE',
  );
  assert.throws(
    () => parseArtifactManifest(JSON.stringify({ ...good, files: [good.files[0], good.files[0]] }), expected),
    (error: unknown) => error instanceof MeshError && error.code === 'ARTIFACT_INVALID',
  );
  assert.throws(
    () => parseArtifactManifest(JSON.stringify({ ...good, files: [{ path: 'x', sha256: 'nope', size_bytes: 1 }] }), expected),
    (error: unknown) => error instanceof MeshError && error.code === 'ARTIFACT_INVALID',
  );
});
