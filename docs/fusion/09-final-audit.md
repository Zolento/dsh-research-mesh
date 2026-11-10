# 09 — Final audit

## 1. Success criteria vs delivered

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Create or continue a long-lived project | **partial** | registration + groups + RLP READY detection; RLP Bootstrap itself stays with RLP |
| 2 | Project/Group/Session/Ticket relations | **yes** | `docs/fusion/01`, workbench projection |
| 3 | Every Ticket has a Mandate; no agent escalation | **yes** | `autonomy.test.ts` (operations, subset, actor gate) |
| 4 | A Ticket can use Group / Agent Teams for multi-step work | **partial** | `assignTicket` binds team + assignment; auto-dispatch of a Captain turn is not implemented, the assignment appears as a launch request |
| 5 | Long GPU job independent of the Agent session | **yes** | existing job executor + `waiting_compute` + `markTicketCompute` |
| 6 | Completion wakes the Ticket | **yes** | artifact-ingestion trigger wiring; `compute_job_completed` wakes `waiting_compute` (tested) |
| 7 | RLP minimal context by role and task | **yes** | `RlpContextAdapter`, `RlpSubagentContext`, tests |
| 8 | Canonical Research State is the only scientific truth | **yes** | Mesh reads only; `RLP_CONTEXT_STALE`, storage gates |
| 9 | No scientific PASS without evidence gate | **yes** | success parks at `waiting_evidence`; `endTicket('completed')` is explicit only |
| 10 | Restart/failure does not duplicate experiments | **yes** | existing reconcile + reconcile-only effects + consumed journal |
| 11 | WebUI shows projects/tickets/agents/experiments/todos | **yes** | Tickets section + workbench API; screenshots not refreshed |
| 12 | Existing Mesh behaviour does not regress | **yes** | 121/124 tests, typecheck, check-dsh |

## 2. Remaining risks

1. **Ticket → Captain dispatch is manual.** The assignment is created and a
   `launch_assignment` effect is recorded, but no code starts the Captain turn
   automatically. This is deliberate (a person or the Captain decides), but it
   means "auto" mode does not yet produce an autonomous execution loop.
2. **RLP Bootstrap is not invoked.** Mesh registers an existing READY checkout;
   creating a new RLP project remains an RLP operation.
3. **UI acceptance passed**, but the Tickets action buttons are not exercised by
   that script; they are covered by unit/integration tests only.
4. **One runnable project per profile** is unchanged; multi-project still needs
   multiple profiles and ports.
5. **No live RLP `run --execute` round trip** in this environment; the shim and
   consumed-ledger paths are unchanged from v0.1.0 and covered by fixtures.
6. **Autonomy mode is process-wide**, not per project; a future revision should
   store it per project to match the "one profile, one project" rule.

## 3. Deployment readiness

Not yet a production release:

- ~~run `node scripts/ui-acceptance.mjs` on an isolated profile~~ (passed 2026-11-10);
- exercise one live consumed-ledger job against a scratch project;
- decide the Ticket → Captain dispatch mechanism.

The branch is safe for local evaluation: no remote push, no migration, no
scientific state write, no real GPU/SSH job.

## 4. Files changed

New: `src/rlp/{types,discovery,paths,context,subagent-context,python,index}.ts`,
`src/autonomy/{types,store,effects,engine}.ts`,
`tests/unit/{rlp,autonomy}.test.ts`,
`tests/integration/rlp-service.test.ts`,
`docs/fusion/00..09`,
plus edits to `src/service.ts`, `src/config/{index,types}.ts`, `src/errors.ts`,
`src/util/ids.ts`, `src/projects/{registry,workbench}.ts`,
`src/bridge/adapters/research-pipeline.ts`, `src/rsi/adapter.ts`,
`src/host/web-api.ts`, `client/client.js`, tests and scripts migrated to the new
root/skill.

## 5. Local commit

- Branch: `feat/rlp-v2.2-fusion`
- `feat(mesh): integrate RLP v2.2.0 and the autonomy ticket layer`
- `test(mesh): pass the isolated UI acceptance on RLP v2.2.0`

(exact hashes: `git log --oneline main..HEAD`)
- Base: `6479734` (`main`, `origin/main` + 1 local commit)
- Nothing was pushed, merged, tagged or deployed.
