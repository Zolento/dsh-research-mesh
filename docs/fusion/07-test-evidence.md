# 07 — Test evidence

Date: 2026-11-10 · Branch `feat/rlp-v2.2-fusion`

## 1. Commands and results

```bash
cd dsh-research-mesh
npm run typecheck     # tsc -p tsconfig.json --noEmit   → PASS (exit 0)
npm run test:all      # node --test 'tests/**/*.test.ts' → 124/124 pass
node scripts/check-dsh.mjs
# check-dsh: installed 0.2.2-rc.1; engines.dsh >=0.2.1-rc.2 <0.3.0-0; PASS
# check-dsh: @deepseek-ai/schemastery 3.19.0; PASS
node --check client/client.js   # PASS
```

## 2. Counts

| Suite | Tests | Result |
|---|---|---|
| unit | 107 | pass |
| integration | 11 | pass |
| e2e | 6 | pass |
| **total** | **124** | **pass, 0 fail, 0 skip** |

Baseline before the branch: 99 tests, 69 pass / 30 fail — every failure was the
missing old `rsi-pipeline` install. Migration to the RLP v2.2.0 skill restored
those 99 (98 + one semantics update), and the fusion added 25 new tests.

## 3. New coverage

| File | Covers |
|---|---|
| `tests/unit/autonomy.test.ts` (11) | Trigger idempotency; observe creates no ticket; explicit vs autonomous Mandate operations; one active assignment; success parks at `waiting_evidence`; stop revokes and blocks resume; policy change blocks autonomous resume and explicit re-auth reissues a Mandate; context-only subscription grants nothing; actor allow-list; backoff/dead effect; reconcile-only never retried |
| `tests/unit/rlp.test.ts` (8) | v2.2.0 discovery + digest; missing/legacy path fails closed; storage matrix NEW/READY/legacy/ambiguous; plan loads real bodies and stable digest; unknown preset blocks; packet non-canonical + stale detection + rebuild; subagent permit subset and experiment manifest/approval; resolver cache/invalidate |
| `tests/integration/rlp-service.test.ts` (3) | service RLP status/storage; explicit trigger → ticket → workbench projection → assignment → stop; legacy-only and ambiguous roots refuse `createGroup` |
| `tests/unit/projects.test.ts` (updated) | `storageKind` and migration semantics for new/legacy/none roots |

## 4. Regression list (existing, still green)

3 groups / 4 members / 12 global; session and worktree binding; model settings
persistence; SQLite scheduler priority/FIFO/CAS; GPU leases; Fake transport;
consumed ledger; artifact SHA-256; restart/reconcile; web API; client bundle.

## 5. Known untested / not run

1. **Real Web UI acceptance** (`scripts/ui-acceptance.mjs`) was not run in this
   round: it boots an isolated DSH profile and headless Chrome and takes several
   minutes. The bundle syntax check passed; the Tickets section reuses existing
   classes. Run it before a release tag.
2. **Real SSH / GPU / Conda** execution is unchanged from v0.1.0 and remains
   verified only by the recorded `LIVE-*` scenarios.
3. **Real RLP `run --execute` shim round trip** is still covered by unit-level
   fixture + consumed-ledger tests, not by a full live RSI loop.
4. **RLP domain profiles (MRI)** are not exercised; the adapter passes
   `--domain` through without interpreting it.
5. Long network partitions and remote process crashes are not simulated beyond
   the existing fault A/B.

## 6. Failure records from this branch

| Observation | Cause | Resolution |
|---|---|---|
| 30/99 red at start | old `rsi-pipeline` uninstalled | fixtures and skill discovery moved to RLP v2.2.0 |
| project inspection test red | semantics changed: no root = NEW project, not legacy | assertion updated to `storageKind` |
| autonomy effects test red | test clock ahead of wall-clock row | test advances the injected clock |
| `RlpContextAdapter` packet check red | `verify` output has no `is_canonical_state` | adapter asserts from the packet file |
| `MANDATE_REVALIDATION_REQUIRED` missing | new failure code not declared | added to `MeshErrorCode` |
