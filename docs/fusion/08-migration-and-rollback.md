# 08 — Migration and rollback

## 1. What changed for an existing profile

| Area | Change | Compatibility |
|---|---|---|
| config | `rlp` block is canonical; `rsi` is parsed as an alias | old `rsi:` configs keep working |
| skill | RLP v2.2.0 discovery; legacy `rsi-pipeline` never implicit | set `rlp.skillPath` explicitly for an old install |
| storage | new root `.research-lifecycle-protocol/` preferred | legacy-only project → `MIGRATION_REQUIRED` for formal runs |
| DB | additive `mesh_*` autonomy tables | no column removed or renamed |
| API | new `/autonomy`, `/triggers`, `/tickets*`, `/autonomy/mode`, `/rlp` | existing routes unchanged |
| UI | Tickets section + RLP badge | existing panels unchanged |
| worker | effects tick around each round | behavior additive |
| version | `0.2.0` | release tag `dsh-research-mesh-v0.2.0-dsh0.2.2-rc.1` |

## 2. Legacy root handling

- Only the legacy root → `MIGRATION_REQUIRED`; `createGroup` and
  `submitExperimentTask` refuse; inspection and audit still work.
- Both roots → `AMBIGUOUS_STORAGE_ROOT`; fail closed.
- New root but no recognizable content → `INVALID_STORAGE_ROOT`; never rebuilt.
- Mesh never runs `migrate_project_root.py --apply`; the operator runs
  `inspect`/`plan` and then migrates with writers stopped.

## 3. Migration steps (operator, explicit)

```bash
# 1. Inspect the layout, do not write.
python3 ~/.agents/skills/research-lifecycle-protocol/scripts/migrate_project_root.py inspect --project <project>

# 2. Plan and back up.
python3 .../migrate_project_root.py plan --project <project> --backup-root <dir>

# 3. Stop DSH sessions and Mesh workers, then apply (the tool asks for
#    confirmation that external writers are still); never from the plugin.
python3 .../migrate_project_root.py migrate --project <project> --apply

# 4. Verify, restart the profile, open the Workbench and confirm READY.
```

## 4. Rollback

- Code: `git checkout <previous-tag>` (or `afa6fc9` for v0.1.0). The autonomy
  tables are additive and ignored by the previous code; the schema remains
  readable.
- Config: remove the `rlp` block and restore `rsi`; the parser accepts both.
- Data: no automatic deletion. If a migration was applied, use RLP's own
  `migrate_project_root.py rollback`; Mesh does not touch RLP files.
- Effects: pending rows from a newer version are inert if the previous code does
  not handle their kinds; they are not re-executed by old code.

## 5. Releases

- Tag format includes the DSH baseline:
  `dsh-research-mesh-v0.2.0-dsh0.2.2-rc.1`.
- Tag only after `typecheck`, `test:all`, `check-dsh` and (for UI changes)
  `ui-acceptance` pass on that commit.
- No push, merge or deploy was performed by this branch; the release tag is a
  local decision for the operator.

## 6. Compatibility notes

- Frozen protocol ids `research-idea-pipeline/...@1` are untouched.
- `src/rsi/` remains importable; `RsiAdapter`/`RlpAdapter` and
  `DEFAULT_RSI_PATHS` are deprecated aliases, not removals.
- Error codes `RSI_*` remain valid API codes; new `RLP_*` codes cover the new
  storage/context gates. Callers should branch on both during transition.
