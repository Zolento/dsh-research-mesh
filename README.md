# DSH Research Mesh

**v0.1.0** — a durable, recoverable multi-group research runtime and Web console for
DeepSeek Harness, built for the Research Idea Pipeline (RSI).

DSH executes agents. RSI owns scientific logic. Research Mesh owns projects, groups,
worktrees, tasks, remote jobs and the control surface.

- Full requirements: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Integrated bridge domain: [`docs/BRIDGE-INTEGRATION.md`](docs/BRIDGE-INTEGRATION.md)
- Web console and model settings: [`docs/UI.md`](docs/UI.md)
- Tests and evidence: [`docs/TESTING.md`](docs/TESTING.md)
- Group-control harness audit and fixed bugs: [`docs/HARNESS-AUDIT.md`](docs/HARNESS-AUDIT.md)
- Current status and limits: [`docs/STATUS.md`](docs/STATUS.md)
- DSH 0.2.2-rc.1 adaptation: [`docs/DSH-0.2.2-rc1.md`](docs/DSH-0.2.2-rc1.md)
- Live local GPU scenario (2 groups × 2 subagents): [`docs/LIVE-GPU-SCENARIO.md`](docs/LIVE-GPU-SCENARIO.md)
- Live SSH + native-member scenario: [`docs/LIVE-SSH-NATIVE.md`](docs/LIVE-SSH-NATIVE.md)
- Attaching an existing whole Git repository: [`docs/PROJECT-ONBOARDING.md`](docs/PROJECT-ONBOARDING.md)

## What is implemented

- **Project registry** independent of chat sessions: RSI state ref, Git repository ref,
  status, runnable flag, durable SQLite record.
- **Session bindings**: `control`, `captain`, `member`, one active binding per session.
- **Team Manager**: 3 groups globally, 4 subagents per group, 12 globally; pause,
  resume, destroy Mesh state without deleting the worktree.
- **Worktree isolation**: one branch/worktree per group, clean/dirty/broken detection,
  path traversal and symlink-escape rejection, explicit-only cleanup.
- **Persistent scheduler**: SQLite, priority + FIFO, dependencies, compare-and-set
  claims, idempotent submit, retry/block/cancel, lease recovery.
- **GPU leases**: two static GPU ids, exclusive Mesh leases, fail-closed probe,
  quarantine on unknown remote state.
- **Executors**: `LocalExecutor`, shared `RemoteJobExecutor` with `FakeTransport`
  (FakeSSH) and `SshTransport`; immutable manifest, generated bash wrapper, Conda
  invocation, remote state file, SHA-256 artifact manifest, verified ingestion.
- **RSI adapter**: discovery, canonical state read, `state_check`, scheduler check,
  real dry-run receipt preview, consumed-ledger receipt verification, outcome handoff.
  It never writes canonical state or invents a scientific verdict.
- **Integrated RTB domain** under `src/bridge/`: SQLite store, task DAG, roles,
  permissions, recovery, staged artifacts, research state gate, RSI process adapter.
- **Web console**: native `main` panel + sidebar entry, Projects, Project Workbench,
  group expansion, Captain/member session navigation, execution/activity views.
- **Web model settings**: native `settings.section` page, manual Provider/Model per
  group/captain/subagent slot, inheritance, live catalog validation, DSH Settings
  persistence through a volatile plugin Config field.
- **Session project entry**: a bound chat shows `Research Mesh / <project>` in the
  native header/hero and returns to its workbench.

## Install locally (no network deployment)

The package is a normal DSH bundle with an optional Web client half. It is verified
against DSH `0.2.2-rc.1` (Node 24) and remains compatible with the `0.2.1-rc.x` baseline.

```bash
cd dsh-research-mesh
node scripts/link-toolchain.mjs     # local checkout only: TypeScript, @types/node, schemastery
npm run typecheck
npm test
```

Install into an isolated profile for UI verification:

```bash
# Materialize a profile, add this package as a bundle, set its config.
# A minimal local acceptance does all of this automatically:
node scripts/ui-acceptance.mjs
```

For a normal profile install:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-research-mesh
```

Then override the `dsh-research-mesh` row in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` with your project root, workers,
Conda and RSI settings. See [`examples/config.example.yml`](examples/config.example.yml).

A `--patch` overlay can load the plugin without installing it, but DSH Settings
refuses to persist volatile fields from an overlay; model settings therefore require
the plugin to be a profile bundle.

