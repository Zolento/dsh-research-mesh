/**
 * Identity and time helpers.
 *
 * Identities are opaque strings so the bridge never has to guess what a DSH
 * branded id is. DSH ids (session ids, message ids) are adopted verbatim by the
 * adapter; bridge-owned ids carry a readable prefix so a log line is
 * self-explanatory.
 *
 * @module dsh-research-team-bridge/ids
 */

import { randomUUID, createHash } from 'node:crypto'

/** Injectable clock so tests can freeze time. */
export interface Clock {
  now(): Date
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => new Date(),
}

/** A clock that always returns the same instant. */
export function fixedClock(at: Date | string): Clock {
  const frozen = typeof at === 'string' ? new Date(at) : at
  return { now: () => new Date(frozen.getTime()) }
}

/** One monotonically increasing sequence per prefix, for readable ids. */
const counters = new Map<string, number>()

/** `prefix_<base36 time>_<seq>` — readable, sortable, unique inside a process. */
export function newId(prefix: string, clock: Clock = systemClock): string {
  const seq = (counters.get(prefix) ?? 0) + 1
  counters.set(prefix, seq)
  return `${prefix}_${clock.now().getTime().toString(36)}_${seq.toString(36)}`
}

/** Reset the per-process counters. Tests call this to keep ids deterministic. */
export function resetIdCounters(): void {
  counters.clear()
}

/** Random, collision-free id used where ordering does not matter. */
export function newUuid(): string {
  return randomUUID()
}

/** Deterministic idempotency key from the semantic content of an operation. */
export function idempotencyKey(parts: readonly (string | number | null | undefined)[]): string {
  const hash = createHash('sha256')
  // Length-framed, so a separator inside a part cannot make two different tuples
  // hash alike: `['a\0b']` and `['a', 'b']` used to produce the same key.
  for (const part of parts) {
    const text = part === null || part === undefined ? '' : String(part)
    hash.update(`${String(Buffer.byteLength(text))}:`).update(text)
  }
  return `ik_${hash.digest('hex').slice(0, 32)}`
}

/** Stable short hash of a JSON-serializable value, used to detect isomorphism. */
export function structuralHash(value: unknown): string {
  // `canonicalJson(undefined)` is `undefined`, and `hash.update(undefined)` throws a
  // TypeError. Hashing is used on caller-supplied content, so an absent value hashes
  // as null rather than crashing the caller.
  return createHash('sha256').update(canonicalJson(value ?? null)).digest('hex')
}

/**
 * Canonical JSON: object keys sorted, arrays kept in order. Two structurally
 * equivalent candidates must hash identically for stagnation detection.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const entry = source[key]
      if (entry === undefined) continue
      out[key] = normalize(entry)
    }
    return out
  }
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ')
  return value
}

/** ISO-8601 UTC. */
export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString()
}

/** Add milliseconds to an ISO timestamp. */
export function plusMs(timestamp: string, ms: number): string {
  return new Date(new Date(timestamp).getTime() + ms).toISOString()
}

/** True when `timestamp` is strictly before `reference`. */
export function isBefore(timestamp: string, reference: string): boolean {
  return new Date(timestamp).getTime() < new Date(reference).getTime()
}
