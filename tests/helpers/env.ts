/** Shared local fixtures: temp Git project, fake conda, test session host. */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveConfig } from '../../src/config/index.ts';
import type { MeshConfig } from '../../src/config/types.ts';
import type { CreateRootSessionInput, CreateSubagentIdentityInput, SessionHost } from '../../src/teams/session-host.ts';
import { StaticModelCatalog } from '../../src/dsh/model-catalog.ts';
import { MemoryModelSettingsStore, type ModelSettingsDocument } from '../../src/teams/models.ts';

export const MOCK_PROVIDER = 'mock';
export const MOCK_MODEL = 'mock-flash';

export interface TempProject {
  readonly root: string;
  readonly source: string;
  readonly fakeRemote: string;
  readonly conda: string;
  readonly commit: string;
  cleanup(): void;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Create a disposable Git-backed research project with one committed script.
 * @param options - extra files to commit, keyed by project-relative path.
 * @returns fixture handles.
 */
export function makeTempProject(options: {
  files?: Readonly<Record<string, string>>;
  name?: string;
} = {}): TempProject {
  const root = mkdtempSync(join(tmpdir(), `mesh-${options.name ?? 'test'}-`));
  const source = join(root, 'source');
  const fakeRemote = join(root, 'fake-remote');
  mkdirSync(source, { recursive: true });
  mkdirSync(join(source, 'experiments'), { recursive: true });
  writeFileSync(join(source, 'experiments', 'metrics.py'), [
    'import json, os, sys',
    'out = os.environ.get("MESH_ARTIFACT_DIR", ".")',
    'os.makedirs(out, exist_ok=True)',
    'with open(os.path.join(out, "metrics.json"), "w", encoding="utf-8") as f:',
    '    json.dump({"accuracy": 0.91, "argv": sys.argv[1:]}, f)',
    'print("metrics written", os.environ.get("MESH_JOB_ID", "no-job"))',
    '',
  ].join('\n'));
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const target = join(source, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  git(source, ['init', '-q']);
  git(source, ['config', 'user.email', 'mesh@test.invalid']);
  git(source, ['config', 'user.name', 'Mesh Test']);
  git(source, ['add', '-A']);
  git(source, ['commit', '-q', '-m', 'fixture']);
  const commit = git(source, ['rev-parse', 'HEAD']);
  const conda = join(root, 'fake-conda');
  writeFileSync(conda, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "${1:-}" = "run" ]; then',
    '  shift',
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      -n) shift 2 ;;',
    '      --no-capture-output) shift ;;',
    '      *) break ;;',
    '    esac',
    '  done',
    'fi',
    'exec "$@"',
    '',
  ].join('\n'));
  chmodSync(conda, 0o755);
  return {
    root,
    source,
    fakeRemote,
    conda,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Resolve a Mesh config against a temp project and fake transport. */
export function makeConfig(project: TempProject, overrides: Record<string, unknown> = {}): MeshConfig {
  return resolveConfig({
    projectRoot: project.root,
    sourceDir: 'source',
    worktreesDir: 'worktrees',
    modelSettingsPath: join(project.root, '.research-mesh', 'model-settings.json'),
    allowFakeTransport: true,
    conda: { executable: project.conda, defaultEnvironment: 'mesh-test' },
    workers: {
      workstation: {
        transport: 'fake',
        enabled: true,
        gpuIds: [0, 1],
        maxGpuJobs: 2,
        condaEnvironment: 'mesh-test',
        fakeRemoteRoot: project.fakeRemote,
      },
    },
    rsi: { enabled: false, allowTestStub: true },
    ...overrides,
  });
}

/** Deterministic root/subagent session binding for host-free tests. */
export class TestSessionHost implements SessionHost {
  readonly binding = 'test' as const;
  readonly roots: string[] = [];
  readonly children: string[] = [];
  readonly rootModels: { sessionId: string; provider?: string; model?: string }[] = [];
  readonly childModels: { sessionId: string; provider?: string; model?: string }[] = [];
  disposed: string[] = [];

  async createRoot(input: CreateRootSessionInput): Promise<{ sessionId: string }> {
    const sessionId = `test-root-${input.name}-${this.roots.length + 1}`;
    this.roots.push(sessionId);
    this.rootModels.push({ sessionId, provider: input.provider, model: input.model });
    return { sessionId };
  }

  async createControl(input: CreateRootSessionInput): Promise<{ sessionId: string }> {
    const sessionId = `test-control-${input.name}-${this.roots.length + 1}`;
    this.roots.push(sessionId);
    this.rootModels.push({ sessionId, provider: input.provider, model: input.model });
    return { sessionId };
  }

  async createSubagent(input: CreateSubagentIdentityInput): Promise<{ sessionId: string }> {
    const sessionId = `test-sub-${input.name}-${this.children.length + 1}`;
    this.children.push(sessionId);
    this.childModels.push({ sessionId, provider: input.provider, model: input.model });
    return { sessionId };
  }

  async resumeRoot(sessionId: string): Promise<void> {
    if (!this.roots.includes(sessionId)) this.roots.push(sessionId);
  }

  async disposeRoot(sessionId: string): Promise<void> {
    this.disposed.push(sessionId);
  }

  async disposeAll(): Promise<void> {
    this.disposed.push(...this.roots, ...this.children);
  }
}

/** Model catalog and settings fixture with one provider/model. */
export function makeModelFixture(groups: readonly string[] = ['group-a', 'group-b', 'group-c']): {
  catalog: StaticModelCatalog;
  settings: MemoryModelSettingsStore;
} {
  const catalog = new StaticModelCatalog([
    { provider: MOCK_PROVIDER, providerName: 'Mock Provider', model: MOCK_MODEL, modelName: 'Mock Flash' },
    { provider: MOCK_PROVIDER, providerName: 'Mock Provider', model: 'mock-pro', modelName: 'Mock Pro' },
  ]);
  const document: ModelSettingsDocument = {
    version: 1,
    groups: Object.fromEntries(groups.map(group => [group, {
      default: { provider: MOCK_PROVIDER, model: MOCK_MODEL },
      captain: 'inherit' as const,
      subagents: {},
    }])),
  };
  return { catalog, settings: new MemoryModelSettingsStore(document) };
}

/** Build an initialized service with deterministic host seams. */
export async function makeService(project: TempProject, options: {
  config?: Record<string, unknown>;
  groups?: readonly string[];
  sessionBinding?: 'external' | 'dsh';
  gpuProbe?: import('../../src/resources/gpu.ts').GpuProbe;
  transport?: import('../../src/executors/transport.ts').JobTransport;
} = {}): Promise<{
  service: import('../../src/service.ts').MeshService;
  host: TestSessionHost;
  models: ReturnType<typeof makeModelFixture>;
  project: TempProject;
}> {
  const { MeshService } = await import('../../src/service.ts');
  const { createLogger } = await import('../../src/util/logger.ts');
  const { StaticGpuProbe } = await import('../../src/resources/gpu.ts');
  const config = makeConfig(project, {
    sessionBinding: options.sessionBinding ?? 'external',
    ...options.config,
  });
  const models = makeModelFixture(options.groups ?? ['group-a', 'group-b', 'group-c']);
  const host = new TestSessionHost();
  const service = new MeshService({
    config,
    logger: createLogger('error'),
    sessionHost: host,
    modelCatalog: models.catalog,
    modelSettings: models.settings,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    gpuProbe: options.gpuProbe ?? new StaticGpuProbe({
      'workstation:0': 'available',
      'workstation:1': 'available',
    }),
  });
  await service.init();
  return { service, host, models, project };
}
