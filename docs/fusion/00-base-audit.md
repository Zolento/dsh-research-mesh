# 00 — Base audit: Mesh × Superagent × RLP v2.2.0

Date: 2026-11-10 (Asia/Shanghai)
Branch: `feat/rlp-v2.2-fusion`
Base commit: `6479734a06b3bcd1edbdcddb6baaa6f42b82db34` (`main`)

This audit reads the actual code in three repositories, not their intentions:

| System | Location | Baseline |
|---|---|---|
| DSH Research Mesh | this repository | `main` @ `6479734` |
| DSH Superagent prototype | `../dsh-superagent-prototype` | `8c32a9d` |
| RLP | `~/.agents/skills/research-lifecycle-protocol` (from `Zolento/my-research-skills`) | v2.2.0, `metadata.version: 2.2.0` |

## 1. What each system actually implements

### 1.1 Mesh (this plugin)

Real, tested components:

- `ProjectRegistry` — durable project + session bindings (`control` / `captain` / `member`),
  partial unique indexes for one active binding per session and one active captain per group.
- `TeamManager` / `DshSessionHost` — 3 groups × 4 members, DSH `SessionController` sessions,
  native `SubagentRuntime` member mode behind `nativeMembers`.
- `WorkspaceManager` — one `mesh/<group>` Git worktree per group, `PathBoundary`, no `git clean`.
- `TaskScheduler` — SQLite bridge `tasks` table + Mesh metadata, `BEGIN IMMEDIATE` + revision CAS,
  priority/FIFO, leases, retry/cancel/block, restart recovery.
- `GpuLeaseManager` — per-device exclusive lease, fail-closed probe.
- `ExperimentJobService` + `RemoteJobExecutor` — immutable manifest bound to worktree HEAD,
  Fake/SSH transport, wrapper, `job-state.json`, artifact manifest, SHA-256 ingestion.
- `RsiAdapter` — read-only canonical state, `state_check`, receipt + consumed-ledger verification.
- `MeshWorker` — explicit claim/poll loop; remote jobs survive agent turns.
- Host API + hand-written client bundle (Projects, Workbench, Models, session entry).

What it does **not** have:

- no project-scoped event/trigger intake;
- no Ticket / Mandate / Assignment objects (only `mesh_tasks` and `mesh_jobs`);
- no durable effects queue (side effects are inline in services);
- no autonomy modes;
- RLP integration is single-skill-path discovery with legacy names and legacy storage root.

### 1.2 Superagent (reference, research prototype)

Implemented core (`src/core/`): `Engine` as the single writer of Trigger/Thread/Eval/Decision/
Ticket/Assignment, five internal parts (`Intake`, `Evals`, `Tickets`, `Assignments`, `Replies`),
synchronous transactional commands, role-scoped `Pick` interfaces, `Mandate` immutable and
revalidated on resume, `Subscription` fan-out (owned vs context), durable `Effects` queue with
`Later` deferral/backoff/health, `Outbox` receipts for channel writes.

Not implemented / prototype-only: GitHub/Feishu sources assume specific hosts, setup is
interactive, no multi-project or research semantics, no RLP, no GPU/experiment execution.

### 1.3 RLP v2.2.0

Authoritative scientific layer:

- `SKILL.md` (28 KB) is L0; `shared-contract.md` + one preset + required references are L1;
  full policies are L2, loaded on demand.
- `scripts/rlp_paths.py` — storage matrix: `NEW_PROJECT`, `READY`, `MIGRATION_REQUIRED`
  (exit 3), `AMBIGUOUS_STORAGE_ROOT`, `INVALID_STORAGE_ROOT`; new root
  `.research-lifecycle-protocol/`, legacy root read-only; frozen protocol ids
  `research-idea-pipeline/...@1`.
- `scripts/context_planner.py load` — machine-readable plan with `loaded[].text`,
  `referenced`, `blocked_missing`, `can_proceed`, `plan_digest`, separated budgets.
- `scripts/context_packet.py build|verify` — non-canonical, regenerable packet with
  `canonical_digest`; `verify` exits 4 and reports `stale` when state moved.
- `scripts/subagent_context.py build` — per-role contract with `permits`, `parent_permits`,
  `manifest_required`, `approval_required`, role-scoped `text`.
- `experiment_execute.py issue|run` — receipt/ledger, `--execute` consumes; `evidence_outcome.py`
  — R9.O/R10/R11 gates; `operational_reconcile.py` — A/B maintenance and outcome commit.

## 2. Comparison by axis

