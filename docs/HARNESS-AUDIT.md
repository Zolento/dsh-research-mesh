# Group-control harness audit

Scope: the code that actually controls research groups — `TeamManager`,
`DshSessionHost`, `ProjectRegistry`, `TaskScheduler`, GPU leases, project
pause/archive transitions, and the group-related Host API. The review was done
against the committed v0.1.0 plus the changes below.

## High-severity findings fixed

### 1. Destroyed groups still consumed the global subagent quota

`TeamManager.totalSubagents()` counted every group, including `destroyed`.
After three groups had twelve agents, destroying one still left
`status().subagents === 12`; the freed four agents could not be used.

**Fix:** destroyed groups are excluded from the global count. A regression test
fills 3×4 agents, destroys group A, creates group D and registers four more
(12 total).

### 2. Project resume resurrected manually paused groups

`setProjectStatus('paused')` paused all active groups; `setProjectStatus('active')`
resumed **all paused groups**, including a group the human had paused manually.
The same bug meant a crash between project-status write and group pause left
active groups under a paused project.

**Fix:** a `mesh_project_pauses(project_id, team_id)` table records only groups
parked by the project transition. Resume restores only those rows. Startup
`reconcileProjectPauses()` repairs drift in either direction; `archived` and
`registered` projects also park running groups. Tests cover manual-pause
preservation and explicit reconciliation.

### 3. The group API could create an orphan group

`POST /groups` called `service.createTeam()`, which created a group even when
the requested `projectId` did not exist. That group had no project, no Captain
binding and consumed a slot.

**Fix:** the API uses `MeshService.createGroup()`, which requires a registered,
runnable, active project whose canonical RSI state is currently readable. A
missing project returns 404 and leaves no group/worktree. `createTeam()` remains
the lower-level deterministic-test seam.

### 4. Failed Captain binding left a half-created group and worktree

If the DSH captain binding failed after the group transaction, the old code
only logged a warning. The group stayed active, unbound and consuming a slot;
its worktree remained.

**Fix:** the service retires the group (which disposes the controller session)
and removes the just-created worktree before rethrowing. A regression test
pre-binds the root session as `control`, forces `SESSION_BINDING_CONFLICT`, and
asserts the group is destroyed, no Captain binding exists, and the worktree is
gone.

### 5. One task could hold two GPU leases

`GpuLeaseManager.acquire()` only checked device occupancy and worker capacity.
Two concurrent submits for the same task could lease GPU 0 and GPU 1 and launch
the experiment twice. The old GPU test even asserted this incorrect behavior.

**Fix:** a task that already owns an active/reserved/quarantined lease is
refused. `RemoteJobExecutor.submit()` also serializes duplicate submits per job
in-process; the losing GPU submit returns without failing the task. The test now
leases GPU 0/1 for **two different tasks** and separately proves one task cannot
hold two devices.

### 6. Adopting an existing remote job after restart leaked its GPU lease

`submit()` acquired the GPU lease **before** reading pre-existing remote state.
If a previous controller had already submitted the job, the method adopted the
remote state but never released the newly acquired lease.

**Fix:** remote state is read before GPU acquisition. A pre-existing job is
adopted/reconciled without taking a new lease. Remote state mismatch now
quarantines the old lease instead of leaving it active.

### 7. Retrying a remote-backed task could resubmit it

`TaskScheduler.retry()` checked only `failed`/`blocked`; it did not inspect the
persisted remote `jobId`. An operator retry could create a new job for a task
whose old remote process still existed.

**Fix:** retry is refused while `meta.jobId` or a remote status is present, and
a remote-backed failure is kept `FAILED` (never converted to `READY` for
automatic retry). The operator must reconcile/abandon and create a new task
with fresh RSI authorization. Submit errors that make the remote state
unknowable enter `RECONCILE_REQUIRED`, not `FAILED`.

## Medium-severity findings fixed

- **Member binding ownership:** a `member` binding could name a group belonging
  to another project; it now checks project ownership and refuses destroyed
  groups.
- **Destroyed groups in project views:** `groupCount` and the Workbench listed
  destroyed groups; active views now exclude them.
- **Member release left its binding active:** `releaseSubagent()` now detaches
  the project binding, otherwise the released session could never be reused.
- **Destroyed group left bindings active:** `destroyTeam()` now detaches the
  Captain and every member binding after Mesh state is retired.
- **Subagent slot mismatch:** WebUI slots are named `subagent-1`…`subagent-4`,
  while registered Mesh identities have names like `worker-1`. Resolution now
  falls back to `subagent-<registration ordinal>`; a regression test proves the
  first named worker receives the `subagent-1` override.
