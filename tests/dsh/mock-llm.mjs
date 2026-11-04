/** Minimal LLM registry used only by the real-loader integration test. */
export const name = 'mesh-test-mock-llm';
export function apply(ctx) {
  ctx.provide('llm', {
    listProviders: () => [{ id: 'mock', name: 'Mock Provider' }],
    listModels: async () => [
      { provider: 'mock', id: 'mock-flash', name: 'Mock Flash' },
      { provider: 'mock', id: 'mock-pro', name: 'Mock Pro' },
    ],
  });
}
