/**
 * SQLite persistence for autonomy objects.
 *
 * All rows live in the same database and connection as the bridge domain, so a
 * Ticket, its Mandate, its Assignment and its queued Effects commit together.
 * The tables are additive: Mesh execution tables and bridge research tables keep
 * their existing owners.
 */

import type { DatabaseSync } from 'node:sqlite';
import { MeshError } from '../errors.ts';
import type { SqliteTeamStore } from '../bridge/runtime/persistence.ts';
import { nowIso } from '../util/time.ts';
import type {
  AssignmentRecord,
  AssignmentStatus,
  EffectRecord,
  EffectStatus,
  MandateRecord,
  SubscriptionMode,
  SubscriptionRecord,
  TicketEndReason,
  TicketRecord,
  TicketStatus,
  TriggerDisposition,
  TriggerKind,
  TriggerRecord,
  TriggerSource,
} from './types.ts';

/** Table DDL for the autonomy layer. */
export const AUTONOMY_DDL = `
CREATE TABLE IF NOT EXISTS mesh_triggers (
  trigger_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  actor TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  disposition TEXT NOT NULL,
  ticket_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_triggers_project ON mesh_triggers(project_id, received_at);
CREATE INDEX IF NOT EXISTS idx_mesh_triggers_thread ON mesh_triggers(thread_key);

CREATE TABLE IF NOT EXISTS mesh_mandates (
  mandate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  source TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  resource_ceiling_json TEXT NOT NULL,
  rlp_scope TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL DEFAULT '',
  autonomous INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS mesh_tickets (
  ticket_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'engineering',
  outcome_ref TEXT,
  experiment_id TEXT,
  mandate_id TEXT NOT NULL REFERENCES mesh_mandates(mandate_id),
  group_id TEXT,
  priority INTEGER NOT NULL,
  autonomous INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL,
  waiting_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_tickets_project ON mesh_tickets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_mesh_tickets_mandate ON mesh_tickets(mandate_id);

CREATE TABLE IF NOT EXISTS mesh_assignments (
  assignment_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES mesh_tickets(ticket_id),
  team_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  task_id TEXT,
  job_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_assignments_ticket ON mesh_assignments(ticket_id, attempt);

CREATE TABLE IF NOT EXISTS mesh_subscriptions (
  ticket_id TEXT NOT NULL REFERENCES mesh_tickets(ticket_id),
  thread_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, thread_key)
);
CREATE INDEX IF NOT EXISTS idx_mesh_subscriptions_thread ON mesh_subscriptions(thread_key);

CREATE TABLE IF NOT EXISTS mesh_effects (
  effect_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  last_error TEXT,
  owner TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_mesh_effects_due ON mesh_effects(status, next_run_at);

CREATE TABLE IF NOT EXISTS mesh_policy (
  policy_id TEXT PRIMARY KEY CHECK (policy_id = 'current'),
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_threads (
  thread_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_threads_project ON mesh_threads(project_id);

CREATE TABLE IF NOT EXISTS mesh_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mesh_assignments_job
  ON mesh_assignments(job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mesh_assignment_active
  ON mesh_assignments(ticket_id) WHERE status IN ('pending', 'running');
`;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string { return String(row[key]); }
function nullableStr(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}
function num(row: Row, key: string): number { return Number(row[key]); }

function triggerFrom(row: Row): TriggerRecord {
  return {
    triggerId: str(row, 'trigger_id'),
    source: str(row, 'source') as TriggerSource,
    eventId: str(row, 'event_id'),
    projectId: str(row, 'project_id'),
    kind: str(row, 'kind') as TriggerKind,
    dedupeKey: str(row, 'dedupe_key'),
    payloadJson: str(row, 'payload_json'),
    payloadDigest: str(row, 'payload_digest'),
    threadKey: str(row, 'thread_key'),
    actor: nullableStr(row, 'actor'),
    occurredAt: str(row, 'occurred_at'),
    receivedAt: str(row, 'received_at'),
    disposition: str(row, 'disposition') as TriggerDisposition,
    ticketId: nullableStr(row, 'ticket_id'),
  };
}

