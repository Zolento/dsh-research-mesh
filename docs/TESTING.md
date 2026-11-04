# Testing

All tests run locally, offline, against temporary projects, a temporary SQLite
database, a fake remote root and a fake Conda executable. No real SSH, GPU, MRI data or
user research project is touched.

## Commands

```bash
cd dsh-research-mesh
node scripts/link-toolchain.mjs
npm run typecheck
npm test              # tests/unit
npm run test:integration
npm run test:e2e
npm run test:all
node scripts/ui-acceptance.mjs   # real Web profile + headless Chrome
```

`npm run test:all` is the aggregate: 72 tests after the group-control harness audit
(63 unit + 6 integration + 3 end-to-end). The audit findings and their
regression tests are in [`HARNESS-AUDIT.md`](HARNESS-AUDIT.md).

## Coverage map

### Unit

| File | Covers |
|---|---|
| `teams.test.ts` | 3 groups / fourth rejected; 4 subagents each / 13th rejected; destroyed group releases quota; pause/resume; restart registry; group default, captain and subagent override; slot-order fallback; resume model; state-path escape; team-id collision; invalid model; no-fallback |
| `workspaces.test.ts` | three worktrees; independent edits; source baseline untouched; existing-directory refusal; `..`; absolute path; symlink escape; dirty cleanup refusal; explicit force; restart recognition |
| `scheduler.test.ts` | priority + FIFO; dependencies; one winner across two schedulers; idempotent submit; restart; invalid transitions; retry/cancel/block; expired local lease recovery; direct-claim concurrency; terminal current-task cleanup |
| `gpu.test.ts` | two tasks lease GPU 0/1 independently; no double lease; one task cannot hold two GPUs; unknown/busy fail-closed; reconcile then reuse |
| `executor.test.ts` | exact Conda argv; manifest traversal/absolute/GPU/forged-digest rejection; test-stub gate; generated wrapper with hostile argv (no shell execution); artifact-manifest path/hash validation |
| `rsi.test.ts` | real skill discovery; read-only `state_check`; real receipt preview; real consumed receipt via ledger; state-change rejection; preview forbidden without explicit test flag |
| `projects.test.ts` | project registration; invalid/missing RSI state; restart; readability failure; control/member bindings and cross-project refusal; manual-pause preservation; archive; startup pause reconciliation; Captain-binding rollback; destroy detaches bindings |
| `model-settings.test.ts` | Config-backed DSH settings write/version; stale-cache refresh; empty group schema; override-without-default rejection; selected model reaches session host; file store restart |
| `client-bundle.test.ts` | loader id; inject; main/sidebar/settings/header/hero registrations; initial component render |
| `session-host.test.ts` | controller member creation without live Captain; model failure cancels the short-lived session |

### Integration

| File | Covers |
|---|---|
| `bridge-domain.test.ts` | staged hypothesis/assurance artifacts, gate hold, canonical state unchanged |
| `multi-team.test.ts` | three concurrent groups, task/team/workspace binding, file isolation, GPU cross-team coordination |
| `dsh-loader.test.ts` | real `@deepseek-ai/dsh-app-boot` Cordis loader: mount, service, config, local task, unload/close |
| `web-api.test.ts` | real loopback HTTP: bootstrap, project creation, workbench, simulation, same-origin 403, content-type 415, model save/invalid |

### End to end

`tests/e2e/closed-loop.test.ts`:

1. temp project + three groups + worktrees;
2. four subagent identities per group;
3. real RSI fixture (state, scheduler, manifest, receipt, ledger);
4. preview authorization (explicit test mode) → manifest → GPU 0 lease;
5. `FakeSSHExecutor` runs the real generated wrapper through fake Conda;
6. real metrics/log files and SHA-256 artifact manifest;
7. verified collection → `INGESTED` → `ASSURANCE_PENDING`;
8. Task/Team/Manifest/Artifact/RSI references checked, state unchanged.

Fault A — submit response lost:

- fake transport starts the remote process and throws `SUBMIT_UNKNOWN`;
- task becomes `RECONCILE_REQUIRED`, job `submitted_unconfirmed`, GPU lease quarantined;
- controller closes, restarts, marks in-flight work for reconciliation;
- `reconcileJob` finds the existing remote result and adopts it;
- collection succeeds; the run log has exactly one execution.

Fault B — partial artifact transfer:

- first download of `metrics.json` is truncated;
- first `collectJob` fails with `ARTIFACT_CHECKSUM_MISMATCH`, task stays `OUTPUT_READY`;
- second `collectJob` succeeds; the run log still has exactly one execution.

## UI acceptance

`scripts/ui-acceptance.mjs`:

- creates an isolated `DSH_HOME`;
- materializes the shipped `web` template into a profile;
- installs this package as a **profile bundle** (not a `--patch` overlay, so DSH Settings
  can persist volatile fields);
- adds a test-only mock LLM adapter and fake Conda/transport;
- boots the real `dsh --profile mesh-ui` Web app on a test port;
- creates one project, three groups, four subagents per group, and a local simulation;
- drives headless Chrome over CDP:
  - dismisses the shipped preview notice;
  - opens Research Mesh from the sidebar;
  - captures Projects, Workbench and expanded Group A;
  - opens the Captain conversation and verifies the project entry;
  - opens a member conversation and verifies the project entry;
  - pauses/resumes the project;
  - captures 1280/768/390 layouts and asserts no horizontal overflow;
  - opens the native Settings section and model page;
  - saves the model document, verifies the profile patch and a browser reload;
  - captures a dark appearance via `prefers-color-scheme`;
  - verifies the assembled Captain used `mock/mock-pro` and the subagent inherited
    `mock/mock-flash`;
  - creates a control discussion, verifies its binding and project entry.
- exits nonzero on any assertion; screenshots are written to `docs/screenshots/`.

## Not tested (honest gaps)

- Real SSH transport and real remote Conda/GPU execution.
- Real RSI `run --execute` shim round trip; the adapter's consumed-ledger verification is
  unit-tested against a real RSI-issued/consumed receipt, while the Mesh e2e uses the
  explicitly labelled preview/test-stub mode.
- Long-running remote jobs and network partition behavior beyond the two injected faults.
- Native DSH Agent Team roster parentage for member sessions (v0.1 uses SessionController
  sessions grouped by Mesh).
- Real API-key/provider traffic and model responses; UI uses a mock adapter.
