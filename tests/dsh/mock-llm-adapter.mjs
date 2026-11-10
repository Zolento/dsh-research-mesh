/** Test-only DSH LLM adapter for local WebUI acceptance. Never used in production. */
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve against the DSH that is actually running: the adapter is loaded by
// that process, and a hardcoded install path goes stale on every Node upgrade.
function runningInstall() {
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL;
  const marker = '/node_modules/@deepseek-ai/dsh/';
  const fromPath = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return null;
    const at = candidate.indexOf(marker);
    return at === -1 ? null : candidate.slice(0, at + '/node_modules/@deepseek-ai/dsh'.length);
  };
  const direct = fromPath(process.argv[1] ?? '');
  if (direct !== null) return direct;
  // The `dsh` launcher on PATH is usually a symlink into the same package.
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    for (const name of ['dsh', 'dsh.cmd']) {
      try {
        const resolved = realpathSync(join(dir, name));
        const found = fromPath(resolved);
        if (found !== null) return found;
      } catch { /* not on this PATH entry */ }
    }
  }
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json').replace(/[/\\]package\.json$/, '');
  } catch {
    throw new Error('cannot locate the running DSH install; set DSH_INSTALL');
  }
}

const INSTALL = runningInstall();
const requireFromInstall = createRequire(`${INSTALL}/package.json`);
const llmEntry = requireFromInstall.resolve('@deepseek-ai/dsh-llm');
const { LlmAdapter } = await import(pathToFileURL(llmEntry).href);

class MockAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'Mock Provider' };
  }

  async listModels(provider) {
    return [
      { provider, id: 'mock-flash', name: 'Mock Flash', description: 'Local UI fixture' },
      { provider, id: 'mock-pro', name: 'Mock Pro', description: 'Local UI fixture' },
    ];
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }

  async *stream() {
    throw new Error('mock adapter is for UI fixtures and does not call a model');
  }
}

export const name = 'mesh-test-mock-llm-adapter';
export const inject = ['llm'];

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new MockAdapter()), 'mesh test mock llm adapter');
}
