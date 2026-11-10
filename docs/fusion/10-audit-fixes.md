# 10 — Independent audit fixes (2026-11-10)

Scope: the defects retained after the owner re-prioritized the external review.
The original P0-01 (HTTP user identity) was **withdrawn as not a defect**: DSH
owns the human entry points, Mesh owns the autonomy and execution boundary, and
RLP owns scientific constraints. Mesh does not implement a second user permission
system.

Retained: scientific completion gate, cross-project/group boundaries, effects
crash recovery, policy persistence, artifact event entry. Original P2
(Ticket → Captain dispatch) remains unimplemented.

## 1. Withdrawn: no Mesh user-permission layer

Removed before merge:

- `src/autonomy/principal.ts` (human/system/session/web principals);
- `security.adminToken` configuration and `x-mesh-admin-token` handling;
- principal parameters on `authorizeAction`, the engine and the service;
- `PRINCIPAL_UNTRUSTED` error code and the HTTP 403 tests.

What remains is the autonomy boundary, not identity: a Ticket still cannot leave
its Mandate, project, route, group, policy version, resource ceiling or RLP
scope. `explicit` is again a request flag owned by the DSH entry point.

## 2. Retained fixes

| ID | Finding | Root cause | Fix | Evidence |
|---|---|---|---|---|
| P0-02 | research Ticket could complete without evidence | `endTicket('completed')` had no proof | research tickets require a `CompletionProof`; `MeshService.completeResearchTicket` calls RLP `evidence_outcome.py decision` and only a PASS for the current state digest proceeds; success still parks at `waiting_evidence` | `tests/unit/completion.test.ts` |
| P0-03 | cross-project / cross-route writes | checks lived only in the API | domain checks: trigger/ticket project, group project, thread owner, context→owned upgrade, mandate/ticket route; `mesh_threads`; unique index on `mesh_assignments(job_id)` | `tests/unit/boundaries.test.ts` |
| P1-01 | crashed `running` effect hung forever | no owner/lease | `owner`/`claimed_at`/`lease_expires_at`; `recover()` replays safe kinds and parks reconcile-only kinds; CAS claims | `tests/unit/effects-recovery.test.ts` |
| P1-02 | policy only in memory | `setPolicy` wrote a field | `mesh_policy` row; monotonic `policy-N` + digest; Mandates bind version and digest; startup restore; revoked mandates never revive | `tests/unit/policy.test.ts` |
| P1-03 | Artifact events only in `runWorkerOnce` | duplicated inline code | one `#recordArtifactIngested`, used by `runWorkerOnce`, service `runUntilIdle`, `collectJob`, `reconcileJob` (already ingested only) and startup recovery; key `artifact:<jobId>` | e2e + startup path |

`authorizeAction` (no Principal) enforces: project active for expanding actions,
ticket/mandate project and route, mandate revocation, required operation,
policy-version binding, group ownership and active state, assignment ownership,
subscription upgrade, RLP formal-run gate and scope, and resource ceilings.

## 3. Database migration

Additive v2, one transaction:

- `mesh_tickets`: `kind`, `outcome_ref`
- `mesh_mandates`: `policy_digest`
- `mesh_effects`: `owner`, `claimed_at`, `lease_expires_at`
- `mesh_policy`, `mesh_threads`
- unique index `uq_mesh_assignments_job`

`rollbackToV1()` drops only v2-only structures; v1 rows survive. The rollback
loses the v2-only policy/threads tables by design; the next engine seeds the
default policy. Test: `tests/unit/migrations.test.ts`.

Foreign keys remain declared but unenforced by SQLite; ownership is enforced in
`authorizeAction`. This is a logical boundary, not a DB sandbox.

## 4. Effects recovery

```
pending --claim(owner, lease)--> running
running --success--> succeeded
running --error(safe)--> pending(backoff) | dead(exhausted)
running --error(reconcile-only)--> failed (no retry)
running --lease expired--> recover(): safe→pending; reconcile-only→failed
```

No blanket reset of `running`. Unknown remote outcomes are never re-executed.

## 5. Scientific completion gate

`waiting_evidence` → `completed` only through `completeResearchTicket`:

1. RLP storage root must permit formal runs;
2. `evidence_outcome.py decision` is invoked for the experiment;
3. only `PASS` for the current state digest produces a proof digest;
4. the engine records it as `outcome_ref`.

HOLD/FAIL, missing or invalid state, and a changed skill refuse completion.
Mesh does not re-implement Evidence Qualification.

## 5.1 Second review round (2026-11-10)

The independent re-review found integration-boundary gaps; all are fixed:

| Finding | Fix |
|---|---|
| RLP decision called without `--assurance`, so PASS was impossible | `RlpCompletionVerifier` locates `<route>/assurance/outcome/<analysis_id>.json`, passes `--assurance`, maps `NEEDS_REVIEW` to HOLD and re-reads the state digest after the decision |
| Completion not bound to the Ticket's route/experiment/job | `completeResearchTicket` derives the route from the ticket, requires `ticket.experimentId === experimentId`, and re-hashes the canonical state before ending |
| Experiment learned from a job was not persisted | `mesh_tickets.experiment_id`; `markCompute` reads the job manifest's RLP experiment and refuses a mismatch |
| `markCompute` accepted another ticket's assignment or an unknown job | assignment must belong to the ticket, the job must exist in the same project and match the assignment task |
| Context subscription could be upgraded by an attaching event | attach path keeps an existing `context` mode; only a new relation becomes `owned` |
| Ordinary messages released `waiting_compute` | only `compute_job_completed` / `artifact_ingested` with the ticket's own `jobId` may wake it; `compute_job_failed` parks for a human |
| Background worker bypassed the artifact event | `MeshWorker` emits `onIngested` from every collect path; the service callback records the same idempotent event |
| Group route not checked | `GroupFacts.routeId` must equal `ticket.routeId` for assign/start |
| Mandate absence not fatal | any action requiring an operation now refuses a ticket without a Mandate |
| RLP formal-run gate too loose | the service requires a new-root routes tree; the async resolver remains authoritative for reporting |
| Effects could write back after lease loss | `finishEffect` is owner-fenced and the runner renews the lease while a handler runs |
| Two active assignments possible under concurrency | partial unique index `uq_mesh_assignment_active` |

Real-RLP tests (no mocked decision) use RLP's own `apply` + `assurance-store` in
`tests/fixtures/rlp_completion_fixture.py` and cover PASS, NEEDS_REVIEW, FAIL,
stale assurance, and an unbound XID.

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

New suites: `rlp-completion` (5, real RLP apply/assurance/decision),
`completion` (6), `boundaries` (5), `effects-recovery` (5), `policy` (4),
`migrations` (1), plus new autonomy cases for subscriptions, wake and job
ownership. The identity suite was removed with P0-01.

## 7. Not verified

- live RLP `run --execute` round trip and real SSH/GPU execution;
- effects that exceed the 5-minute lease (no heartbeat yet);
- SQLite-level foreign-key enforcement (logical checks only).

## 8. Merge readiness

Code passes the full regression and isolated UI acceptance. Before merging:

- decide whether the RLP decision entry is stable for the chosen project state;
- accept that P2 dispatch is absent (`auto` stops at an assignment request);
- run one live consumed-ledger job on a scratch project.

## 9. P2 status

Ticket → Captain dispatch is not implemented. `dispatch_ticket` and
`launch_assignment` only record audit events; an Assignment stays `pending`
until a host entry starts it.