- **Captain resume model:** `resumeRootSession()` used the plugin-wide fallback
  instead of the group's persisted captain assignment. It now resolves the
  group's current manual model.
- **Controller member after restart:** creation required the Captain Agent to be
  live even though the controller path does not need a parent handle. The
  controller path now runs first, so a persisted group can add a member after a
  restart.
- **Session creation failure:** a controller session whose `selectModel` failed
  was left orphaned. It is now cancelled/discarded, and resuming then disposing
  also releases the resumed handle.
- **Group id collision:** a caller-supplied `teamId` could overwrite an existing
  bridge team; collision is checked before and inside the creation transaction.
- **Scheduler stale pointer:** `currentTaskId` remained after success/failure/
  cancellation/block. Terminal transitions clear it.
- **Direct `claimTask` bypass:** named claims now enforce team/group active state
  and global/per-team concurrency, matching `claimNext`.
- **Stale task/team mismatch:** `claimNext` requires both the Mesh group and the
  bridge team to be active; submission requires an active group and a matching,
  active project. The scheduler also checks project status inside the claim
  transaction, closing the pause/claim race. A submission whose `projectId`
  differs from the group's project is refused.
- **Re-registering a released member:** `mesh_agent_models` used a plain INSERT,
  so reusing a released session hit the primary key. It is now an UPSERT; the
  administrator can release and re-register the same external session.
- **Captain session reused as a member:** the duplicate check now covers group
  Captain ids, not only existing member rows.
- **Project activation with missing RSI state:** `setStatus('active')` now
  refuses an unreadable canonical state, and member registration requires an
  active project.
- **Artifact ingestion:** artifact IDs can no longer collide after path
  sanitizing; artifact rows + job update commit atomically; a DB failure rolls
  back the promoted final directory; staging is cleared before a retry; hashing
  is streamed in 1 MiB chunks.
- **Model settings:** `Config` schema now accepts an untouched empty group
  (`captain: inherit`, no default); a group with overrides but no default is
  rejected. Config-backed reads observe a newer volatile revision instead of
  serving an indefinitely stale cache.
- **State path escape:** group creation canonicalizes the RSI state path and
  rejects lexical or symlink escapes outside `projectRoot`; group creation also
  rejects a project whose RSI state is no longer readable.
- **UI path leakage:** project cards/workbench no longer fall back to showing a
  full RSI filesystem path when no description exists.

## Regression tests added

- destroyed group releases quota and group slot
- scheduler refuses project/group mismatch and paused-project claims
- state-path escape rejection
- team-id collision rejection
- project pause preserves manual group pause
- project archive parks groups and blocks submission
- startup pause reconciliation repairs drift
- missing RSI state blocks orphan group creation
- member binding cannot cross projects
- failed Captain binding rolls back group/worktree
- destroyed group detaches Captain/member bindings
- released member binding is detached
- subagent slot override applies by registration order
- captain resume uses group model
- controller member creation without a live Captain
- controller model failure cancels the short-lived session
- direct claim honors per-team concurrency
- terminal task clears group `currentTaskId`
- one task cannot hold two GPU leases
- unknown project cannot create a group through the API
- remote nonzero exit ends FAILED, never READY for automatic resubmission
- released member can be re-registered without a primary-key conflict
- Captain session cannot be registered as a member
- project activation checks canonical-state readability

## Remaining limitations (not papered over)

- **Cross-process duplicate submit without a GPU** is still possible in theory:
  the in-process submit lock and one-task-one-GPU rule cover the current
  single-controller GPU deployment, but there is no distributed job CAS.
- Member sessions are controller-backed DSH sessions grouped by Mesh; they are
  not native `SubagentRuntime` continuable children, so DSH Agent Team roster
  parentage is not the authority yet.
- Native model-invoked `subagent` tool calls bypass Mesh quotas.
- Real SSH/Conda/GPU execution remains unexercised.
- Session deletion does not automatically detach a control binding; Detach is
  explicit. Destroying a **group** does detach its generated bindings.
- A group whose worktree was retained after destruction blocks reuse of the same
  group name/branch until workspace cleanup is explicitly performed.

## Verification

- `npm run typecheck` — pass.
- `npm run test:all` — 75 tests, 0 failures.
- `node scripts/ui-acceptance.mjs` — real isolated DSH web profile + Chrome CDP,
  pass; all screenshots regenerated.
- No push, deployment, real SSH, real GPU, or upstream modification.
