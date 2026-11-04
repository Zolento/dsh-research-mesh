# Web console and model settings

## Product shape

Two main views:

1. **Projects** — long-lived research projects, RSI readability, group count, status.
2. **Project Workbench** — RSI summary, three groups, execution, recent activity.

Group detail expands inside the Workbench. Conversations stay in DSH's native chat.
Model configuration is a `settings.section` page plus a full-width Models view in the
Research Mesh main panel (useful on narrow screens where the native Settings dialog
reserves most of the width for its navigation).

## Native extension points used

| Concern | DSH interface |
|---|---|
| Global page | `ctx.slots.register({ name: 'main', key: 'research-mesh' }, Page)` |
| Left navigation | `ctx.slots.register({ name: 'sidebar.panellist', id: 'research-mesh', label, locale }, Icon)` |
| Switch page | `ctx.layout.selectPanel('research-mesh')` |
| Settings page | `ctx.slots.register({ name: 'settings.section', id: 'research-mesh-models', order: 30 }, Page)` |
| Bound-chat entry | `conversation.session.header.actions` and `conversation.hero.options` |
| Open existing session | `ctx.uiWorkspace.openSession(sessionId)` |
| Create control conversation | `ctx.sessions.create({ workspaceId })` |
| Live model catalog | Host `ctx.llm.listProviders/listModels` (through `/model-settings`) |
| Persist assignments | DSH `SettingsForms` on a volatile Config field |
| Host data | plugin-owned `ctx.webServer` prefix route |

No upstream source is modified. No DOM injection, route hijacking or global overlay is
used for the console.

## Behaviour

### Projects

- Empty state: "还没有研究项目。关联一个已有 RSI 项目以开始。"
- Link form asks name, canonical `research-state.json` path, Git repository path and an
  optional description.
- Host rejects a missing/invalid state, a state without `state_version`, or a non-Git
  repository.
- A project outside this runtime's configured source root is registered read-only
  (`registered`); the UI shows the reason and cannot create groups for it.
- Loading, error with retry, stale-with-last-confirmed-time are distinct states.

### Workbench

- Header: back, project name/description, status, new discussion, local simulation,
  pause/resume.
- RSI: `state_version`, goal, last file update, critical uncertainties, planned/running/
  done experiments, scheduler `next_actions` (read-only). A `decision.next_phase` is
  labelled **advisory**; Mesh never invents an R0–R14 stage.
- Groups: route, worktree branch, current Mesh task. Expanded: Captain, four subagent
  identities, actual provider/model, live agent status, group Mesh tasks, open-session
  buttons.
- Execution: Mesh jobs and GPU leases with separate statuses. Text states explicitly
  that execution completion is not scientific PASS.
- Activity: last decision-relevant events only.
- Pause stops new scheduling by parking groups; running jobs are not terminated and the
  UI says so. Resume restores the groups.
- New discussion creates a native workspace-backed DSH session, binds it as `control`,
  and opens it. It is not a Captain.
- Attach requires the exact session id and an explicit action; no title/path guessing.
- A bound conversation shows `Research Mesh / <project>`; clicking returns to the
  workbench. The entry is cached across remounts so navigation does not flicker.

### Model settings

Document:

```json
{
  "version": 1,
  "groups": {
    "group-a": {
      "default": { "provider": "mock", "model": "mock-flash" },
      "captain": { "provider": "mock", "model": "mock-pro" },
      "subagents": {
        "subagent-1": "inherit",
        "subagent-2": "inherit",
        "subagent-3": "inherit",
        "subagent-4": "inherit"
      }
    }
  }
}
```

- Providers and models come only from the live catalog; no free text, AI selection,
  stage routing, cost optimization or fallback.
- Changing provider repopulates the model select.
- A stored pair no longer advertised is displayed as unavailable and the save/creation
  path reports `MODEL_CONFIG_INVALID`.
- Inheritance is explicit; a subagent/captain without a group default is an error.
- Save writes through the Host API into `ctx.settings.update(...)`; the document is
  validated by schemastery and lands in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
  as `modelAssignments`.
- `mesh_agent_models` records the provider/model/source/config version actually passed to
  `SessionController.selectModel` at creation.
- The page and API never receive API keys; provider secrets remain in DSH credentials.

## Responsive and visual rules

- DSH theme tokens (`--dsw-alias-*`, `--dsh-font-family-*`) instead of a private palette.
- 8px spacing, restrained 8–12px radii, borders instead of stacked shadows.
- Status color only for running / attention / failure / verified states.
- `prefers-reduced-motion` disables transitions.
- Layouts verified at 1440, 1280, 768 and 390 px; no horizontal overflow.
- Buttons have visible focus rings and minimum 32px hit targets.
- Loading, empty, error, stale and success states exist for async views.

## Screenshots

All captured from a real isolated DSH web profile through headless Chrome by
`scripts/ui-acceptance.mjs`; the script also asserts no horizontal overflow.

| File | View |
|---|---|
| `docs/screenshots/projects-1440.png` | Projects |
| `docs/screenshots/workbench-1440.png` | Workbench |
| `docs/screenshots/workbench-group-1440.png` | Group A expanded, Captain + 4 members |
| `docs/screenshots/captain-session-1440.png` | Native Captain conversation with project entry |
| `docs/screenshots/member-session-1440.png` | Native member conversation with project entry |
| `docs/screenshots/workbench-1280.png` | 1280 px |
| `docs/screenshots/workbench-768.png` | 768 px |
| `docs/screenshots/workbench-390.png` | 390 px |
| `docs/screenshots/model-settings-1440.png` | Native Settings section |
| `docs/screenshots/model-settings-390.png` | Full-width model page at 390 px |
| `docs/screenshots/projects-dark.png` | Dark appearance |

## Known UI limitations

- Native Settings is a wide modal; at 390 px its navigation consumes most of the width.
  The Research Mesh main panel provides a full-width Models view as the mobile path.
- The DSH shell has no public slot for a third-party settings-section icon; the generic
  gear is shown.
- A third-party client cannot set the native `ModelSelect` widget; the page builds
  select elements from the live catalog.
- v0.1 group/member sessions are created through SessionController and bound by Mesh;
  they do not come from the native `SubagentRuntime` continuable-child roster.
