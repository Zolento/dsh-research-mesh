/**
 * DSH-native model settings persistence.
 *
 * The document lives in this plugin's volatile Config, so writes go through
 * `ctx.settings` into the active profile's `cordis.patch.yml`, validated by
 * schemastery, revision-fenced, and reloaded on the next boot. There is no
 * second database and no API key in this document.
 */

import { MeshError } from '../errors.ts';
import { validateModelDocument, type ModelSettingsDocument, type ModelSettingsStore } from './models.ts';

/** Structural subset of DSH's `SettingsForms` service. */
export interface SettingsFormsLike {
  describe(): readonly { ns: string; revision: number }[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}

/** Structural view of a schemastery volatile field. */
export interface VolatileLike<T> {
  get(): T;
}

/** Inputs for the config-backed store. */
export interface ConfigModelSettingsStoreOptions {
  readonly settings: SettingsFormsLike;
  readonly namespace: string;
  readonly ref: VolatileLike<unknown> | unknown;
}

/** Volatile-Config-backed model settings store. */
export class ConfigModelSettingsStore implements ModelSettingsStore {
  readonly #settings: SettingsFormsLike;
  readonly #namespace: string;
  readonly #ref: VolatileLike<unknown> | unknown;
  #cache: ModelSettingsDocument | null = null;

  /**
   * @param options - settings service, profile entry id and volatile ref.
   */
  constructor(options: ConfigModelSettingsStoreOptions) {
    this.#settings = options.settings;
    this.#namespace = options.namespace;
    this.#ref = options.ref;
  }

  read(): ModelSettingsDocument {
    const value = this.#unwrap();
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value as Record<string, unknown>).length === 0) {
      this.#cache = null;
      return { version: 1, groups: {} };
    }
    if (value !== undefined && value !== null) {
      const current = validateModelDocument(value);
      // Another DSH surface may have written a newer revision. Prefer the live
      // volatile value unless this store's just-written cache is still newer
      // than the not-yet-propagated ref.
      if (this.#cache === null || current.version >= this.#cache.version) this.#cache = current;
    }
    return this.#cache ?? { version: 1, groups: {} };
  }

  async write(document: ModelSettingsDocument): Promise<ModelSettingsDocument> {
    const validated = validateModelDocument(document);
    const next: ModelSettingsDocument = {
      version: Math.max(validated.version, this.read().version) + 1,
      groups: validated.groups,
    };
    await this.#update(next);
    this.#cache = next;
    return next;
  }

  async #update(document: ModelSettingsDocument): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const descriptor = this.#settings.describe().find(entry => entry.ns === this.#namespace);
      if (descriptor === undefined) {
        throw new MeshError('MODEL_CONFIG_INVALID', 'DSH settings does not serve the Research Mesh entry', {
          namespace: this.#namespace,
        });
      }
      try {
        await this.#settings.update(this.#namespace, { modelAssignments: document }, descriptor.revision);
        return;
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== 'SETTINGS_CONFLICT' || attempt > 0) {
          throw new MeshError('MODEL_CONFIG_INVALID', `DSH refused the model settings write: ${error instanceof Error ? error.message : String(error)}`, {
            namespace: this.#namespace,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  #unwrap(): unknown {
    const value = this.#ref;
    if (typeof value === 'object' && value !== null && 'get' in value && typeof (value as { get?: unknown }).get === 'function') {
      return (value as VolatileLike<unknown>).get();
    }
    return value;
  }
}
