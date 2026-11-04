/**
 * Manual model assignment for groups, captains and subagents.
 *
 * No automatic model selection, stage routing, cost optimisation or fallback
 * exists here. A call either resolves one exact provider/model that the user
 * configured (or an explicitly configured group default), or fails with a
 * configuration error.
 */

import { MeshError } from '../errors.ts';

/** One provider/model pair chosen by a user. */
export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
}

/** Where a resolved model came from. */
export type ModelSource = 'group-default' | 'captain-override' | 'subagent-override' | 'plugin-config' | 'caller';

/** A resolved model plus its provenance for auditability. */
export interface ResolvedModel extends ModelChoice {
  readonly source: ModelSource;
  readonly configVersion: string;
}

/** Per-group model document. Subagent keys are stable slot/agent names. */
export interface GroupModelAssignment {
  readonly default?: ModelChoice;
  readonly captain?: ModelChoice | 'inherit';
  readonly subagents?: Readonly<Record<string, ModelChoice | 'inherit'>>;
}

/** The whole saved settings document. */
export interface ModelSettingsDocument {
  readonly version: number;
  readonly groups: Readonly<Record<string, GroupModelAssignment>>;
}

/** Live provider/model catalog seam. */
export interface ModelCatalogEntry {
  readonly provider: string;
  readonly providerName: string;
  readonly model: string;
  readonly modelName: string;
}

/** Read-only catalog; implementations must not expose API keys. */
export interface ModelCatalog {
  /**
   * List every registered provider/model pair.
   * @returns catalog entries.
   */
  list(): Promise<readonly ModelCatalogEntry[]>;
  /**
   * Return whether an exact provider/model pair is currently registered.
   * @param provider - provider id.
   * @param model - model id.
   * @returns true only for an exact live pair.
   */
  has(provider: string, model: string): Promise<boolean>;
}

/** Persistent model-document seam. */
export interface ModelSettingsStore {
  /**
   * Read the saved document.
   * @returns current document.
   */
  read(): ModelSettingsDocument;
  /**
   * Replace the saved document after validation.
   * @param document - complete new document.
   * @returns the stored document and its version.
   */
  write(document: ModelSettingsDocument): ModelSettingsDocument | Promise<ModelSettingsDocument>;
}

/** In-memory store used by tests and as a safe default before settings mount. */
export class MemoryModelSettingsStore implements ModelSettingsStore {
  #document: ModelSettingsDocument;

  /**
   * @param document - initial document.
   */
  constructor(document: ModelSettingsDocument = { version: 1, groups: {} }) {
    this.#document = document;
  }

  read(): ModelSettingsDocument {
    return this.#document;
  }

  write(document: ModelSettingsDocument): ModelSettingsDocument {
    const next: ModelSettingsDocument = {
      version: Math.max(document.version, this.#document.version) + 1,
      groups: document.groups,
    };
    this.#document = next;
    return next;
  }
}

/** Validate a settings document shape without touching the catalog. */
export function validateModelDocument(value: unknown): ModelSettingsDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MeshError('MODEL_CONFIG_INVALID', 'model settings must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1) {
    throw new MeshError('MODEL_CONFIG_INVALID', 'model settings version must be a positive integer');
  }
  if (typeof record.groups !== 'object' || record.groups === null || Array.isArray(record.groups)) {
    throw new MeshError('MODEL_CONFIG_INVALID', 'model settings groups must be an object');
  }
  const groups: Record<string, GroupModelAssignment> = {};
  for (const [group, raw] of Object.entries(record.groups as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group)) {
      throw new MeshError('MODEL_CONFIG_INVALID', `invalid group key: ${group}`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new MeshError('MODEL_CONFIG_INVALID', `group ${group} settings must be an object`);
    }
    const groupRecord = raw as Record<string, unknown>;
    const assignment: {
      default?: ModelChoice;
      captain?: ModelChoice | 'inherit';
      subagents?: Record<string, ModelChoice | 'inherit'>;
    } = {};
    if (groupRecord.default !== undefined && groupRecord.default !== null) {
      assignment.default = validateChoice(groupRecord.default, `groups.${group}.default`);
    }
    if (groupRecord.captain !== undefined) {
      assignment.captain = groupRecord.captain === 'inherit'
        ? 'inherit'
        : validateChoice(groupRecord.captain, `groups.${group}.captain`);
    }
    if (groupRecord.subagents !== undefined) {
      if (typeof groupRecord.subagents !== 'object' || groupRecord.subagents === null || Array.isArray(groupRecord.subagents)) {
        throw new MeshError('MODEL_CONFIG_INVALID', `groups.${group}.subagents must be an object`);
      }
      const subagents: Record<string, ModelChoice | 'inherit'> = {};
      for (const [slot, choice] of Object.entries(groupRecord.subagents as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(slot)) {
          throw new MeshError('MODEL_CONFIG_INVALID', `invalid subagent slot: ${group}/${slot}`);
        }
        subagents[slot] = choice === 'inherit'
          ? 'inherit'
          : validateChoice(choice, `groups.${group}.subagents.${slot}`);
      }
      assignment.subagents = subagents;
    }
    groups[group] = assignment;
  }
  return { version: record.version, groups };
}

