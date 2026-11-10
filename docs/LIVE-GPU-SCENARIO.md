> Historical engineering run (RSI-era paths). Current integration: `docs/fusion/`.

# Live local GPU scenario — 2 groups × 2 subagents

This is an engineering integration run of `dsh-research-mesh`, not a scientific
study. The RSI canonical state is the **RSI skill's imported preflight example**
(`examples/preflight-identifiability/ct-mri.json`), and the GPU workload is a
synthetic linear-regression smoke task. No claim or research state was updated.

## Environment

- DSH: `@deepseek-ai/dsh@0.2.2-rc.1`, Node `v24.12.0`, isolated profile
  `mesh-real`, port `3321`.
- Provider: API Pool relay at `http://127.0.0.1:8765/v1`, route
  `deepseek-pool`, model `deepseek-flash`. The isolated profile used the live
  relay through a `llm-pi-ai` provider profile; it did not load a second copy of
  the `dsh-api-pool` host plugin.
- Local compute: NVIDIA GeForce RTX 4060 Ti, CUDA 13.3, conda env `torch`,
  PyTorch `2.13.0+cu132`.
- Project: `/tmp/mesh-real/project`; source Git baseline
  `/tmp/mesh-real/project/source`; isolated DSH home `/tmp/mesh-real/home`.
- The main running DSH profile/port `3080` was not modified.

## Scenario

1. Register one project with RSI route A canonical state.
2. Create exactly two groups, each with its own Git worktree.
3. Register two subagents in each group (4 total), all on
   `deepseek-pool/deepseek-flash`.
4. Prompt one Captain and one member with a real model request.
5. Run one RSI-bound GPU experiment through the Mesh executor on group A.
6. Verify worktree isolation, quotas, session bindings, RSI state immutability,
   GPU lease release and artifact hashes.

## Observed results

### Groups and sessions

| Group | Root session | Worktree | Subagents |
|---|---|---|---|
| group-a | `session-ae0ac49d…` | `worktrees/group-a` | `session-71e060f7…` experiment, `session-1de26004…` assurance |
| group-b | `session-6deaba21…` | `worktrees/group-b` | `session-a6137a76…` experiment, `session-bbe86358…` assurance |

- Exactly 6 DSH sessions: 2 Captain + 4 members.
- All four subagents and both Captains recorded
  `provider=deepseek-pool`, `model=deepseek-flash`, source `group-default`.
- Prompting Captain A and member A-1 produced a real assistant message
  `MESH_PROVIDER_OK` with response metadata
  `provider=deepseek-pool`, `model=deepseek-flash`; both settled to `idle`.
- Group B remained idle; it had no task. Its sessions and model selections were
  verified, but no model prompt was sent there.

### Quotas and isolation

- Third group: rejected, `at most 2 research groups are supported`.
- Third subagent in group A: rejected, `already has 2 subagents`.
- No third group worktree was created; exactly two worktrees exist.
- Marker written in group A did not appear in source or group B.
- Source, group A and group B worktrees were clean after the run.

### Real GPU experiment

| Field | Value |
|---|---|
| Task | `task_453b3696…` |
| Job | `job_f363f841…` |
| Job final | `ingested` |
| Task final | `ASSURANCE_PENDING` |
| GPU | 0, RTX 4060 Ti |
| Actual device | `cuda:0` |
| CUDA available | true |
| torch | `2.13.0+cu132` |
| Steps | 400 |
| Wall clock | `0.233 s` |
| Artifact manifest digest | `33154bb1…` |
| Artifacts | `metrics.json`, `run.log` |

Artifacts:

```
metrics.json  sha256 ede976e3…  272 bytes
run.log       sha256 eba7fbc3…  253 bytes
```

The job reached `OUTPUT_READY → INGESTED`; the task reached
`ASSURANCE_PENDING`, not scientific PASS. The GPU lease was `released` before
collection. An outcome handoff file was written under
`.research-mesh/outcomes/job_f363f841….json`.

### RSI boundary

- `state_check.py --check` passed with zero hard violations before/after.
- `experiment_execute.py scheduler-check` returned `PASS`.
- Canonical state SHA-256 was identical before and after the Mesh run:
  `baef3c7e…`.
