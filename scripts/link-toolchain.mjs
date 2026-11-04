#!/usr/bin/env node
/**
 * Link the offline local toolchain and the DSH-installed schemastery package.
 *
 * No network and no package manager run: this plugin's unit tests and the local
 * WebUI acceptance execute from a checkout, so TypeScript and @types/node are
 * resolved from an existing local installation. A published install declares
 * them as normal dependencies.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');
mkdirSync(join(nodeModules, '@deepseek-ai'), { recursive: true });
mkdirSync(join(nodeModules, '@types'), { recursive: true });
mkdirSync(join(nodeModules, '.bin'), { recursive: true });

const candidates = [
  process.env.DSH_INSTALL,
  '/home/lenovo/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh',
  join(homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
].filter((value) => value !== undefined && value !== "");
const install = candidates.find(candidate => existsSync(join(candidate, 'package.json')));
if (install === undefined) {
  console.error('link-toolchain: installed @deepseek-ai/dsh not found; set DSH_INSTALL');
  process.exit(1);
}
const requireFromInstall = createRequire(join(install, 'package.json'));

function link(name, target) {
  const linkPath = join(nodeModules, name);
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, 'dir');
  console.log(`linked ${name} -> ${target}`);
}

const schemastery = dirname(requireFromInstall.resolve('@deepseek-ai/schemastery/package.json'));
link('@deepseek-ai/schemastery', schemastery);

const typescriptCandidates = [
  join(homedir(), 'node_modules', 'typescript'),
  join(root, '..', 'dsh-research-team-bridge', 'node_modules', 'typescript'),
  join(root, '..', 'deepseek-harness', 'node_modules', 'typescript'),
  join(install, 'node_modules', 'typescript'),
];
const typescript = typescriptCandidates.find(candidate => existsSync(join(candidate, 'bin', 'tsc')));
if (typescript === undefined) {
  console.error('link-toolchain: TypeScript not found; install typescript@^5.9.3');
  process.exit(1);
}
link('typescript', typescript);
rmSync(join(nodeModules, '.bin', 'tsc'), { force: true });
symlinkSync(join(typescript, 'bin', 'tsc'), join(nodeModules, '.bin', 'tsc'), 'file');

const typesNodeCandidates = [
  join(homedir(), 'node_modules', '@types', 'node'),
  join(root, '..', 'dsh-research-team-bridge', 'node_modules', '@types', 'node'),
  join(install, 'node_modules', '@types', 'node'),
];
const typesNode = typesNodeCandidates.find(candidate => existsSync(join(candidate, 'package.json')));
if (typesNode === undefined) {
  console.error('link-toolchain: @types/node not found; install @types/node@^22');
  process.exit(1);
}
link('@types/node', typesNode);
console.log('toolchain linked');