| Axis | Mesh today | Superagent | RLP v2.2.0 |
|---|---|---|---|
| Primary subject | Project / Group / Job | Repository / Thread / Ticket | Research State / Route / Route XID |
| Identity | `project_id`, `team_id`, `task_id`, `job_id` | thread/ticket/assignment ids | route, state_version, XID, receipt id |
| Authorization | project status + group quota + GPU lease | Policy + Mandate | execution receipt + evidence gates + A/B/C |
| Execution state | scheduler status + job status | assignment state + reports | experiments/protocols inside state; ledger outside |
| Recovery | lease expiry, reconcile, `RECONCILE_REQUIRED` | effects/outbox, resume under Mandate | state digest checks, consumed ledger, migrate lock |
| UI | Projects/Workbench/Settings | web panel for human attention | text protocol, no UI |

## 3. Authority Ownership Matrix

| Entity | Sole authority | Notes |
|---|---|---|
| Project, Group, Session Binding | Mesh | `mesh_projects`, `mesh_groups`, `mesh_session_bindings` |
| Trigger, Thread, Ticket, Mandate, Assignment, Subscription | Mesh (new `src/autonomy/`) | idempotent, project-scoped |
| Policy (autonomy mode, allowed sources, ceilings) | Mesh settings/config | versioned `policy_version` on every Mandate |
| Team Task DAG | existing Agent Teams / bridge `tasks` | Mesh does not mirror the DAG |
| Compute Job, GPU Lease, Job Manifest | Mesh | `mesh_jobs`, `mesh_gpu_leases` |
| RLP research state, evidence, claims, decisions | RLP | Mesh reads, never writes |
| RLP execution authorization | RLP ledger/receipt | Mesh verifies, never mints |
| Artifact bytes | experiment store / `artifactsDir` | content-addressed, SHA-256 |
| Artifact reference + run provenance | Mesh records; RLP accepts via outcome | explicit cross-reference, not duplicate truth |
| Model / provider choice | user config via DSH settings | no auto-selection, no fallback |
| Scientific PASS / FAIL | RLP only | Mesh stops at `ASSURANCE_PENDING` |

## 4. Real gaps found

1. **No Ticket/Mandate layer.** Mesh tasks are execution units; there is no durable work item
   that survives session churn and carries authorization scope.
2. **No event intake.** Every task enters through an API call; no trigger dedupe, no
   observe/auto candidates, no subscription fan-out.
3. **No durable effects.** Reply/notice/launch side effects happen inline; a crash between
   commit and side effect can lose or duplicate them.
4. **RLP assumptions are stale.** `src/rsi/` hardcodes `~/.agents/skills/rsi-pipeline`, the
   legacy root `canonicalStatePath()`, and required-file lists for the old skill.
5. **No L0/L1/L2 context.** Prompts would have had to inline the whole skill; no packet
   verification, no per-role subagent contract.
6. **Project routes assume legacy root.** `ProjectRegistry.inspect()` only scans
   `.research-idea-pipeline/routes`.
7. **Old tests depend on the removed `rsi-pipeline` install**, which is why 30/99 tests fail
   in the current environment; the code is not at fault but the fixture is.

## 5. Decisions for this fusion

| Need | Decision | Relationship |
|---|---|---|
| Event/ticket intake | new `src/autonomy/` engine over existing `MeshStore` connection | extend, not replace |
| Effects queue | new `mesh_effects` table + runner in `src/autonomy/effects.ts` | adapts Superagent `Effects`, reuses Mesh DB |
| RLP access | new `src/rlp/` adapters calling RLP scripts | replaces `src/rsi/` discovery semantics, keeps `RsiAdapter` as deprecated facade |
| Storage resolution | `StorageResolver` via `rlp_paths.py resolve` | extends, replaces hardcoded path |
| Context | `RlpContextAdapter` via `context_planner`/`context_packet` | new adapter, no rule reimplementation |
| Subagent permissions | `RlpSubagentContext` via `subagent_context.py` | new adapter, permits ⊆ parent |
| UI | extend Workbench with a Tickets section + API routes | no parallel panel |
| Scheduler | unchanged; tickets reference team tasks/jobs | no second scheduler |

## 6. Non-goals (explicit)

- No new agent-team framework; Captain/Member stay native DSH sessions.
- No R0–R14 as Mesh task states; RLP phases never enter `mesh_tasks.status`.
- No automatic legacy-root migration; `MIGRATION_REQUIRED` is fail-closed for formal runs.
- No automatic RLP state write, receipt mint, or scientific verdict.
- No cross-system atomic transaction claim: SQLite and the RLP file ledger use an
  intent/receipt/reconcile protocol with stable operation ids.

## 7. Verification baseline observed before changes

```
npm run typecheck                  PASS
node scripts/check-dsh.mjs         PASS (0.2.2-rc.1, schemastery 3.19.0)
npm run test:all                   99 tests, 69 pass, 30 fail
```

All 30 failures are `ENOENT ~/.agents/skills/rsi-pipeline/...`; the RLP replacement is
installed at `~/.agents/skills/research-lifecycle-protocol` v2.2.0. Section 7 is re-measured
in `07-test-evidence.md` after the migration.
