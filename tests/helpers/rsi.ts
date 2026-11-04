/** Real RSI fixture builder for adapter integration tests. */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export interface RsiFixture {
  readonly state: string;
  readonly scheduler: string;
  readonly manifest: string;
  readonly receipt: string;
  readonly ledger: string;
  readonly experiment: string;
  readonly stateVersion: string;
  readonly preview: string;
  readonly consumed: string | null;
  readonly returncode?: number;
}

/**
 * Build a real receipt with the installed RSI scripts inside a temp project.
 * @param projectRoot - temp project root.
 * @param skillPath - installed RSI skill root.
 * @param execute - also consume the receipt via `run --execute`.
 * @returns paths and statuses.
 */
export function buildRsiFixture(
  projectRoot: string,
  skillPath: string,
  execute = false,
  options: { cwd?: string; argv?: readonly string[]; extraCode?: readonly string[] } = {},
): RsiFixture {
  const script = join(import.meta.dirname, '..', 'fixtures', 'rsi_fixture.py');
  const args = [script, '--root', projectRoot, '--skill', skillPath];
  if (execute) args.push('--execute');
  if (options.cwd !== undefined) args.push('--cwd', options.cwd);
  if (options.argv !== undefined) args.push('--argv-json', JSON.stringify(options.argv));
  for (const extra of options.extraCode ?? []) args.push('--extra-code', extra);
  const raw = execFileSync('python3', args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const line = raw.split('\n').filter(entry => entry.trim().startsWith('{')).at(-1);
  if (line === undefined) throw new Error(`RSI fixture returned no JSON: ${raw}`);
  return JSON.parse(line) as RsiFixture;
}
