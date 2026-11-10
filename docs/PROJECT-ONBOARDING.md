# Attaching an existing RSI Git repository

The plugin does not need a special `source/` subdirectory. An existing RSI
checkout can be the project root itself.

## UI flow

1. Open **Research Mesh → 关联研究项目**.
2. Use **打开「添加工作区」** (or the sidebar **+ 添加工作区**) to open DSH's
   native Add-workspace window and pick the repository root. The plugin does not
   reimplement or override that host dialog; after the workspace exists, choose
   it from **从已有 DSH 工作区选择**.
3. The plugin calls `POST /projects/inspect` and:
   - verifies the path is a Git checkout;
   - discovers `.research-lifecycle-protocol/routes/*/research-state.json`;
   - fills the project name and the first valid route;
   - shows whether this runtime can execute the repository or only register it
     read-only.
4. Pick another route from the dropdown if needed.
5. Click **关联**. If this profile is configured for the repository, the plugin creates
   the default control, worktrees and artifacts/store directories automatically.
   It still does not create or modify RLP state.

If the repository has no RLP state, the form does **not** invent one. It offers a
copyable migration prompt instead.

## Whole-repository configuration

For a repository such as MoSA:

```yaml
- id: dsh-research-mesh
  name: dsh-research-mesh
  config:
    projectRoot: /home/lenovo/code/myproj/MoSA
    sourceDir: .                         # the repo itself
    controlDir: /home/lenovo/code/myproj/.mesh/MoSA
    worktreesDir: /home/lenovo/code/myproj/.mesh/MoSA/worktrees
    sessionBinding: dsh
    allowFakeTransport: false
```

`sourceDir: .` makes the repository root the executable source. Mesh creates
`controlDir` (and later worktrees) itself; it does not write the RLP state.
Worktrees must live outside the repository checkout.

The current runtime has **one executable source root per profile**. Other
repositories can be registered in the UI as read-only; use another DSH profile
with a different `projectRoot` for a second executable repository.

## Migration prompt

Copy this into a DSH/Claude session when the repository has no RLP state:

```text
请在 Git 仓库 <ABSOLUTE_REPO_PATH> 中按 research-lifecycle-protocol skill 规范初始化研究项目：
1. 读取 research-lifecycle-protocol skill 的 references/project-layout.md 与 Bootstrap/start-project 入口；
2. 保留现有代码和 Git 历史，不要重写或迁移业务代码；
3. 按规范创建 .research-lifecycle-protocol/routes/A/research-state.json，state_version 必须存在，内容来自真实项目分析而不是模板占位；
4. 运行 state_check.py 和项目规定的校验，报告无法自动判断的信息，禁止伪造科学状态；
5. 完成后告诉我在 DSH Research Mesh 中应使用的 route 和 state 路径。
```

The plugin creates only Mesh control directories and worktrees. A canonical
`research-state.json` must come from the RSI workflow; the UI rejects a state
without `state_version`.

The previous custom chooser was removed. The plugin now reuses the DSH
Workspace registry: users pick a repository in the native Add-workspace window,
then the project form selects that workspace path. This keeps the exact host UI
without a third-party modal. The typed absolute-path field remains for
automation.
