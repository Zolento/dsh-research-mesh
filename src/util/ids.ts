/**
 * Identifier minting and validation.
 *
 * Durable identifiers are never derived from process IDs: a restarted worker
 * must not inherit another process's identity. Task execution identity is the
 * attempt id, not the worker process.
 */

import { randomUUID } from 'node:crypto';
import { MeshError } from '../errors.ts';

/** Prefixes used by every durable Mesh identity. */
export const ID_PREFIX = {
  team: 'team',
  workspace: 'ws',
  subagent: 'sa',
  task: 'task',
  attempt: 'attempt',
  job: 'job',
  lease: 'lease',
  artifact: 'artifact',
  worker: 'worker',
  event: 'event',
  binding: 'bind',
  project: 'proj',
} as const;

/** A durable identifier prefix. */
export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/**
 * Mint a new opaque identifier.
 * @param prefix - stable kind prefix.
 * @returns `<prefix>_<uuid>`.
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Mint a worker identity for one runtime process.
 * @returns a fresh worker id.
 */
export function newWorkerId(): string {
  return newId(ID_PREFIX.worker);
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate a human-readable slug used in branches, directories and route ids.
 * @param value - candidate.
 * @param field - field name for the failure message.
 * @returns the unchanged value.
 */
export function requireSlug(value: string, field: string): string {
  if (!SAFE_NAME.test(value) || value === '.' || value === '..') {
    throw new MeshError('INVALID_ARGUMENT', `${field} must match ${SAFE_NAME.source}`, { field, value });
  }
  return value;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/**
 * Validate a caller- or system-supplied durable id.
 * @param value - candidate id.
 * @param field - field name for the failure message.
 * @returns the unchanged value.
 */
export function requireId(value: string, field: string): string {
  if (!ID_RE.test(value)) {
    throw new MeshError('INVALID_ARGUMENT', `${field} is not a valid durable id`, { field });
  }
  return value;
}

/**
 * Convert free text to a safe slug; used only for generated names, never to
 * rewrite a caller-supplied identifier.
 * @param text - source text.
 * @param fallback - used when no safe characters remain.
 * @returns a lower-case slug.
 */
export function slugify(text: string, fallback = 'group'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}