function validateChoice(value: unknown, field: string): ModelChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MeshError('MODEL_CONFIG_INVALID', `${field} must be a provider/model object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== 'string' || record.provider.trim() === '') {
    throw new MeshError('MODEL_CONFIG_INVALID', `${field}.provider must be a non-empty string`);
  }
  if (typeof record.model !== 'string' || record.model.trim() === '') {
    throw new MeshError('MODEL_CONFIG_INVALID', `${field}.model must be a non-empty string`);
  }
  return { provider: record.provider.trim(), model: record.model.trim() };
}

/** Resolve manual model choices against the live catalog. */
export class ModelResolver {
  readonly #store: ModelSettingsStore;
  readonly #catalog: ModelCatalog;
  readonly #fallback: ModelChoice | undefined;
  readonly #version: string;

  /**
   * @param store - persisted settings document.
   * @param catalog - live provider/model catalog.
   * @param fallback - explicit plugin config default, if any.
   * @param version - config document version label.
   */
  constructor(store: ModelSettingsStore, catalog: ModelCatalog, fallback: ModelChoice | undefined, version = 'settings-v1') {
    this.#store = store;
    this.#catalog = catalog;
    this.#fallback = fallback;
    this.#version = version;
  }

  /** Current settings document. */
  get document(): ModelSettingsDocument {
    return this.#store.read();
  }

  /** Live catalog snapshot without secrets. */
  async listCatalog(): Promise<readonly ModelCatalogEntry[]> {
    return this.#catalog.list();
  }

  /**
   * Resolve the captain model for a group.
   * @param groupName - group slug.
   * @returns resolved model.
   */
  async resolveCaptain(groupName: string): Promise<ResolvedModel> {
    const group = this.#store.read().groups[groupName];
    if (group?.captain !== undefined && group.captain !== 'inherit') {
      return this.#validate(group.captain, 'captain-override', groupName);
    }
    return this.#resolveGroupDefault(groupName);
  }

  /**
   * Resolve a subagent model by its stable slot/agent name.
   * @param groupName - group slug.
   * @param slot - subagent name or slot.
   * @returns resolved model.
   */
  async resolveSubagent(groupName: string, slot: string, ordinal?: number): Promise<ResolvedModel> {
    const group = this.#store.read().groups[groupName];
    const choice = group?.subagents?.[slot]
      ?? (ordinal === undefined ? undefined : group?.subagents?.[`subagent-${ordinal}`]);
    if (choice !== undefined && choice !== 'inherit') {
      return this.#validate(choice, 'subagent-override', groupName);
    }
    return this.#resolveGroupDefault(groupName);
  }

  /**
   * Validate and save a complete settings document.
   * @param value - candidate document.
   * @returns saved document.
   */
  async save(value: unknown): Promise<ModelSettingsDocument> {
    const document = validateModelDocument(value);
    for (const [groupName, group] of Object.entries(document.groups)) {
      if (group.default === undefined) {
        const hasOverride = (group.captain !== undefined && group.captain !== 'inherit')
          || Object.values(group.subagents ?? {}).some(choice => choice !== 'inherit');
        if (hasOverride) {
          throw new MeshError('MODEL_CONFIG_INVALID', `group ${groupName} has overrides but no default provider/model`, {
            groupName,
            configVersion: this.#version,
          });
        }
        // An untouched group is intentionally empty; it still falls back to the
        // plugin-level agent route until the user assigns a default.
        continue;
      }
      await this.#assertLive(group.default, `groups.${groupName}.default`);
      if (group.captain !== undefined && group.captain !== 'inherit') {
        this.#assertLive(group.captain, `groups.${groupName}.captain`);
      }
      for (const [slot, choice] of Object.entries(group.subagents ?? {})) {
        if (choice !== 'inherit') await this.#assertLive(choice, `groups.${groupName}.subagents.${slot}`);
      }
    }
    return await this.#store.write(document);
  }

  async #resolveGroupDefault(groupName: string): Promise<ResolvedModel> {
    const group = this.#store.read().groups[groupName];
    if (group?.default !== undefined) return this.#validate(group.default, 'group-default', groupName);
    if (this.#fallback !== undefined) {
      await this.#assertLive(this.#fallback, 'plugin.agent');
      return { ...this.#fallback, source: 'plugin-config', configVersion: this.#version };
    }
    throw new MeshError('MODEL_CONFIG_INVALID', `group ${groupName} has no default provider/model and no override`, {
      groupName,
      configVersion: this.#version,
    });
  }

  async #validate(choice: ModelChoice, source: ModelSource, groupName: string): Promise<ResolvedModel> {
    await this.#assertLive(choice, `groups.${groupName}`);
    return { provider: choice.provider, model: choice.model, source, configVersion: this.#version };
  }

  async #assertLive(choice: ModelChoice, field: string): Promise<void> {
    if (!(await this.#catalog.has(choice.provider, choice.model))) {
      throw new MeshError('MODEL_CONFIG_INVALID', 'configured provider/model is not registered in the live catalog', {
        field,
        provider: choice.provider,
        model: choice.model,
        configVersion: this.#version,
      });
    }
  }
}
