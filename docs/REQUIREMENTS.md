> Historical requirement baseline (v0.1.0, RSI era). Where it conflicts with RLP v2.2.0, the RLP skill and `docs/fusion/` are authoritative; Mesh engineering behaviour follows the current source and tests.

# DSH Research Mesh — 权威需求文档（v0.1.0）

> 本文件是当前开发的**需求权威来源**，用于在上下文压缩、会话恢复或换人接手时完整恢复任务。
> 当本文件与零散聊天冲突时，以本文件 + 本地实际源码 + 已通过测试为准；若用户后续明确修订，追加“变更记录”而不覆盖历史。
>
> 文档版本：`req-2026-11-05-01`
> 项目目录：`/home/lenovo/code/dsh-plugins/dsh-research-mesh`
> 本地分支：`feat/research-mesh-v0.1.0`
> 产品标识：`dsh-research-mesh`
> 目标版本：`v0.1.0`

---

## 0. 任务定位与总原则

### 0.1 产品定位

DSH Research Mesh 是**面向 RSI Pipeline 的轻量级多群组科研协作运行时**，不是新的科研 Agent 框架。

- **DSH** 执行 Agent。
- **RSI** 管理科研逻辑与科学权威。
- **Research Mesh** 管理群组、任务、工作区、远程作业和科研项目控制台。

### 0.2 四条不可动摇的原则

1. **Research Project First**：科研项目是长期主体，不依附于某个聊天 Session。
2. **Session as Interface**：DSH 原生 Session 是讨论、控制和查看历史的入口，不是项目身份。
3. **Team as Executor**：Research Group 是执行单元；Captain 是 DSH Root Session，成员是 DSH 子代理。
4. **RSI as Scientific Authority**：科学阶段、证据、Assurance、实验授权、预算、结论只能由 RSI 决定。Mesh 不伪造、不越权、不把执行成功写成科学 PASS。

### 0.3 最小复杂度

- 优先复用 DSH 已有能力（Session、Agent、Subagent、Team、Settings、Model Catalog、WebUI Slots）。
- 优先复用已有 `dsh-research-team-bridge` 的 host-free 领域逻辑。
- 不引入 Kubernetes、Slurm、Ray、Redis、Temporal、Docker/Podman 等额外运行平台。
- 不重复实现 RSI 的科研决策、Assurance、证据闸门。
- 不为了未来大规模 Swarm 过度设计。
- v0.1 目标是**正确、可恢复、可验证的最小闭环**，不是最大规模。

---

## 1. 源码基线与环境（2026-11-05 实测）

### 1.1 本地 DSH

| 项 | 值 |
|---|---|
| 目标运行态 | 发布包 `@deepseek-ai/dsh 0.2.2-rc.1`（临时 npm 安装验证） |
| 本地源码 checkout | `/home/lenovo/code/dsh-plugins/deepseek-harness` |
| 源码 tag | `dsh-v0.2.2-rc.1` |
| 源码 commit | `66491b05e3…` |
| Node | `v24.12.0`（rc1 要求 >=24.9.0）；插件源码/Tests 仍可用 Node 22 验证 |
| 兼容基线 | 保留 `0.2.1-rc.5` 回归验证 |
| SQLite | `node:sqlite` 可用（`DatabaseSync`），有 ExperimentalWarning |
| DSH home | `/home/lenovo/.dsh` |
| Web GUI | `http://127.0.0.1:3080` |

历史参考版本 `dsh-v0.2.0-rc.2` 仅作对比，**不切换、不覆盖当前源码**。

### 1.2 插件加载事实

- 外部插件包：`type: module`、`main` 指向入口、`dsh.bundle.patch`、可选 `dsh.client.platform: "web"` + `exports["./client"]`。
- 版本门禁优先看 `engines.dsh`。当前项目声明：`">=0.2.1-rc.2 <0.3.0-0"`。rc1 的兼容性检查使用 `includePrerelease: true`，因此该范围覆盖 `0.2.2-rc.1`；已在 rc1 `evaluatePluginCompatibility()` 中实测。
- 本地免安装加载：`dsh --profile <p> --patch <abs.yml>`，patch 里 `name` 可为**绝对文件路径**。
- 真实 Loader 进程内测试：`@deepseek-ai/dsh-app-boot` 的 `boot(binName, absoluteConfigPath)`。
- 插件 `apply` 若为 async，**不能返回非 disposer 的对象**（Cordis 会报 `Invalid effect`）；异步 apply 必须返回 `undefined`。
- 注册通过 `ctx.effect()` / `ctx.on()` / `ctx.provide()`；卸载必须释放 SQLite、定时器、Session handle、HTTP 路由。
- 外部 `--patch` 绝对路径行位于 profile 模块拦截层之外，因此**运行时不要 import `@deepseek-ai/*`**；本插件的 host-free 模块不依赖 DSH 包。

### 1.3 现有 `dsh-research-team-bridge`

