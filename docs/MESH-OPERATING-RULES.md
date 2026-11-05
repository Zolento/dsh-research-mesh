# Canonical checkout + Mesh worktrees

This is the operating contract implemented by the plugin for a whole-repository
RSI project such as MoSA.

## Layout

```text
canonical checkout/          # solo DSH session, canonical RSI state, Git history
  .research-idea-pipeline/routes/<R>/research-state.json
  .git/

outside the checkout/
  .mesh/<project>/control/   # SQLite, manifests, shards, outcomes
  .mesh/<project>/worktrees/ # mesh/<group> Git worktrees
```

## Enforced by the plugin

- `sourceDir: .` makes the canonical checkout the only executable source.
- For a whole-repository project, `controlDir` and `worktreesDir` must be
  **outside** the source checkout. Configuration rejects them otherwise.
- Group worktrees always use the `mesh/<group>` branch prefix.
- `ProjectRegistry` registers a repository as runnable only when its real path
  equals the configured `sourceDir`; other RSI repositories are read-only.
- The worker reads the canonical RSI state through `RsiAdapter`; it never writes
  `research-state.json`. The only RSI write path is the explicit `A/B/C` state
  copy performed by the human/RSI skill, not by Mesh.
- Job creation starts from the worktree HEAD; uncommitted canonical changes are
  not silently copied into a group. Commit or stash first.
- A handled consumed-ledger crash is marked `RECONCILE_REQUIRED`; it is never
  resubmitted automatically.

## Solo + team coexistence

| Work | Location |
|---|---|
| Solo DSH session | canonical checkout |
| Mesh group code | separate `mesh/<group>` worktree |
| RSI state | canonical checkout, read-only to Mesh |
| GPU/experiment | Mesh lease + RSI scheduler; no concurrent same-GPU run |
| Merge back | review worktree commits, then merge/cherry-pick |

Do not use `cp -a` for isolation. Use a Git worktree, or let Mesh create group
worktrees. Do not archive worktrees as permanent copies; use the project's
`/data/...` archive rules.

## Switching a plugin runtime

One DSH profile has one executable `sourceDir`. To switch the canonical
repository, update `projectRoot`/`sourceDir` in the profile patch (or use a
separate profile), restart DSH, and re-attach the project.
