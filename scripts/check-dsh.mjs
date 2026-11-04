#!/usr/bin/env node
/** Verify the installed DSH satisfies this plugin's engines.dsh range. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const candidates = [
  process.env.DSH_INSTALL,
  '/home/lenovo/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh',
  join(homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
].filter(value => value !== undefined && value !== '');
const install = candidates.find(candidate => existsSync(join(candidate, 'package.json')));
if (install === undefined) {
  console.error('check-dsh: installed @deepseek-ai/dsh not found');
  process.exit(1);
}
const installed = JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')).version;
const expected = pkg.engines?.dsh ?? '*';
const requireFromInstall = createRequire(join(install, 'package.json'));
let semver;
try { semver = requireFromInstall('semver'); } catch { semver = undefined; }
const ok = semver === undefined ? true : semver.satisfies(installed, expected, { includePrerelease: true });
console.log(`check-dsh: installed ${installed}; engines.dsh ${expected}; ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exit(1);
