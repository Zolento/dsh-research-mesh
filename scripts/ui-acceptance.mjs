#!/usr/bin/env node
/**
 * Local WebUI acceptance: isolated DSH_HOME, real web profile, real plugin load,
 * real API mutations, headless Chrome screenshots and overflow checks.
 *
 * Test-only seams: a mock LLM adapter row and the fake SSH transport. No real
 * model call, no SSH, no GPU job, no external network.
 */
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH = process.env.DSH_BIN ?? 'dsh';
const PORT = Number(process.env.MESH_UI_PORT ?? 3311);
const CDP_PORT = Number(process.env.MESH_CDP_PORT ?? 9333);
const SKILL = process.env.RSI_SKILL_PATH ?? '/home/lenovo/.agents/skills/rsi-pipeline';
const SHOTS = join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), 'mesh-ui-accept-'));
const project = join(tmp, 'project');
const home = join(tmp, 'home');
const remote = join(tmp, 'remote');
const logs = join(tmp, 'logs');
mkdirSync(logs, { recursive: true });

function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }

function prepareProject() {
  mkdirSync(join(project, 'source', 'experiments'), { recursive: true });
  writeFileSync(join(project, 'source', 'experiments', 'run.py'), 'print("fixture")\n');
  git(join(project, 'source'), ['init', '-q']);
  git(join(project, 'source'), ['config', 'user.email', 'mesh@test.invalid']);
  git(join(project, 'source'), ['config', 'user.name', 'Mesh Acceptance']);
  git(join(project, 'source'), ['add', '-A']);
  git(join(project, 'source'), ['commit', '-q', '-m', 'fixture']);
  const route = join(project, '.research-idea-pipeline', 'routes', 'A');
  mkdirSync(route, { recursive: true });
  execFileSync('cp', [join(SKILL, 'templates', 'research-state.template.json'), join(route, 'research-state.json')]);
  const conda = join(tmp, 'fake-conda');
  writeFileSync(conda, '#!/usr/bin/env bash\nset -euo pipefail\nif [ "${1:-}" = "run" ]; then shift; while [ $# -gt 0 ]; do case "$1" in -n) shift 2 ;; --no-capture-output) shift ;; *) break ;; esac; done; fi\nexec "$@"\n');
  chmodSync(conda, 0o755);
  return { route, conda };
}

function prepareProfile(conda) {
  // Materialize the shipped web template, then install this local package as a
  // profile bundle without running pnpm. The profile patch (not a --patch
  // overlay) owns the plugin config, so DSH Settings may persist assignments.
  execFileSync(DSH, ['--profile', 'mesh-ui', '--from-default-profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'ignore',
  });
  const profileDir = join(home, 'profiles', 'mesh-ui');
  const manifestPath = join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = { ...(manifest.dependencies ?? {}), 'dsh-research-mesh': `link:${ROOT}` };
  const bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-research-mesh');
  bundles.push('dsh-research-mesh');
  manifest.dsh.profile.bundles = bundles;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  const link = join(profileDir, 'node_modules', 'dsh-research-mesh');
  try { rmSync(link, { recursive: true, force: true }); } catch { /* fresh profile */ }
  symlinkSync(ROOT, link, 'dir');
  const patch = join(profileDir, 'cordis.patch.yml');
  writeFileSync(patch, `
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-flash
- insert:
    - id: mesh-test-mock-llm-adapter
      name: '${join(ROOT, 'tests', 'dsh', 'mock-llm-adapter.mjs')}'
- id: dsh-research-mesh
  name: dsh-research-mesh
  config:
    projectRoot: '${project}'
    sourceDir: 'source'
    worktreesDir: 'worktrees'
    modelSettingsPath: '${join(tmp, 'model-settings.json')}'
    allowFakeTransport: true
    sessionBinding: dsh
    agent:
      provider: mock
      model: mock-flash
    conda:
      executable: '${conda}'
      defaultEnvironment: research
    workers:
      workstation:
        transport: fake
        enabled: true
        gpuIds: [0, 1]
        maxGpuJobs: 2
        condaEnvironment: research
        fakeRemoteRoot: '${remote}'
    rsi:
      enabled: true
      skillPath: '${SKILL}'
      allowTestStub: true
    autoStartScheduler: false
`);
  return patch;
}

async function waitFor(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(200);
  }
}

