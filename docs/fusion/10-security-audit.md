# 10 — Independent audit fixes (2026-11-10)

Scope: the P0/P1 findings from the external review of v0.2.0. No new feature
layer was added; every fix is a runtime constraint with a regression test.
P2 (Ticket → Captain auto-dispatch) is **not implemented**; see §9.

## 1. Root causes and fixes

| # | Finding | Root cause | Fix | Evidence |
|---|---|---|---|---|
| P0-1 | HTTP body could claim `explicit` / system sources | `web-api` passed body fields straight to the engine; no principal concept | `src/autonomy/principal.ts`; engine accepts a `Principal`, untrusted callers may only report `session` events and `explicit` is ignored; `/tickets` requires a verified human; `/autonomy/mode` requires a human; optional `security.adminToken` (constant-time compare) is the only HTTP human entry | `tests/unit/security.test.ts`, `tests/integration/web-api.test.ts` |
| P0-2 | No single Mandate check | each method had partial checks | `src/autonomy/authorize.ts::authorizeAction`; every Ticket/Assignment transition calls it; checks mandate revocation, project/route, group ownership, operation set, policy version, resource ceiling, paused project/group, RLP scope | `tests/unit/security.test.ts`, `boundaries.test.ts` |
| P0-3 | `endTicket('completed')` fabricated scientific completion | no proof argument | `CompletionProof` required for research tickets; `MeshService.completeResearchTicket` calls RLP `evidence_outcome.py decision` and only a PASS for the current state digest proceeds; execution success still parks at `waiting_evidence` | `tests/unit/completion.test.ts` |
| P0-4 | cross-project / cross-route writes | checks lived in the API, not the domain | engine checks trigger/ticket project, group project, thread owner, context→owned upgrade, mandate/ticket route; DB adds `mesh_threads`, and a unique index on `mesh_assignments(job_id)` | `tests/unit/boundaries.test.ts` |
| P1-5 | crashed `running` effect hung forever | no owner/lease | `owner`, `claimed_at`, `lease_expires_at`; `EffectsRunner.recover()` replays safe kinds and parks reconcile-only kinds; tick claims are CAS | `tests/unit/effects-recovery.test.ts` |
| P1-6 | policy only in memory | `setPolicy` wrote a field | `mesh_policy` row; monotonic `policy-N`; digest stored; Mandates bind `policyVersion` + `policyDigest`; startup loads it | `tests/unit/policy.test.ts` |
| P1-7 | Artifact events only in `runWorkerOnce` | duplicated inline code | one `#recordArtifactIngested`, called from `runWorkerOnce`, service `runUntilIdle`, `collectJob`, `reconcileJob` (only when already ingested) and startup recovery; dedupe key `artifact:<jobId>` | existing e2e + startup path |
| P1-8 | stale RLP cache | cache and skill digest never rechecked | storage cache keyed by root existence/mtime; context verifies every loaded document digest; `RlpRuntime.isStale()` rebuilds adapters when the skill digest changes | `tests/unit/rlp.test.ts` |

## 2. Database migration

Additive v2, applied in one transaction (`AutonomyStore.#migrate`):

- `mesh_tickets`: `kind`, `outcome_ref`
- `mesh_mandates`: `policy_digest`
- `mesh_effects`: `owner`, `claimed_at`, `lease_expires_at`
- `mesh_triggers`: `principal_kind`, `principal_id`
- new `mesh_policy`, `mesh_threads`
- unique index `uq_mesh_assignments_job`

`rollbackToV1()` drops only v2-only structures; v1 rows are preserved. A v2-only
rollout loses the policy/threads tables (documented); the next engine seeds the
default policy. Test: `tests/unit/migrations.test.ts`.

Foreign keys are declared where the schema already had them but SQLite
enforcement is off; ownership is enforced in `authorizeAction`. This is a
logical boundary, not a DB sandbox.

## 3. Real authorization path

