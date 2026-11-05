# MoSA → Research Mesh migration

## 1. RSI state paths

MoSA is already a canonical RSI project. The paths the plugin needs are:

```text
/home/lenovo/code/myproj/MoSA/.research-idea-pipeline/routes/A/research-state.json
/home/lenovo/code/myproj/MoSA/.research-idea-pipeline/routes/B/research-state.json
/home/lenovo/code/myproj/MoSA/.research-idea-pipeline/routes/C/research-state.json
```

Select the **repository root** `/home/lenovo/code/myproj/MoSA`, not
`MoSA/source`. In the attach form, type that root and press **检测**; the route
list should show A/B/C. If it does not, the running bundle is older than the
onboarding change or the selected directory is not the repo root.

## 2. Do not copy 9.3 GB just to isolate Mesh

`MoSA/AGENTS.md` already says:

- one canonical implementation under `~/code/MoSA`;
- no `MoSA_*` sibling code copies;
- use Git branches/worktrees for experimental variants.

A full `cp -a MoSA MoSA_mesh` would create a 9.3 GB duplicate, duplicate the
Git object store, and conflict with that rule.

### Recommended: canonical MoSA + Mesh worktrees

Use canonical MoSA for a solo DSH session and let Research Mesh create its own
group worktrees outside the checkout:

```yaml
projectRoot: /home/lenovo/code/myproj/MoSA
sourceDir: .
controlDir: /home/lenovo/code/myproj/.mesh/MoSA
worktreesDir: /home/lenovo/code/myproj/.mesh/MoSA/worktrees
```

This is the current `web` profile configuration. Solo work stays in MoSA;
each Mesh group gets `mesh/group-*` worktrees and never edits the canonical
checkout. Group worktrees start at `HEAD`, so commit or stash current changes
before creating groups.

### If you really need a separate MoSA_mesh

Do not copy the whole directory. Use a Git worktree, which shares objects and
history:

```bash
cd /home/lenovo/code/myproj/MoSA
# Commit or stash current changes first: a worktree starts at a commit.
git worktree add /home/lenovo/code/myproj/.mesh/MoSA_mesh \
  -b mesh/solo-baseline
```

Then use:

```yaml
projectRoot: /home/lenovo/code/myproj/.mesh/MoSA_mesh
sourceDir: .
controlDir: /home/lenovo/code/myproj/.mesh/MoSA_mesh-control
worktreesDir: /home/lenovo/code/myproj/.mesh/MoSA_mesh-worktrees
```

Uncommitted MoSA changes are **not** included. To carry them over, commit them
on a temporary branch first, or create a patch and apply it in the worktree.
Large data/checkpoints must stay symlinked; never duplicate them.

## 3. AGENTS.md section for dual solo/Mesh work

This section is now present in the canonical MoSA `AGENTS.md` as §11, and the
plugin enforcement is documented in [MESH-OPERATING-RULES.md](MESH-OPERATING-RULES.md).
The shared contract id is `dsh-research-mesh/mesh-collaboration@1`.

Add this to the project's `AGENTS.md` (canonical or the worktree copy):

```text
## Research Mesh 团队工作约定

- canonical 代码根目录仍为项目 Git 根目录；单开会话默认在这里工作。
- Mesh 不直接写 canonical checkout：每个 group 使用独立 Git worktree，
  分支为 mesh/<group>；组内改动只在该 worktree 内提交。
- Mesh 控制目录与 worktree 根必须放在仓库外（例如
  /home/lenovo/code/myproj/.mesh/<project>），不得提交进 Git。
- canonical Research State 位于
  .research-idea-pipeline/routes/<route>/research-state.json；Mesh worker
  只读该状态，不得在 worktree 内另造或改写同名状态。
- 建组前先提交或 stash canonical 的未提交改动；worktree 从 HEAD 创建。
- 单开会话与 Mesh 组不得同时占用同一 GPU/实验；以 Mesh GPU lease 和
  RSI scheduler 为准。
- 组结束后将 worktree 的提交合并/摘回 canonical 前先做 review；
  不删除历史证据、不重置 RSI 失败记录或预算。
```

## 4. Migration prompt

Paste this into a DSH/Claude session:

```text
请在 /home/lenovo/code/myproj/MoSA 中完成 Research Mesh 迁移，遵守现有
AGENTS.md 与 rsi-pipeline skill：
1. 不复制 9.3GB 代码目录，不新建 MoSA_* 兄弟副本；使用 Git worktree 或
   Mesh 自动创建的 worktree。
2. 保留现有 .research-idea-pipeline/routes/{A,B,C}/research-state.json，
   不修改 canonical Research State，不伪造 state_version。
3. 确认 sourceDir 为仓库根，controlDir/worktreesDir 放在仓库外的
   /home/lenovo/code/myproj/.mesh/MoSA 下。
4. 在 AGENTS.md 增加“单开会话 + Mesh 团队工作”约定：单开在 canonical，
   Mesh 组只在 mesh/<group> worktree 中写代码；建组前提交/stash；RSI
   canonical state 只读；GPU/实验不并发冲突。
5. 校验 git status、state_check.py、scheduler-check；报告未提交改动、
   子模块和数据软链接的处理方式。
```