- 路径：`/home/lenovo/code/dsh-plugins/dsh-research-team-bridge`
- 单分支 `main`，32 commits，无 remote、无 tag、无 stash；有 5 个未提交的路径修改，**不得清理或覆盖**。
- 该仓库固定在 `dsh-v0.2.0-rc.2`，在 rc.5 下安装被拒绝，rc.5 subagent API 已重命名。
- 其 **host-free 领域层**质量高、可复用：`runtime/persistence.ts`、`team/tasks.ts`、`team/roles.ts`、`runtime/permissions.ts`、`runtime/recovery.ts`、`research/artifacts.ts`、`research/state-gate.ts`、`adapters/research-pipeline.ts`、`types.ts`、`errors.ts`、`ids.ts`。
- 本轮已将这些模块复制进 `src/bridge/` 并做最小改造（事务可重入、Mesh 状态 claim），详见 `docs/BRIDGE-INTEGRATION.md`。

### 1.4 本地 RSI

| 项 | 值 |
|---|---|
| 已安装 skill | `/home/lenovo/.agents/skills/rsi-pipeline` |
| 安装来源 | `INSTALL-SOURCE.json`：branch `research-idea-pipeline/skill-rsi-dev`，commit `2269957…` |
| 是否 git 仓库 | 否（安装副本） |
| 本机源码副本 | `/home/lenovo/code/myproj/skills-dev/research-idea-pipeline/skill-rsi-dev/research-idea-pipeline` |
| canonical state | `<project>/.research-idea-pipeline/routes/<R>/research-state.json` |
| scheduler | 同目录 `scheduler.json` |
| ledger | `<route>/.execution/`（`events.jsonl`、`key`、`head`） |
| 关键脚本 | `state_check.py`、`experiment_execute.py`、`execution_gate.py`、`evidence_outcome.py`、`preset_router.py` |

**RSI 既有契约（实测）：**

- `state_check.py <state> --check --json`：只读；退出 0 通过 / 3 硬违规 / 4 环境。
- `experiment_execute.py issue`：产生 `execution-receipt@1`（HMAC seal、binding、TTL 900s）。
- `experiment_execute.py run` 默认 dry-run（preview），**不消费预算**；`--execute` 才追加 `consume` 事件并在本地 `subprocess.run` 阻塞执行。
- `evidence_outcome.py` 要求 `execution_record.launch_seal` 与真实 `consume` 事件匹配；外部调度器**不能**自行 dispatch 后伪造 receipt。
- **合规外部调度模式**：RSI `run --execute` 启动一个阻塞的 Mesh shim，shim 提交/等待 Mesh 作业；RSI 仍拥有 consume、seal、预算、日志。
- v0.1 的直接 receipt-gated 执行仅作为显式 `test-stub`/`preview` 测试模式，生产默认必须走 consumed-ledger 或明确拒绝。
- 不存在 `rsi_receipt_ref` 字段；真实引用是 `execution_record.receipt.id` + `launch_seal`。
- 无稳定的机器可读“当前 R0–R14 阶段”；UI 只能展示 state/version/scheduler/uncertainties/experiments 等可核实信息，不得自造成阶段。
- RSI canonical state **只读**；Mesh 不写、不改、不复制成第二科学真相。

---

## 2. 实体模型与数据关系

### 2.1 核心实体

```
Research Project 1 ── N Research Group 1 ── N Subagent
        │                   │
        │                   ├── Captain = DSH Root Session
        │                   ├── Worktree / Branch
        │                   └── Mesh Tasks / Jobs
        │
        ├── N Session Binding (control / captain / member)
        ├── 1 Canonical RSI Research State (只读权威)
        ├── N Mesh Task
        ├── N Mesh Job / Artifact
        └── 1 Project Control Directory
```

### 2.2 Research Project 字段（最低）

```
project_id: string           # 稳定、不得等于聊天 Session ID
name: string
description: string
rsi_state_ref: string        # 绝对 canonical research-state.json 路径
repository_ref: string       # 绝对 Git 仓库路径
status: active | paused | archived | registered
runnable: boolean            # 当前运行时能否为其创建 Group/Worktree
created_at: timestamp
updated_at: timestamp
```

### 2.3 Research Group 字段（最低）

```
group_id / team_id: string
project_id: string
route_name / research_route_id: string
captain_session_id / root_session_id: string
workspace_id: string | null
worktree_ref: string
status: active | paused | destroyed
current_task_id: string | null
created_at / updated_at: timestamp
```

### 2.4 Session Binding 字段

```
project_id: string
session_id: string
role: control | captain | member
group_id: string | null
attached_at: timestamp
detached_at: timestamp | null
```

约束：

- Project ID 独立于聊天 Session ID。
- 同一项目允许多个 Control Session。
- 同一 Captain Session 只能属于一个 Group。
- 一个 Group 只能属于一个 Project。
- 一个 Session 同一时刻只能有一个 active binding。
- 成员真实父子关系以 DSH 持久化 Session / Agent Team Roster 为准。
- Fork 产生新 Session，不自动继承项目写入授权；需显式 Attach。
- 删除 Control Session 只解除绑定，不级联删除项目。
- 关闭聊天标签页不删除 Project/Group/Job/RSI State。
- Captain Session 丢失显示“需要恢复”，不得静默重建并重复任务。

---

## 3. 规模与配额

全局硬上限（跨全部项目共享，不是每项目）：