```
HTTP → principalFor(request)
  no x-mesh-admin-token → webPrincipal (authenticated:false)
  matching token        → humanPrincipal('web-admin')
  ↓
MeshService method (default SYSTEM_PRINCIPAL for host code)
  ↓
AutonomyEngine.receiveTrigger / assign / start / finish / markCompute /
resume / stop / end / subscribe
  ↓
authorizeAction(principal, action, policy, project, ticket, mandate, group,
                assignment, rlp, resource, subscription modes)
  ↓ throw PRINCIPAL_UNTRUSTED | MANDATE_* | POLICY_BLOCKED | RLP_GATE_HOLD
  ↓
SQLite write in one transaction
```

A request body can never choose `human`, `system` or a trusted actor. An
unauthenticated caller may stop a ticket (authority-reducing) but cannot create,
assign, start, finish, mark compute, re-authorize or change policy. The DSH
launch token is not user identity and is not treated as one.

## 4. Effects recovery state machine

```
pending --claim(owner, lease)--> running
running --success--> succeeded
running --error(safe)--> pending (backoff) | dead (attempts exhausted)
running --error(reconcile-only)--> failed (no retry)
running --lease expired--> recover(): safe → pending | reconcile-only → failed
```

Recovery never blanket-resets `running`. A reconcile-only outcome is reported as
`RECONCILE_REQUIRED` in `last_error`; an operator must reconcile the external
state before enqueueing a new operation. Two workers ticking concurrently run a
row once (CAS claim). Verified by five fault-injection tests.

## 5. Scientific completion gate

- `waiting_evidence` can only become `completed` through
  `completeResearchTicket`, which:
  1. asserts the RLP storage root permits formal runs;
  2. calls `evidence_outcome.py decision` for the experiment;
  3. requires `status = PASS` and computes a proof digest over state digest +
     experiment + decision;
  4. passes a `CompletionProof` to the engine, which records `outcome_ref`.
- HOLD/FAIL, a missing state, a file that is not JSON, or a stale skill all
  refuse completion (`RLP_GATE_HOLD`).
- Engineering tickets may complete on their engineering result; cancellation
  needs no proof.
- Mesh does not implement Evidence Qualification; it calls RLP's entry.

## 6. Test evidence

```
npm run typecheck     PASS
npm run test:all      153 tests, 153 pass, 0 fail
node scripts/check-dsh.mjs
  installed 0.2.2-rc.1; engines.dsh >=0.2.1-rc.2 <0.3.0-0; PASS
  @deepseek-ai/schemastery 3.19.0; PASS
node scripts/ui-acceptance.mjs   PASS (isolated profile, 3 groups, model
  settings, dark mode, 1440/1280/768/390 no overflow)
```

New suites: `security` (7), `completion` (6), `boundaries` (5),
`effects-recovery` (5), `policy` (4), `migrations` (1), plus one HTTP trust
test in `web-api` (total 153, from 124).

## 7. Not verified

- Real DSH user identity: none exists in the plugin API; the admin token is an
  operator-supplied secret, not SSO. The UI itself has no way to hold it, so
  privileged HTTP actions require an out-of-band client.
- Real SSH/GPU execution and a live RLP `run --execute` round trip.
- Long-running effects that exceed the 5-minute lease (no heartbeat yet).
- Foreign-key enforcement at the SQLite level (logical checks only).

## 8. Deployment / merge readiness

Not ready to merge to `main`:

- the admin-token path has no UI client yet, so ticket creation from the browser
  is intentionally unavailable (the browser still shows tickets and may stop
  them);
- P2 dispatch is absent, so `auto` mode still stops at an assignment request;
- the live RLP `run --execute` round trip and real SSH/GPU execution remain
  unverified.

## 9. P2 status

Ticket → Captain auto-dispatch is **not implemented** in this round. The
`dispatch_ticket` / `launch_assignment` effects only record audit events; an
Assignment stays `pending` until a verified host entry starts it. The design
constraint (reuse native sessions, no second DAG, stop wins, unknown external
state → `waiting_human`) is recorded but not exercised.
