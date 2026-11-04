# Integrated bridge domain

`src/bridge/` is derived from the MIT-licensed
[`dsh-research-team-bridge`](https://github.com/Zolento/dsh-research-team-bridge)
checkout at `/home/lenovo/code/dsh-plugins/dsh-research-team-bridge`, commit
`2c94b93` (branch `main`). It was copied rather than renamed because that package
pins DSH 0.2.0-rc.2, cannot install on the local 0.2.1-rc.5 host, and uses a removed
subagent API. Its host-free domain still compiles and is the durable scientific layer
of this plugin.

## Copied modules

| Mesh path | Source | Role |
|---|---|---|
| `src/bridge/errors.ts` | `src/errors.ts` | `RtbError` / `RtbHold` |
| `src/bridge/ids.ts` | `src/ids.ts` | clock, ids, idempotency, structural hash |
| `src/bridge/types.ts` | `src/types.ts` | teams, members, tasks, artifacts, gate, store types |
| `src/bridge/runtime/persistence.ts` | `src/runtime/persistence.ts` | SQLite store, CAS, WAL, recovery rows |
| `src/bridge/runtime/permissions.ts` | `src/runtime/permissions.ts` | role and budget policy |
| `src/bridge/runtime/recovery.ts` | `src/runtime/recovery.ts` | journal/mail/task recovery rules |
| `src/bridge/team/roles.ts` | `src/team/roles.ts` | fixed research role catalog |
| `src/bridge/team/tasks.ts` | `src/team/tasks.ts` | dependency DAG, leases, attempts |
| `src/bridge/research/artifacts.ts` | `src/research/artifacts.ts` | staged artifacts + provenance |
| `src/bridge/research/state-gate.ts` | `src/research/state-gate.ts` | single-writer, staged proposal gate |
| `src/bridge/adapters/research-pipeline.ts` | `src/adapters/research-pipeline.ts` | read-only RSI process adapter |

`src/bridge/index.ts` is a Mesh-owned barrel; it is not copied.

## Local modifications

1. **Re-entrant transactions** (`runtime/persistence.ts`): added `transaction()` and
   `read()`; nested store calls use `SAVEPOINT` so Mesh rows and bridge rows commit in
   one outer transaction. Existing method semantics are unchanged.
2. **`claimTaskAtStatus()`**: extracted from `claimTask()` so Mesh records the
   `claimed` hand-off state before `running`; the bridge `claimTask()` still sets
   `running` for existing callers.
3. **Barrel export names**: `ROLE_CATALOG` instead of a non-existent `ROLE_PROFILES`.
4. **TypeScript settings** match the copied code (`noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes` disabled), while the rest of the Mesh source remains
   under the strict root tsconfig.
5. No other behavioural edits were made to the copied domain.

## How Mesh uses it

- `TeamManager` writes bridge `teams` / `members` rows.
- `TaskScheduler` creates bridge `tasks`, uses bridge revisions and leases; Mesh adds
  priority, remote states, worker claims and concurrency.
- `MeshService.stageResearchProposal()` / `evaluateResearchProposal()` instantiate the
  bridge `ResearchStateGate`; canonical state is never written by Mesh.
- `MeshService.stageResearchArtifact()` delegates to `stageArtifact()`.
- `RsiAdapter.pipelineAdapter()` exposes the bridge `ResearchPipelineAdapter` to the
  state gate.

## Tests of the integrated domain

- `tests/integration/bridge-domain.test.ts` proves staged hypothesis/assurance artifacts,
  gate hold, and unchanged canonical state.
- All Mesh restart/scheduler tests use the bridge SQLite store and task rows.

## Not copied

The bridge's message bus, native-team transport, captain loop, IPC/MCP, client panel,
projection and dual-leader runtime are not part of v0.1. They target rc.2 and a different
team model; Research Mesh owns group/session/task orchestration. The old repository is
left untouched, including its five pre-existing uncommitted path edits.
