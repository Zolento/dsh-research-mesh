# DSH 0.2.2-rc.1 adaptation

Target: local `deepseek-harness` checkout at tag `dsh-v0.2.2-rc.1`
(commit `66491b05e3`), and the published package
`@deepseek-ai/dsh@0.2.2-rc.1`.

Node requirement: `>=24.9.0`. Verified with Node `v24.12.0`. The plugin source
and its unit tests still run under Node 22; the rc1 host itself does not.

## What changed for the plugin

### 1. Host services now activate after the plugin

In rc1 the Web composition activates `agents`, `sessionController`,
`workspaceController`, `settings` and `llm` later than rc5. At `apply()` time:

```text
agents: false
sessionController: false
workspaceController: false
llm: true (in the observed Web composition)
settings: false
```

The plugin now late-binds every optional host service through `ctx.inject`:

- `agents` → `DshSessionHost.attachAgents` and live Workbench status
- `sessionController` → controller-backed Web sessions
- `workspaceController` → DSH Workspace association for group worktrees
- `settings` → replaces the fallback file store with `ConfigModelSettingsStore`
- `llm` → replaces the static catalog with `DshModelCatalog`

The important functional fix is the settings store: without late binding, rc1
silently used the file fallback and never wrote `modelAssignments` into the
profile patch. The rc1 WebUI acceptance now verifies the Config-backed path and
the profile patch.

### 2. Client package dependency edges

The package now declares `dsh.client.inject` for the client modules whose
services the console consumes:

- slots, locale, layout, workspace, conversation, settings
- session controller and workspace controller

The hand-written client bundle still uses the rc1
`window.__ModuleLoader__.load({ id, factory })` contract; no bundle rewrite is
needed.

### 3. Compatibility range

`engines.dsh` remains:

```json
">=0.2.1-rc.2 <0.3.0-0"
```

rc1's `evaluatePluginCompatibility()` calls semver with
`includePrerelease: true`, so this range covers `0.2.2-rc.1`. Verified directly
against the rc1 `dsh-app-boot` package. `scripts/check-dsh.mjs` also uses
`includePrerelease: true`.

### 4. Loader test layout

The published rc1 package installs dependencies flat under
`node_modules/@deepseek-ai`, while the previous global install nested them under
`dsh/node_modules/@deepseek-ai`. The loader test now accepts either layout and
works with `DSH_INSTALL`.

## Verification

```bash
# Node 22 baseline, rc5 loader
npm run typecheck
npm run test:all                 # 99 tests

# Node 24 + published rc1
PATH=/home/lenovo/.nvm/versions/node/v24.12.0/bin:$PATH \
  DSH_INSTALL=/tmp/dsh-rc1/node_modules/@deepseek-ai/dsh \
  node --test 'tests/**/*.test.ts'   # 99 tests

PATH=/home/lenovo/.nvm/versions/node/v24.12.0/bin:$PATH \
  DSH_INSTALL=/tmp/dsh-rc1/node_modules/@deepseek-ai/dsh \
  node --test tests/integration/dsh-loader.test.ts

PATH=/home/lenovo/.nvm/versions/node/v24.12.0/bin:$PATH \
  DSH_BIN=/tmp/dsh-rc1/node_modules/.bin/dsh \
  DSH_INSTALL=/tmp/dsh-rc1/node_modules/@deepseek-ai/dsh \
  node scripts/ui-acceptance.mjs
```

All pass. The rc1 UI acceptance covers group creation, controller-backed
Captain/member sessions, session header navigation, model settings persistence,
responsive layouts and dark appearance.

## Remaining differences / limitations

- Real rc1 installations are Node 24 only; the plugin's Node 22 support is for
  source tests, not for running the rc1 host.
- The rc1 host activates services late; code added in future plugins must not
  assume `ctx.get('agents'/'settings')` is populated during `apply()`.
- Native `SubagentRuntime` parentage and tool-level quota enforcement remain
  separate work; they are not required for the rc1 adaptation.
- No DSH upstream files were modified.
