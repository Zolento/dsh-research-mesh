# 07 — Test evidence

Date: 2026-11-10 · Branch `feat/rlp-v2.2-fusion`

## 1. Commands and results

```bash
cd dsh-research-mesh
npm run typecheck     # tsc -p tsconfig.json --noEmit   → PASS (exit 0)
npm run test:all      # node --test 'tests/**/*.test.ts' → 153/153 pass
node scripts/check-dsh.mjs
# check-dsh: installed 0.2.2-rc.1; engines.dsh >=0.2.1-rc.2 <0.3.0-0; PASS
# check-dsh: @deepseek-ai/schemastery 3.19.0; PASS
node --check client/client.js   # PASS
node scripts/ui-acceptance.mjs  # PASS (isolated profile, headless Chrome)
# {"ok":true,"teams":3,"screenshots":[11 files],"tokenUsed":true}
```

## 2. Counts

| Suite | Tests | Result |
|---|---|---|
| unit | 132 | pass |
| integration | 16 | pass |
| e2e | 5 | pass |
| **total** | **153** | **pass, 0 fail, 0 skip** |

Baseline before the branch: 99 tests, 69 pass / 30 fail — every failure was the
missing old `rsi-pipeline` install. Migration to the RLP v2.2.0 skill restored
those 99 (98 + one semantics update), and the fusion added 54 new tests.

## 3. New coverage

| File | Covers |
|---|---|
| `tests/unit/autonomy.test.ts` (11) | Trigger idempotency; observe creates no ticket; explicit vs autonomous Mandate operations; one active assignment; success parks at `waiting_evidence`; stop revokes and blocks resume; policy change blocks autonomous resume and explicit re-auth reissues a Mandate; context-only subscription grants nothing; actor allow-list; backoff/dead effect; reconcile-only never retried |
| `tests/unit/rlp.test.ts` (8) | v2.2.0 discovery + digest; missing/legacy path fails closed; storage matrix NEW/READY/legacy/ambiguous; plan loads real bodies and stable digest; unknown preset blocks; packet non-canonical + stale detection + rebuild; subagent permit subset and experiment manifest/approval; resolver cache/invalidate |
| `tests/integration/rlp-service.test.ts` (3) | service RLP status/storage; explicit trigger → ticket → workbench projection → assignment → stop; legacy-only and ambiguous roots refuse `createGroup` |
| `tests/unit/projects.test.ts` (updated) | `storageKind` and migration semantics for new/legacy/none roots |
| `tests/unit/completion.test.ts` (6) | success parks at waiting_evidence; no proof → HOLD; proof records outcome; engineering/cancel; service verifier PASS/HOLD |
| `tests/unit/boundaries.test.ts` (5) | cross-project trigger/team/thread; context→owned upgrade; route mismatch |
| `tests/unit/effects-recovery.test.ts` (5) | expired claim replay vs reconcile-only park; double worker; backoff; double restart |
| `tests/unit/policy.test.ts` (4) | observe→auto→restart; auto→off→restart; revoked mandate; mandate binds persisted policy |
| `tests/unit/migrations.test.ts` (1) | v2 upgrade, rollback, re-upgrade preserve rows |

## 4. Regression list (existing, still green)

3 groups / 4 members / 12 global; session and worktree binding; model settings
persistence; SQLite scheduler priority/FIFO/CAS; GPU leases; Fake transport;
consumed ledger; artifact SHA-256; restart/reconcile; web API; client bundle.

## 5. Known untested / not run

1. **Real Web UI acceptance** passed on an isolated profile: project, three
   groups, Captain/member sessions, model settings, dark mode and responsive
   overflow checks. The Tickets stop/resume buttons are not clicked by the
   script (they are covered by unit/integration tests).
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
| UI acceptance: "mock catalog did not register" | mock adapter hardcoded a stale global DSH install and could not import `@deepseek-ai/dsh-llm` | adapter now resolves the running DSH (PATH symlink → real package) with `DSH_INSTALL` override |
| UI acceptance: catalog empty on first request | rc1 activates `llm` after the plugin | acceptance polls `/bootstrap` until the catalog appears |
