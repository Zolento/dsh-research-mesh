/** Browserless contract test for the served client bundle. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const bundlePath = join(import.meta.dirname, '..', '..', 'client', 'client.js');
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { name: string };

function reactStub() {
  return {
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      return { type, props: props ?? {}, children };
    },
    useState(initial: unknown) {
      const value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, () => {}];
    },
    useEffect() {},
    useMemo(factory: () => unknown) { return factory(); },
    useCallback(fn: unknown) { return fn; },
    useRef(initial: unknown) { return { current: initial }; },
  };
}

function loadBundle() {
  const source = readFileSync(bundlePath, 'utf8');
  let handoff: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> } | undefined;
  const window = { __ModuleLoader__: { load: (spec: typeof handoff) => { handoff = spec; } } };
  new Function('window', 'require', 'module', 'exports', source)(window, () => {}, { exports: {} }, {});
  assert.ok(handoff !== undefined, 'bundle must register through window.__ModuleLoader__.load');
  return { source, handoff, react: reactStub() };
}

test('bundle registers under the package name and exposes the Cordis client plugin', () => {
  const { handoff, source } = loadBundle();
  assert.equal(handoff?.id, pkg.name);
  const module = handoff?.factory(name => {
    if (name === 'react') return reactStub();
    throw new Error(`unexpected external: ${name}`);
  });
  assert.ok(Array.isArray(module?.inject));
  assert.ok(module?.inject.includes('slots'));
  assert.ok(module?.inject.includes('uiWorkspace'));
  assert.equal(typeof module?.apply, 'function');
  assert.ok(source.includes('dsh-research-mesh'));
});

test('apply registers the main panel, sidebar entry, settings page and session header entry', () => {
  const { handoff, react } = loadBundle();
  const module = handoff?.factory(name => {
    if (name === 'react') return react;
    throw new Error(`unexpected external: ${name}`);
  }) as {
    apply(ctx: unknown): void;
  };
  const registrations: { name: string; options: Record<string, unknown>; component: unknown }[] = [];
  const provided: Record<string, unknown> = {};
  const selected: unknown[] = [];
  const effects: (() => void)[] = [];
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject(_name: string, callback: () => unknown) {
        const result = callback();
        if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* dispose handles are irrelevant here */ }
        }
      },
      register(options: Record<string, unknown>, component: unknown) {
        registrations.push({ name: String(options.name), options, component });
        return () => {};
      },
    },
    layout: { selectPanel: (id: unknown) => { selected.push(id); } },
    uiWorkspace: { openSession: () => {}, startSession: () => {} },
    effect(body: () => unknown) { const disposer = body(); if (typeof disposer === 'function') effects.push(disposer as () => void); },
    provide(name: string, value: unknown) { provided[name] = value; },
  };
  module.apply(ctx);
  assert.deepEqual(registrations.map(entry => entry.name).sort(), [
    'conversation.hero.options',
    'conversation.session.header.actions',
    'main',
    'settings.section',
    'sidebar.panellist',
  ]);
  const main = registrations.find(entry => entry.name === 'main');
  assert.equal(main?.options.key, 'research-mesh');
  const sidebar = registrations.find(entry => entry.name === 'sidebar.panellist');
  assert.equal(sidebar?.options.id, 'research-mesh');
  const settings = registrations.find(entry => entry.name === 'settings.section');
  assert.equal(settings?.options.id, 'research-mesh-models');
  const header = registrations.find(entry => entry.name === 'conversation.session.header.actions');
  assert.equal(header?.options.id, 'research-mesh-project');
  assert.ok(provided.researchMeshNavigation !== undefined);
  assert.equal(effects.length, 1, 'dictionary registration is one effect');
});

test('projects and settings components render a stable initial tree without a browser', () => {
  const { handoff, react } = loadBundle();
  const module = handoff?.factory(name => {
    if (name === 'react') return react;
    throw new Error(`unexpected external: ${name}`);
  }) as {
    ProjectsPage: (props: unknown) => unknown;
    ModelSettingsPage: (props: unknown) => unknown;
    ResearchMeshPage: (props: unknown) => unknown;
  };
  const ctx = { layout: { selectPanel: () => {} }, uiWorkspace: { openSession: () => {} } };
  const t = (key: string) => key;
  const projects = module.ProjectsPage({ ctx, t, onOpen: () => {} });
  assert.notEqual(projects, null);
  const settings = module.ModelSettingsPage({ ctx, t });
  assert.notEqual(settings, null);
  const page = module.ResearchMeshPage({ ctx, t });
  assert.notEqual(page, null);
});