- The route A state was not modified by Mesh.
- The RSI receipt was created by the real `experiment_execute.py issue` path and
  the Mesh run was authorized through `run` **preview** only. `consumed` is
  `null`; no ledger consumption occurred.

## Bugs found during the run

### Fixed: group API accepted a route with no RSI state

The first run created group B (route B) even though
`routes/B/research-state.json` did not exist. The group had a worktree and
sessions but no readable route state, so any RSI task in it would fail later.

**Fix:** `MeshService.createGroup()` now requires a readable state file for the
requested route before creating a group. `tests/unit/projects.test.ts` covers
the rejection and successful creation after the state exists. The UI acceptance
and this scenario now seed valid route B/C states.

### Fixed: local GPU test blocked by fail-closed fake probe

With a local `transport: fake` worker, the executor used `UnknownGpuProbe`, so
the first real run failed closed with `GPU_AVAILABILITY_UNKNOWN` even though the
GPU was free.

**Fix:** fake-transport workers now use `LocalGpuProbe`, which queries
`nvidia-smi` without a shell and fails closed on missing data. The rerun acquired
GPU 0 and completed. This is test-only transport; production SSH still uses
`SshGpuProbe`.

### Fixed after this run: three recorded defects

The three defects this scenario and the harness audit left open were fixed in
the follow-up round: durable `prepared -> submitting` job CAS, a host
`tools.guard()` for native `subagent` calls, and automatic `control` binding
detach on session disposal. See
[HARNESS-AUDIT.md](HARNESS-AUDIT.md) "Closed in the follow-up round".

### Test-harness issue: prompt assertion was too weak

The driver's `sawExpectedText` check searched the serialized session including
the user prompt, so it could match `MESH_PROVIDER_OK` before the assistant
replied. The actual provider response was verified separately in the raw
session log (`assistant/message` with source
`model=deepseek-pool/deepseek-flash`). The report should not rely on that boolean
alone.

## Follow-up: real SSH and native members

See [LIVE-SSH-NATIVE.md](LIVE-SSH-NATIVE.md) for a real localhost SSH run and
native SubagentRuntime member parentage. The SSH GPU probe was fixed there.

## Risks / boundaries observed

1. **This is a test-stub/preview execution, not a consumed RSI run.** The task
   is `ASSURANCE_PENDING`; the ledger was not consumed and no scientific
   outcome was written. A production run must use the consumed-ledger/shim path.
2. **The RSI state is an imported CT/MRI preflight example**, while the executed
   workload is a generic GPU linear-regression script. The RSI manifest binds
   both the example `train.py` and the extra GPU script, but the scientific
   protocol and the actual workload do not match. The metrics have no scientific
   meaning.
3. **The transport is `fake-ssh`.** The wrapper, conda env and GPU are real and
   local, but there is no SSH, remote host, or remote isolation.
4. **The provider route uses the live API Pool relay directly**, not a second
   `dsh-api-pool` host plugin in the isolated profile. Provider/model selection
   and real completions were verified; pool endpoint management was not.
5. **`LocalGpuProbe` is not an exclusive GPU lock.** It treats GPU memory below
   90% as available and does not account for compute contention or other users.
   It is fail-closed on missing data, but not a scheduler for the whole host.
6. **Subagents are controller-backed DSH sessions grouped by Mesh**, not native
   `SubagentRuntime` continuable children. Prompting works; native roster
   parentage is not established.
7. **The prompt was injected through the host `sessionController` from a
   test-only driver plugin**, bypassing the Web UI approval path. It proves the
   provider route, not the production chat interaction path.
8. **Group B was not exercised with a task.** It validates two-group creation,
   session/model setup and isolation, but only group A ran an experiment.
9. **The real API Pool relay log contains unrelated `client disconnected`
   entries** from the existing main DSH traffic; our two prompts completed
   successfully. No plugin warning/error was emitted.

## Reproduction artifacts

Kept locally (not committed):

- `/tmp/mesh-real/report.json`
- `/tmp/mesh-real/project/.research-idea-pipeline/routes/A/`
- `/tmp/mesh-real/project/.research-mesh/artifacts/job_f363f841…/`
- `/tmp/mesh-real/project/.research-mesh/outcomes/job_f363f841….json`
- `/tmp/mesh-real/server.log`

The isolated server and the stale test server were stopped after the run.
