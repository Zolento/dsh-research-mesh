/** Whole-repository project configuration (repo root === source root). */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertGitSource, resolveConfig } from '../../src/config/index.ts';

test('a whole Git checkout can be the project and source root', () => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-whole-'));
  try {
    mkdirSync(join(root, '.git'));
    const config = resolveConfig({
      projectRoot: root,
      sourceDir: '.',
      controlDir: join(root, '..', `.mesh-control-${process.pid}`),
      worktreesDir: join(root, '..', `.mesh-worktrees-${process.pid}`),
      sessionBinding: 'external',
      allowFakeTransport: false,
    });
    assert.equal(config.sourceDir, root);
    assert.equal(config.controlDir, join(root, '..', `.mesh-control-${process.pid}`));
    assert.equal(config.databasePath, join(root, '..', `.mesh-control-${process.pid}`, 'runtime.sqlite'));
    assertGitSource(config);
    assert.ok(existsSync(config.controlDir), 'the Mesh control directory is created');
    writeFileSync(join(config.controlDir, 'probe'), 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', `.mesh-worktrees-${process.pid}`), { recursive: true, force: true });
    rmSync(join(root, '..', `.mesh-control-${process.pid}`), { recursive: true, force: true });
  }
});

test('Mesh control and worktrees must be outside a whole-repository source', () => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-whole-bad-'));
  try {
    mkdirSync(join(root, '.git'));
    assert.throws(
      () => resolveConfig({
        projectRoot: root,
        sourceDir: '.',
        controlDir: join(root, '.research-mesh'),
        worktreesDir: join(root, '..', `.mesh-worktrees-${process.pid}`),
        sessionBinding: 'external',
        allowFakeTransport: false,
      }),
      /controlDir must be outside sourceDir/,
    );
    assert.throws(
      () => resolveConfig({
        projectRoot: root,
        sourceDir: '.',
        controlDir: join(root, '..', `.mesh-control-${process.pid}`),
        worktreesDir: join(root, 'nested-worktrees'),
        sessionBinding: 'external',
        allowFakeTransport: false,
      }),
      /worktreesDir must not be inside sourceDir/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
