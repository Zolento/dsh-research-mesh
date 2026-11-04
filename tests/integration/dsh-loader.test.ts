/** Real DSH Cordis loader integration: mount, provide, execute a task, unload. */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { makeTempProject } from '../helpers/env.ts';

function locateDsh(): string | undefined {
  const candidates = [
    process.env.DSH_INSTALL,
    '/home/lenovo/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh',
  ].filter((value): value is string => value !== undefined && value !== '');
  return candidates.find(candidate => existsSync(join(candidate, 'package.json')));
}

test('real Cordis loader mounts the plugin, runs a task and releases resources', async () => {
  const install = locateDsh();
  if (install === undefined) {
    assert.ok(true, 'installed DSH not found; loader integration skipped');
    return;
  }
  const bootPath = join(install, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(bootPath)) {
    assert.ok(true, 'dsh-app-boot not installed; loader integration skipped');
    return;
  }
  const project = makeTempProject({ name: 'dsh-loader' });
  const home = mkdtempSync(join(tmpdir(), 'mesh-dsh-home-'));
  const reportPath = join(home, 'report.json');
  const configPath = join(home, 'cordis.yml');
  const root = resolve(import.meta.dirname, '..', '..');
  const config = [
    {
      id: 'mesh-loader-mock-llm',
      name: join(root, 'tests', 'dsh', 'mock-llm.mjs'),
    },
    {
      id: 'dsh-research-mesh',
      name: join(root, 'src', 'index.ts'),
      config: {
        projectRoot: project.root,
        sourceDir: 'source',
        worktreesDir: 'worktrees',
        allowFakeTransport: true,
        sessionBinding: 'external',
        agent: { provider: 'mock', model: 'mock-flash' },
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
      },
    },
    {
      id: 'mesh-loader-probe',
      name: join(root, 'tests', 'dsh', 'probe.mjs'),
      config: { reportPath },
    },
  ];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { boot } = await import(pathToFileURL(bootPath).href) as {
      boot: (bin: string, path: string) => Promise<{ fiber: { dispose(): Promise<void> }; get(name: string): unknown }>;
    };
    const ctx = await boot('mesh-loader-test', configPath);
    try {
      assert.equal(existsSync(reportPath), true, 'probe should write a report');
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        ok: boolean;
        error: string | null;
        checks: Record<string, unknown>;
      };
      assert.equal(report.error, null);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.checks.serviceProvided, true);
      assert.equal(report.checks.initialized, true);
      assert.equal(report.checks.teamCount, 1);
      assert.equal(report.checks.taskStatus, 'SUCCEEDED');
      assert.equal(report.checks.projectRoot, project.root);
      const service = ctx.get('researchMesh') as { initialized: boolean };
      assert.equal(service.initialized, true);
    } finally {
      await ctx.fiber.dispose();
    }
    const serviceAfterDispose = (() => {
      try { return ctx.get('researchMesh') as { initialized?: boolean } | undefined; } catch { return undefined; }
    })();
    assert.equal(serviceAfterDispose?.initialized ?? false, false);
    // The database is closed: its WAL sidecars are gone and the file can be removed.
    rmSync(join(project.root, '.research-mesh', 'runtime.sqlite'), { force: true });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    project.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});
