/**
 * Durable model-assignment document.
 *
 * DSH's Settings Service generates forms from a plugin's Config schema; it does
 * not own arbitrary per-group runtime documents. This store uses the same
 * Harness-home convention as `dsh-loop` and `dsh-api-pool`: one plugin-owned,
 * atomically rewritten JSON document under `$DSH_HOME/dsh-research-mesh/`.
 * It is not a second database, and it never stores credentials.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { MeshError } from '../errors.ts';
import { atomicWriteText } from '../util/fs-safe.ts';
import {
  validateModelDocument,
  type ModelSettingsDocument,
  type ModelSettingsStore,
} from './models.ts';

/** File-backed model settings store. */
export class FileModelSettingsStore implements ModelSettingsStore {
  readonly path: string;

  /**
   * @param path - absolute JSON document path.
   */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Read the saved document, or a stable empty document when absent.
   * @returns parsed document.
   */
  read(): ModelSettingsDocument {
    if (!existsSync(this.path)) return { version: 1, groups: {} };
    const stat = statSync(this.path);
    if (!stat.isFile()) throw new MeshError('MODEL_CONFIG_INVALID', 'model settings path is not a file', { path: this.path });
    if (stat.size > 4 * 1024 * 1024) throw new MeshError('MODEL_CONFIG_INVALID', 'model settings document is too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new MeshError('MODEL_CONFIG_INVALID', 'model settings document is not valid JSON', {
        path: this.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return validateModelDocument(parsed);
  }

  /**
   * Persist a validated document atomically, bumping its version.
   * @param document - validated document.
   * @returns the stored document.
   */
  write(document: ModelSettingsDocument): ModelSettingsDocument {
    const validated = validateModelDocument(document);
    const next: ModelSettingsDocument = {
      version: Math.max(validated.version, this.read().version) + 1,
      groups: validated.groups,
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    atomicWriteText(this.path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
