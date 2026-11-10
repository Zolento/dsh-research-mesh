# 02 — Authority and state

## 1. Authority Ownership Matrix

| Entity | Sole authority | Store |
|---|---|---|
| Project, Group, Session Binding | Mesh | `mesh_projects`, `mesh_groups`, `mesh_session_bindings` |
| Trigger | Mesh | `mesh_triggers` (unique dedupe key) |
| Thread relation (subscription) | Mesh | `mesh_subscriptions` |
| Ticket | Mesh | `mesh_tickets` (unique idempotency key) |
| Mandate | Mesh | `mesh_mandates` (immutable; revoke only) |
| Assignment | Mesh | `mesh_assignments` |
| Policy / autonomy mode | Mesh config | `rlp.autonomyMode`, `policyVersion` on Mandate |
| Team Task DAG | native Agent Teams / bridge `tasks` | bridge tables |
| Compute Job, GPU Lease | Mesh | `mesh_jobs`, `mesh_gpu_leases` |
| RLP Research State, Evidence, Claim, Decision | RLP | `<project>/.research-lifecycle-protocol/routes/<R>/research-state.json` |
| RLP execution authorization | RLP ledger/receipt | route `.execution/` ledger |
| Artifact bytes | experiment store (`artifactsDir`) | content-addressed files |
| Artifact provenance | Mesh records, RLP accepts | `mesh_artifacts`, `mesh_outcomes` |
| Model / provider | user config via DSH settings | profile patch `modelAssignments` |
| Scientific PASS/FAIL/HOLD | RLP | research state only |

## 2. Stable identities

| Object | Prefix | Scope | Idempotency |
|---|---|---|---|
| Trigger | `trg_` | project | `dedupe_key` unique; replay returns `duplicate` |
| Ticket | `tkt_` | project/route | `idempotency_key` unique, defaults `trigger:<triggerId>` |
| Mandate | `mnd_` | project/route | one per authorization; reissued (not mutated) on explicit re-auth |
| Assignment | `asg_` | ticket | at most one active `pending|running` per ticket |
| Effect | `eff_` | global | unique `(kind, dedupe_key)` |

## 3. State machines

### Trigger disposition
`accepted` (ticket created) · `candidate` (recorded, no work) · `ignored`
(mode off / ineligible) · `blocked` (policy) · `attached` (named ticket) ·
`duplicate` (replay).

### Ticket
```
open → assigned → running → waiting_compute | waiting_evidence | waiting_human
     ↑                                              │
     └──────────── resume (explicit, mandate valid) ┘
any → ended (completed | stopped | failed | cancelled)
```
Rules:
- `ended` is terminal for autonomous triggers; only an explicit resume of a
  non-stopped ticket reopens it.
- `stopped` revokes the Mandate and cannot be resumed by any event.
- `completed` is set only after RLP commits its own scientific outcome; a
  successful executor parks the ticket at `waiting_evidence`.
- RLP R0–R14 phases never appear as Mesh states.

### Assignment
`pending → running → ended`. A retry creates a new attempt; a remote-backed
attempt is never retried automatically (`RECONCILE_REQUIRED`).

### Effect
`pending → running → succeeded | failed | dead`, bounded exponential backoff;
`reconcile-only` kinds park at `failed` on error and are never re-executed.

## 4. Mandate rules

- Created from a Trigger plus the current Policy; records issuer, source,
  project/route, scope, allowed operations, resource ceiling, RLP scope and
  policy version.
- Immutable. A policy change does not revoke live Mandates; an ended ticket's
  resume revalidates and, when explicit, issues a **new** Mandate under the
  current policy.
- Autonomous Mandates never include `compute.submit`, `rlp.state.write` or
  experiment execution.
- A model's Assessment can propose a Ticket but can never widen operations,
  resources or scope.

## 5. Persistence and recovery

All autonomy tables are additive in `<controlDir>/runtime.sqlite`, sharing the
transaction of the bridge domain. On startup:
1. recover scheduler/jobs/GPU/worktrees (existing behavior);
2. tick due effects;
3. show unresolved `failed` effects as human attention items.

No cross-system atomicity is claimed: SQLite and the RLP file ledger are linked
by stable operation ids and an intent → receipt → reconcile protocol.
