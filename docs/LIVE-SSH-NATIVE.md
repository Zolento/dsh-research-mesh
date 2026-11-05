# Live SSH + native-member scenario

This follows [LIVE-GPU-SCENARIO.md](LIVE-GPU-SCENARIO.md) with two changes:
the executor used a **real SSH transport to localhost**, and members were created
as **native DSH SubagentRuntime children** (`nativeMembers: true`).

It is still an engineering integration run. The RSI state is the imported
preflight example, the workload is a synthetic GPU smoke task, and the run used
the RSI test-stub preview path. It is not a scientific result.

## Environment

- DSH `0.2.2-rc.1`, Node `v24.12.0`, isolated profile `mesh-real`, port `3321`.
- Real OpenSSH server on localhost:22, user `lenovo`, temporary dedicated
  `ed25519` key added to `authorized_keys` only for this test and removed after.
- Real conda env `torch` and RTX 4060 Ti. The remote job root was
  `/tmp/mesh-real/remote-ssh`.
- Provider `deepseek-pool/deepseek-flash` through the API Pool relay.

## Results

- 2 groups, 4 members, each member a native child session:
  - `bc107e64…` worker-1-1, parent `session-02a36559…`
  - `60cd046e…` worker-1-2
  - `979b2814…` worker-2-1
  - `94febee4…` worker-2-2
- Raw session header for `bc107e64…`:
  ```json
  {"origin":"subagent","parentSession":"session-02a36559…",
   "delegationDepth":1,"agentPreset":"standard"}
  ```
  with descriptor `mode:continuable`, `provider:spawn`.
- Quotas still held: third group rejected, third member rejected.
- Real SSH job `job_a2138592…` reached `output_ready → ingested`; task reached
  `ASSURANCE_PENDING`; GPU lease released; artifact manifest verified.
- `metrics.json`: `cuda:0`, RTX 4060 Ti, `torch 2.13.0+cu132`, MSE
  `0.037900…`, wall clock `0.261 s`.
- RSI canonical state digest unchanged; preview `PASS`.
- Worktrees/source clean.

## Bug found and fixed

**SSH GPU probe treated normal desktop VRAM as busy.** It queried only
`index,memory.used` and required `< 64 MiB`; a desktop using 893 MiB on a 16 GB
card was reported busy, so the first SSH run failed `GPU_UNAVAILABLE`. The probe
now queries `memory.total` and uses the same 90% occupancy rule as the local
probe. The rerun acquired GPU 0 and completed.

This also documents the remaining risk: occupancy alone cannot see compute
contention or another low-memory process.

## Native-member limitation observed

The native child is created and persisted with correct parentage, but after its
initial `MESH_MEMBER_READY` activation settles the in-process Agent is no longer
live. The test driver's `sessionController.prompt(memberId)` therefore returned
`missing live session`. Navigation to the persisted child is still the intended
UI path; follow-up turns should use the native SubagentRuntime continuation API,
not the controller prompt path used for controller-backed members.

## Group controls

The Workbench now has group-level Pause / Resume / Stop / Destroy and an inline
New group action. Stop is distinct from pause: it parks the group, cancels
`PENDING`/`READY` tasks, and leaves running jobs untouched. The UI acceptance run
exercised Pause → Resume; the API test covers Pause/Stop/Resume and requires
explicit `confirm:true` for Destroy.

## Main profile

`dsh-research-mesh` is installed in the running `web` profile and configured
against `/home/lenovo/code/myproj/MoSA` as a whole-repository project (see
[PROJECT-ONBOARDING.md](PROJECT-ONBOARDING.md)). The running GUI still needs one restart to activate the new bundle row;
that restart was not performed by this test.

## Remaining gap

Consumed-ledger support now accepts a shim **authorization manifest** separately
from the real **execution manifest**, and the shim has a consume-only mode. A
full real consumed-ledger run (RSI consumes once, Mesh verifies, Mesh launches,
crash recovery) is still not wired as a single coordinator.
