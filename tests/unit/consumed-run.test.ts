/** Consumed-ledger coordinator mechanics (RSI process + shim + Mesh callback). */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runConsumedShim } from '../../src/rsi/consumed-run.ts';
import { SHIM_RESULT_SCHEMA, SHIM_SPEC_SCHEMA } from '../../src/rsi/blocking-shim.ts';
import type { RsiAuthorization } from '../../src/rsi/adapter.ts';
import { MeshError } from '../../src/errors.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mesh-consumed-'));
  const ledger = join(root, 'ledger');
  mkdirSync(ledger);
  writeFileSync(join(ledger, 'events.jsonl'), '');
  writeFileSync(join(root, 'receipt.json'), JSON.stringify({ id: 'receipt-1' }));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ state_version: '1' }));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schema: 'execution-manifest@1' }));
  writeFileSync(join(root, 'scheduler.json'), JSON.stringify({ schema: 'scheduler@1' }));
  writeFileSync(join(root, 'shim-spec.json'), JSON.stringify({
    schema: SHIM_SPEC_SCHEMA,
    job_id: 'job-1',
    attempt_id: 'attempt-1',
    timeout_seconds: 5,
    poll_ms: 10,
    mode: 'wait',
  }));
  const rsi = join(root, 'fake_rsi.py');
  writeFileSync(rsi, `#!/usr/bin/env python3
import json, sys
args = sys.argv
ledger = args[args.index('--ledger') + 1]
receipt = json.load(open(args[args.index('--receipt') + 1]))
experiment = args[args.index('--experiment') + 1]
event = {'kind': 'consume', 'receipt_id': receipt['id'], 'experiment_id': experiment, 'dry_run': False}
with open(ledger + '/events.jsonl', 'a', encoding='utf-8') as out:
    out.write(json.dumps(event) + '\\n')
`);
  chmodSync(rsi, 0o700);
  const auth = {
    mode: 'rsi-receipt', receiptRef: 'receipt.json', receiptDigest: 'a'.repeat(64),
    experimentId: 'X1', stateVersion: '1', rsiManifestDigest: 'b'.repeat(64),
    verifiedBy: 'test', verifiedAt: new Date().toISOString(),
  } as unknown as RsiAuthorization;
  return {
    root, ledger, rsi, auth,
    spec: {
      python: 'python3', script: rsi,
      statePath: join(root, 'state.json'), manifestPath: join(root, 'manifest.json'),
      schedulerPath: join(root, 'scheduler.json'), receiptPath: join(root, 'receipt.json'),
      ledgerPath: ledger, experimentId: 'X1',
      shimSpecPath: join(root, 'shim-spec.json'), shimResultPath: join(root, 'shim-result.json'),
      timeoutMs: 5000, journalPath: join(root, 'journal.json'),
    },
  };
}

test('consumed coordinator waits for consume, verifies, launches and mirrors exit code', async () => {
  const f = fixture();
  try {
    let launched = 0;
    const result = await runConsumedShim(f.spec, {
      receiptId: () => 'receipt-1',
      verify: () => f.auth,
      onConsumed: async authorization => {
        assert.equal(authorization, f.auth);
        launched += 1;
        return 0;
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.consumed, true);
    assert.equal(launched, 1);
    const shim = JSON.parse(readFileSync(f.spec.shimResultPath, 'utf8'));
    assert.equal(shim.schema, SHIM_RESULT_SCHEMA);
    assert.equal(shim.exit_code, 0);
    const journal = JSON.parse(readFileSync(f.spec.journalPath, 'utf8'));
    assert.equal(journal.phase, 'completed');
    assert.equal(journal.exitCode, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a failed Mesh launch still releases the consumed shim with exit code 1', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => runConsumedShim(f.spec, {
        receiptId: () => 'receipt-1',
        verify: () => f.auth,
        onConsumed: async () => { throw new MeshError('EXECUTOR_FAILED', 'launch failed'); },
      }),
      /launch failed/,
    );
    const shim = JSON.parse(readFileSync(f.spec.shimResultPath, 'utf8'));
    assert.equal(shim.exit_code, 1);
    const journal = JSON.parse(readFileSync(f.spec.journalPath, 'utf8'));
    assert.equal(journal.phase, 'launch_failed');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a missing consume event fails closed instead of launching the experiment', async () => {
  const f = fixture();
  try {
    writeFileSync(f.rsi, '#!/usr/bin/env python3\nimport sys\nsys.exit(3)\n');
    chmodSync(f.rsi, 0o700);
    await assert.rejects(
      () => runConsumedShim(f.spec, {
        receiptId: () => 'receipt-1',
        verify: () => f.auth,
        onConsumed: async () => 0,
      }),
      (error: unknown) => error instanceof MeshError && error.code === 'RSI_CONSUME_MISSING',
    );
    assert.equal(existsSync(f.spec.shimResultPath), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
