/** Build a real RLP terminal state + Assurance file through the skill scripts. */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { TempProject } from './env.ts';

export interface CompletionFixture {
  readonly state: string;
  readonly assurance: string | null;
  readonly experiment: string;
}

/**
 * @param project - temp project.
 * @param skill - RLP skill root.
 * @param mode - pass | needs_review | fail | stale.
 * @returns real fixture paths produced by RLP's own apply/assurance-store.
 */
export function buildCompletionFixture(
  project: TempProject,
  skill: string,
  mode: 'pass' | 'needs_review' | 'fail' | 'stale',
): CompletionFixture {
  const raw = execFileSync('python3', [
    join(import.meta.dirname, '..', 'fixtures', 'rlp_completion_fixture.py'),
    '--root', project.root, '--skill', skill, '--mode', mode,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const line = raw.split('\n').filter(entry => entry.trim().startsWith('{')).at(-1);
  if (line === undefined) throw new Error(`no JSON from completion fixture: ${raw}`);
  return JSON.parse(line) as CompletionFixture;
}
