# Architecture

> Authority for requirements is [`REQUIREMENTS.md`](REQUIREMENTS.md). This page
> describes the implemented runtime.

## Layers

```
Cordis plugin (src/index.ts)
├── Config (src/config/schema.ts)           volatile modelAssignments
├── MeshService (src/service.ts)            composition root
│   ├── ProjectRegistry                     projects + session bindings
│   ├── TeamManager                         groups, quotas, DSH sessions
│   │   ├── SessionHost                     DSH SessionController/AgentRegistry
│   │   └── ModelResolver                   manual model assignments + live catalog
│   ├── WorkspaceManager                    Git worktrees + PathBoundary
│   ├── TaskScheduler                       SQLite task DAG + claims
│   ├── GpuLeaseManager                     two-device exclusive leases
│   ├── ExperimentJobService                RSI authorization → manifest
│   ├── RemoteJobExecutor                   FakeSSH / SSH shared workflow
│   ├── LocalExecutor                       controller-side Conda tasks
│   ├── RlpRuntime                          skill discovery, storage matrix, L0/L1/L2
│   ├── AutonomyEngine                      Trigger → Gate → Ticket/Mandate → Assignment
│   ├── EffectsRunner                       durable outbox in the same SQLite transaction
│   ├── RsiAdapter (deprecated)             canonical state + receipt gates
│   ├── MeshWorker                          explicit claim/poll loop
│   └── integrated bridge domain            store, artifacts, state gate
├── Host API (src/host/web-api.ts)          /dsh-research-mesh/api
└── Client bundle (client/client.js)        main/sidebar/settings/session slots
```

## Persistence

One SQLite database (`<controlDir>/runtime.sqlite`) holds both the integrated bridge
domain and Mesh execution tables. The bridge store owns `teams`, `members`, `tasks`,
`messages`, `artifacts`, `journal`, `run_states`, `budgets`. Mesh adds:

- `mesh_projects`, `mesh_session_bindings`
- `mesh_groups`, `mesh_workspaces`
- `mesh_tasks`, `mesh_attempts`
- `mesh_gpu_leases`, `mesh_jobs`, `mesh_artifacts`
- `mesh_agent_models` (provider/model/config version actually used)
- `mesh_events`, `mesh_outcomes`

`SqliteTeamStore.transaction()` runs Mesh rows and bridge rows on the same connection.
Nested bridge calls use savepoints. The autonomy layer adds
`mesh_triggers`, `mesh_tickets`, `mesh_mandates`, `mesh_assignments`,
`mesh_subscriptions` and `mesh_effects` to the same database.

Scientific state is **not** in SQLite. Canonical `research-state.json` stays under the
project's `.research-lifecycle-protocol/routes/<R>/` and is read-only to Mesh. A
legacy `.research-idea-pipeline/` root is audit/migration-only and makes formal
runs fail closed (`MIGRATION_REQUIRED`).

## Project and session lifecycle

- A project exists before any group and is identified by `project_id`, never a session id.
- `control` sessions are ordinary DSH conversations bound explicitly to one project.
- A group creation creates a DSH root session (SessionController when available) and
  one worktree/branch; its session is bound as `captain`.
- A member registration creates a DSH session in the group worktree, selects the
  configured model, and binds it as `member`.
- Bindings survive process restart; one active binding per session is enforced by a
  partial unique index. Detach keeps the project and all research state.
- The client session header/hero subscribes to `/session` through a shared cache and
  renders the project entry only for a bound session.

Fake-transport local execution uses a local `nvidia-smi` probe; it is gated by
`allowFakeTransport` and is not a host-wide GPU lock. Production SSH uses the
remote probe.

## Scheduling and execution

`TaskScheduler` uses `BEGIN IMMEDIATE` plus bridge task-revision compare-and-set for
claims. Ordering is priority descending, then a monotonic `enqueue_seq` for FIFO.
Dependency completion is evaluated inside the claim transaction.

An experiment path is:

```
RLP canonical state / scheduler / manifest / receipt
  → RlpAdapter/RsiAdapter verifies authorization (preview in test mode; consumed ledger in production)
  → ExperimentJobService builds immutable manifest bound to worktree HEAD commit
  → GPU lease + fail-closed probe
  → RemoteJobExecutor stages git archive + 0600 wrapper + manifest
  → transport.submit (FakeSSH or SSH)
  → remote job-state.json / artifact-manifest.json
  → output-ready → verified SHA-256 ingestion → INGESTED → ASSURANCE_PENDING
  → outcome handoff JSON for RLP
```

`SubmitUnknown` marks `submitted_unconfirmed` and `RECONCILE_REQUIRED`; no retry is
automatic. Recovery queries remote state first. Partial artifact transfer leaves the
job at `OUTPUT_READY` and retries only the transfer.

## Autonomy

`AutonomyEngine` (`src/autonomy/engine.ts`) owns immutable Triggers, Tickets,
Mandates, Assignments and Subscriptions. It is not a scheduler: a Ticket
references an existing Team Task or compute job through an Assignment. Two
invariants are mechanical:

- a model's Assessment cannot widen a Mandate (`operations`, resource ceiling
  and RLP scope come from the Trigger + Policy);
- execution success parks a Ticket at `waiting_evidence`; only RLP's outcome
  gate permits `completed`.

Durable effects (`src/autonomy/effects.ts`) are enqueued in the same transaction
that changes autonomy rows and run after commit with bounded backoff.
`reconcile-only` effects park on error and are never re-executed, which keeps an
unknown remote submission from becoming a duplicate experiment.

## RLP integration

`RlpRuntime` (`src/rlp/`) discovers `research-lifecycle-protocol` v2.2.0,
resolves the storage matrix through `rlp_paths.py`, loads L0/L1/L2 context
through `context_planner.py`, builds and verifies Research Context Packets, and
builds per-role subagent contracts with a permits-subset check. Mesh never
re-implements an RLP rule and never writes canonical state.

## Web console extension points

Verified on DSH 0.2.2-rc.1 (baseline rc5 remains covered):

| Slot | Registration | Purpose |
|---|---|---|
| `main` (keyed) | `key: research-mesh` | global page |
| `sidebar.panellist` | `id: research-mesh` | left navigation entry |
| `settings.section` | `id: research-mesh-models` | model settings page |
| `conversation.session.header.actions` | session-scoped | project entry for a bound chat |
| `conversation.hero.options` | session-scoped | same entry on a blank/draft chat |

`ctx.layout.selectPanel('research-mesh')` switches to the console. The console never
creates a chat session on entry, never changes the selected session, and returns to the
prior conversation through normal sidebar selection. `ctx.uiWorkspace.openSession`
opens existing sessions; session creation uses `ctx.sessions.create({ workspaceId })`
for control discussions.

## Model assignment

Document shape:

```json
{
  "version": 1,
  "groups": {
    "group-a": {
      "default": { "provider": "p", "model": "m" },
      "captain": "inherit",
      "subagents": { "subagent-1": "inherit", "subagent-2": { "provider": "p", "model": "m2" } }
    }
  }
}
```

- Document lives in the plugin's **volatile Config** (`modelAssignments`), persisted by
  DSH `SettingsForms` into the profile patch. There is no model database.
- Resolution: explicit override → group default → plugin `agent` config. Missing or
  unregistered route → `MODEL_CONFIG_INVALID`; no fallback.
- SessionController sessions receive the resolved model through `selectModel`.
- The actual provider/model/source/config version per session is recorded in
  `mesh_agent_models` and shown in the Workbench.

## Failure model

| Failure | Behavior |
|---|---|
| worker dies before completion | expired local lease → task FAILED, attempt retained |
| worker dies after remote submit | task `RECONCILE_REQUIRED`, GPU lease quarantined, no auto-resubmit |
| submit response lost | `submitted_unconfirmed`; restart queries remote; duplicate launch prevented by job dir/state check |
| artifact transfer partial | job stays `OUTPUT_READY`; next collect re-downloads and verifies |
| canonical state changed after receipt | `RSI_STATE_CHANGED`; refuses job |
| provider/model removed | save/creation rejected; UI reports invalid route |
| project paused | groups paused; new submissions rejected; running jobs untouched |