- 最多 **3 个 Research Groups**。
- 每组最多 **4 个 Subagents**。
- 全局最多 **12 个 Subagents**。
- 最多 **3 个 Captain Root Sessions**（与 3 Groups 对应）。
- Root Captain 不计入 12 个 Subagents。
- 禁止子代理绕过 Mesh 配额递归创建新代理。

必须区分：

- **Agent 身份数量**（配额）。
- **同时执行的模型请求数量**（并发限制）。
- **GPU 作业并发数**（资源租约）。

已知限制：DSH rc.5 无法可靠拦截全部原生 subagent 创建入口（模型工具可绕过）。Mesh 在自身创建/委派路径强制配额；部署若需全局硬停，应禁用原生 `subagent` 工具或安装 host guard。不得假装实现了全局强制。

第一版允许只让一个项目处于完整活动状态；其他项目可登记、查看、暂停。

---

## 4. 运行架构模块（第一版四模块 + RSI Adapter）

### 4.1 Mesh Team Manager

- 持久化 Team Registry。
- 创建 / 查询 / 暂停 / 恢复 / 销毁 Mesh 管理状态。
- DSH 重启后恢复 Registry。
- 复用 DSH Session Persistence，不另写聊天记录/Agent Memory。
- 每组对应独立 DSH Root Session（Captain）。
- 组注册 4 个 subagent identity；强制 4/12 配额。
- 模型解析必须使用用户手动配置的 Provider/Model，不允许自动 Fallback。

### 4.2 Workspace Isolation Manager

科研项目运行工作区布局：

```
research-project/
├── source/                       # Git 基线仓库
├── worktrees/
│   ├── group-a/
│   ├── group-b/
│   └── group-c/
└── .research-mesh/
    ├── runtime.sqlite
    ├── sessions/
    ├── manifests/
    ├── logs/
    ├── artifacts/
    ├── proposals/
    └── outcomes/
```

要求：

- 从指定 Git Commit / 基线分支创建 Worktree。
- 每组唯一工作分支。
- 查询 Worktree 状态、未提交修改、损坏检测。
- 防止不同 Group 共用同一可写目录。
- 暂停/恢复保留工作区。
- 只有显式 cleanup 命令才能删除工作区。
- 不得删除用户已有目录。
- 不得使用 `git clean -fdx`。
- 所有 Mesh 文件操作做路径规范化与边界检查：`../`、绝对路径、符号链接逃逸、同名目录覆盖、源基线误改、Artifact 写出工作区。
- 明确声明 Git Worktree 不是 OS 安全沙箱；只保证 Mesh API 边界。

科研状态隔离：

- 一个科研项目只有一个权威 Research State。
- 每组可产生提案/产物，但通过 Coordinator 按 RSI 规则验证/写回。
- 不得让三个 Agent 同时直接修改同一 `research-state.json`。
- 优先复用 RSI 的原子写入、锁、版本机制。

### 4.3 Persistent Task Scheduler

- 本地 SQLite，不引入外部消息队列、Redis、Temporal。
- SQLite 只负责执行状态；RSI `research-state.json` 负责科学状态。
- Task 最低字段（snake_case 契约）：

```
task_id, project_id, team_id, type(research|local|experiment),
status, priority, dependencies[], created_at, updated_at,
attempt_id, workspace_id, rsi_state_version, receipt_ref
```

扩展字段允许：`payload`、`job_id`、`gpu_id`、`max_attempts`、`error_code`、`error_message`、`enqueue_seq`。

状态机：

```
PENDING → READY → CLAIMED → RUNNING → SUCCEEDED / FAILED / BLOCKED
远程实验额外：
SUBMITTED → RECONCILE_REQUIRED | OUTPUT_READY → INGESTED → ASSURANCE_PENDING
取消：CANCELLED（仅尚未运行/远程未提交）
```

调度：

- 确定性 FIFO + Priority，不做 LLM 自适应。
- 支持提交、按 Team 查询、依赖检查、领取、并发限制、持久化转换、失败记录、幂等提交、进程重启恢复、显式重试/阻塞/取消未运行任务。
- 所有关键状态转换使用事务。
- 防止两个 Worker 同时领取同一任务（BEGIN IMMEDIATE + CAS）。
- 稳定 `task_id` 与 `attempt_id`；不得用进程 PID 作为任务身份。
- 远程任务 `RECONCILE_REQUIRED` 时禁止自动重新提交。

Runtime 生命周期：

- Controller 由 DSH 插件提供 Service。
- 允许显式 start/stop/drive，不要求独立守护进程。
- 插件卸载释放回调、定时器、本地资源。
- 不依赖 DSH 聊天上下文维持队列。

### 4.4 Resource Manager（单工作站双 GPU）

静态配置：

```yaml
workers:
  workstation:
    transport: ssh
    enabled: false
    gpu_ids: [0, 1]
    max_gpu_jobs: 2
    conda_environment: configurable
```