async function api(base, path, init) {
  const response = await fetch(`${base}/dsh-research-mesh/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = await response.json();
  if (payload.ok !== true) throw new Error(`${path}: ${JSON.stringify(payload.error)}`);
  return payload.value;
}

async function main() {
  const { route, conda } = prepareProject();
  prepareProfile(conda);
  const logPath = join(tmp, 'boot.log');
  const server = spawn(DSH, ['--profile', 'mesh-ui', '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk.toString(); writeFileSync(logPath, log); });
  server.stderr.on('data', chunk => { log += chunk.toString(); writeFileSync(logPath, log); });
  let browser;
  try {
    await waitFor(() => log.includes(`http://127.0.0.1:${PORT}`), 'web server');
    const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1];
    if (token === undefined) throw new Error('boot log has no token');
    const base = `http://127.0.0.1:${PORT}`;
    const bootstrap = await api(base, '/bootstrap');
    if (bootstrap.catalog.length === 0) throw new Error('mock catalog did not register');
    const created = await api(base, '/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: '3D Wave-TOF',
        description: 'Accelerated 3D wave imaging for time-of-flight MRI',
        rsiStateRef: join(route, 'research-state.json'),
        repositoryRef: join(project, 'source'),
      }),
    });
    await api(base, '/model-settings', {
      method: 'POST',
      body: JSON.stringify({
        document: {
          version: 1,
          groups: {
            'group-a': {
              default: { provider: 'mock', model: 'mock-flash' },
              captain: { provider: 'mock', model: 'mock-pro' },
              subagents: { 'subagent-1': 'inherit', 'subagent-2': 'inherit', 'subagent-3': 'inherit', 'subagent-4': 'inherit' },
            },
            'group-b': { default: { provider: 'mock', model: 'mock-pro' }, captain: 'inherit', subagents: {} },
            'group-c': { default: { provider: 'mock', model: 'mock-flash' }, captain: 'inherit', subagents: {} },
          },
        },
      }),
    });
    const groups = [];
    for (const [name, routeId] of [['group-a', 'A'], ['group-b', 'B'], ['group-c', 'C']]) {
      groups.push(await api(base, '/groups', { method: 'POST', body: JSON.stringify({ projectId: created.projectId, name, routeId }) }));
    }
    for (let index = 1; index <= 4; index += 1) {
      await api(base, '/subagents', {
        method: 'POST',
        body: JSON.stringify({ teamId: groups[0].teamId, name: `subagent-${index}`, role: index === 1 ? 'experiment' : 'discovery' }),
      });
    }
    await api(base, '/simulate', { method: 'POST', body: JSON.stringify({ projectId: created.projectId }) });
    const createdSnapshot = await api(base, `/workbench?projectId=${created.projectId}`);
    const captainModel = createdSnapshot.groups[0].agentModels.find(model => model.role === 'captain');
    if (captainModel?.provider !== 'mock' || captainModel?.model !== 'mock-pro') {
      throw new Error(`Captain was not created with the configured model: ${JSON.stringify(captainModel)}`);
    }
    const memberModel = createdSnapshot.groups[0].agentModels.find(model => model.role === 'experiment');
    if (memberModel?.provider !== 'mock' || memberModel?.model !== 'mock-flash') {
      throw new Error(`Subagent was not created with the inherited model: ${JSON.stringify(memberModel)}`);
    }

    // Chrome + CDP.
    const chromeProfile = join(tmp, 'chrome');
    browser = spawn('google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${chromeProfile}`,
      '--no-first-run', '--no-default-browser-check',
      `http://127.0.0.1:${PORT}/?token=${token}`,
    ], { stdio: 'ignore' });
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).ok } catch { return false }
    }, 'chrome CDP');
    const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = pages.find(candidate => candidate.type === 'page');
    if (page === undefined) throw new Error('chrome page target missing');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(async () => {
      const result = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return result.result.value === 'complete';
    }, 'page load');
    await delay(2500);
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const shot = async (name) => {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(SHOTS, name), Buffer.from(result.data, 'base64'));
      const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
      if (overflow > 1) throw new Error(`${name}: horizontal overflow ${overflow}px`);
    };
    const click = async selector => {
      const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`);
      if (!ok) throw new Error(`selector not found: ${selector}`);
      await delay(900);
    };
    const clickText = async (text) => {
      const ok = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find(node => (node.innerText || '').includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true })()`);
      if (!ok) throw new Error(`button text not found: ${text}`);
      await delay(900);
    };

    // Dismiss the shipped preview notice when it is present.
    await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find(node => /^(继续|Continue|Got it)$/i.test((node.innerText || '').trim())); if (el) el.click(); return el !== undefined })()`);
    await delay(600);
    // Projects page.
    await waitFor(async () => evaluate('document.body.innerText.includes("Research Mesh")'), 'sidebar entry');
    await click('button[aria-label="Research Mesh"]');
    await waitFor(async () => evaluate('document.body.innerText.includes("3D Wave-TOF")'), 'project list');
    await shot('projects-1440.png');

    // Workbench.
    await click('.mesh-project');
    await waitFor(async () => evaluate('document.body.innerText.includes("Project Workbench") || document.body.innerText.includes("group-a")'), 'workbench');
    await shot('workbench-1440.png');

    // Expand group A and capture member rows.
    await click('.mesh-group button[aria-expanded]');
    await waitFor(async () => evaluate('document.body.innerText.includes("Captain")'), 'group details');
    await shot('workbench-group-1440.png');

    // Pause only stops new scheduling; resume restores it.
    await clickText('暂停项目');
    await waitFor(async () => evaluate('document.body.innerText.includes("恢复项目")'), 'paused project');
    await clickText('恢复项目');
    await waitFor(async () => evaluate('document.body.innerText.includes("暂停项目")'), 'resumed project');

    // Responsive desktop and tablet captures.
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await shot('workbench-1280.png');
    await send('Emulation.setDeviceMetricsOverride', { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await shot('workbench-768.png');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await delay(300);

    // Native session navigation: open the Captain, return to the Mesh, create a
    // project discussion, and verify the Host persisted its binding.
    const captainOpened = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('.mesh-group button')).find(node => /打开会话|Open session/i.test(node.innerText || '')); if (!el) return false; el.click(); return true })()`);
    if (!captainOpened) throw new Error('Captain session link not found');
    await waitFor(async () => evaluate('document.body.innerText.includes("Research Mesh / 3D Wave-TOF")'), 'Captain conversation', 6000);
    await shot('captain-session-1440.png');
    await click('button[aria-label="Research Mesh"]');
    await delay(800);
    const projectVisible = await evaluate('document.body.innerText.includes("3D Wave-TOF")');
    if (!projectVisible) {
      await click('.mesh-project');
      await delay(600);
    }
    if (!(await evaluate('document.body.innerText.includes("Captain")'))) {
      await click('.mesh-group button[aria-expanded]');
      await delay(400);
    }
    const memberOpened = await evaluate(`(() => { const buttons = Array.from(document.querySelectorAll('.mesh-group button')).filter(node => /打开会话|Open session/i.test(node.innerText || '')); if (buttons.length < 2) return false; buttons[1].click(); return true })()`);
    if (!memberOpened) throw new Error('member session link not found');
    await waitFor(async () => evaluate('document.body.innerText.includes("Research Mesh / 3D Wave-TOF")'), 'member conversation', 6000);
    await shot('member-session-1440.png');
    await click('button[aria-label="Research Mesh"]');
    await delay(800);
    if (!(await evaluate('document.body.innerText.includes("3D Wave-TOF")'))) await click('.mesh-project');
    await delay(500);
    await clickText('新建项目讨论');
    await delay(1600);
    const headerLinked = await evaluate('document.body.innerText.includes("Research Mesh / 3D Wave-TOF")');
    if (!headerLinked) {
      throw new Error('bound session header did not show the project entry');
    }
    const headerOpened = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find(node => (node.innerText || '').includes('Research Mesh /')); if (!el) return false; el.click(); return true })()`);
    if (!headerOpened) throw new Error('project entry in the session header was not clickable');
    await delay(800);
    if (!(await evaluate('document.body.innerText.includes("Research Groups")'))) {
      throw new Error('project entry did not return to the Project Workbench');
    }
    const afterDiscussion = await api(base, `/workbench?projectId=${created.projectId}`);
    if (afterDiscussion.project.controlSessions.length < 1) throw new Error('control session was not bound');
    if (afterDiscussion.project.controlSessions.length < 1) throw new Error('control session binding was not persisted');
    await click('button[aria-label="Research Mesh"]');
    await delay(800);
    if (!(await evaluate('document.body.innerText.includes("3D Wave-TOF")'))) await click('.mesh-project');
    await delay(500);

    // Narrow viewport: workbench, then the full-width model page.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await delay(500);
    await shot('workbench-390.png');
    await clickText('返回 Projects');
    await waitFor(async () => evaluate('document.body.innerText.includes("3D Wave-TOF")'), 'projects after narrow');
    const narrowModels = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find(node => /研究模型|Research models/i.test((node.innerText || '').trim())); if (!el) return false; el.click(); return true })()`);
    if (!narrowModels) throw new Error('full-width model entry not found');
    await waitFor(async () => evaluate('document.body.innerText.includes("group-a")'), 'narrow model settings');
    await shot('model-settings-390.png');

    // Back to desktop, open settings and the model page.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await delay(300);
    await clickText('返回 Projects');
    const accountOpened = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find(node => /账号菜单|account menu/i.test(node.getAttribute('aria-label') || node.innerText || '')); if (!el) return false; el.click(); return true })()`);
    if (!accountOpened) throw new Error('account menu not found');
    await delay(400);
    const settingsOpened = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button, [role="menuitem"]')).find(node => /^(设置|settings|preferences)$/i.test((node.innerText || node.getAttribute('aria-label') || '').trim())); if (!el) return false; el.click(); return true })()`);
    if (!settingsOpened) {
      const labels = await evaluate(`Array.from(document.querySelectorAll('button, [role="menuitem"]')).map(node => node.getAttribute('aria-label') || (node.innerText || '').trim()).filter(Boolean).slice(-50)`);
      throw new Error(`settings entry not found; entries=${JSON.stringify(labels)}`);
    }
    await delay(700);
    const modelNav = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], a')).find(node => /Research models|研究模型/i.test(node.innerText || '') && node.getAttribute('data-mesh-main-models') === null); if (!el) return false; el.click(); return true })()`);
    if (!modelNav) {
      const labels = await evaluate(`Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], a')).map(node => (node.innerText || '').trim()).filter(Boolean).slice(-60)`);
      throw new Error(`model settings nav not found; entries=${JSON.stringify(labels)}`);
    }
    await waitFor(async () => evaluate('document.body.innerText.includes("group-a")'), 'model settings page');
    await shot('model-settings-1440.png');
    const saveClicked = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find(node => /保存模型配置|Save model settings/i.test((node.innerText || '').trim())); if (!el) return false; el.click(); return true })()`);
    if (!saveClicked) throw new Error('model settings save button not found');
    await delay(1200);
    const patchPath = join(home, 'profiles', 'mesh-ui', 'cordis.patch.yml');
    if (!existsSync(patchPath)) throw new Error('profile patch was not created');
    const profilePatch = readFileSync(patchPath, 'utf8');
    if (!profilePatch.includes('modelAssignments') || !profilePatch.includes('mock-flash')) {
      throw new Error('model assignments were not persisted through DSH settings');
    }
    // Browser reload and Host re-read must agree with the saved assignment.
    await send('Page.reload', { ignoreCache: false });
    await delay(2500);
    const persisted = await api(base, '/model-settings');
    if (persisted.document.groups['group-a']?.captain?.model !== 'mock-pro') {
      throw new Error('saved model assignment was not restored after reload');
    }
    await click('button[aria-label="Research Mesh"]');
    await delay(600);
    if (!(await evaluate('document.body.innerText.includes("3D Wave-TOF")'))) await click('.mesh-project');
    await delay(500);

    // Dark appearance: the shell default follows the system preference.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await send('Page.reload', { ignoreCache: false });
    await delay(3000);
    await click('button[aria-label="Research Mesh"]');
    await delay(700);
    await shot('projects-dark.png');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.reload', { ignoreCache: false });
    await delay(1500);

    console.log(JSON.stringify({
      ok: true,
      screenshots: ['projects-1440.png', 'workbench-1440.png', 'workbench-group-1440.png', 'captain-session-1440.png', 'member-session-1440.png', 'workbench-1280.png', 'workbench-768.png', 'workbench-390.png', 'model-settings-1440.png', 'model-settings-390.png', 'projects-dark.png'],
      projectId: created.projectId,
      teams: groups.length,
      tokenUsed: true,
    }, null, 2));
    ws.close();
  } finally {
    if (browser) browser.kill('SIGKILL');
    server.kill('SIGTERM');
    await delay(800);
    server.kill('SIGKILL');
    if (process.env.MESH_KEEP_TMP !== '1') rmSync(tmp, { recursive: true, force: true });
    else console.log('kept', tmp);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
