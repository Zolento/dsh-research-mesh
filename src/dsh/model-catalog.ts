/**
 * Model catalog adapters.
 *
 * Host mode reads DSH's live `ctx.llm` registry. Tests use the deterministic
 * static catalog. Neither implementation touches credentials or API keys.
 */

import type { ModelCatalog, ModelCatalogEntry } from '../teams/models.ts';

/** Structural subset of DSH's LlmRuntime. */
export interface DshLlmLike {
  listProviders(): readonly { id: string; name: string }[];
  listModels(provider: string): Promise<readonly {
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly string[];
  }[]>;
}

/** Live DSH model catalog. */
export class DshModelCatalog implements ModelCatalog {
  readonly #llm: DshLlmLike;

  /**
   * @param llm - DSH LLM runtime service.
   */
  constructor(llm: DshLlmLike) {
    this.#llm = llm;
  }

  async list(): Promise<readonly ModelCatalogEntry[]> {
    const entries: ModelCatalogEntry[] = [];
    for (const provider of this.#llm.listProviders()) {
      try {
        const models = await this.#llm.listModels(provider.id);
        for (const model of models) {
          entries.push({
            provider: provider.id,
            providerName: provider.name,
            model: model.id,
            modelName: model.name,
          });
        }
      } catch {
        // A provider whose adapter cannot describe its models is omitted; the
        // UI must never offer an unverifiable pair.
      }
    }
    entries.sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
    return entries;
  }

  async has(provider: string, model: string): Promise<boolean> {
    try {
      const models = await this.#llm.listModels(provider);
      return models.some(candidate => candidate.id === model);
    } catch {
      return false;
    }
  }
}

/** Deterministic catalog for tests and offline UI fixtures. */
export class StaticModelCatalog implements ModelCatalog {
  readonly #entries: readonly ModelCatalogEntry[];

  /**
   * @param entries - provider/model pairs to expose.
   */
  constructor(entries: readonly ModelCatalogEntry[]) {
    this.#entries = [...entries];
  }

  async list(): Promise<readonly ModelCatalogEntry[]> {
    return this.#entries;
  }

  async has(provider: string, model: string): Promise<boolean> {
    return this.#entries.some(entry => entry.provider === provider && entry.model === model);
  }
}