- `enabled: false` 为默认安全值。
- 本地 GPU 租约表；同一 GPU 同时最多一个 Mesh 独占实验任务。
- GPU 0/1 可分别分配；第三个独占任务等待。
- 异常恢复后先对账再重新分配。
- 已停止/状态未知任务不得导致静默重复提交。
- 租约只约束 Mesh 提交的作业，不代表 OS 级独占，不能检测所有外部用户任务。
- 提交真实任务前必须验证目标 GPU 可用；无可靠检查接口时拒绝或待确认，不得假定空闲。
- 不实现复杂抢占、显存预测、动态迁移。

### 4.5 SSH / Conda Executor

统一执行接口：

- `LocalExecutor`
- `SSHExecutor`
- `FakeSSHExecutor`

FakeSSH 与生产共用同一 Job Manifest Schema 与状态转换逻辑。

Conda：

- 默认 `conda run -n <env> --no-capture-output python ...`；实际参数以本地 Conda 为准。
- 不默认 `source activate` 修改全局 Shell。
- 环境名/可执行文件由配置提供。
- 不自动创建、删除、升级远程 Conda 环境。
- 不自动安装 CUDA/PyTorch 等大型依赖。
- DSH 自身 Node/pnpm 不强制 Conda。

Job Manifest 最低字段：

```jsonc
{
  "job_id": "...",
  "attempt_id": "...",
  "project_id": "...",
  "team_id": "...",
  "code": { "commit": "..." },
  "execution": {
    "entrypoint": "...",
    "argv": [],
    "working_directory": "...",
    "conda_environment": "..."
  },
  "resources": { "worker_id": "workstation", "gpu_id": 0 },
  "artifacts": { "destination": "artifacts" },
  "authorization": {
    "rsi_receipt_ref": "...",
    "research_state_version": "..."
  }
}
```

安全：

- 不得拼接任意 Agent 生成的 Shell 字符串远程执行。
- 受控 argv 数组、路径白名单、严格转义。
- 默认要求已提交且可识别的 Git Commit；有未提交修改拒绝远程提交。
- 代码用 Git Commit 固定，通过不可变归档/受控同步进入远程独立 Job 目录。
- 通过 SSH + rsync/scp 传输；不同步整个 DSH 项目、不双向同步 SQLite、不双向同步 RSI state、不默认同步大型 MRI 数据。
- 远程目录以 `job_id` + `attempt_id` 唯一标识。
- 远程产物先写临时目录，完成后再生成带 SHA-256 的 Artifact Manifest；Controller 校验后才标 `INGESTED`。
- SSH 断线不得导致作业丢失；远程作业稳定身份、可查询状态。
- Submit 后网络中断必须先查询远程状态，不得立即重提。
- 同一 `job_id`+`attempt_id` 不能重复启动两个训练进程。
- 无法确认时进入 `RECONCILE_REQUIRED`，禁止自动重跑。
- 使用现有 SSH 密钥认证，不保存私钥/密码/Token 到插件配置。
- 不得关闭 SSH Host Key 验证。

### 4.6 RSI Pipeline 最小集成

Adapter 提供：

- 发现/验证 RSI Skill 路径。
- 读取 canonical Research State。
- 获取可核实的当前状态/合法下一步（只读）。
- 调用现有 RSI 只读检查接口。
- 获取/验证实际存在的执行授权。
- 将合法实验任务交给 Mesh Scheduler。
- 提供实验运行状态、Artifact 引用、结果回收信息。

禁止：

- 自行制造 RSI 实验批准凭证。
- 直接把 Mesh 任务成功写成科学 PASS。
- 通过直接修改账本绕过接口。
- 改写 RSI 科研流程。
- 修改 RSI 原始仓库。

第一版目标不是自动跑完 R0–R14，而是让 RSI 已合法产生的科研任务进入 Mesh 并可靠完成执行层闭环。

---

## 5. WebUI 需求 A：手动 Provider / Model 配置

### 5.1 页面

在 DSH Research Mesh 插件 WebUI 增加 **Model Settings** 页面。

优先复用：

- DSH Settings Service
- Config Forms / Config Editor
- WebUI Settings 扩展槽
- Model Catalog
- 原生 Provider / Model Selection

接口以本地 DSH 源码为准。

用户可：

1. 为 Group A/B/C 分别指定默认 Provider / Model。
2. 为每组 Captain 指定独立 Provider / Model。
3. 为每组最多 4 个 Subagents 分别指定 Provider / Model。
4. Captain 与 Subagent 可选择继承所在 Group 默认模型。
5. Save 保存全部模型配置。
6. 重新打开页面恢复保存值。

### 5.2 选择规则

- Provider/Model 必须由用户手动指定。
- 只展示 DSH 当前已注册的 Provider/Model。
- Provider 变化后 Model 下拉只显示该 Provider 的模型。
- 不实现 AI 自动选型。
- 不按 RSI 阶段自动切换。
- 不按任务类型自动切换。
- 不做成本驱动自动优化。
- 不做自动 Fallback。
- 不允许静默切换其他模型。
- 未配置且无法继承有效模型时，禁止 Agent 启动并显示配置错误。

### 5.3 持久化

