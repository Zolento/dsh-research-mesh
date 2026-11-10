# 05 — Runtime and recovery

## 1. Agent session vs compute job

- A Ticket's Assignment binds an **execution attempt**, not an Agent process.
- A Captain session may end its turn while a remote GPU job continues; the
  Ticket parks at `waiting_compute` with the job id (`markTicketCompute`).
- `compute_job_completed` / `compute_job_failed` Triggers wake the Ticket; the
  Workbench shows the wait explicitly.
- A long GPU job therefore never holds an Agent Worker slot.

## 2. Loops

| Loop | Owner | Cadence |
|---|---|---|
| Agent turns | DSH sessions | driven by the Captain/member |
| Task claim/execute | `MeshWorker` | `runWorkerOnce()` or `schedulerPollMs` |
| Job poll/collect | `MeshWorker.pollJobs()` | every worker round |
| Durable effects | `EffectsRunner.tick()` | startup, before/after each worker round, explicit `runEffects()` |

Order on every `runWorkerOnce()`: due effects → one claim/execute round → job
poll/collect → due effects again.

## 3. Crash windows

| Crash point | Durable state | Recovery |
|---|---|---|
| before commit | nothing | replay is safe; Trigger dedupe/Ticket idempotency key |
| after commit, before effect | effect row `pending` | tick after restart |
| effect ran, ack lost | effect stays `pending` | handler is idempotent by `(kind, dedupe key)`; `reconcile-only` parks |
| RLP receipt consumed, job not confirmed | journal `consumed` + ledger `consume` | `#markConsumedInterruptions` → `RECONCILE_REQUIRED`, never rerun |
| scheduler claim lost | expired lease | task FAILED, attempt retained |
| remote submit unknown | job `submitted_unconfirmed` | query remote state first; adopt or reconcile |
| partial artifact transfer | job `OUTPUT_READY` | retry transfer only, verify SHA-256 |
| policy changed while a ticket waits | old Mandate | resume requires explicit approval, new Mandate |

## 4. Restart behaviour

1. `MeshService.init()` opens SQLite, builds autonomy store/engine, discovers RLP.
2. `startupRecovery()` runs the existing scheduler/job/GPU/worktree recovery.
3. Due effects run once.
4. Workbench shows:
   - `rlp.storageStatus` and `formalRunAllowed`;
   - open tickets and their waits;
   - `autonomy.pendingEffects` and failed reconcile items;
   - recent candidates.

No Ticket is ended by a restart. No effect is duplicated because every mutation
is keyed by a stable identity.

## 5. Admission controls

- `submitExperimentTask` and `createGroup`: refuse legacy-only or ambiguous RLP
  roots synchronously.
- `MeshWorker` experiment path: requires an RLP authorization (`consumed`
  receipt in production; `preview` only with `allowTestStub`).
- GPU lease: fail-closed probe; `unknown` blocks.
- Native `subagent` tool: host guard denies member fan-out, paused groups and
  quota overflow.

## 6. What is not claimed

- No OS-level sandbox: worktrees and `PathBoundary` protect Mesh APIs, not the
  process account.
- No cross-system transaction: SQLite ↔ RLP ledger uses intent/receipt/reconcile.
- No exactly-once remote execution: the guarantee is "at most one launch without
  reconciliation", not automatic retry.
