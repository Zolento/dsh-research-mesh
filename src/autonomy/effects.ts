/**
 * Durable effects.
 *
 * A command enqueues its side effects in the same SQLite transaction that
 * changes the autonomy rows, then `tick()` runs them after commit. Failures are
 * retried with bounded exponential backoff. A `reconcile-only` effect is never
 * re-executed: it represents an external operation whose outcome is unknown, so
 * a failure parks it for explicit reconciliation instead of risking a duplicate
 * remote experiment.
 */

import { randomUUID } from 'node:crypto';
import { MeshError } from '../errors.ts';
import { isoFromMs, nowIso } from '../util/time.ts';
import type { EffectRecord, EffectStatus } from './types.ts';
import type { AutonomyStore } from './store.ts';

/** What an effect handler may return. */
export type EffectOutcome = 'done' | 'defer';

/** One registered handler. */
export interface EffectHandler {
  /**
   * Perform the effect.
   * @param payload - JSON payload recorded with the row.
   * @param record - the durable row.
   * @returns `defer` to retry later without counting an attempt.
   */
  run(payload: Readonly<Record<string, unknown>>, record: EffectRecord): Promise<EffectOutcome>;
  /**
   * `reconcile-only` handlers are never retried after an error; the row parks as
   * `failed` so an operator can reconcile the external state first.
   */
  readonly retry: 'safe' | 'reconcile-only';
}

/** Options for the runner. */
export interface EffectsOptions {
  /** Clock override for tests. */
  readonly now?: () => number;
  /** Initial retry delay. */
  readonly baseDelayMs?: number;
  /** Maximum retry delay. */
  readonly maxDelayMs?: number;
  /** Attempts before a row is declared dead. */
  readonly maxAttempts?: number;
  /** Identity recorded on a claim; defaults to a per-process id. */
  readonly owner?: string;
  /** Claim lease before a crashed owner is recovered. */
  readonly leaseMs?: number;
}

/** One tick report. */
export interface EffectsTickReport {
  readonly processed: number;
  readonly done: number;
  readonly deferred: number;
  readonly failed: number;
  readonly dead: number;
  /** Stale running claims recovered before this tick. */
  readonly recovered: number;
}

/** Result of one recovery scan. */
export interface EffectsRecoveryReport {
  readonly replayed: number;
  readonly parked: number;
}