- 优先复用 DSH 插件设置持久化，不另建模型配置数据库。
- 配置变更只影响后续新建 Agent 会话 / 明确重配置的会话，不强制修改正在执行任务。
- 保存 Provider、Model、Agent 身份、配置版本，保证任务可追溯。
- API Key 继续由 DSH 原生 Provider 配置管理。
- 不得把 API Key 保存到 Mesh 状态数据库或返回页面。

### 5.4 实现边界

- 优先用 DSH 原生 WebUI 插件扩展机制创建设置页。
- 当前版本不能自动生成完整界面时，实现最小 Client UI 扩展并使用现有 Settings Slot。
- 不得直接修改 DSH 上游 WebUI 源码。
- 不得把“编辑配置文件”当作 WebUI 功能的替代。

### 5.5 验收

- WebUI 页面成功加载。
- Provider/Model 可手动选择。
- 各 Group 配置独立。
- Captain/Subagent 覆盖正确。
- 模型继承正确。
- 保存、刷新、重载后一致。
- 无效/已删除 Provider/Model 显示错误，不自动回退。
- Agent 实际创建时使用用户选择的 Provider/Model。
- 页面不泄露 API Key。
- 优先 Mock Model Catalog + 本地 Harness UI 集成测试。

---

## 6. WebUI 需求 B：Research Mesh 控制台

### 6.1 信息架构（只有两主视图）

1. **Projects** — 科研项目列表。
2. **Project Workbench** — 项目工作台。

群组详情是 Workbench 内展开视图，不另建第三层完整页面。
Agent 会话继续使用 DSH 原生聊天界面。
模型/运行参数使用插件设置页面。

### 6.2 全局入口

- 通过 DSH `main` 全局页面扩展注册 “Research Mesh”。
- 在 DSH 左侧导航添加入口。
- 进入 Research Mesh 不创建新聊天 Session、不改当前 Session ID、不清空聊天上下文。
- 离开返回聊天时保持此前会话选择。
- 刷新/重启浏览器后恢复项目 Registry。
- 未选择聊天会话时仍能查看 Projects。
- 不得修改 DSH DOM、劫持路由、插入全局浮层。
- 若当前本地 API 与参考源码不一致，以实际 API 为准。
- 禁止修改 DSH 内置页面源码。

已核实的 rc.5 原生接口：

- `ctx.slots.inject('main', function*(){ yield ctx.slots.register({ name:'main', key: PANEL_ID, locale, store, inject, children }, Page); ... })`
- `ctx.slots.register({ name:'sidebar.panellist', id: PANEL_ID, order, label, locale }, Icon)`
- `ctx.layout.selectPanel(PANEL_ID)`
- `ctx.uiWorkspace.openSession(sessionId)` 打开已有原生 Session。
- `ctx.uiWorkspace.startSession()` 创建新聊天（但项目讨论应使用 host 创建并绑定后 openSession）。
- Client `inject` 可用：`slots`、`locale`、`layout`、`uiWorkspace`、`remote`、`remote.session`、`configForms`。
- Model Catalog：`await ctx.remote.session.modelCatalog()` → `{groups:[{id,name,models:[{id,name,...}]}], failures, default}`。

### 6.3 Projects 页面

顶部：

```
Research Mesh
Manage research projects and collaborative agent teams.
```

项目条目展示：

- 项目名称。
- 一行研究目标摘要。
- 活动 / 暂停 / 归档状态。
- 最近活动时间。
- Research Group 数量。
- RSI State 是否可读取。
- 是否存在需处理异常。

点击主要区域打开 Workbench。
不得在主视觉层展示 Session ID、SQLite 路径、完整 Git Commit；这些进详情/诊断。

项目创建：

- 第一版主要“关联已有 RSI 项目”。
- 输入：项目名称、RSI Project/State 有效位置、已有 Git 仓库/工作区、可选描述。
- 关联前验证路径与 RSI 状态合法。
- 不能创建没有科学状态依据却声称已进入 R0–R14 的项目。
- 新项目 Bootstrap 未完成时显示明确未初始化状态。

空状态：

> 还没有研究项目。关联一个已有 RSI 项目以开始。

入口：“关联研究项目”。
禁止显示三张空白群组卡片、假进度条、虚构 GPU 活动。

### 6.4 Project Workbench

从上到下：

**A. Project Header**

- 返回 Projects。
- 项目名称。
- 一行目标描述。
- 当前项目状态。
- 新建项目讨论入口。

**B. Research State**

- RSI 当前有效阶段（只在可核实时显示）。
- 最近一次有效科学状态更新时间。
- 当前待处理科学问题/阻塞原因。
- RSI 读取失败明确提示。

**C. Research Groups**

- Group A/B/C。
- 群组名称与科研路线。
- 当前 Captain / 成员活动。
- 当前主要任务。
- Worktree 状态。
- 最新有效活动。

**D. Execution**

- Mesh Job Queue。
- GPU 0 / GPU 1 的 Mesh 租约信息。
- 已完成、等待中、失败、待对账作业。
- Artifact 是否回收。

**E. Recent Activity**

- 只显示少量决策相关最近事件 + 查看详情入口。
- 不在首页展示完整任务日志。

群组展示：