## Typical flow

1. Start DSH Web. Open **Research Mesh** in the left sidebar.
2. **Link research project**: choose the canonical
   `.research-idea-pipeline/routes/<R>/research-state.json` and the Git checkout.
3. Open the project workbench. It shows the RSI state summary, groups, Mesh jobs,
   GPU leases and recent decision-relevant events.
4. Create groups through `POST /dsh-research-mesh/api/groups` or the host API. Each
   group owns a root DSH session, a branch and a worktree.
5. Register up to four subagents per group. Each gets a real DSH session, the manually
   configured Provider/Model, and a project/session binding.
6. Open the Captain or a member from the workbench: DSH native conversation opens, and
   `Research Mesh / <project>` returns to the project.
7. **New project discussion** creates a normal workspace-backed DSH session and binds
   it as `control`; it is not a Captain.
8. Use **Research models** in Settings (or the full-width Models entry) to choose
   providers/models. Values are written to the profile patch through `ctx.settings`.
9. Submit local/demo tasks with the workbench **Run local simulation**, or submit
   experiment tasks through the service API. Artifacts are verified before a job is
   marked `INGESTED`; the task rests at `ASSURANCE_PENDING`, never a scientific PASS.

## Host API

Prefix: `/dsh-research-mesh/api`. JSON envelope: `{ ok, value }` or
`{ ok: false, error: { code, message } }`. Mutations require same-origin,
`application/json`, and a bounded body.

| Method | Path | Purpose |
|---|---|---|
| GET | `/bootstrap` | projects, model document, catalog, diagnostics, worker |
| GET | `/workbench?projectId=` | project, groups, members, models, tasks, jobs, leases, RSI summary, activity |
| POST | `/projects` | link an existing RSI project |
| POST | `/projects/status` | pause/resume/archive a project |
| POST | `/groups` | create a group (root session + worktree) |
| POST | `/subagents` | register a subagent identity |
| POST | `/sessions/control` | Host-created control session |
| POST | `/sessions/attach` | explicit project binding |
| POST | `/sessions/detach` | remove a binding, keep the project |
| GET | `/model-settings` | saved document + live catalog + invalid-route report |
| POST | `/model-settings` | validate and save through DSH Settings |
| POST | `/simulate` | submit one local task and run a worker round |
| GET | `/session?sessionId=` | binding and live status for the session header entry |

## Scheduled task states

```
PENDING → READY → CLAIMED → RUNNING → SUCCEEDED | FAILED | BLOCKED
remote experiment:
RUNNING → SUBMITTED → RECONCILE_REQUIRED | OUTPUT_READY → INGESTED → ASSURANCE_PENDING
CANCELLED only before remote execution
```

Execution success never implies a scientific conclusion. RSI remains the authority for
Assurance and outcome analysis.

## Security posture

- Path operations are boundary-checked; symlink escapes and `../` are refused.
- Git worktrees are isolation for files, **not** an OS sandbox.
- Shell commands use argv arrays and strict quoting; no agent string is interpolated as shell syntax.
- Remote jobs require a clean worktree and a full Git commit.
- SSH host-key verification is never disabled; no private key/password/token is stored.
- Model settings never contain API keys; catalog entries are identifiers only.
- Defaults keep SSH disabled and test-only fake transport/stub modes behind explicit flags.

## Known limitations

See [`docs/STATUS.md`](docs/STATUS.md). The most important:

- One runtime has one configured project root that can create groups; other registered
  projects are visible but `registered` (non-runnable).
- Mesh enforces quotas on its own creation paths; native `subagent` tool calls can
  bypass the Mesh quota unless the deployment disables that tool or adds a host guard.
- v0.1 member sessions are workspace-backed DSH sessions grouped by Mesh; they are not
  created through the native `SubagentRuntime` continuable-child path. Roster parentage
  from DSH Agent Team is therefore not yet the authority.
- Direct receipt-gated execution is a labelled `test-stub` mode. Production RSI
  authorization must use the consumed-ledger/shim path; the adapter refuses unknown
  authorization.
- Real SSH/GPU execution is implemented but not exercised in this round; only
  `FakeTransport` was tested.

## License

MIT. The integrated `src/bridge/` modules are derived from the MIT-licensed
`dsh-research-team-bridge`; provenance and local modifications are recorded in
[`docs/BRIDGE-INTEGRATION.md`](docs/BRIDGE-INTEGRATION.md).
