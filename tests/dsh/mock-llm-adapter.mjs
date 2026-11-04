/** Test-only DSH LLM adapter for local WebUI acceptance. Never used in production. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const INSTALL = process.env.DSH_INSTALL ?? '/home/lenovo/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh';
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