- 桌面优先纵向列表/信息行。
- 最重要：研究方向、当前任务、是否执行、有无异常、如何进入团队。
- 不让装饰头像挤占研究内容。
- 点击 Group 在 Workbench 内展开：Captain、4 个 Subagent 槽位、实际 Provider/Model、成员运行状态、组内任务摘要、Worktree 分支、打开 Captain/成员会话入口。
- 若 DSH 官方 Team Projection 已提供数据，优先复用，不重复构建成员状态数据库。
- 完整任务 DAG 与消息历史通过原生 Team 会话查看；第一版不做可编辑 DAG。

执行信息必须区分：

- Agent 是否执行 Turn。
- Team Task 是否完成。
- Mesh Job 是否成功。
- RSI Assurance 是否通过。

不得合并成统一“完成”。
实验执行完成但未审核显示：“实验产物已回收 · 等待科学审核”。
不显示没有科学定义的研究完成百分比。

### 6.5 会话与项目关系

- Project 身份独立于 Session。
- Control Session 是讨论/查询/提交控制请求入口，本身不是 Captain。
- 从 Workbench “新建讨论”：
  1. 用 DSH 原生 Session 创建接口生成普通会话。
  2. 显式绑定到当前 Project ID。
  3. 打开该会话。
  4. 会话顶部显示简洁 Research Mesh 项目入口（例如 `Research Mesh / 3D Wave-TOF`），点击返回 Workbench。
- 绑定需 Host 持久化确认，不能只存浏览器内存。
- 提供显式 Attach Project；禁止按标题、目录、自然语言猜项目。
- 切换绑定必须显式完成，并显示即将关联项目。
- 普通 Control Session 同一时刻只能一个活动项目上下文。
- 已在运行 Job 不因会话绑定改变而改变项目归属。
- 三个 Group 对应独立 Root Session；每个 Captain 拥有原生 Agent Team；子代理由对应 Team 创建/恢复。
- 点击群组/成员使用 DSH 原生导航，不创建重复 Session。
- 删除 Control Session 只解除/标记 Binding，不级联删除项目。
- Fork 产生新 Session ID，不自动继承项目写权限，允许明确关联。
- Captain Session 丢失显示“需要恢复”，不能静默重建。

### 6.6 手动模型配置（控制台要求）

- 设置页面为 Group A/B/C 默认、Captain、每组 4 个 Subagents 配置。
- 允许显式继承 Group 默认。
- 只用 DSH 已注册 Provider/Model。
- 不自动选型、不按阶段切换、不静默 Fallback。
- API Key 不写入 Mesh 状态数据库。
- 模型不存在时报错并阻止 Agent 创建。
- 创建成员时必须实际使用配置模型，不能只显示。
- 检查 DSH 原生 Agent Team Spawn 路径；适配必须使用受支持扩展能力。

### 6.7 视觉规范

- Calm, Precise, Research-oriented, Native to DSH。
- 主标题约 22–26px；区域标题 15–18px；正文 13–15px；辅助 12–13px。
- 8px 间距体系；圆角 8–12px；主要用边界线与留白，不堆阴影。
- 优先复用 DSH 主题 token、字体、组件、暗色模式变量；不得硬编码一套冲突主题。
- 中性色为主；颜色只用于有意义状态：运行中/需注意/失败/已验证完成。
- 普通元信息不用高饱和 Badge；避免连续 3+ 强调色；不用大面积霓虹渐变/炫目 AI 动画。
- 项目列表以可扫描为第一目标；群组摘要不展开也能回答“这个团队正在做什么”。
- 技术 ID、完整路径、详细日志、JSON 放详情。
- 不显示意义不明的大数字卡片；不把所有事件塞进单一日志。
- 动画只做必要轻量状态过渡；遵守 `prefers-reduced-motion`。
- 响应式：1440px 桌面、1280px 笔记本、768px 平板、390px 手机；窄屏群组单列，不横向溢出。
- 操作不能只依赖 Hover；按钮有清晰键盘焦点与可触达区域。
- 每个异步视图具备 Loading / Empty / Error / Unavailable / Stale-Reconnecting / Success。
- 网络断开显示最后确认状态及更新时间，不伪装实时。
- 点击操作明确展示提交中/成功/失败。
- 不允许无作用装饰按钮。

### 6.8 交互规则

- 渐进式展示：先目标、群组状态、待处理事项；成员详情、任务依赖、日志按需展开。
- 常用操作易找：打开项目、返回列表、新建讨论、进 Captain、查看任务、查看异常、修改模型。
- 低频操作（删除项目、清理工作树、强制取消远程作业）不在醒目主操作区。
- “关闭页面”只关 UI。
- “暂停项目”只阻止新 Mesh 任务调度；是否影响已运行 Job 必须明确，不得暗中终止。
- “停止团队”必须与暂停区分。
- 删除/强制停止等不可逆操作必须二次确认。
- v0.1 未实现的生命周期操作不显示看似可用的按钮。
- 不重复开发 DSH 官方 Team Task Board；单组任务由 DSH Agent Team，远程计算由 Mesh Job Queue，科学结论由 RSI；UI 只引用关联，不复制三份权威状态。

---

## 7. 技术实现约束

### 7.1 目录建议（可调整）

