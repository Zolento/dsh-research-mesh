# Canonical checkout + Mesh worktrees

**Collaboration contract:** `dsh-research-mesh/mesh-collaboration@1`.

This is the operating contract implemented by the plugin for a whole-repository
RLP project such as MoSA.

## Layout

```text
canonical checkout/          # solo DSH session, canonical RLP state, Git history
  .research-lifecycle-protocol/routes/<R>/research-state.json
  .git/

outside the checkout/
  .mesh/<project>/control/   # SQLite, manifests, shards, outcomes
  .mesh/<project>/worktrees/ # mesh/<group> Git worktrees
  /data/zhanglt/<project>_store/  # large artifacts, weights, history
```

## Enforced by the plugin

- `sourceDir: .` makes the canonical checkout the only executable source.
- For a whole-repository project, `controlDir` and `worktreesDir` must be
  **outside** the source checkout. Configuration rejects them otherwise.
- Group worktrees always use the `mesh/<group>` branch prefix.
- `ProjectRegistry` registers a repository as runnable only when its real path
  equals the configured `sourceDir`; other RSI repositories are read-only.
- `artifactsDir` defaults to `<controlDir>/artifacts`; for MoSA it points at
  `/data/zhanglt/MoSA_store/mesh/artifacts`. Large products belong in the store,
  never in the worktree or canonical checkout.
- The worker reads the canonical RLP state through `RsiAdapter`; it never writes
  `research-state.json`. Git naturally checks out tracked state into a worktree,
  but that copy is only a baseline snapshot; reads use the canonical absolute
  path, and the only authority is the canonical state.
- Mesh does not allocate RSI experiment IDs. The RLP single writer reserves the
  route/XID before dispatch; the worker records the supplied id and artifact
  paths so collisions can be detected on merge.
- Job creation starts from the worktree HEAD; uncommitted canonical changes are
  not silently copied into a group. Commit or stash first.
- A handled consumed-ledger crash is marked `RECONCILE_REQUIRED`; it is never
  resubmitted automatically.
- A GPU lease is not a system-wide lock. Operators must check the Mesh lease,
  RLP scheduler and the actual GPU process together; a solo session is invisible
  to the plugin lease.

## Solo + team coexistence

| Work | Location |
|---|---|
| Solo DSH session | canonical checkout |
| Mesh group code | separate `mesh/<group>` worktree |
| RLP state | canonical checkout, read-only to Mesh |
| GPU/experiment | Mesh lease + RLP scheduler; no concurrent same-GPU run |
| Merge back | review worktree commits, then merge/cherry-pick |

Do not use `cp -a` for isolation. Use a Git worktree, or let Mesh create group
worktrees. Do not archive worktrees as permanent copies; use the project's
`/data/...` archive rules.

## Deployment: one profile per project

One DSH profile has one executable project. Keep MoSA in `web` (or `web-mosa`)
and create `web-<project>` for every other canonical repository, each on its own
port, controlDir and store path. See
[PROFILE-PER-PROJECT.md](PROFILE-PER-PROJECT.md). Restart the affected profile
after changing `projectRoot`, `sourceDir`, `controlDir` or `artifactsDir`.