function mandateFrom(row: Row): MandateRecord {
  return {
    mandateId: str(row, 'mandate_id'),
    projectId: str(row, 'project_id'),
    routeId: str(row, 'route_id'),
    issuer: str(row, 'issuer'),
    source: str(row, 'source') as TriggerSource,
    triggerId: str(row, 'trigger_id'),
    scopeJson: str(row, 'scope_json'),
    operationsJson: str(row, 'operations_json'),
    resourceCeilingJson: str(row, 'resource_ceiling_json'),
    rlpScope: str(row, 'rlp_scope'),
    policyVersion: str(row, 'policy_version'),
    policyDigest: str(row, 'policy_digest'),
    autonomous: num(row, 'autonomous') === 1,
    createdAt: str(row, 'created_at'),
    revokedAt: nullableStr(row, 'revoked_at'),
    revokeReason: nullableStr(row, 'revoke_reason'),
  };
}

function ticketFrom(row: Row): TicketRecord {
  return {
    ticketId: str(row, 'ticket_id'),
    projectId: str(row, 'project_id'),
    routeId: str(row, 'route_id'),
    title: str(row, 'title'),
    objective: str(row, 'objective'),
    status: str(row, 'status') as TicketStatus,
    kind: (str(row, 'kind') === 'research' ? 'research' : 'engineering'),
    outcomeRef: nullableStr(row, 'outcome_ref'),
    experimentId: nullableStr(row, 'experiment_id'),
    mandateId: str(row, 'mandate_id'),
    groupId: nullableStr(row, 'group_id'),
    priority: num(row, 'priority'),
    autonomous: num(row, 'autonomous') === 1,
    idempotencyKey: str(row, 'idempotency_key'),
    scopeJson: str(row, 'scope_json'),
    waitingReason: nullableStr(row, 'waiting_reason'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
    endedAt: nullableStr(row, 'ended_at'),
    endReason: nullableStr(row, 'end_reason') as TicketEndReason | null,
  };
}

function assignmentFrom(row: Row): AssignmentRecord {
  return {
    assignmentId: str(row, 'assignment_id'),
    ticketId: str(row, 'ticket_id'),
    teamId: str(row, 'team_id'),
    status: str(row, 'status') as AssignmentStatus,
    attempt: num(row, 'attempt'),
    taskId: nullableStr(row, 'task_id'),
    jobId: nullableStr(row, 'job_id'),
    sessionId: nullableStr(row, 'session_id'),
    createdAt: str(row, 'created_at'),
    startedAt: nullableStr(row, 'started_at'),
    endedAt: nullableStr(row, 'ended_at'),
    errorCode: nullableStr(row, 'error_code'),
    errorMessage: nullableStr(row, 'error_message'),
  };
}

function effectFrom(row: Row): EffectRecord {
  return {
    effectId: str(row, 'effect_id'),
    kind: str(row, 'kind'),
    dedupeKey: str(row, 'dedupe_key'),
    payloadJson: str(row, 'payload_json'),
    status: str(row, 'status') as EffectStatus,
    attempts: num(row, 'attempts'),
    maxAttempts: num(row, 'max_attempts'),
    nextRunAt: str(row, 'next_run_at'),
    lastError: nullableStr(row, 'last_error'),
    owner: nullableStr(row, 'owner'),
    claimedAt: nullableStr(row, 'claimed_at'),
    leaseExpiresAt: nullableStr(row, 'lease_expires_at'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

/** CRUD facade for the autonomy tables. */
export class AutonomyStore {
  readonly #store: SqliteTeamStore;

  /**
   * @param store - integrated bridge store (owns the SQLite connection).
   */
  constructor(store: SqliteTeamStore) {
    this.#store = store;
    this.#store.transaction(db => {
      db.exec(AUTONOMY_DDL);
      this.#migrate(db);
    });
  }

  /** Additive schema migration from the v0.2.0 shape to v0.2.1. */
  #migrate(db: DatabaseSync): void {
    const columns = (table: string): string[] =>
      db.prepare(`PRAGMA table_info(${table})`).all().map(row => String((row as Row).name));
    if (!columns('mesh_tickets').includes('kind')) {
      db.exec("ALTER TABLE mesh_tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'engineering'");
    }
    if (!columns('mesh_tickets').includes('outcome_ref')) {
      db.exec('ALTER TABLE mesh_tickets ADD COLUMN outcome_ref TEXT');
    }
    if (!columns('mesh_tickets').includes('experiment_id')) {
      db.exec('ALTER TABLE mesh_tickets ADD COLUMN experiment_id TEXT');
    }
    if (!columns('mesh_effects').includes('owner')) {
      db.exec('ALTER TABLE mesh_effects ADD COLUMN owner TEXT');
      db.exec('ALTER TABLE mesh_effects ADD COLUMN claimed_at TEXT');
      db.exec('ALTER TABLE mesh_effects ADD COLUMN lease_expires_at TEXT');
    }
    if (!columns('mesh_mandates').includes('policy_digest')) {
      db.exec("ALTER TABLE mesh_mandates ADD COLUMN policy_digest TEXT NOT NULL DEFAULT ''");
    }
    db.exec("INSERT INTO mesh_meta(key, value) VALUES ('autonomy_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  }

  /**
   * Downgrade the additive v2 schema for rollback drills. Rows are preserved;
   * only v2-only columns/tables are removed.
   * @param db - open connection.
   */
  rollbackToV1(db: DatabaseSync): void {
    db.exec('DROP INDEX IF EXISTS uq_mesh_assignments_job');
    db.exec('DROP TABLE IF EXISTS mesh_threads');
    db.exec('DROP TABLE IF EXISTS mesh_policy');
    for (const column of ['kind', 'outcome_ref', 'experiment_id']) {
      try { db.exec(`ALTER TABLE mesh_tickets DROP COLUMN ${column}`); } catch { /* older sqlite */ }
    }
    for (const column of ['owner', 'claimed_at', 'lease_expires_at']) {
      try { db.exec(`ALTER TABLE mesh_effects DROP COLUMN ${column}`); } catch { /* older sqlite */ }
    }
    db.exec("INSERT INTO mesh_meta(key, value) VALUES ('autonomy_schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  }

  /** Current additive schema version. */
  schemaVersion(): number {
    const row = this.read(db => db.prepare("SELECT value FROM mesh_meta WHERE key = 'autonomy_schema_version'").get() as Row | undefined);
    return row === undefined ? 0 : Number(row.value);
  }

  /** Run one transaction on the shared connection. */
  transaction<T>(work: (db: DatabaseSync) => T): T {
    return this.#store.transaction(work);
  }

  /** Read-only query on the shared connection. */
  read<T>(work: (db: DatabaseSync) => T): T {
    return this.#store.read(work);
  }

  // -- triggers ------------------------------------------------------------

  /** Insert a Trigger once; a duplicate dedupe key returns false. */
  insertTrigger(record: TriggerRecord): boolean {
    return this.transaction(db => {
      const result = db.prepare(`INSERT OR IGNORE INTO mesh_triggers
        (trigger_id, source, event_id, project_id, kind, dedupe_key, payload_json, payload_digest,
         thread_key, actor, occurred_at, received_at, disposition, ticket_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.triggerId, record.source, record.eventId, record.projectId, record.kind, record.dedupeKey,
        record.payloadJson, record.payloadDigest, record.threadKey, record.actor, record.occurredAt,
        record.receivedAt, record.disposition, record.ticketId,
      );
      return Number(result.changes) === 1;
    });
  }

  getTrigger(triggerId: string): TriggerRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_triggers WHERE trigger_id = ?').get(triggerId) as Row | undefined);
    return row === undefined ? undefined : triggerFrom(row);
  }

  getTriggerByDedupe(dedupeKey: string): TriggerRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_triggers WHERE dedupe_key = ?').get(dedupeKey) as Row | undefined);
    return row === undefined ? undefined : triggerFrom(row);
  }

  setTriggerDisposition(triggerId: string, disposition: TriggerDisposition, ticketId: string | null): void {
    this.transaction(db => {
      db.prepare('UPDATE mesh_triggers SET disposition = ?, ticket_id = ? WHERE trigger_id = ?')
        .run(disposition, ticketId, triggerId);
    });
  }

  listTriggers(projectId: string, limit = 100): readonly TriggerRecord[] {
    return this.read(db => db.prepare(
      'SELECT * FROM mesh_triggers WHERE project_id = ? ORDER BY received_at DESC LIMIT ?',
    ).all(projectId, limit).map(row => triggerFrom(row as Row)));
  }

  // -- mandates ------------------------------------------------------------

  insertMandate(record: MandateRecord): void {
    this.transaction(db => {
      db.prepare(`INSERT INTO mesh_mandates
        (mandate_id, project_id, route_id, issuer, source, trigger_id, scope_json, operations_json,
         resource_ceiling_json, rlp_scope, policy_version, policy_digest, autonomous, created_at, revoked_at, revoke_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.mandateId, record.projectId, record.routeId, record.issuer, record.source, record.triggerId,
        record.scopeJson, record.operationsJson, record.resourceCeilingJson, record.rlpScope,
        record.policyVersion, record.policyDigest, record.autonomous ? 1 : 0, record.createdAt,
        record.revokedAt, record.revokeReason,
      );
    });
  }

  getMandate(mandateId: string): MandateRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_mandates WHERE mandate_id = ?').get(mandateId) as Row | undefined);
    return row === undefined ? undefined : mandateFrom(row);
  }

  revokeMandate(mandateId: string, reason: string, at = nowIso()): void {
    this.transaction(db => {
      db.prepare('UPDATE mesh_mandates SET revoked_at = ?, revoke_reason = ? WHERE mandate_id = ? AND revoked_at IS NULL')
        .run(at, reason, mandateId);
    });
  }

  // -- tickets -------------------------------------------------------------

  insertTicket(record: TicketRecord): void {
    this.transaction(db => {
      db.prepare(`INSERT INTO mesh_tickets
        (ticket_id, project_id, route_id, kind, title, objective, status, mandate_id, group_id, priority,
         autonomous, idempotency_key, scope_json, waiting_reason, created_at, updated_at, ended_at, end_reason,
         outcome_ref, experiment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.ticketId, record.projectId, record.routeId, record.kind, record.title, record.objective, record.status,
        record.mandateId, record.groupId, record.priority, record.autonomous ? 1 : 0, record.idempotencyKey,
        record.scopeJson, record.waitingReason, record.createdAt, record.updatedAt, record.endedAt, record.endReason,
        record.outcomeRef, record.experimentId,
      );
    });
  }

  getTicket(ticketId: string): TicketRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_tickets WHERE ticket_id = ?').get(ticketId) as Row | undefined);
    return row === undefined ? undefined : ticketFrom(row);
  }

  getTicketByIdempotency(key: string): TicketRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_tickets WHERE idempotency_key = ?').get(key) as Row | undefined);
    return row === undefined ? undefined : ticketFrom(row);
  }

  updateTicket(record: TicketRecord): void {
    this.transaction(db => {
      db.prepare(`UPDATE mesh_tickets SET status = ?, group_id = ?, mandate_id = ?, scope_json = ?, waiting_reason = ?,
        updated_at = ?, ended_at = ?, end_reason = ?, outcome_ref = ?, experiment_id = ? WHERE ticket_id = ?`).run(
        record.status, record.groupId, record.mandateId, record.scopeJson, record.waitingReason, record.updatedAt,
        record.endedAt, record.endReason, record.outcomeRef, record.experimentId, record.ticketId,
      );
    });
  }

  listTickets(projectId: string, statuses?: readonly TicketStatus[]): readonly TicketRecord[] {
    return this.read(db => {
      if (statuses === undefined || statuses.length === 0) {
        return db.prepare('SELECT * FROM mesh_tickets WHERE project_id = ? ORDER BY created_at DESC')
          .all(projectId).map(row => ticketFrom(row as Row));
      }
      const placeholders = statuses.map(() => '?').join(', ');
      return db.prepare(`SELECT * FROM mesh_tickets WHERE project_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`)
        .all(projectId, ...statuses).map(row => ticketFrom(row as Row));
    });
  }

  countOpenTickets(projectId: string): number {
    const row = this.read(db => db.prepare(
      "SELECT COUNT(*) AS n FROM mesh_tickets WHERE project_id = ? AND status <> 'ended'",
    ).get(projectId) as Row | undefined);
    return row === undefined ? 0 : num(row, 'n');
  }

  findTicketsByThread(threadKey: string): readonly TicketRecord[] {
    return this.read(db => db.prepare(`SELECT t.* FROM mesh_tickets t
      JOIN mesh_subscriptions s ON s.ticket_id = t.ticket_id
      WHERE s.thread_key = ? ORDER BY t.created_at DESC`).all(threadKey).map(row => ticketFrom(row as Row)));
  }

  // -- assignments ---------------------------------------------------------

  insertAssignment(record: AssignmentRecord): void {
    this.transaction(db => {
      db.prepare(`INSERT INTO mesh_assignments
        (assignment_id, ticket_id, team_id, status, attempt, task_id, job_id, session_id,
         created_at, started_at, ended_at, error_code, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.assignmentId, record.ticketId, record.teamId, record.status, record.attempt, record.taskId,
        record.jobId, record.sessionId, record.createdAt, record.startedAt, record.endedAt,
        record.errorCode, record.errorMessage,
      );
    });
  }

  updateAssignment(record: AssignmentRecord): void {
    this.transaction(db => {
      db.prepare(`UPDATE mesh_assignments SET status = ?, task_id = ?, job_id = ?, session_id = ?,
        started_at = ?, ended_at = ?, error_code = ?, error_message = ? WHERE assignment_id = ?`).run(
        record.status, record.taskId, record.jobId, record.sessionId, record.startedAt, record.endedAt,
        record.errorCode, record.errorMessage, record.assignmentId,
      );
    });
  }

  getAssignment(assignmentId: string): AssignmentRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_assignments WHERE assignment_id = ?').get(assignmentId) as Row | undefined);
    return row === undefined ? undefined : assignmentFrom(row);
  }

  listAssignments(ticketId: string): readonly AssignmentRecord[] {
    return this.read(db => db.prepare('SELECT * FROM mesh_assignments WHERE ticket_id = ? ORDER BY attempt ASC')
      .all(ticketId).map(row => assignmentFrom(row as Row)));
  }

  activeAssignment(ticketId: string): AssignmentRecord | undefined {
    const row = this.read(db => db.prepare(
      "SELECT * FROM mesh_assignments WHERE ticket_id = ? AND status IN ('pending','running') ORDER BY attempt DESC LIMIT 1",
    ).get(ticketId) as Row | undefined);
    return row === undefined ? undefined : assignmentFrom(row);
  }

  findAssignmentByJob(jobId: string): AssignmentRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_assignments WHERE job_id = ? LIMIT 1').get(jobId) as Row | undefined);
    return row === undefined ? undefined : assignmentFrom(row);
  }

  maxAttempt(ticketId: string): number {
    const row = this.read(db => db.prepare('SELECT IFNULL(MAX(attempt), 0) AS n FROM mesh_assignments WHERE ticket_id = ?')
      .get(ticketId) as Row | undefined);
    return row === undefined ? 0 : num(row, 'n');
  }

  // -- subscriptions -------------------------------------------------------

  upsertSubscription(ticketId: string, threadKey: string, mode: SubscriptionMode, at = nowIso()): void {
    this.transaction(db => {
      db.prepare(`INSERT INTO mesh_subscriptions (ticket_id, thread_key, mode, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(ticket_id, thread_key) DO UPDATE SET mode = excluded.mode`)
        .run(ticketId, threadKey, mode, at);
    });
  }

  listSubscriptions(ticketId: string): readonly SubscriptionRecord[] {
    return this.read(db => db.prepare('SELECT * FROM mesh_subscriptions WHERE ticket_id = ? ORDER BY created_at')
      .all(ticketId).map(row => ({
        ticketId: str(row as Row, 'ticket_id'),
        threadKey: str(row as Row, 'thread_key'),
        mode: str(row as Row, 'mode') as SubscriptionMode,
        createdAt: str(row as Row, 'created_at'),
      })));
  }

  // -- effects -------------------------------------------------------------

  /** Insert an effect unless (kind, dedupeKey) exists; returns whether it was new. */
  insertEffect(record: EffectRecord): boolean {
    return this.transaction(db => {
      const result = db.prepare(`INSERT OR IGNORE INTO mesh_effects
        (effect_id, kind, dedupe_key, payload_json, status, attempts, max_attempts, next_run_at,
         last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.effectId, record.kind, record.dedupeKey, record.payloadJson, record.status, record.attempts,
        record.maxAttempts, record.nextRunAt, record.lastError, record.createdAt, record.updatedAt,
      );
      return Number(result.changes) === 1;
    });
  }

  getEffect(effectId: string): EffectRecord | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_effects WHERE effect_id = ?').get(effectId) as Row | undefined);
    return row === undefined ? undefined : effectFrom(row);
  }

  listDueEffects(nowIsoValue: string, limit = 20): readonly EffectRecord[] {
    return this.read(db => db.prepare(
      "SELECT * FROM mesh_effects WHERE status = 'pending' AND next_run_at <= ? ORDER BY next_run_at ASC, created_at ASC LIMIT ?",
    ).all(nowIsoValue, limit).map(row => effectFrom(row as Row)));
  }

  listEffects(status?: EffectStatus, limit = 100): readonly EffectRecord[] {
    return this.read(db => status === undefined
      ? db.prepare('SELECT * FROM mesh_effects ORDER BY created_at DESC LIMIT ?').all(limit).map(row => effectFrom(row as Row))
      : db.prepare('SELECT * FROM mesh_effects WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(status, limit).map(row => effectFrom(row as Row)));
  }

  /**
   * Atomically claim a due effect: pending -> running with an owner and a lease.
   * @param effectId - effect identity.
   * @param owner - worker identity.
   * @param leaseMs - lease lifetime.
   * @param at - claim timestamp.
   * @returns true when this caller won the claim.
   */
  claimEffect(effectId: string, owner: string, leaseMs: number, at = nowIso()): boolean {
    const lease = new Date(Date.parse(at) + leaseMs).toISOString();
    return this.transaction(db => {
      const result = db.prepare(`UPDATE mesh_effects
        SET status = 'running', owner = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE effect_id = ? AND status = 'pending'`).run(owner, at, lease, at, effectId);
      return Number(result.changes) === 1;
    });
  }

  /** Running rows whose lease expired; a crashed owner can no longer hold them. */
  staleClaims(nowIsoValue: string, limit = 20): readonly EffectRecord[] {
    return this.read(db => db.prepare(`SELECT * FROM mesh_effects
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC LIMIT ?`).all(nowIsoValue, limit).map(row => effectFrom(row as Row)));
  }

  /**
   * Recover one stale running row. The caller decides whether the kind is safe
   * to replay; this only performs the conditional transition.
   * @param effectId - effect identity.
   * @param next - `pending` (replay) or `failed` (reconcile required).
   * @param options - error text and next run time.
   */
  recoverClaim(effectId: string, next: 'pending' | 'failed', options: { error: string; nextRunAt?: string; at?: string }): boolean {
    const at = options.at ?? nowIso();
    return this.transaction(db => {
      const result = db.prepare(`UPDATE mesh_effects
        SET status = ?, owner = NULL, claimed_at = NULL, lease_expires_at = NULL,
            attempts = attempts + 1, last_error = ?, next_run_at = COALESCE(?, next_run_at), updated_at = ?
        WHERE effect_id = ? AND status = 'running'`).run(next, options.error, options.nextRunAt ?? null, at, effectId);
      return Number(result.changes) === 1;
    });
  }

  // -- policy --------------------------------------------------------------

  /** Load the persisted policy, if any. */
  loadPolicy(): { version: string; digest: string; json: string; updatedAt: string } | undefined {
    const row = this.read(db => db.prepare("SELECT * FROM mesh_policy WHERE policy_id = 'current'").get() as Row | undefined);
    return row === undefined ? undefined : {
      version: str(row, 'version'), digest: str(row, 'digest'),
      json: str(row, 'json'), updatedAt: str(row, 'updated_at'),
    };
  }

  /** Persist the single current policy row. */
  savePolicy(version: string, digest: string, json: string, at = nowIso()): void {
    this.transaction(db => {
      db.prepare(`INSERT INTO mesh_policy (policy_id, version, digest, json, updated_at)
        VALUES ('current', ?, ?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET version = excluded.version, digest = excluded.digest,
          json = excluded.json, updated_at = excluded.updated_at`).run(version, digest, json, at);
    });
  }

  // -- threads -------------------------------------------------------------

  /** Record the owning project of a thread key (idempotent). */
  upsertThread(threadKey: string, projectId: string, at = nowIso()): void {
    this.transaction(db => {
      db.prepare(`INSERT INTO mesh_threads (thread_key, project_id, created_at) VALUES (?, ?, ?)
        ON CONFLICT(thread_key) DO NOTHING`).run(threadKey, projectId, at);
    });
  }

  /** Project that owns a thread key. */
  threadProject(threadKey: string): string | undefined {
    const row = this.read(db => db.prepare('SELECT project_id FROM mesh_threads WHERE thread_key = ?').get(threadKey) as Row | undefined);
    return row === undefined ? undefined : String(row.project_id);
  }

  /** One Mesh job row, read from the shared database. */
  job(jobId: string): { jobId: string; taskId: string; projectId: string; teamId: string; manifestJson: string } | undefined {
    const row = this.read(db => db.prepare('SELECT * FROM mesh_jobs WHERE job_id = ?').get(jobId) as Row | undefined);
    if (row === undefined) return undefined;
    return {
      jobId: String(row.job_id), taskId: String(row.task_id), projectId: String(row.project_id),
      teamId: String(row.team_id), manifestJson: String(row.manifest_json),
    };
  }

  /** Group facts for authorization, read from the Mesh registry. */
  groupFacts(teamId: string): { teamId: string; projectId: string; routeId: string; status: import('../storage/types.ts').MeshGroupStatus } | undefined {
    const row = this.read(db => db.prepare('SELECT project_id, route_id, status FROM mesh_groups WHERE team_id = ?').get(teamId) as Row | undefined);
    if (row === undefined) return undefined;
    return {
      teamId,
      projectId: String(row.project_id),
      routeId: String(row.route_id),
      status: String(row.status) as import('../storage/types.ts').MeshGroupStatus,
    };
  }

  finishEffect(effectId: string, status: EffectStatus, options: {
    error?: string | null;
    nextRunAt?: string;
    attempts?: number;
    at?: string;
    owner?: string;
  } = {}): boolean {
    const at = options.at ?? nowIso();
    return this.transaction(db => {
      const result = options.owner === undefined
        ? db.prepare(`UPDATE mesh_effects SET status = ?, attempts = COALESCE(?, attempts),
            next_run_at = COALESCE(?, next_run_at), last_error = ?, owner = NULL, claimed_at = NULL,
            lease_expires_at = NULL, updated_at = ? WHERE effect_id = ?`).run(
            status, options.attempts ?? null, options.nextRunAt ?? null, options.error ?? null, at, effectId,
          )
        : db.prepare(`UPDATE mesh_effects SET status = ?, attempts = COALESCE(?, attempts),
            next_run_at = COALESCE(?, next_run_at), last_error = ?, owner = NULL, claimed_at = NULL,
            lease_expires_at = NULL, updated_at = ?
            WHERE effect_id = ? AND owner = ? AND status = 'running'`).run(
            status, options.attempts ?? null, options.nextRunAt ?? null, options.error ?? null, at, effectId,
            options.owner,
          );
      return Number(result.changes) === 1;
    });
  }

  /** Extend a live claim; false when ownership was lost to recovery. */
  renewClaim(effectId: string, owner: string, leaseMs: number, at = nowIso()): boolean {
    const lease = new Date(Date.parse(at) + leaseMs).toISOString();
    return this.transaction(db => {
      const result = db.prepare(`UPDATE mesh_effects SET lease_expires_at = ?, updated_at = ?
        WHERE effect_id = ? AND owner = ? AND status = 'running'`).run(lease, at, effectId, owner);
      return Number(result.changes) === 1;
    });
  }

  /** Fail a missing row loudly: every autonomy mutation must hit a real record. */
  requireTicket(ticketId: string): TicketRecord {
    const ticket = this.getTicket(ticketId);
    if (ticket === undefined) {
      throw new MeshError('TICKET_NOT_FOUND', `unknown ticket ${ticketId}`, { ticketId });
    }
    return ticket;
  }
}