function errorText(error: unknown): string {
  if (error instanceof MeshError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Durable queue runner over `mesh_effects`. */
export class EffectsRunner {
  readonly #store: AutonomyStore;
  readonly #handlers = new Map<string, EffectHandler>();
  readonly #now: () => number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxAttempts: number;
  readonly #owner: string;
  readonly #leaseMs: number;

  /**
   * @param store - autonomy store (owns the transaction boundary).
   * @param options - clock, backoff and attempt bounds.
   */
  constructor(store: AutonomyStore, options: EffectsOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#baseDelayMs = options.baseDelayMs ?? 2_000;
    this.#maxDelayMs = options.maxDelayMs ?? 300_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#owner = options.owner ?? `eff-worker-${randomUUID()}`;
    this.#leaseMs = options.leaseMs ?? 5 * 60_000;
  }

  /** Claim owner recorded on running rows. */
  get owner(): string {
    return this.#owner;
  }

  /**
   * Recover effects whose owner lease expired. A safe kind is replayed; an
   * external side effect whose outcome is unknown is parked for reconciliation.
   * @returns counts by recovery decision.
   */
  recover(): EffectsRecoveryReport {
    const now = nowIso();
    let replayed = 0;
    let parked = 0;
    for (const row of this.#store.staleClaims(now)) {
      const handler = this.#handlers.get(row.kind);
      if (handler === undefined || handler.retry === 'safe') {
        if (this.#store.recoverClaim(row.effectId, 'pending', {
          error: 'claim lease expired; replaying a safe effect',
          nextRunAt: now,
          at: now,
        })) replayed += 1;
      } else {
        if (this.#store.recoverClaim(row.effectId, 'failed', {
          error: 'RECONCILE_REQUIRED: owner died while an external effect was in flight',
          at: now,
        })) parked += 1;
      }
    }
    return { replayed, parked };
  }

  /**
   * Register the only handler for one kind.
   * @param kind - effect kind.
   * @param handler - invocation.
   */
  register(kind: string, handler: EffectHandler): void {
    if (this.#handlers.has(kind)) throw new MeshError('INVALID_ARGUMENT', `effect kind ${kind} is already handled`);
    this.#handlers.set(kind, handler);
  }

  /** Registered kinds. */
  kinds(): readonly string[] {
    return [...this.#handlers.keys()];
  }

  /**
   * Enqueue an effect unless the same (kind, dedupeKey) already exists.
   * @param kind - effect kind.
   * @param dedupeKey - stable idempotency key.
   * @param payload - JSON-safe payload.
   * @param maxAttempts - per-row override.
   * @returns true when a new row was written.
   */
  enqueue(kind: string, dedupeKey: string, payload: Readonly<Record<string, unknown>>, maxAttempts?: number): boolean {
    if (!this.#handlers.has(kind)) {
      throw new MeshError('INVALID_ARGUMENT', `no handler is registered for effect kind ${kind}`, { kind });
    }
    const at = nowIso();
    return this.#store.insertEffect({
      effectId: `eff_${crypto.randomUUID()}`,
      kind,
      dedupeKey,
      payloadJson: JSON.stringify(payload),
      status: 'pending',
      attempts: 0,
      maxAttempts: maxAttempts ?? this.#maxAttempts,
      nextRunAt: at,
      lastError: null,
      owner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  /** Whether a matching row still waits. */
  pending(kind?: string, dedupeKey?: string): boolean {
    return this.#store.listEffects('pending').some(row =>
      (kind === undefined || row.kind === kind) && (dedupeKey === undefined || row.dedupeKey === dedupeKey));
  }

  /**
   * Run every due effect once.
   * @param limit - maximum rows in this tick.
   * @returns counts by outcome.
   */
  async tick(limit = 20): Promise<EffectsTickReport> {
    const recovery = this.recover();
    const due = this.#store.listDueEffects(isoFromMs(this.#now()), limit);
    let done = 0;
    let deferred = 0;
    let failed = 0;
    let dead = 0;
    for (const row of due) {
      if (!this.#store.claimEffect(row.effectId, this.#owner, this.#leaseMs, nowIso())) continue;
      const handler = this.#handlers.get(row.kind);
      if (handler === undefined) {
        this.#store.finishEffect(row.effectId, 'dead', { error: `no handler for ${row.kind}` });
        dead += 1;
        continue;
      }
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.payloadJson);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        this.#store.finishEffect(row.effectId, 'dead', { error: 'payload is not JSON' });
        dead += 1;
        continue;
      }
      // Keep the claim alive while a slow handler runs; if renewal fails the
      // claim was recovered by another worker and this task must not write back.
      const renewal = setInterval(() => {
        this.#store.renewClaim(row.effectId, this.#owner, this.#leaseMs);
      }, Math.max(1_000, Math.floor(this.#leaseMs / 2)));
      renewal.unref?.();
      try {
        const outcome = await handler.run(payload, row);
        if (outcome === 'defer') {
          this.#store.finishEffect(row.effectId, 'pending', {
            nextRunAt: isoFromMs(this.#now() + this.#baseDelayMs),
            attempts: row.attempts,
            owner: this.#owner,
          });
          deferred += 1;
          continue;
        }
        this.#store.finishEffect(row.effectId, 'succeeded', { attempts: row.attempts + 1, owner: this.#owner });
        done += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = errorText(error);
        if (handler.retry === 'reconcile-only') {
          this.#store.finishEffect(row.effectId, 'failed', {
            attempts, error: `${message}; reconcile before retry`, owner: this.#owner,
          });
          failed += 1;
          continue;
        }
        if (attempts >= row.maxAttempts) {
          this.#store.finishEffect(row.effectId, 'dead', { attempts, error: message, owner: this.#owner });
          dead += 1;
          continue;
        }
        const delay = Math.min(this.#baseDelayMs * 2 ** (attempts - 1), this.#maxDelayMs);
        this.#store.finishEffect(row.effectId, 'pending', {
          attempts, error: message, nextRunAt: isoFromMs(this.#now() + delay), owner: this.#owner,
        });
        failed += 1;
      } finally {
        clearInterval(renewal);
      }
    }
    return { processed: due.length, done, deferred, failed, dead, recovered: recovery.replayed + recovery.parked };
  }

  /** All rows, for diagnostics and the Workbench. */
  list(status?: EffectStatus): readonly EffectRecord[] {
    return this.#store.listEffects(status);
  }
}
