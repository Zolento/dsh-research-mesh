/**
 * DSH Research Mesh browser half.
 *
 * Hand-written loader bundle, matching the DSH client contract:
 *   window.__ModuleLoader__.load({ id: <package name>, factory(require) {...} })
 *
 * Registers:
 * - a global `main` panel and its `sidebar.panellist` entry;
 * - a `settings.section` page for manual provider/model assignment;
 * - a `conversation.session.header.actions` entry that links a bound chat
 *   session back to its research project.
 *
 * The bundle reads only the plugin-owned Host API. It never parses
 * research-state.json, never touches SQLite, and never receives an API key.
 */
window.__ModuleLoader__.load({
  id: 'dsh-research-mesh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useMemo = React.useMemo
    const useRef = React.useRef

    const NS = 'researchMesh'
    const PANEL_ID = 'research-mesh'
    const API = '/dsh-research-mesh/api'
    const LAST_PROJECT_KEY = 'dsh-research-mesh:last-project'

    const COPY = {
      zh: {
        nav: 'Research Mesh',
        title: 'Research Mesh',
        subtitle: '管理科研项目与协作 Agent 团队。',
        projects: '科研项目',
        project: '项目',
        workbench: '项目工作台',
        back: '返回 Projects',
        open: '打开工作台',
        newProject: '关联研究项目',
        cancel: '取消',
        create: '关联',
        name: '项目名称',
        rsiState: 'RSI Research State 路径',
        repository: 'Git 仓库 / 工作区路径',
        description: '项目描述（可选）',
        noDescription: '未填写项目描述',
        empty: '还没有研究项目。关联一个已有 RSI 项目以开始。',
        loading: '正在加载…',
        error: '加载失败',
        retry: '重试',
        stale: '连接中断，显示最后确认状态',
        noProject: '选择一个项目以打开工作台。',
        groups: 'Research Groups',
        group: 'Group',
        route: '科研路线',
        status: '状态',
        currentTask: '当前任务',
        worktree: 'Worktree',
        captain: 'Captain',
        subagents: 'Subagents',
        openSession: '打开会话',
        emptySlot: '空槽位',
        addSubagent: '添加子代理',
        rsi: 'Research State',
        rsiVersion: 'state_version',
        rsiGoal: '研究目标',
        rsiUpdated: '最近更新时间',
        rsiAdvisory: 'RSI 建议阶段（advisory）',
        rsiNext: '下一步合法动作（只读）',
        rsiError: 'RSI 状态读取失败',
        openCritical: '未解决 critical 不确定性',
        planned: 'planned 实验',
        running: 'running 实验',
        done: 'done 实验',
        execution: 'Execution',
        jobs: 'Mesh Job Queue',
        gpu: 'GPU 租约',
        noJobs: '暂无 Mesh Job。',
        noGpu: '暂无 GPU 租约。',
        activity: 'Recent Activity',
        noActivity: '暂无活动。',
        simulation: '运行本地模拟任务',
        simulationRunning: '正在执行…',
        discussion: '新建项目讨论',
        attach: '关联已有会话',
        attachHint: '输入已有 DSH Session ID',
        attachAction: '关联',
        detach: '解除绑定',
        models: '研究模型',
        modelsTitle: 'Research Group 模型配置',
        modelsSub: '必须手动选择 DSH 已注册的 Provider / Model。无自动选型、无回退。',
        groupDefault: '组默认模型',
        inherit: '继承组默认',
        override: '覆盖',
        provider: 'Provider',
        model: 'Model',
        save: '保存模型配置',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        unavailable: '（已不可用）',
        modelError: '无效模型',
        notRegistered: '模型不在 DSH 当前目录中，请重新选择',
        captainEmpty: '未设置 Captain 会话',
        memberEmpty: '该组还没有子代理',
        pauseProject: '暂停项目',
        resumeProject: '恢复项目',
        pausedNotice: '项目已暂停：不再调度新任务；已运行的 Job 不受影响。',
        sessionUnavailable: '需要恢复',
        pauseGroup: '暂停群组',
        resumeGroup: '恢复群组',
        stopGroup: '停止群组',
        destroyGroup: '销毁群组',
        groupStoppedNotice: '群组已停止：不再调度新任务；未开始的排队任务已取消，运行中的 Job 不受影响。',
        groupPausedNotice: '群组已暂停：不再调度新任务。',
        groupDestroyConfirm: '销毁群组只会移除 Mesh 管理状态并保留 worktree。确认销毁？',
        groupCreate: '新建群组',
        groupNamePrompt: '群组名称（例如 group-c）',
        groupRoutePrompt: '科研路线 ID（例如 C）',
        session: '会话',
        agentRunning: '运行中',
        agentIdle: '空闲',
        taskStatus: '任务',
        worktreeMissing: 'Worktree 不可用',
        jobSubmitted: '已提交',
        jobOutput: '产物已回收',
        jobIngested: '已入库',
        assurancePending: '等待科学审核',
        scientificNote: '实验执行完成不等于科学结论通过；结果等待 RSI 审核。',
        attachSuccess: '已关联到项目',
        attachFailed: '关联失败',
        projectCreated: '项目已关联',
        projectFailed: '关联失败',
        noSession: '当前会话未绑定研究项目。',
        bindingConflict: '该会话已绑定其他项目。',
      },
      en: {
        nav: 'Research Mesh',
        title: 'Research Mesh',
        subtitle: 'Manage research projects and collaborative agent teams.',
        projects: 'Research Projects',
        project: 'Project',
        workbench: 'Project Workbench',
        back: 'Back to Projects',
        open: 'Open workbench',
        newProject: 'Link research project',
        cancel: 'Cancel',
        create: 'Link',
        name: 'Project name',
        rsiState: 'RSI Research State path',
        repository: 'Git repository / workspace path',
        description: 'Description (optional)',
        noDescription: 'No project description',
        empty: 'No research projects yet. Link an existing RSI project to begin.',
        loading: 'Loading…',
        error: 'Could not load',
        retry: 'Retry',
        stale: 'Connection lost — showing the last confirmed state',
        noProject: 'Select a project to open its workbench.',
        groups: 'Research Groups',
        group: 'Group',
        route: 'Research route',
        status: 'Status',
        currentTask: 'Current task',
        worktree: 'Worktree',
        captain: 'Captain',
        subagents: 'Subagents',
        openSession: 'Open session',
        emptySlot: 'Empty slot',
        addSubagent: 'Add subagent',
        rsi: 'Research State',
        rsiVersion: 'state_version',
        rsiGoal: 'Research goal',
        rsiUpdated: 'Last updated',
        rsiAdvisory: 'Advisory RSI phase',
        rsiNext: 'Next legal actions (read-only)',
        rsiError: 'Could not read RSI state',
        openCritical: 'Open critical uncertainties',
        planned: 'planned experiments',
        running: 'running experiments',
        done: 'done experiments',
        execution: 'Execution',
        jobs: 'Mesh Job Queue',
        gpu: 'GPU leases',
        noJobs: 'No Mesh jobs yet.',
        noGpu: 'No GPU leases yet.',
        activity: 'Recent Activity',
        noActivity: 'No recent activity.',
        simulation: 'Run local simulation',
        simulationRunning: 'Running…',
        discussion: 'New project discussion',
        attach: 'Attach existing session',
        attachHint: 'Existing DSH Session ID',
        attachAction: 'Attach',
        detach: 'Detach',
        models: 'Research models',
        modelsTitle: 'Research group model assignments',
        modelsSub: 'Provider and model are chosen manually from the live DSH catalog. No automatic selection or fallback.',
        groupDefault: 'Group default',
        inherit: 'Inherit group default',
        override: 'Override',
        provider: 'Provider',
        model: 'Model',
        save: 'Save model settings',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        unavailable: '(unavailable)',
        modelError: 'Invalid model',
        notRegistered: 'This model is not in the live DSH catalog; choose another.',
        captainEmpty: 'No Captain session',
        memberEmpty: 'No subagents registered',
        pauseProject: 'Pause project',
        resumeProject: 'Resume project',
        pausedNotice: 'Project paused: no new tasks are scheduled; running jobs are unaffected.',
        sessionUnavailable: 'needs recovery',
        pauseGroup: 'Pause group',
        resumeGroup: 'Resume group',
        stopGroup: 'Stop group',
        destroyGroup: 'Destroy group',
        groupStoppedNotice: 'Group stopped: no new tasks are scheduled; queued tasks are cancelled and running jobs continue.',
        groupPausedNotice: 'Group paused: no new tasks are scheduled.',
        groupDestroyConfirm: 'Destroy removes Mesh management state and keeps the worktree. Continue?',
        groupCreate: 'New group',
        groupNamePrompt: 'Group name (for example group-c)',
        groupRoutePrompt: 'Research route id (for example C)',
        session: 'Session',
        agentRunning: 'running',
        agentIdle: 'idle',
        taskStatus: 'Task',
        worktreeMissing: 'Worktree unavailable',
        jobSubmitted: 'submitted',
        jobOutput: 'artifacts ready',
        jobIngested: 'ingested',
        assurancePending: 'awaiting scientific review',
        scientificNote: 'Execution success is not a scientific conclusion; results await RSI review.',
        attachSuccess: 'Attached to project',
        attachFailed: 'Attach failed',
        projectCreated: 'Project linked',
        projectFailed: 'Could not link project',
        noSession: 'This session is not linked to a research project.',
        bindingConflict: 'This session is already bound to another project.',
      },
    }

    const CSS = `
      .mesh-root { box-sizing: border-box; height: 100%; overflow: auto; padding: 24px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-base, transparent); font-family: var(--dsh-font-family-text, system-ui, sans-serif); }
      .mesh-root *, .mesh-root *::before, .mesh-root *::after { box-sizing: border-box; }
      .mesh-inner { max-width: 1120px; margin: 0 auto; display: grid; gap: 20px; }
      .mesh-title { font-size: 24px; line-height: 1.2; font-weight: 620; margin: 0; letter-spacing: -0.01em; }
      .mesh-subtitle { font-size: 13px; color: var(--dsw-alias-label-secondary, #5b6470); margin: 6px 0 0; }
      .mesh-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .mesh-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .mesh-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); color: inherit; border-radius: 8px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; min-height: 32px; }
      .mesh-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
      .mesh-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 2px; }
      .mesh-btn:disabled { opacity: .55; cursor: default; }
      .mesh-btn.primary { background: var(--dsw-alias-button-primary-fill, #2563eb); color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; }
      .mesh-btn.ghost { background: transparent; }
      .mesh-btn.danger { color: var(--dsw-alias-label-danger, #b42318); }
      .mesh-section { border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22)); padding-top: 16px; display: grid; gap: 12px; }
      .mesh-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .mesh-h2 { font-size: 16px; font-weight: 600; margin: 0; }
      .mesh-h3 { font-size: 14px; font-weight: 600; margin: 0; }
      .mesh-muted { color: var(--dsw-alias-label-secondary, #5b6470); font-size: 12.5px; }
      .mesh-list { display: grid; gap: 8px; }
      .mesh-card { border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 14px 16px; display: grid; gap: 8px; }
      .mesh-project { width: 100%; text-align: left; cursor: pointer; }
      .mesh-project:hover { border-color: var(--dsw-alias-border-l3, rgba(128,128,128,.4)); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.06)); }
      .mesh-project:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 2px; }
      .mesh-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .mesh-meta { display: flex; gap: 8px 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #5b6470); }
      .mesh-badge { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius: 999px; padding: 2px 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #5b6470); background: var(--dsw-alias-bg-layer-2, transparent); white-space: nowrap; }
      .mesh-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #8a8f98); }
      .mesh-dot.active { background: var(--dsw-alias-status-success, #2e7d32); }
      .mesh-dot.warn { background: var(--dsw-alias-status-warning, #b26a00); }
      .mesh-dot.error { background: var(--dsw-alias-status-danger, #b42318); }
      .mesh-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .mesh-kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 12px; font-size: 13px; }
      .mesh-kv dt { color: var(--dsw-alias-label-secondary, #5b6470); }
      .mesh-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      .mesh-form { display: grid; gap: 10px; max-width: 680px; }
      .mesh-field { display: grid; gap: 4px; font-size: 13px; }
      .mesh-input { width: 100%; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; padding: 7px 10px; min-height: 32px; }
      .mesh-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
      .mesh-select { min-height: 32px; max-width: 100%; }
      .mesh-error { border: 1px solid var(--dsw-alias-status-danger, #b42318); border-radius: 8px; padding: 8px 10px; font-size: 13px; color: var(--dsw-alias-label-danger, #b42318); }
      .mesh-empty { border: 1px dashed var(--dsw-alias-border-l3, rgba(128,128,128,.35)); border-radius: 10px; padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary, #5b6470); font-size: 13px; }
      .mesh-loading { color: var(--dsw-alias-label-secondary, #5b6470); font-size: 13px; padding: 12px 0; }
      .mesh-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .mesh-table th, .mesh-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16)); vertical-align: top; }
      .mesh-table th { color: var(--dsw-alias-label-secondary, #5b6470); font-weight: 500; }
      .mesh-group { display: grid; gap: 10px; }
      .mesh-group-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
      .mesh-group-body { display: grid; gap: 10px; padding: 12px 0 0; border-top: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
      .mesh-member { display: grid; grid-template-columns: minmax(120px, 1.2fr) minmax(100px, .8fr) minmax(140px, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14)); font-size: 13px; }
      .mesh-member:last-child { border-bottom: 0; }
      .mesh-model { font-family: var(--dsh-font-family-code, monospace); font-size: 12px; overflow-wrap: anywhere; }
      .mesh-stale { font-size: 12px; color: var(--dsw-alias-label-warning, #9a6700); }
      .mesh-modal { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35)); display: grid; place-items: center; z-index: 80; padding: 16px; }
      .mesh-modal-card { width: min(620px, 100%); max-height: 90vh; overflow: auto; background: var(--dsw-alias-bg-base, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 12px; padding: 18px; display: grid; gap: 12px; }
      .mesh-tag { font-size: 11.5px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); border-radius: 6px; padding: 1px 6px; color: var(--dsw-alias-label-secondary, #5b6470); }
      .mesh-settings-row { display: grid; grid-template-columns: minmax(100px, 160px) minmax(90px, 130px) minmax(0, 1fr); gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16)); }
      .mesh-settings-row > * { min-width: 0; }
      .mesh-settings-label { font-weight: 500; font-size: 13px; overflow-wrap: anywhere; }
      .mesh-settings-row .mesh-inline { display: flex; gap: 6px; align-items: center; min-width: 0; }
      .mesh-settings-row .mesh-select { width: 100%; min-width: 0; }
      .mesh-model-picker { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(110px, 1.2fr); gap: 8px; width: 100%; min-width: 0; align-items: center; }
      .mesh-model-picker .mesh-error { grid-column: 1 / -1; }
      .mesh-settings-group { display: grid; gap: 6px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22)); }
      .mesh-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .mesh-code { font-family: var(--dsh-font-family-code, monospace); font-size: 11.5px; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary, #5b6470); }
      .mesh-session-link { border: 0; background: transparent; color: var(--dsw-alias-brand-text, #2563eb); font: inherit; font-size: 12.5px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
      .mesh-session-link:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
      .mesh-session-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
      @media (max-width: 900px) { .mesh-root { padding: 16px; } .mesh-grid { grid-template-columns: 1fr; } .mesh-member { grid-template-columns: 1fr 1fr; } }
      @media (max-width: 700px) { .mesh-settings-row { grid-template-columns: 1fr; gap: 6px; } .mesh-model-picker { grid-template-columns: 1fr; } }
      @media (max-width: 600px) { .mesh-root { padding: 12px; } .mesh-title { font-size: 20px; } .mesh-kv { grid-template-columns: 1fr; } .mesh-member { grid-template-columns: 1fr; } .mesh-table { font-size: 11.5px; } .mesh-section-head { display: grid; grid-template-columns: 1fr; gap: 6px; } .mesh-badge { white-space: normal; } .mesh-actions .mesh-btn { flex: 1 1 auto; } }
      @media (prefers-reduced-motion: reduce) { .mesh-root * { transition: none !important; animation: none !important; } }
    `

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-research-mesh]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-research-mesh', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: init?.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...init,
      })
      let payload
      try { payload = await response.json() } catch { throw new Error(`HTTP ${response.status}`) }
      if (payload === null || typeof payload !== 'object') throw new Error('unexpected response')
      if (payload.ok !== true) {
        const error = payload.error ?? {}
        const failure = new Error(typeof error.message === 'string' ? error.message : `HTTP ${response.status}`)
        failure.code = error.code
        throw failure
      }
      return payload.value
    }

    /** Shared, remount-safe cache for the current Session's project binding. */
    const sessionBindingCache = new Map()
    const sessionBindingListeners = new Set()
    function notifySessionBinding() {
      for (const listener of sessionBindingListeners) listener()
    }
    function invalidateSessionBinding(sessionId) {
      if (typeof sessionId === 'string') sessionBindingCache.delete(sessionId)
      notifySessionBinding()
    }
    function loadSessionBinding(sessionId) {
      const existing = sessionBindingCache.get(sessionId)
      if (existing !== undefined && (existing.status === 'loading' || Date.now() - existing.at < 10_000)) return
      sessionBindingCache.set(sessionId, { status: 'loading', value: null, at: Date.now() })
      api(`/session?sessionId=${encodeURIComponent(sessionId)}`)
        .then(value => { sessionBindingCache.set(sessionId, { status: 'ready', value, at: Date.now() }); notifySessionBinding() })
        .catch(error => { sessionBindingCache.set(sessionId, { status: 'error', value: null, error: error.message, at: Date.now() }); notifySessionBinding() })
    }
    function useSessionBinding(sessionId) {
      const [, setTick] = useState(0)
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        const listener = () => setTick(tick => tick + 1)
        sessionBindingListeners.add(listener)
        loadSessionBinding(sessionId)
        return () => { sessionBindingListeners.delete(listener) }
      }, [sessionId])
      return typeof sessionId === 'string' ? sessionBindingCache.get(sessionId) : undefined
    }

    function useAsync(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null, loadedAt: null })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(() => { setNonce(value => value + 1) }, [])
      useEffect(() => {
        let live = true
        setState(previous => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        Promise.resolve().then(loader).then(data => {
          if (!live) return
          setState({ status: 'ready', data, error: null, loadedAt: new Date().toISOString() })
        }).catch(error => {
          if (!live) return
          setState(previous => ({
            status: previous.data === null ? 'error' : 'stale',
            data: previous.data,
            error: error instanceof Error ? error.message : String(error),
            loadedAt: previous.loadedAt,
          }))
        })
        return () => { live = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce])
      return { ...state, reload }
    }

    function statusTone(status) {
      if (status === 'active' || status === 'ready' || status === 'RUNNING' || status === 'SUCCEEDED' || status === 'INGESTED') return 'active'
      if (status === 'FAILED' || status === 'RECONCILE_REQUIRED' || status === 'error' || status === 'broken') return 'error'
      if (status === 'paused' || status === 'BLOCKED' || status === 'stale' || status === 'ASSURANCE_PENDING') return 'warn'
      return ''
    }

    function StatusBadge({ status, label }) {
      return h('span', { className: 'mesh-badge' },
        h('span', { className: `mesh-dot ${statusTone(status)}`, 'aria-hidden': 'true' }),
        label ?? status)
    }

    function Section({ title, aside, children }) {
      return h('section', { className: 'mesh-section' },
        h('div', { className: 'mesh-section-head' },
          h('h2', { className: 'mesh-h2' }, title),
          aside === undefined ? null : aside),
        children)
    }

    function ErrorLine({ message, onRetry, t }) {
      return h('div', { className: 'mesh-error', role: 'alert' },
        h('div', { className: 'mesh-row' }, h('span', null, message), onRetry === undefined ? null : h('button', { className: 'mesh-btn', onClick: onRetry }, t('retry'))))
    }

    function Loading({ t }) {
      return h('div', { className: 'mesh-loading', role: 'status' }, t('loading'))
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    function projectOpener(ctx) {
      return projectId => {
        try { window.localStorage.setItem(LAST_PROJECT_KEY, projectId) } catch { /* private mode */ }
        try { window.dispatchEvent(new CustomEvent('dsh-research-mesh:open-project', { detail: { projectId } })) } catch { /* no window */ }
        try { ctx.layout.selectPanel(PANEL_ID) } catch { /* layout unavailable in a test stub */ }
      }
    }

    function ProjectForm({ t, onCancel, onCreated }) {
      const [form, setForm] = useState({ name: '', rsiStateRef: '', repositoryRef: '', description: '' })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const submit = event => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        api('/projects', { method: 'POST', body: JSON.stringify(form) })
          .then(() => onCreated())
          .catch(failure => setError(failure.message))
          .finally(() => setBusy(false))
      }
      return h('div', { className: 'mesh-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('newProject') },
        h('form', { className: 'mesh-modal-card', onSubmit: submit },
          h('h2', { className: 'mesh-h2' }, t('newProject')),
          h('p', { className: 'mesh-subtitle' }, t('rsiState')),
          error === null ? null : h('div', { className: 'mesh-error', role: 'alert' }, error),
          h('label', { className: 'mesh-field' }, t('name'),
            h('input', { className: 'mesh-input', required: true, value: form.name, onChange: event => setForm({ ...form, name: event.target.value }) })),
          h('label', { className: 'mesh-field' }, t('rsiState'),
            h('input', { className: 'mesh-input', required: true, placeholder: '/project/.research-idea-pipeline/routes/A/research-state.json', value: form.rsiStateRef, onChange: event => setForm({ ...form, rsiStateRef: event.target.value }) })),
          h('label', { className: 'mesh-field' }, t('repository'),
            h('input', { className: 'mesh-input', required: true, placeholder: '/project/source', value: form.repositoryRef, onChange: event => setForm({ ...form, repositoryRef: event.target.value }) })),
          h('label', { className: 'mesh-field' }, t('description'),
            h('textarea', { className: 'mesh-input', rows: 3, value: form.description, onChange: event => setForm({ ...form, description: event.target.value }) })),
          h('div', { className: 'mesh-actions' },
            h('button', { className: 'mesh-btn primary', type: 'submit', disabled: busy }, busy ? t('saving') : t('create')),
            h('button', { className: 'mesh-btn ghost', type: 'button', onClick: onCancel }, t('cancel')))))
    }

    function ProjectsPage({ ctx, onOpen, t, onModels }) {
      const [creating, setCreating] = useState(false)
      const state = useAsync(() => api('/bootstrap'), [])
      const projects = state.data?.projects ?? []
      const header = h('div', { className: 'mesh-header' },
        h('div', null,
          h('h1', { className: 'mesh-title' }, t('title')),
          h('p', { className: 'mesh-subtitle' }, t('subtitle'))),
        h('div', { className: 'mesh-actions' },
          onModels === undefined ? null : h('button', { className: 'mesh-btn', 'data-mesh-main-models': 'true', onClick: onModels }, t('models')),
          h('button', { className: 'mesh-btn primary', onClick: () => setCreating(true) }, t('newProject')),
          h('button', { className: 'mesh-btn', onClick: state.reload, disabled: state.status === 'loading' }, t('retry'))))
      const status = state.status === 'loading'
        ? h(Loading, { t })
        : state.status === 'error'
          ? h(ErrorLine, { t, message: `${t('error')}: ${state.error}`, onRetry: state.reload })
          : state.status === 'stale'
            ? h('div', { className: 'mesh-stale', role: 'status' }, `${t('stale')} · ${formatTime(state.loadedAt)}`)
            : null
      const projectCard = project => h('button', {
        key: project.projectId,
        type: 'button',
        className: 'mesh-card mesh-project',
        onClick: () => onOpen(project.projectId),
      },
      h('div', { className: 'mesh-row' },
        h('strong', null, project.name),
        h(StatusBadge, { status: project.status, label: project.status })),
      h('div', { className: 'mesh-muted' }, project.description || t('noDescription')),
      h('div', { className: 'mesh-meta' },
        h('span', null, `${t('groups')}: ${project.groupCount}`),
        h('span', null, `RSI: ${project.rsiReadable ? `v${project.rsiVersion}` : 'unavailable'}`),
        h('span', null, `${t('rsiUpdated')}: ${formatTime(project.updatedAt)}`),
        project.runnable ? null : h('span', { className: 'mesh-tag' }, 'registered (not runnable here)')))
      const list = projects.length === 0
        ? h('div', { className: 'mesh-empty' },
          h('p', null, t('empty')),
          h('button', { className: 'mesh-btn primary', onClick: () => setCreating(true) }, t('newProject')))
        : h('div', { className: 'mesh-list' }, ...projects.map(projectCard))
      const modal = creating
        ? h(ProjectForm, { t, onCancel: () => setCreating(false), onCreated: () => { setCreating(false); state.reload() } })
        : null
      return h('div', { className: 'mesh-inner' },
        header,
        status,
        h(Section, { title: t('projects'), aside: h('span', { className: 'mesh-muted' }, String(projects.length)) }, list),
        modal)
    }

    function MemberRow({ ctx, t, role, sessionId, parentSessionId, model, status, onOpen }) {
      const live = status === 'running' ? t('agentRunning') : status === undefined || status === null ? t('sessionUnavailable') : t('agentIdle')
      const tone = status === 'running' ? 'active' : status === undefined || status === null ? 'warn' : 'ready'
      return h('div', { className: 'mesh-member' },
        h('div', null, h('strong', null, role), h('div', { className: 'mesh-code' }, sessionId)),
        h('div', null, h(StatusBadge, { status: tone, label: live })),
        h('div', { className: 'mesh-model' }, model === undefined ? '—' : `${model.provider} / ${model.model}`),
        h('button', { className: 'mesh-session-link', type: 'button', onClick: () => onOpen(sessionId, parentSessionId) }, t('openSession')))
    }

    function RsiSection({ data, t }) {
      const rows = [
        ['dt', t('rsiGoal')], ['dd', data.rsi.goal ?? '—'],
        ['dt', t('rsiUpdated')], ['dd', formatTime(data.rsi.updatedAt)],
        ['dt', t('openCritical')], ['dd', String(data.rsi.openCriticalUncertainties)],
        ['dt', t('planned')], ['dd', String(data.rsi.plannedExperiments)],
        ['dt', t('running')], ['dd', String(data.rsi.runningExperiments)],
        ['dt', t('done')], ['dd', String(data.rsi.acceptedExperimentResults)],
      ]
      if (data.rsi.phaseAdvisory !== null) rows.push(['dt', t('rsiAdvisory')], ['dd', data.rsi.phaseAdvisory])
      const actions = data.rsi.scheduler.map((action, index) => h('div', { key: `${action.action}-${index}`, className: 'mesh-meta' },
        h('span', { className: 'mesh-tag' }, action.action),
        h('span', null, action.type),
        h('span', null, action.target),
        h('span', null, `eig ${action.eig}`),
        h('span', null, `cost ${action.cost}`)))
      return h(Section, {
        title: t('rsi'),
        aside: h(StatusBadge, {
          status: data.rsi.available ? 'ready' : 'error',
          label: data.rsi.available ? `state_version ${data.rsi.stateVersion}` : 'unavailable',
        }),
      },
      data.rsi.error === null ? null : h('div', { className: 'mesh-error', role: 'alert' }, `${t('rsiError')}: ${data.rsi.error}`),
      h('dl', { className: 'mesh-kv' }, ...rows.map(([tag, text], index) => h(tag, { key: index }, text))),
      actions.length === 0 ? null : h('div', null,
        h('div', { className: 'mesh-muted' }, t('rsiNext')),
        h('div', { className: 'mesh-list' }, ...actions)))
    }

    function GroupsSection({ ctx, t, data, expanded, toggle, openSession, onGroupState, onCreate }) {
      const modelFor = (group, sessionId) => group.agentModels.find(model => model.sessionId === sessionId)
      const groupCard = group => {
        const isOpen = expanded[group.team.teamId] === true
        const currentTask = group.tasks.find(task => ['CLAIMED', 'RUNNING', 'SUBMITTED', 'RECONCILE_REQUIRED', 'OUTPUT_READY'].includes(task.status))
        const members = group.subagents.map(subagent => h(MemberRow, {
          key: subagent.sessionId, ctx, t,
          role: `${subagent.name} · ${subagent.role}`,
          sessionId: subagent.sessionId,
          model: modelFor(group, subagent.sessionId),
          status: group.liveStatus?.[subagent.sessionId],
          onOpen: openSession,
        }))
        const taskTable = group.tasks.length === 0 ? null : h('table', { className: 'mesh-table' },
          h('thead', null, h('tr', null, h('th', null, 'Task'), h('th', null, 'Type'), h('th', null, t('status')), h('th', null, 'Attempt'))),
          h('tbody', null, ...group.tasks.map(task => h('tr', { key: task.taskId },
            h('td', null, task.title),
            h('td', null, task.type),
            h('td', null, h(StatusBadge, { status: task.status, label: task.status })),
            h('td', null, `${task.attemptCount}/${task.maxAttempts}`)))))
        const body = isOpen ? h('div', { className: 'mesh-group-body' },
          h('div', null,
            h('div', { className: 'mesh-muted' }, t('captain')),
            h(MemberRow, {
              ctx, t, role: 'Captain',
              sessionId: group.team.rootSessionId,
              model: modelFor(group, group.team.rootSessionId),
              status: group.liveStatus?.[group.team.rootSessionId],
              onOpen: openSession,
            })),
          h('div', null,
            h('div', { className: 'mesh-muted' }, t('subagents')),
            members.length === 0 ? h('div', { className: 'mesh-muted' }, t('memberEmpty')) : members),
          taskTable) : null
        return h('div', { key: group.team.teamId, className: 'mesh-card mesh-group' },
          h('div', { className: 'mesh-group-head' },
            h('div', null,
              h('div', { className: 'mesh-row' },
                h('strong', null, group.team.name),
                h(StatusBadge, { status: group.team.status, label: group.team.status })),
              h('div', { className: 'mesh-meta' },
                h('span', null, `${t('route')}: ${group.team.researchRouteId}`),
                h('span', null, `${t('worktree')}: ${group.workspace?.branch ?? t('worktreeMissing')}`),
                h('span', null, `${t('currentTask')}: ${currentTask?.title ?? '—'}`))),
            h('div', { className: 'mesh-actions' },
              group.team.status === 'active'
                ? h('button', { className: 'mesh-btn ghost', onClick: () => onGroupState(group.team.teamId, 'pause') }, t('pauseGroup'))
                : group.team.status === 'paused' || group.team.status === 'stopped'
                  ? h('button', { className: 'mesh-btn ghost', onClick: () => onGroupState(group.team.teamId, 'resume') }, t('resumeGroup'))
                  : null,
              group.team.status === 'active' || group.team.status === 'paused'
                ? h('button', { className: 'mesh-btn ghost', onClick: () => onGroupState(group.team.teamId, 'stop') }, t('stopGroup'))
                : null,
              group.team.status === 'destroyed'
                ? null
                : h('button', { className: 'mesh-btn ghost', onClick: () => onGroupState(group.team.teamId, 'destroy') }, t('destroyGroup')),
              h('button', { className: 'mesh-btn', onClick: () => toggle(group.team.teamId), 'aria-expanded': isOpen }, isOpen ? '收起' : '展开'))),
          body)
      }
      return h(Section, {
        title: t('groups'),
        aside: h('div', { className: 'mesh-actions' },
          h('span', { className: 'mesh-muted' }, `${data.groups.length}/3`),
          h('button', { className: 'mesh-btn primary', onClick: onCreate }, t('groupCreate'))),
      },
      data.groups.length === 0
        ? h('div', { className: 'mesh-empty' }, 'No research groups yet.')
        : h('div', { className: 'mesh-list' }, ...data.groups.map(groupCard)))
    }

    function ExecutionSection({ data, t }) {
      const jobRows = data.jobs.map(job => h('tr', { key: job.jobId },
        h('td', null,
          h('div', { className: 'mesh-code' }, job.jobId),
          job.errorCode === null ? null : h('div', { className: 'mesh-muted' }, `${job.errorCode}: ${job.errorMessage ?? ''}`)),
        h('td', null, h(StatusBadge, { status: job.status, label: job.status })),
        h('td', null, job.gpuId < 0 ? '—' : String(job.gpuId)),
        h('td', null, formatTime(job.updatedAt))))
      const leaseRows = data.gpuLeases.map(lease => h('tr', { key: lease.leaseId },
        h('td', null, lease.workerId),
        h('td', null, String(lease.gpuId)),
        h('td', null, h(StatusBadge, { status: lease.state, label: lease.state }))))
      const jobs = data.jobs.length === 0
        ? h('div', { className: 'mesh-muted' }, t('noJobs'))
        : h('table', { className: 'mesh-table' },
          h('thead', null, h('tr', null, h('th', null, 'Job'), h('th', null, t('status')), h('th', null, 'GPU'), h('th', null, 'Updated'))),
          h('tbody', null, ...jobRows))
      const leases = data.gpuLeases.length === 0
        ? h('div', { className: 'mesh-muted' }, t('noGpu'))
        : h('table', { className: 'mesh-table' },
          h('thead', null, h('tr', null, h('th', null, 'Worker'), h('th', null, 'GPU'), h('th', null, t('status')))),
          h('tbody', null, ...leaseRows))
      return h(Section, { title: t('execution') },
        h('div', { className: 'mesh-grid' },
          h('div', null, h('h3', { className: 'mesh-h3' }, t('jobs')), jobs),
          h('div', null, h('h3', { className: 'mesh-h3' }, t('gpu')), leases)),
        h('p', { className: 'mesh-muted' }, t('scientificNote')))
    }

    function ActivitySection({ data, t }) {
      const rows = data.recentEvents.slice(0, 12).map(event => h('div', { key: event.seq, className: 'mesh-meta' },
        h('span', { className: 'mesh-tag' }, event.entityType),
        h('span', null, event.kind),
        h('span', { className: 'mesh-code' }, event.entityId),
        h('span', null, formatTime(event.createdAt))))
      return h(Section, {
        title: t('activity'),
        aside: h('span', { className: 'mesh-muted' }, formatTime(data.generatedAt)),
      },
      rows.length === 0 ? h('div', { className: 'mesh-muted' }, t('noActivity')) : h('div', { className: 'mesh-list' }, ...rows))
    }

    function Workbench({ ctx, projectId, onBack, t }) {
      const openSession = async (sessionId, parentSessionId) => {
        try {
          await ctx.sessions.refresh()
          const address = typeof parentSessionId === 'string' ? ctx.sessions.subagentAddress?.(sessionId) : undefined
          ctx.uiWorkspace.openSession(address ?? sessionId)
        } catch (error) {
          window.alert(String(error?.message ?? error))
        }
      }
      const state = useAsync(() => api(`/workbench?projectId=${encodeURIComponent(projectId)}`), [projectId])
      const data = state.data
      const [expanded, setExpanded] = useState({})
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [attach, setAttach] = useState('')
      useEffect(() => {
        if (data === null || ctx.workspaces === undefined) return
        for (const group of data.groups) {
          const path = group.workspace?.path ?? group.team.workspacePath
          if (typeof path === 'string' && path !== '') {
            ctx.workspaces.create({ path }).catch(() => { /* best-effort Host registration */ })
          }
        }
      }, [data, ctx])

      if (state.status === 'loading') return h('div', { className: 'mesh-inner' }, h(Loading, { t }))
      if (state.status === 'error' || data === null) {
        return h('div', { className: 'mesh-inner' },
          h('div', { className: 'mesh-actions' }, h('button', { className: 'mesh-btn', onClick: onBack }, t('back'))),
          h(ErrorLine, { t, message: `${t('error')}: ${state.error}`, onRetry: state.reload }))
      }
      const project = data.project
      const toggle = teamId => setExpanded(previous => ({ ...previous, [teamId]: !previous[teamId] }))
      const newDiscussion = () => {
        setBusy('discussion')
        setNotice(null)
        Promise.resolve()
          .then(async () => {
            const workspace = await ctx.workspaces.create({ path: project.repositoryRef })
            return await ctx.sessions.create({ workspaceId: workspace.workspaceId })
          })
          .then(async sessionId => {
            await api('/sessions/attach', { method: 'POST', body: JSON.stringify({ projectId, sessionId }) })
            invalidateSessionBinding(sessionId)
            try { await ctx.sessions.refresh() } catch { /* best effort */ }
            openSession(sessionId)
          })
          .catch(error => setNotice({ kind: 'error', text: error.message }))
          .finally(() => setBusy(null))
      }
      const attachSession = () => {
        if (attach.trim() === '') return
        setBusy('attach')
        setNotice(null)
        api('/sessions/attach', { method: 'POST', body: JSON.stringify({ projectId, sessionId: attach.trim() }) })
          .then(() => { invalidateSessionBinding(attach.trim()); setNotice({ kind: 'ok', text: t('attachSuccess') }); setAttach(''); state.reload() })
          .catch(error => setNotice({ kind: 'error', text: error.message }))
          .finally(() => setBusy(null))
      }
      const simulate = () => {
        setBusy('simulate')
        setNotice(null)
        api('/simulate', { method: 'POST', body: JSON.stringify({ projectId }) })
          .then(() => state.reload())
          .catch(error => setNotice({ kind: 'error', text: error.message }))
          .finally(() => setBusy(null))
      }
      const groupState = (teamId, action) => {
        if (action === 'destroy' && !window.confirm(t('groupDestroyConfirm'))) return
        setBusy('group')
        setNotice(null)
        api('/groups/state', { method: 'POST', body: JSON.stringify({ teamId, action, confirm: action === 'destroy' }) })
          .then(() => {
            if (action === 'stop') setNotice({ kind: 'ok', text: t('groupStoppedNotice') })
            else if (action === 'pause') setNotice({ kind: 'ok', text: t('groupPausedNotice') })
            else setNotice(null)
            state.reload()
          })
          .catch(error => setNotice({ kind: 'error', text: error.message }))
          .finally(() => setBusy(null))
      }
      const createGroup = () => {
        const name = window.prompt(t('groupNamePrompt'))
        if (name === null || name.trim() === '') return
        const routeId = window.prompt(t('groupRoutePrompt'))
        if (routeId === null || routeId.trim() === '') return
        setBusy('group')
        setNotice(null)
        api('/groups', { method: 'POST', body: JSON.stringify({ projectId, name: name.trim(), routeId: routeId.trim() }) })
          .then(() => state.reload())
          .catch(error => setNotice({ kind: 'error', text: error.message }))
          .finally(() => setBusy(null))
      }
      const setProjectStatus = status => {
        setBusy('project')
        setNotice(null)
        api('/projects/status', { method: 'POST', body: JSON.stringify({ projectId, status }) })
          .then(() => { setNotice({ kind: 'ok', text: status === 'paused' ? t('pausedNotice') : null }); state.reload() })
          .catch(error => setNotice({ kind: 'error', text: error.message }))
          .finally(() => setBusy(null))
      }
      return h('div', { className: 'mesh-inner' },
        h('div', { className: 'mesh-actions' }, h('button', { className: 'mesh-btn ghost', onClick: onBack }, t('back'))),
        h('div', { className: 'mesh-header' },
          h('div', null,
            h('h1', { className: 'mesh-title' }, project.name),
            h('p', { className: 'mesh-subtitle' }, project.description || t('noDescription'))),
          h('div', { className: 'mesh-actions' },
            h(StatusBadge, { status: project.status, label: project.status }),
            h('button', { className: 'mesh-btn primary', onClick: newDiscussion, disabled: busy !== null || project.status !== 'active' }, busy === 'discussion' ? t('saving') : t('discussion')),
            h('button', { className: 'mesh-btn', onClick: simulate, disabled: busy !== null || project.status !== 'active' }, busy === 'simulate' ? t('simulationRunning') : t('simulation')),
            project.status === 'active'
              ? h('button', { className: 'mesh-btn ghost', onClick: () => setProjectStatus('paused'), disabled: busy !== null }, t('pauseProject'))
              : project.status === 'paused'
                ? h('button', { className: 'mesh-btn ghost', onClick: () => setProjectStatus('active'), disabled: busy !== null }, t('resumeProject'))
                : null)),
        state.status === 'stale' ? h('div', { className: 'mesh-stale', role: 'status' }, `${t('stale')} · ${formatTime(state.loadedAt)}`) : null,
        notice === null ? null : h('div', { className: notice.kind === 'error' ? 'mesh-error' : 'mesh-muted', role: notice.kind === 'error' ? 'alert' : 'status' }, notice.text),
        h('div', { className: 'mesh-card mesh-inline' },
          h('input', { className: 'mesh-input', style: { maxWidth: '320px' }, placeholder: t('attachHint'), value: attach, onChange: event => setAttach(event.target.value), 'aria-label': t('attachHint') }),
          h('button', { className: 'mesh-btn', onClick: attachSession, disabled: busy !== null || attach.trim() === '' }, t('attachAction'))),
        h(RsiSection, { data, t }),
        h(GroupsSection, { ctx, t, data, expanded, toggle, openSession, onGroupState: groupState, onCreate: createGroup }),
        h(ExecutionSection, { data, t }),
        h(ActivitySection, { data, t }))
    }

    function ResearchMeshPage({ ctx, t }) {
      const [view, setView] = useState(() => {
        let projectId = null
        try { projectId = window.localStorage.getItem(LAST_PROJECT_KEY) } catch { projectId = null }
        return projectId === null ? { kind: 'projects' } : { kind: 'workbench', projectId }
      })
      useEffect(() => {
        const listener = event => {
          const projectId = event?.detail?.projectId
          if (typeof projectId === 'string' && projectId !== '') setView({ kind: 'workbench', projectId })
        }
        window.addEventListener('dsh-research-mesh:open-project', listener)
        return () => window.removeEventListener('dsh-research-mesh:open-project', listener)
      }, [])
      const open = projectId => {
        setView({ kind: 'workbench', projectId })
        try { window.localStorage.setItem(LAST_PROJECT_KEY, projectId) } catch { /* ignore */ }
      }
      const back = () => {
        setView({ kind: 'projects' })
        try { window.localStorage.removeItem(LAST_PROJECT_KEY) } catch { /* ignore */ }
      }
      const openModels = () => setView({ kind: 'models' })
      const fromModels = () => setView({ kind: 'projects' })
      return h('div', { className: 'mesh-root' },
        view.kind === 'projects'
          ? h(ProjectsPage, { ctx, t, onOpen: open, onModels: openModels })
          : view.kind === 'models'
            ? h(ModelSettingsPage, { ctx, t, onBack: fromModels })
            : h(Workbench, { ctx, t, projectId: view.projectId, onBack: back }))
    }

    function ModelPicker({ t, catalog, value, disabled, onChange }) {
      const providers = useMemo(() => {
        const map = new Map()
        for (const entry of catalog) {
          if (!map.has(entry.provider)) map.set(entry.provider, { id: entry.provider, name: entry.providerName, models: [] })
          map.get(entry.provider).models.push(entry)
        }
        return [...map.values()].sort((left, right) => left.id.localeCompare(right.id))
      }, [catalog])
      const provider = value?.provider ?? ''
      const models = providers.find(candidate => candidate.id === provider)?.models ?? []
      const known = value === undefined || value === null || catalog.some(entry => entry.provider === value.provider && entry.model === value.model)
      return h('div', { className: 'mesh-inline mesh-model-picker' },
        h('select', {
          className: 'mesh-input mesh-select', 'aria-label': t('provider'), disabled, value: provider,
          onChange: event => {
            const next = providers.find(candidate => candidate.id === event.target.value)
            if (next === undefined) { onChange(undefined); return }
            onChange({ provider: next.id, model: next.models[0]?.model ?? '' })
          },
        },
        h('option', { value: '' }, `— ${t('provider')} —`),
        ...providers.map(candidate => h('option', { key: candidate.id, value: candidate.id }, candidate.name))),
        h('select', {
          className: 'mesh-input mesh-select', 'aria-label': t('model'), disabled: disabled || provider === '', value: value?.model ?? '',
          onChange: event => { if (provider !== '') onChange({ provider, model: event.target.value }) },
        },
        h('option', { value: '' }, `— ${t('model')} —`),
        known ? null : h('option', { value: value?.model ?? '' }, `${value.provider} / ${value.model} ${t('unavailable')}`),
        ...models.map(model => h('option', { key: model.model, value: model.model }, model.modelName))),
        known ? null : h('span', { className: 'mesh-error' }, t('notRegistered')))
    }

    function ModelSettingsPage({ ctx, t, onBack }) {
      const [document, setDocument] = useState(null)
      const [catalog, setCatalog] = useState([])
      const [errors, setErrors] = useState([])
      const [state, setState] = useState('loading')
      const [failure, setFailure] = useState(null)
      const [saveState, setSaveState] = useState('idle')

      const load = useCallback(() => {
        setState('loading')
        api('/model-settings').then(value => {
          setDocument(value.document)
          setCatalog(value.catalog)
          setErrors(value.errors)
          setState('ready')
        }).catch(error => { setFailure(error.message); setState('error') })
      }, [])
      useEffect(() => { load() }, [load])

      if (state === 'loading') return h('div', { className: 'mesh-root' }, h('div', { className: 'mesh-inner' }, h(Loading, { t })))
      if (state === 'error' || document === null) {
        return h('div', { className: 'mesh-root' }, h('div', { className: 'mesh-inner' },
          h(ErrorLine, { t, message: `${t('error')}: ${failure}`, onRetry: load })))
      }
      const groups = Object.keys(document.groups ?? {})
      for (const name of ['group-a', 'group-b', 'group-c']) if (!groups.includes(name)) groups.push(name)
      const updateGroup = (name, patch) => {
        const current = document.groups?.[name] ?? {}
        setDocument({ ...document, groups: { ...(document.groups ?? {}), [name]: { ...current, ...patch } } })
      }
      const save = () => {
        setSaveState('saving'); setFailure(null)
        api('/model-settings', { method: 'POST', body: JSON.stringify({ document }) })
          .then(value => { setDocument(value.document); setCatalog(value.catalog); setErrors(value.errors); setSaveState('saved') })
          .catch(error => { setFailure(error.message); setSaveState('error') })
      }

      return h('div', { className: 'mesh-root' }, h('div', { className: 'mesh-inner' },
        h('div', { className: 'mesh-header' },
          h('div', null, h('h1', { className: 'mesh-title' }, t('modelsTitle')), h('p', { className: 'mesh-subtitle' }, t('modelsSub'))),
          h('div', { className: 'mesh-actions' },
            onBack === undefined ? null : h('button', { className: 'mesh-btn ghost', onClick: onBack }, t('back')),
            h('button', { className: 'mesh-btn primary', onClick: save, disabled: saveState === 'saving' }, saveState === 'saving' ? t('saving') : t('save')),
            h('span', { className: 'mesh-muted', role: 'status' }, saveState === 'saved' ? t('saved') : saveState === 'error' ? t('saveFailed') : ''))),
        failure === null ? null : h('div', { className: 'mesh-error', role: 'alert' }, failure),
        errors.length === 0 ? null : h('div', { className: 'mesh-error', role: 'alert' }, ...errors.map((error, index) => h('div', { key: index }, `${error.group} · ${error.scope}: ${error.provider}/${error.model} — ${error.reason}`))),
        h(Section, { title: t('groups') },
          ...groups.map(name => {
            const group = document.groups?.[name] ?? {}
            const captain = group.captain ?? 'inherit'
            const subagents = group.subagents ?? {}
            return h('div', { key: name, className: 'mesh-settings-group' },
              h('h3', { className: 'mesh-h3' }, name),
              h('div', { className: 'mesh-settings-row' },
                h('span', { className: 'mesh-settings-label' }, t('groupDefault')),
                h('span', { className: 'mesh-muted' }, ''),
                h(ModelPicker, { t, catalog, value: group.default, onChange: value => updateGroup(name, { default: value }) })),
              h('div', { className: 'mesh-settings-row' },
                h('span', { className: 'mesh-settings-label' }, t('captain')),
                h('label', { className: 'mesh-inline' }, h('input', { type: 'checkbox', checked: captain === 'inherit', onChange: event => updateGroup(name, { captain: event.target.checked ? 'inherit' : (group.default ?? undefined) }) }), h('span', null, t('inherit'))),
                captain === 'inherit'
                  ? h('span', { className: 'mesh-muted' }, `${t('inherit')} → ${group.default === undefined ? '—' : `${group.default.provider} / ${group.default.model}`}`)
                  : h(ModelPicker, { t, catalog, value: captain, onChange: value => updateGroup(name, { captain: value }) })),
              ...[1, 2, 3, 4].map(slot => {
                const key = `subagent-${slot}`
                const choice = subagents[key] ?? 'inherit'
                return h('div', { key, className: 'mesh-settings-row' },
                  h('span', { className: 'mesh-settings-label' }, `${t('subagents')} ${slot}`),
                  h('label', { className: 'mesh-inline' }, h('input', { type: 'checkbox', checked: choice === 'inherit', onChange: event => updateGroup(name, { subagents: { ...subagents, [key]: event.target.checked ? 'inherit' : (group.default ?? undefined) } }) }), h('span', null, t('inherit'))),
                  choice === 'inherit'
                    ? h('span', { className: 'mesh-muted' }, `${t('inherit')} → ${group.default === undefined ? '—' : `${group.default.provider} / ${group.default.model}`}`)
                    : h(ModelPicker, { t, catalog, value: choice, onChange: value => updateGroup(name, { subagents: { ...subagents, [key]: value } }) }))
              }))
          }))))
    }

    function SessionProjectEntry({ ctx, t, sessionId }) {
      const state = useSessionBinding(sessionId)
      if (state === undefined || state.status !== 'ready') return null
      if (state.value?.binding === null || state.value === undefined) return null
      const projectName = state.value.projectName ?? state.value.binding.projectId
      return h('button', {
        type: 'button',
        className: 'mesh-session-link',
        title: `${t('title')} / ${projectName}`,
        onClick: () => projectOpener(ctx)(state.value.binding.projectId),
      }, `${t('title')} / ${projectName}`)
    }

    function MeshPanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 10, cy: 10, r: 7, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 10, cy: 10, r: 2.4, fill: 'currentColor' }),
        h('path', { d: 'M10 3v3M10 14v3M3 10h3M14 10h3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    const inject = ['slots', 'locale', 'layout', 'uiWorkspace', 'sessions', 'workspaces']

    function apply(ctx) {
      ensureStyle()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-research-mesh: dictionaries')
      const openProject = projectOpener(ctx)
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ ctx, t }),
        }, ResearchMeshPage)
      })
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('nav'),
        locale: NS,
      }, MeshPanelIcon))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'research-mesh-models',
        order: 30,
        label: () => t('models'),
        locale: NS,
        inject: () => ({ ctx, t }),
      }, ModelSettingsPage))
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'research-mesh-project',
        order: 50,
        locale: NS,
        inject: () => ({ ctx, t }),
      }, SessionProjectEntry))
      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'research-mesh-project',
        order: 50,
        locale: NS,
        inject: () => ({ ctx, t }),
      }, SessionProjectEntry))
      try {
        ctx.provide('researchMeshNavigation', { openProject, panelId: PANEL_ID })
      } catch {
        // A test double or a composition without provide support still gets the panel.
      }
    }

    return {
      inject,
      apply,
      ResearchMeshPage,
      ProjectsPage,
      Workbench,
      ModelSettingsPage,
      SessionProjectEntry,
      MeshPanelIcon,
      COPY,
      PANEL_ID,
      API,
    }
  },
})
