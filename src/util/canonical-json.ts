/**
 * Deterministic JSON serialization used for content binding and digests.
 *
 * Object keys are sorted recursively; `undefined` object members are omitted;
 * arrays keep order. Non-finite numbers, bigint, functions and symbols are
 * rejected so a digest can never silently cover a different value than the one
 * persisted.
 */

import { MeshError } from '../errors.ts';

/** JSON-safe primitive. */
export type CanonicalPrimitive = string | number | boolean | null;

/** JSON-safe value accepted by canonical serialization. */
export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/**
 * Serialize a value with recursively sorted object keys and no whitespace.
 * @param value - JSON-safe value.
 * @returns canonical JSON text.
 */
export function canonicalJson(value: CanonicalValue): string {
  return serialize(value, new Set());
}

function serialize(value: CanonicalValue | undefined, seen: Set<object>): string {
  if (value === undefined) throw new MeshError('INVALID_ARGUMENT', 'canonical JSON cannot encode undefined');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new MeshError('INVALID_ARGUMENT', 'canonical JSON cannot encode a non-finite number');
      }
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new MeshError('INVALID_ARGUMENT', 'canonical JSON cannot encode a cycle');
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map(item => serialize(item, seen)).join(',')}]`;
        }
        const record = value as Readonly<Record<string, CanonicalValue | undefined>>;
        const keys = Object.keys(record).sort();
        const members: string[] = [];
        for (const key of keys) {
          const member = record[key];
          if (member === undefined) continue;
          members.push(`${JSON.stringify(key)}:${serialize(member, seen)}`);
        }
        return `{${members.join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new MeshError('INVALID_ARGUMENT', `canonical JSON cannot encode ${typeof value}`);
  }
}

/**
 * Parse JSON text and require an object root.
 * @param text - JSON text.
 * @param field - label used in the failure.
 * @returns the parsed object.
 */
export function parseJsonObject(text: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MeshError('INVALID_ARGUMENT', `${field} is not valid JSON`, {
      field,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MeshError('INVALID_ARGUMENT', `${field} must contain a JSON object`, { field });
  }
  return parsed as Record<string, unknown>;
}