```
src/
├── projects/        # registry, session-bindings
├── teams/           # team-adapter, models, session-host
├── workspaces/
├── scheduler/
├── executors/
├── resources/
├── rsi/
├── storage/
├── ui/              # ProjectsPage, ProjectWorkbench, GroupSection, SessionProjectEntry, MeshSettings
├── dsh/             # host adapters
├── index.ts
└── service.ts
client/              # 浏览器 bundle（手写或 esbuild）
tests/
docs/
schemas/
```

### 7.2 Host / Client 边界

Host：

- Project Registry。
- Session Bindings。
- Group 与 Worktree 关系。
- RSI 只读状态。
- Mesh Job 摘要。
- 持久化。

Client：

- 页面布局。
- 项目选择。
- 群组展开。
- 状态呈现。
- 原生 Session 导航。
- 设置编辑。

前端不得自行解析 `research-state.json` 或访问后端 SQLite；状态必须通过 Host 数据接口。

### 7.3 数据源

- Project / Group / Session Binding：Mesh Registry。
- Agent Team 成员/组内任务：DSH 原生状态（v0.1 中 Mesh 自身注册表作为可核实来源；如官方投影可用则合并）。
- RSI 科学状态：canonical source（只读）。
- Mesh Job：现有队列。
- 界面只组合，不产生第二套科学真相。

### 7.4 不重复实现

- DSH 聊天页、Session History、Agent Team Mailbox、完整 Task DAG 编辑器、RSI Pipeline、实验审批/证据闸门、大型分布式平台。

---

## 8. 测试要求

### 8.1 单元测试

Team Manager：

- 创建 3 Groups；拒绝第 4。
- 每组 4 Subagents；拒绝第 13。
- 暂停/恢复。
- Registry 重启恢复。
- 手动模型：Group 默认、Captain 覆盖、Subagent 覆盖、继承、无效模型拒绝。
- Agent 实际创建使用配置模型。

Workspace：

- 三组独立 Worktree。
- 同文件不同组独立修改。
- 不污染 source 基线。
- 拒绝路径冲突。
- 拒绝 `../`、绝对路径、符号链接逃逸。
- 未授权删除已有目录拒绝。
- 重开仍识别 Worktree。

Scheduler：

- FIFO + Priority。
- 依赖未满足不执行。
- 并发领取不重复。
- 重复 Submit 幂等。
- SQLite 重启不丢状态。
- 无效状态转换拒绝。
- 重试/阻塞/取消。
- lease 过期恢复不重放。

Resource：

- GPU0/GPU1 分别分配。
- 第三个独占等待。
- 同一 GPU 无双重租约。
- 异常恢复先对账再分配。
- 已停止/未知任务不静默重复提交。

SSH/Conda：

- Conda 参数正确。
- Host/工作目录/argv 验证。
- 无 Shell 注入/路径越界。
- SSH Submit 超时进对账。
- 远程已有同 Job 不重复启动。
- 产物校验失败不标成功。
- 不实际访问 SSH/GPU。

### 8.2 集成测试

- 临时 Git 仓库 + SQLite；三组并发。
- Task/Team 绑定正确。
- 使用正确 Worktree。
- 不同团队互不改文件。
- GPU 请求不冲突。
- Job Manifest 可从磁盘恢复。
- 停止/恢复不重复执行。
- RSI Adapter 契约测试；尽量用真实只读命令与合法 Fixture；模拟授权必须明确标 Test Stub，不能混入生产路径。

### 8.3 端到端闭环（必须自动执行）

1. 创建测试科研项目。
2. 创建 3 Groups + 独立 Worktree。
3. 每组注册 4 个模拟子代理身份。
4. Group A 创建合法测试研究任务。
5. RSI 测试适配器验证执行边界。
6. 生成 Job Manifest 进入 Scheduler。
7. 申请模拟 GPU。
8. FakeSSH 模拟远程 Conda 执行，实际跑本地轻量脚本。
9. 生成真实可检查的测试文件、日志、指标 JSON。
10. 模拟远程 Artifact 回收并验证 SHA-256。
11. 结果登记 `INGESTED` / `ASSURANCE_PENDING`，不得自动科学 PASS。
12. Task/Team/Manifest/Artifact/RSI 引用完整关联。

故障注入：

- **A：Submit 响应丢失**。远程已启动但 Controller 未收确认；重启恢复 DB，Reconcile 发现原任务，不重复执行。
- **B：结果传输中断**。远程完成但 Artifact 只传一部分；第一次 Collect 失败/保持待回收；第二次恢复传输后校验通过，不重跑实验。

### 8.4 DSH 插件集成测试

通过本地 Harness 真实插件加载路径至少一次：

- 注册。
- 提供 Mesh Service。
- 读取配置。
- 初始化本地状态。
- 执行模拟任务。
- 卸载并释放资源。

不要求真实大模型或真实 Web 界面，但不能只靠单元测试宣称适配 DSH。

### 8.5 新增 WebUI / 控制台测试

项目管理：

- 注册两个合法测试项目；列表正常。
- 项目切换不混淆。
- 重启后仍存在。
- RSI 路径失效显示明确异常。
- 列表加载失败可重试。

