# Delivery status — v0.1.0

Date: 2026-11-05 (Asia/Shanghai)
Branch: `feat/research-mesh-v0.1.0`
Repository: `/home/lenovo/code/dsh-plugins/dsh-research-mesh` (local git, no remote)

## Verified environment

- Installed DSH: `0.2.1-rc.5`
- Source checkout: `/home/lenovo/code/dsh-plugins/deepseek-harness`,
  tag `dsh-v0.2.1-rc.2`, commit `687f282e86`
- Node: `v22.23.2`
- RSI: `/home/lenovo/.agents/skills/rsi-pipeline`, install source
  `2269957302bd0e8c1b18fdea7c5f9c229ddaa420`
- DSH Web acceptance runs an isolated profile, port and `DSH_HOME`; the user's running
  GUI/profile is untouched.

## Test result at delivery

| Suite | Tests | Result |
|---|---|---|
| Unit | 45 | pass |
| Integration | 6 | pass |
| End-to-end + fault injection | 3 | pass |
| **Total** | **54** | **pass, 0 fail, 0 skip** |
| Typecheck | `tsc --noEmit` | pass |
| Client bundle syntax | `node --check client/client.js` | pass |
| Real Web UI acceptance | Chrome CDP script | pass |

Commands actually run:

```bash
node scripts/link-toolchain.mjs
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run test:all
node scripts/ui-acceptance.mjs
```

## Completed phases

- **Phase 1** — source audit; rc.5 loader/client/session/settings/model APIs verified;
  bridge host-free domain copied; plugin skeleton.
- **Phase 2** — project registry, session bindings, quotas, worktrees, path boundaries.
- **Phase 3** — SQLite scheduler, deterministic priority/FIFO, CAS claims, GPU leases,
  recovery, project/session Web APIs.
- **Phase 4** — immutable manifests, Local/FakeSSH/SSH executors, Conda wrapper,
  artifact SHA-256 ingestion, fault injection, RSI adapter.
- **Phase 5** — real Web profile boot, Projects/Workbench/Settings UI, session navigation,
  model settings persistence, screenshots, responsive checks.

## Local UI evidence

Captured by `scripts/ui-acceptance.mjs` from the real web profile; the script also
asserts zero horizontal overflow:

- `docs/screenshots/projects-1440.png`
- `docs/screenshots/workbench-1440.png`
- `docs/screenshots/workbench-group-1440.png`
- `docs/screenshots/captain-session-1440.png`
- `docs/screenshots/member-session-1440.png`
- `docs/screenshots/workbench-1280.png`
- `docs/screenshots/workbench-768.png`
- `docs/screenshots/workbench-390.png`
- `docs/screenshots/model-settings-1440.png`
- `docs/screenshots/model-settings-390.png`
- `docs/screenshots/projects-dark.png`

The screenshots were inspected; no clipped content or horizontal overflow was accepted.

## Confirmed end-to-end state progression

`READY → CLAIMED → RUNNING → SUBMITTED → OUTPUT_READY → INGESTED → ASSURANCE_PENDING`

Artifacts were hashed and verified. Canonical RSI state was checked before/after and
never changed. The task was not written as scientific PASS.

Fault A: `submitted_unconfirmed` + `RECONCILE_REQUIRED`; restart + reconcile adopted the
existing remote job; one execution.
Fault B: first collect `ARTIFACT_CHECKSUM_MISMATCH`; job retained `OUTPUT_READY`;
second collect passed; one execution.

## Known limitations / not verified

1. **Single runnable project root.** One plugin instance can create groups only for the
   project whose repository is the configured `sourceDir` and whose state is under
   `projectRoot`. Additional projects are registered read-only. Full multi-project
   execution is not implemented.
2. **Subagent parentage.** Captain/member sessions are created through
   `SessionController` and grouped by Mesh bindings. They are not created through the
   native `SubagentRuntime` continuable-child path, so DSH Agent Team roster parentage is
   not yet the authority. Quotas are enforced on Mesh creation paths.
3. **Native subagent tool bypass.** Model-invoked native `subagent` tool calls do not pass
   through the Mesh quota. A deployment requiring a hard stop must disable that tool or
   install a host guard.
4. **RSI authorization mode.** The UI/demo execution path uses the adapter's explicitly
   labelled preview/test-stub mode; production dispatch must use a consumed-ledger shim.
   The adapter verifies a real consumed receipt in unit tests but the full RSI
   `run --execute` shim round trip was not exercised.
5. **Real transport.** SSH and real Conda/GPU execution are implemented but unverified
   against a workstation. Tests use `FakeTransport` and fake Conda.
6. **Remote network faults.** Only lost submit response and partial artifact transfer were
   injected; long partitions and remote process crashes were not.
7. **Settings persistence mode.** Model assignments are a volatile plugin Config written
   by DSH Settings into the profile patch. The page uses a plugin HTTP API for its data
   (not `configForms` directly); project/workbench data has no public Remote namespace.
8. **UI shell constraints.** At 390 px the native Settings modal reserves most of the
   width; the full-width Models view inside Research Mesh is the mobile path. DSH does
   not expose a third-party settings-section icon, so the generic gear is used.
9. **Pause semantics.** Pausing parks the project's groups (no new claims) and leaves
   running jobs untouched. There is no separate "stop team" action in the UI.
10. **Deletion/lifecycle.** Project deletion, worktree cleanup and forced remote-job
   cancellation are API-only or intentionally absent from the main UI; irreversible
   actions are not presented as one-click controls.

## Git state

- Local branch only; no remote configured.
- No push, merge, tag, release or deployment.
- No DSH upstream file modified; no RSI file modified.
- `node_modules/`, runtime SQLite, worktrees, temp artifacts and logs are ignored.
- The original `dsh-research-team-bridge` repository and its pre-existing uncommitted
  changes were not modified.