Session Binding：

- 从 Project A 创建普通 Control Session，绑定正确。
- 新建普通 DSH Session 不自动绑定。
- Attach 后才允许项目操作。
- Control Session 不成为额外 Captain。
- 返回聊天不改变原 Session 身份。
- 删除 Control Session 不删除项目。
- Fork 不自动继承 Project 写权限。
- 重启后恢复 Captain Session 映射。

Team / 模型：

- 最多 3 组；每组最多 4 子代理。
- 点击成员打开已有 Session，不重复创建。
- 无效模型显示错误。
- 手工配置保存/重载/实际生效。
- Worktree 与 Group 关联正确。

UI：

- 用真实 WebUI 插件加载。
- 允许 Playwright/现有浏览器测试。
- 至少验证 Projects、Workbench、Group 展开、Captain Session 导航、新建讨论、返回 Project、Model Settings、Empty/Loading/Error/Reconnecting、深浅主题、桌面/平板/手机、键盘访问与焦点。
- 生成本地截图并**实际检查**：无布局破损、文字裁剪、按钮遮挡、横向溢出。
- 不能只靠组件测试宣称 UI 验收。

运行回归：

- Worktree 隔离。
- Task Queue 幂等/恢复。
- Fake SSH/Conda。
- 双 GPU 租约。
- RSI Adapter 契约。

---

## 9. 开发阶段

- **Phase 1**：审查与信息架构；核对 DSH API、现有 Mesh、NanmiCoder 参考；先定生命周期与数据契约，不先写大量静态 UI。
- **Phase 2**：Project Registry + Session Binding；测试项目身份独立于聊天。
- **Phase 3**：WebUI 全局入口、Projects、Workbench；接真实 Registry/测试数据；响应式与主题。
- **Phase 4**：Group 导航 + 模型配置；接 DSH Agent Team 真实成员；Captain/Member Session 导航；模型持久化。
- **Phase 5**：本地端到端验收；Fake Runtime 闭环；桌面/窄屏截图检查；修复。

---

## 10. 本轮禁止事项

- Push GitHub/远程仓库。
- Merge 到 main。
- 创建 Release/Tag。
- 修改 DSH 上游源码。
- 部署 systemd/服务。
- 连接真实工作站启动训练。
- 占用真实 GPU 执行实验。
- 删除/覆盖既有科研数据。
- 未经许可重构 RSI Pipeline。
- 修改已有科研项目 canonical Research State。
- 以模拟测试成功冒充真实科研闭环完成。
- 不允许为了入口修改 DSH 内置页面源码。
- 不允许 DOM hack/路由劫持/全局浮层替代原生扩展。

允许：本地开发分支与本地 Git commit；使用临时目录、临时 Git 仓库、FakeSSH、模拟 Conda、Mock Model Catalog。

---

## 11. 最终验收条件

1. 插件可在当前本地 Harness 成功加载。
2. 最多 3 Groups、每组 4 Subagents、全局 12。
3. 三组 Git Worktree 隔离通过测试。
4. 持久化任务提交/并发领取正确。
5. 双模拟 GPU 资源租约正确。
6. SSH/Conda Executor 有可用实现和完整 Fake 测试。
7. 任务提交幂等 + 断线对账。
8. Artifact 回收与完整性校验通过。
9. RSI Adapter 不绕过科研闸门。
10. 本地端到端闭环测试通过。
11. 故障注入与进程重启恢复通过。
12. Typecheck、插件测试、适用构建检查通过。
13. 未发生远程部署、真实 GPU 执行或远程 Push。
14. **Project Registry 持久化，项目独立于聊天 Session。**
15. **原生全局入口 + 左侧导航；不修改上游页面。**
16. **Projects 页面、Project Workbench、Group 展开。**
17. **Captain/Member 使用原生 Session 导航，不重复创建。**
18. **新建项目讨论并显式绑定；Attach 已有会话。**
19. **手动 Provider/Model 设置页可用、保存、重载、实际生效。**
20. **UI Loading/Empty/Error/Reconnecting、深浅主题、桌面/平板/手机、键盘焦点、截图检查。**

---

## 12. 最终报告要求

A. 架构与代码：基线/HEAD、新增/修改模块、DSH API 适配、RSI Adapter 范围、Team/Task/Executor 关系。
B. 核心功能：三组隔离、并发/租约、Fake SSH/Conda、断线/重复/崩溃恢复、闭环。
C. 测试证据：命令、通过/失败/跳过数、关键状态变化、未测试的真实远程行为、已知限制。
D. 本地 Git：分支、commit、工作区、未 push/merge/tag/deploy 确认。
E. WebUI：产品交互流程、Project/Group/Session 数据关系、原生扩展接口、模型配置验证、真实 UI 集成结果、截图路径、未实现项。

报告以方法、机制、验收结果为主，不堆日志/文件清单/操作流水账。

---

## 13. 变更记录

| 日期 | 变更 | 来源 |
|---|---|---|
| 2026-11-05 | 建立本文档，合并原始 Mesh v0.1 需求、WebUI 模型配置需求、Project Workbench/会话管理需求 | 用户三轮指令 |
