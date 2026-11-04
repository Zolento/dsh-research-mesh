/**
 * Durable {@link TeamStore} backed by SQLite (`node:sqlite`, synchronous).
 *
 * Why this module is shaped the way it is:
 *
 * - **Lazy in the only way that matters.** `node:sqlite` prints an
 *   `ExperimentalWarning` the moment the module is *loaded*, not when a database
 *   is opened. A static `import 'node:sqlite'` would therefore make every plugin
 *   boot noisy. The module is pulled in through `createRequire` inside
 *   {@link openTeamStore}, so importing this file stays silent and the caller
 *   decides when to pay for SQLite.
 * - **Compare-and-set is enforced by the database, not by a read-then-write.**
 *   Every mutating method runs inside `BEGIN IMMEDIATE`, so two store instances
 *   (or two processes) on the same file cannot both win a claim: the second one
 *   sees the first one's committed row or fails on the write lock.
 * - **Durability is real.** Rows are written verbatim — including an in-flight
 *   `TaskLease` and every `revision` counter — so reopening the same path
 *   returns exactly what was written, and a crash mid-claim leaves a lease that
 *   recovery can act on instead of a silent retry.
 * - **Foreign keys are on.** Child rows (members, tasks, messages, artifacts,
 *   journal rows, run states, budgets) must reference a `teams` row. A caller
 *   that writes a task before its team gets an explicit refusal instead of an
 *   orphan row that recovery can never reason about.
 *
 * The store never invents ids, timestamps or revisions: the caller owns those,
 * which is what makes recovery decisions reproducible from the file alone.
 *
 * @module dsh-research-team-bridge/runtime/persistence
 */

import { createRequire } from 'node:module'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { RtbError } from '../errors.ts'
import type { AnyRtbErrorCode } from '../errors.ts'
import { isoNow, systemClock } from '../ids.ts'
import type { Clock } from '../ids.ts'
import type {
  ArtifactId, ArtifactQuery, ArtifactRef, Budget, BudgetUsage, CanonicalRefs, DeliveryStatus, JournalEntry,
  MessageId, MessagePatch, MessageQuery, ResearchArtifact, ResearchArtifactKind, ResearchRole, ResearchTask,
  StoreConflict, TaskId, TaskLease, TaskProgress, TaskQuery, TaskStatus, TeamId, TeamMember, TeamMessage,
  TeamMessagePayloadMap, TeamMessageType, TeamRecord, TeamRunState, TeamStore, Timestamp,
} from '../types.ts'

/** On-disk schema version written into the `meta` table. */
export const TEAM_STORE_SCHEMA_VERSION = 1

/** Default write-lock wait so a second process retries instead of failing fast. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/**
 * Constructor shape of `DatabaseSync`. Declared structurally so this module can
 * stay import-silent: the real constructor is injected by {@link openTeamStore}.
 */
export type DatabaseCtor = new (location: string, options?: { timeout?: number }) => DatabaseSync

export interface SqliteTeamStoreOptions {
  /** Path of the SQLite file. The parent directory must already exist. */
  readonly path: string
  /** Injectable clock, used only for the store's own `meta` bookkeeping. */
  readonly clock?: Clock
  /** How long a writer waits for the file lock. Defaults to 5s. */
  readonly busyTimeoutMs?: number
}

/** Options accepted by {@link openTeamStore}. */
export type OpenTeamStoreOptions = SqliteTeamStoreOptions

type SqlValue = string | number | null
type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// Schema: one source of truth for DDL, column order and describeSchema()
// ---------------------------------------------------------------------------

interface ColumnSpec {
  readonly name: string
  readonly ddl: string
  /** Store-generated (e.g. `AUTOINCREMENT`): never bound by a codec. */
  readonly generated?: boolean
  /** Table-level constraint entry, not a real column. */
  readonly constraint?: boolean
}

interface TableSpec {
  readonly name: string
  readonly purpose: string
  readonly columns: readonly ColumnSpec[]
  readonly indexes?: readonly string[]
}

const TABLES: readonly TableSpec[] = [
  {
    name: 'meta',
    purpose: 'store-owned bookkeeping (schema version, first open time)',
    columns: [
      { name: 'key', ddl: 'key TEXT PRIMARY KEY' },
      { name: 'value', ddl: 'value TEXT NOT NULL' },
    ],
  },
  {
    name: 'teams',
    purpose: 'one durable team record per run',
    columns: [
      { name: 'team_id', ddl: 'team_id TEXT PRIMARY KEY' },
      { name: 'title', ddl: 'title TEXT NOT NULL' },
      { name: 'objective', ddl: 'objective TEXT NOT NULL' },
      { name: 'state_version_at_start', ddl: 'state_version_at_start TEXT' },
      { name: 'captain_agent_id', ddl: 'captain_agent_id TEXT NOT NULL' },
      { name: 'project_root', ddl: 'project_root TEXT' },
      { name: 'research_state_path', ddl: 'research_state_path TEXT' },
      { name: 'pipeline_root', ddl: 'pipeline_root TEXT' },
      { name: 'budget', ddl: 'budget TEXT NOT NULL' },
      { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
      { name: 'updated_at', ddl: 'updated_at TEXT NOT NULL' },
      { name: 'status', ddl: 'status TEXT NOT NULL' },
      { name: 'revision', ddl: 'revision INTEGER NOT NULL' },
    ],
  },
  {
    name: 'members',
    purpose: 'durable role -> DSH session mapping',
    columns: [
      { name: 'team_id', ddl: 'team_id TEXT NOT NULL REFERENCES teams(team_id)' },
      { name: 'agent_id', ddl: 'agent_id TEXT NOT NULL' },
      { name: 'role', ddl: 'role TEXT NOT NULL' },
      { name: 'name', ddl: 'name TEXT NOT NULL' },
      { name: 'parent_agent_id', ddl: 'parent_agent_id TEXT' },
      { name: 'provider', ddl: 'provider TEXT NOT NULL' },
      { name: 'status', ddl: 'status TEXT NOT NULL' },
      { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
      { name: 'updated_at', ddl: 'updated_at TEXT NOT NULL' },
      { name: 'last_turn', ddl: 'last_turn TEXT' },
      { name: 'failure_reason', ddl: 'failure_reason TEXT' },
      { name: 'current_task_id', ddl: 'current_task_id TEXT' },
      { name: 'revision', ddl: 'revision INTEGER NOT NULL' },
      { name: 'pk', ddl: 'PRIMARY KEY (team_id, agent_id)', constraint: true },
    ],
    indexes: ['CREATE INDEX IF NOT EXISTS idx_members_team ON members(team_id)'],
  },
  {
    name: 'tasks',
    purpose: 'task DAG nodes with lease + revision state',
    columns: [
      { name: 'task_id', ddl: 'task_id TEXT PRIMARY KEY' },
      { name: 'team_id', ddl: 'team_id TEXT NOT NULL REFERENCES teams(team_id)' },
      { name: 'parent_task_id', ddl: 'parent_task_id TEXT' },
      { name: 'dependencies', ddl: 'dependencies TEXT NOT NULL' },
      { name: 'role', ddl: 'role TEXT NOT NULL' },
      { name: 'title', ddl: 'title TEXT NOT NULL' },
      { name: 'objective', ddl: 'objective TEXT NOT NULL' },
      { name: 'status', ddl: 'status TEXT NOT NULL' },
      { name: 'assigned_agent', ddl: 'assigned_agent TEXT' },
      { name: 'attempt_id', ddl: 'attempt_id TEXT' },
      { name: 'attempt_count', ddl: 'attempt_count INTEGER NOT NULL' },
      { name: 'max_attempts', ddl: 'max_attempts INTEGER NOT NULL' },
      { name: 'input_artifacts', ddl: 'input_artifacts TEXT NOT NULL' },
      { name: 'output_artifacts', ddl: 'output_artifacts TEXT NOT NULL' },
      { name: 'budget', ddl: 'budget TEXT NOT NULL' },
      { name: 'failure_reason', ddl: 'failure_reason TEXT' },
      { name: 'lease', ddl: 'lease TEXT' },
      { name: 'research_route', ddl: 'research_route TEXT' },
      { name: 'state_version', ddl: 'state_version TEXT' },
      { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
      { name: 'updated_at', ddl: 'updated_at TEXT NOT NULL' },
      { name: 'revision', ddl: 'revision INTEGER NOT NULL' },
      { name: 'idempotency_key', ddl: 'idempotency_key TEXT NOT NULL' },
      { name: 'progress', ddl: 'progress TEXT NOT NULL' },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id)',
      // Deliberately not UNIQUE: the store has no task-level idempotency
      // lookup, and the in-memory fake does not dedupe tasks either. A unique
      // index here would make the two implementations disagree.
      'CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(team_id, idempotency_key)',
    ],
  },
  {
    name: 'messages',
    purpose: 'durable message ledger',
    columns: [
      { name: 'message_id', ddl: 'message_id TEXT PRIMARY KEY' },
      { name: 'team_id', ddl: 'team_id TEXT NOT NULL REFERENCES teams(team_id)' },
      { name: 'task_id', ddl: 'task_id TEXT' },
      { name: 'sender_agent_id', ddl: 'sender_agent_id TEXT NOT NULL' },
      { name: 'sender_role', ddl: 'sender_role TEXT NOT NULL' },
      { name: 'recipient_agent_id', ddl: 'recipient_agent_id TEXT NOT NULL' },
      { name: 'recipient_role', ddl: 'recipient_role TEXT NOT NULL' },
      { name: 'message_type', ddl: 'message_type TEXT NOT NULL' },
      { name: 'research_route', ddl: 'research_route TEXT' },
      { name: 'state_version', ddl: 'state_version TEXT' },
      { name: 'artifact_refs', ddl: 'artifact_refs TEXT NOT NULL' },
      { name: 'evidence_refs', ddl: 'evidence_refs TEXT NOT NULL' },
      { name: 'payload', ddl: 'payload TEXT NOT NULL' },
      { name: 'summary', ddl: 'summary TEXT NOT NULL' },
      { name: 'trust', ddl: 'trust TEXT NOT NULL' },
      { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
      { name: 'delivery_status', ddl: 'delivery_status TEXT NOT NULL' },
      { name: 'attempt', ddl: 'attempt INTEGER NOT NULL' },
      { name: 'in_reply_to', ddl: 'in_reply_to TEXT' },
      { name: 'idempotency_key', ddl: 'idempotency_key TEXT NOT NULL' },
      { name: 'routing', ddl: 'routing TEXT NOT NULL' },
      { name: 'failure_reason', ddl: 'failure_reason TEXT' },
      { name: 'revision', ddl: 'revision INTEGER NOT NULL' },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_messages_team ON messages(team_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(team_id, idempotency_key)',
    ],
  },
  {
    name: 'artifacts',
    purpose: 'staged research products with provenance',
    columns: [
      { name: 'artifact_id', ddl: 'artifact_id TEXT PRIMARY KEY' },
      { name: 'kind', ddl: 'kind TEXT NOT NULL' },
      { name: 'team_id', ddl: 'team_id TEXT NOT NULL REFERENCES teams(team_id)' },
      { name: 'task_id', ddl: 'task_id TEXT NOT NULL' },
      { name: 'attempt_id', ddl: 'attempt_id TEXT' },
      { name: 'producer_agent_id', ddl: 'producer_agent_id TEXT NOT NULL' },
      { name: 'producer_role', ddl: 'producer_role TEXT NOT NULL' },
      { name: 'epistemic_status', ddl: 'epistemic_status TEXT NOT NULL' },
      { name: 'research_route', ddl: 'research_route TEXT' },
      { name: 'state_version', ddl: 'state_version TEXT' },
      { name: 'refs', ddl: 'refs TEXT NOT NULL' },
      { name: 'evidence_refs', ddl: 'evidence_refs TEXT NOT NULL' },
      { name: 'content', ddl: 'content TEXT NOT NULL' },
      { name: 'provenance', ddl: 'provenance TEXT NOT NULL' },
      { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
      { name: 'idempotency_key', ddl: 'idempotency_key TEXT NOT NULL' },
      { name: 'revision', ddl: 'revision INTEGER NOT NULL' },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_artifacts_team ON artifacts(team_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_idempotency ON artifacts(team_id, idempotency_key)',
    ],
  },
  {
    name: 'journal',
    purpose: 'write-ahead intent/result rows for recovery',
    columns: [
      { name: 'seq', ddl: 'seq INTEGER PRIMARY KEY AUTOINCREMENT', generated: true },
      { name: 'action_id', ddl: 'action_id TEXT NOT NULL' },
      { name: 'team_id', ddl: 'team_id TEXT NOT NULL REFERENCES teams(team_id)' },
      { name: 'task_id', ddl: 'task_id TEXT' },
      { name: 'attempt_id', ddl: 'attempt_id TEXT' },
      { name: 'kind', ddl: 'kind TEXT NOT NULL' },
      { name: 'action', ddl: 'action TEXT NOT NULL' },
      { name: 'payload', ddl: 'payload TEXT NOT NULL' },
      { name: 'outcome', ddl: 'outcome TEXT' },
      { name: 'error', ddl: 'error TEXT' },
      { name: 'idempotency_key', ddl: 'idempotency_key TEXT NOT NULL' },
      { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_journal_team ON journal(team_id)',
      'CREATE INDEX IF NOT EXISTS idx_journal_action ON journal(action_id)',
      'CREATE INDEX IF NOT EXISTS idx_journal_idempotency ON journal(team_id, idempotency_key)',
    ],
  },
  {
    name: 'run_states',
    purpose: 'durable resume pointer for one team run',
    columns: [
      { name: 'team_id', ddl: 'team_id TEXT PRIMARY KEY REFERENCES teams(team_id)' },
      { name: 'run_id', ddl: 'run_id TEXT NOT NULL' },
      { name: 'status', ddl: 'status TEXT NOT NULL' },
      { name: 'current_state_version', ddl: 'current_state_version TEXT' },
      { name: 'pending_action_ids', ddl: 'pending_action_ids TEXT NOT NULL' },
      { name: 'open_task_ids', ddl: 'open_task_ids TEXT NOT NULL' },
      { name: 'unacknowledged_message_ids', ddl: 'unacknowledged_message_ids TEXT NOT NULL' },
      { name: 'last_checkpoint_at', ddl: 'last_checkpoint_at TEXT NOT NULL' },
      { name: 'next_resumable_action', ddl: 'next_resumable_action TEXT' },
      { name: 'revision', ddl: 'revision INTEGER NOT NULL' },
    ],
  },
  {
    name: 'budgets',
    purpose: 'consumed budget counters per team',
    columns: [
      { name: 'team_id', ddl: 'team_id TEXT PRIMARY KEY REFERENCES teams(team_id)' },
      { name: 'concurrent_agents', ddl: 'concurrent_agents INTEGER NOT NULL' },
      { name: 'messages', ddl: 'messages INTEGER NOT NULL' },
      { name: 'experiment_runs', ddl: 'experiment_runs INTEGER NOT NULL' },
      { name: 'started_at', ddl: 'started_at TEXT' },
    ],
  },
]

const DDL: string = TABLES
  .map(table => `CREATE TABLE IF NOT EXISTS ${table.name} (\n  ${table.columns.map(column => column.ddl).join(',\n  ')}\n)`)
  .concat(TABLES.flatMap(table => table.indexes ?? []))
  .join(';\n')
  .concat(';')

/** Ordered column names of one table, excluding generated and constraint-only entries. */
function columnNames(table: string): readonly string[] {
  return tableSpec(table).columns
    .filter(column => column.generated !== true && column.constraint !== true)
    .map(column => column.name)
}

/** Physical columns of one table: generated columns exist, constraint entries do not. */
function physicalColumnNames(table: string): readonly string[] {
  return tableSpec(table).columns.filter(column => column.constraint !== true).map(column => column.name)
}

function tableSpec(table: string): TableSpec {
  const spec = TABLES.find(candidate => candidate.name === table)
  if (spec === undefined) throw new RtbError('SCHEMA_INVALID', `unknown table ${table}`, { table })
  return spec
}

/**
 * Human-readable schema description, for diagnostics and tests. The first entry
 * carries the schema version so a report can always state what it inspected.
 */
export function describeSchema(): readonly string[] {
  return [
    `schema_version=${TEAM_STORE_SCHEMA_VERSION}`,
    ...TABLES.map(table => `${table.name}(${columnNames(table.name).join(', ')}) — ${table.purpose}`),
  ]
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a compare-and-set precondition fails. */
export class StoreConflictError extends RtbError {
  readonly conflict: StoreConflict

  constructor(conflict: StoreConflict, message?: string, code: AnyRtbErrorCode = 'STORE_CONFLICT') {
    super(
      code,
      message ?? `${conflict.entity} ${conflict.id} conflict: ${conflict.code} (expected ${conflict.expected}, found ${conflict.actual})`,
      { code: conflict.code, entity: conflict.entity, id: conflict.id, expected: conflict.expected, actual: conflict.actual },
    )
    this.name = 'StoreConflictError'
    this.conflict = conflict
  }
}

function revisionConflict(entity: string, id: string, expected: number, actual: number): StoreConflictError {
  return new StoreConflictError({ code: 'REVISION_CONFLICT', entity, id, expected, actual })
}

function duplicateRow(entity: string, id: string): StoreConflictError {
  return new StoreConflictError({ code: 'DUPLICATE', entity, id, expected: 0, actual: 0 }, `${entity} ${id} already exists`)
}

function alreadyClaimed(id: string, owner: string, expected: number, actual: number): StoreConflictError {
  return new StoreConflictError(
    { code: 'ALREADY_CLAIMED', entity: 'task', id, expected, actual },
    `task ${id} is leased by ${owner}; claim refused`,
    'ALREADY_CLAIMED',
  )
}

function closedStore(): RtbError {
  return new RtbError('STORE_CONFLICT', 'store is closed', { code: 'DUPLICATE', reason: 'STORE_CLOSED' })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Translate a raw `node:sqlite` failure into the bridge vocabulary. Constraint
 * violations must never escape as opaque SQLite strings: a caller has to be able
 * to branch on `RtbError.code`. Non-SQLite errors (a codec bug, for example) are
 * rethrown untouched so they cannot masquerade as a store conflict.
 */
function wrapSqliteError(error: unknown, context: string): Error {
  if (error instanceof RtbError) return error
  const code = (error as { code?: unknown }).code
  if (code !== 'ERR_SQLITE_ERROR') {
    return error instanceof Error ? error : new RtbError('STORE_CONFLICT', `${context} failed: ${messageOf(error)}`, { context })
  }
  const errcode = (error as { errcode?: unknown }).errcode
  const detail = messageOf(error)
  if (errcode === 787) {
    return new RtbError('SCHEMA_INVALID', `foreign key violation during ${context}: ${detail}`, {
      reason: 'FOREIGN_KEY_VIOLATION', context,
    })
  }
  if (errcode === 1555 || errcode === 2067 || errcode === 19) {
    return new StoreConflictError(
      { code: 'DUPLICATE', entity: context, id: 'unknown', expected: 0, actual: 0 },
      `duplicate or constraint violation during ${context}: ${detail}`,
    )
  }
  return new RtbError('STORE_CONFLICT', `sqlite failure during ${context}: ${detail}`, { reason: 'SQLITE_FAILURE', context })
}

/** Table name of a write statement, for diagnostics only. */
function writeContext(sql: string): string {
  const match = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)
  return match?.[1] ?? 'write'
}

// ---------------------------------------------------------------------------
// Row codecs
// ---------------------------------------------------------------------------

/**
 * Read a NOT NULL text column.
 *
 * Every such column is declared NOT NULL, so a null or a number here means the file
 * was written by something other than this schema. Coercing it to `''` or `'0'`
 * turned corruption into a plausible value; the failure is explicit instead.
 */
function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value === 'string') return value
  throw new RtbError('SCHEMA_INVALID',
    `column ${key} holds ${value === null || value === undefined ? 'no value' : typeof value}, not the text this schema stores`, {
      reason: 'COLUMN_TYPE_INVALID', column: key,
    })
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key]
  return value === null || value === undefined ? null : String(value)
}

function integer(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new RtbError('SCHEMA_INVALID',
    `column ${key} holds ${value === null || value === undefined ? 'no value' : typeof value}, not the integer this schema stores`, {
      reason: 'COLUMN_TYPE_INVALID', column: key,
    })
}

/**
 * Decode one JSON column.
 *
 * A torn or hand-edited payload used to surface as a raw `SyntaxError` from
 * `JSON.parse`, which reads as a bridge fault; it is a store-integrity fault and
 * says so. Values written before this check that were silently coerced are the
 * reason the surrounding readers validate their own shapes too.
 */
function decode<T>(row: Row, key: string): T {
  const raw = row[key]
  if (typeof raw !== 'string') {
    throw new RtbError('SCHEMA_INVALID', `column ${key} holds no JSON payload`, {
      reason: 'COLUMN_TYPE_INVALID', column: key,
    })
  }
  try {
    return JSON.parse(raw) as T
  } catch (error: unknown) {
    throw new RtbError('SCHEMA_INVALID', `column ${key} is not valid JSON`, {
      reason: 'CORRUPT_JSON', column: key, detail: error instanceof Error ? error.message : String(error),
    })
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? null)
}

const TEAM_COLUMNS = columnNames('teams')
const MEMBER_COLUMNS = columnNames('members')
const TASK_COLUMNS = columnNames('tasks')
const MESSAGE_COLUMNS = columnNames('messages')
const ARTIFACT_COLUMNS = columnNames('artifacts')
const JOURNAL_COLUMNS = columnNames('journal')
const RUN_STATE_COLUMNS = columnNames('run_states')
const BUDGET_COLUMNS = columnNames('budgets')

function upsertSql(table: string, columns: readonly string[], keyColumns: readonly string[]): string {
  const updates = columns.filter(column => !keyColumns.includes(column)).map(column => `${column}=excluded.${column}`).join(', ')
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(${keyColumns.join(', ')}) DO UPDATE SET ${updates}`
}

function insertSql(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
}

const TEAM_UPSERT = upsertSql('teams', TEAM_COLUMNS, ['team_id'])
const MEMBER_UPSERT = upsertSql('members', MEMBER_COLUMNS, ['team_id', 'agent_id'])
const TASK_UPSERT = upsertSql('tasks', TASK_COLUMNS, ['task_id'])
const MESSAGE_UPSERT = upsertSql('messages', MESSAGE_COLUMNS, ['message_id'])
const RUN_STATE_UPSERT = upsertSql('run_states', RUN_STATE_COLUMNS, ['team_id'])
const BUDGET_UPSERT = upsertSql('budgets', BUDGET_COLUMNS, ['team_id'])
const MESSAGE_INSERT = insertSql('messages', MESSAGE_COLUMNS)
const ARTIFACT_INSERT = insertSql('artifacts', ARTIFACT_COLUMNS)
const JOURNAL_INSERT = insertSql('journal', JOURNAL_COLUMNS)

function rowToTeam(row: Row): TeamRecord {
  return {
    teamId: text(row, 'team_id'),
    title: text(row, 'title'),
    objective: text(row, 'objective'),
    stateVersionAtStart: textOrNull(row, 'state_version_at_start'),
    captainAgentId: text(row, 'captain_agent_id'),
    projectRoot: textOrNull(row, 'project_root'),
    researchStatePath: textOrNull(row, 'research_state_path'),
    pipelineRoot: textOrNull(row, 'pipeline_root'),
    budget: decode<Budget>(row, 'budget'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    status: text(row, 'status') as TeamRecord['status'],
    revision: integer(row, 'revision'),
  }
}

function teamValues(team: TeamRecord): readonly SqlValue[] {
  return [
    team.teamId, team.title, team.objective, team.stateVersionAtStart, team.captainAgentId, team.projectRoot,
    team.researchStatePath, team.pipelineRoot, encode(team.budget), team.createdAt, team.updatedAt, team.status,
    team.revision,
  ]
}

function rowToMember(row: Row): TeamMember {
  return {
    teamId: text(row, 'team_id'),
    agentId: text(row, 'agent_id'),
    role: text(row, 'role') as ResearchRole,
    name: text(row, 'name'),
    parentAgentId: textOrNull(row, 'parent_agent_id'),
    provider: text(row, 'provider'),
    status: text(row, 'status') as TeamMember['status'],
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    lastTurn: textOrNull(row, 'last_turn') as TeamMember['lastTurn'],
    failureReason: textOrNull(row, 'failure_reason'),
    currentTaskId: textOrNull(row, 'current_task_id'),
    revision: integer(row, 'revision'),
  }
}

function memberValues(member: TeamMember): readonly SqlValue[] {
  return [
    member.teamId, member.agentId, member.role, member.name, member.parentAgentId, member.provider, member.status,
    member.createdAt, member.updatedAt, member.lastTurn, member.failureReason, member.currentTaskId, member.revision,
  ]
}

function rowToTask(row: Row): ResearchTask {
  return {
    task_id: text(row, 'task_id'),
    team_id: text(row, 'team_id'),
    parent_task_id: textOrNull(row, 'parent_task_id'),
    dependencies: decode<readonly TaskId[]>(row, 'dependencies'),
    role: text(row, 'role') as ResearchRole,
    title: text(row, 'title'),
    objective: text(row, 'objective'),
    status: text(row, 'status') as TaskStatus,
    assigned_agent: textOrNull(row, 'assigned_agent'),
    attempt_id: textOrNull(row, 'attempt_id'),
    attempt_count: integer(row, 'attempt_count'),
    max_attempts: integer(row, 'max_attempts'),
    input_artifacts: decode<readonly ArtifactRef[]>(row, 'input_artifacts'),
    output_artifacts: decode<readonly ArtifactRef[]>(row, 'output_artifacts'),
    budget: decode<Budget>(row, 'budget'),
    failure_reason: textOrNull(row, 'failure_reason'),
    lease: decode<TaskLease | null>(row, 'lease'),
    research_route: textOrNull(row, 'research_route'),
    state_version: textOrNull(row, 'state_version'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
    revision: integer(row, 'revision'),
    idempotency_key: text(row, 'idempotency_key'),
    progress: decode<TaskProgress>(row, 'progress'),
  }
}

function taskValues(task: ResearchTask): readonly SqlValue[] {
  return [
    task.task_id, task.team_id, task.parent_task_id, encode(task.dependencies), task.role, task.title, task.objective,
    task.status, task.assigned_agent, task.attempt_id, task.attempt_count, task.max_attempts,
    encode(task.input_artifacts), encode(task.output_artifacts), encode(task.budget), task.failure_reason,
    encode(task.lease), task.research_route, task.state_version, task.created_at, task.updated_at, task.revision,
    task.idempotency_key, encode(task.progress),
  ]
}

function rowToMessage(row: Row): TeamMessage {
  return {
    message_id: text(row, 'message_id'),
    team_id: text(row, 'team_id'),
    task_id: textOrNull(row, 'task_id'),
    sender_agent_id: text(row, 'sender_agent_id'),
    sender_role: text(row, 'sender_role') as ResearchRole,
    recipient_agent_id: text(row, 'recipient_agent_id'),
    recipient_role: text(row, 'recipient_role') as ResearchRole,
    message_type: text(row, 'message_type') as TeamMessageType,
    research_route: textOrNull(row, 'research_route'),
    state_version: textOrNull(row, 'state_version'),
    artifact_refs: decode<readonly ArtifactRef[]>(row, 'artifact_refs'),
    evidence_refs: decode<TeamMessage['evidence_refs']>(row, 'evidence_refs'),
    payload: decode<TeamMessagePayloadMap[TeamMessageType]>(row, 'payload'),
    summary: text(row, 'summary'),
    trust: text(row, 'trust') as TeamMessage['trust'],
    created_at: text(row, 'created_at'),
    delivery_status: text(row, 'delivery_status') as DeliveryStatus,
    attempt: integer(row, 'attempt'),
    in_reply_to: textOrNull(row, 'in_reply_to'),
    idempotency_key: text(row, 'idempotency_key'),
    routing: decode<TeamMessage['routing']>(row, 'routing'),
    failure_reason: textOrNull(row, 'failure_reason'),
    revision: integer(row, 'revision'),
  }
}

function messageValues(message: TeamMessage): readonly SqlValue[] {
  return [
    message.message_id, message.team_id, message.task_id, message.sender_agent_id, message.sender_role,
    message.recipient_agent_id, message.recipient_role, message.message_type, message.research_route,
    message.state_version, encode(message.artifact_refs), encode(message.evidence_refs), encode(message.payload),
    message.summary, message.trust, message.created_at, message.delivery_status, message.attempt,
    message.in_reply_to, message.idempotency_key, encode(message.routing), message.failure_reason, message.revision,
  ]
}

function rowToArtifact(row: Row): ResearchArtifact {
  return {
    artifact_id: text(row, 'artifact_id'),
    kind: text(row, 'kind') as ResearchArtifactKind,
    team_id: text(row, 'team_id'),
    task_id: text(row, 'task_id'),
    attempt_id: textOrNull(row, 'attempt_id'),
    producer_agent_id: text(row, 'producer_agent_id'),
    producer_role: text(row, 'producer_role') as ResearchRole,
    epistemic_status: text(row, 'epistemic_status') as ResearchArtifact['epistemic_status'],
    research_route: textOrNull(row, 'research_route'),
    state_version: textOrNull(row, 'state_version'),
    refs: decode<CanonicalRefs>(row, 'refs'),
    evidence_refs: decode<ResearchArtifact['evidence_refs']>(row, 'evidence_refs'),
    content: decode<Readonly<Record<string, unknown>>>(row, 'content'),
    provenance: decode<ResearchArtifact['provenance']>(row, 'provenance'),
    created_at: text(row, 'created_at'),
    idempotency_key: text(row, 'idempotency_key'),
    revision: integer(row, 'revision'),
  }
}

function artifactValues(artifact: ResearchArtifact): readonly SqlValue[] {
  return [
    artifact.artifact_id, artifact.kind, artifact.team_id, artifact.task_id, artifact.attempt_id,
    artifact.producer_agent_id, artifact.producer_role, artifact.epistemic_status, artifact.research_route,
    artifact.state_version, encode(artifact.refs), encode(artifact.evidence_refs), encode(artifact.content),
    encode(artifact.provenance), artifact.created_at, artifact.idempotency_key, artifact.revision,
  ]
}

function rowToJournal(row: Row): JournalEntry {
  return {
    action_id: text(row, 'action_id'),
    team_id: text(row, 'team_id'),
    task_id: textOrNull(row, 'task_id'),
    attempt_id: textOrNull(row, 'attempt_id'),
    kind: text(row, 'kind') as JournalEntry['kind'],
    action: text(row, 'action') as JournalEntry['action'],
    payload: decode<Readonly<Record<string, unknown>>>(row, 'payload'),
    outcome: textOrNull(row, 'outcome') as JournalEntry['outcome'],
    error: textOrNull(row, 'error'),
    idempotency_key: text(row, 'idempotency_key'),
    created_at: text(row, 'created_at'),
  }
}

function journalValues(entry: JournalEntry): readonly SqlValue[] {
  return [
    entry.action_id, entry.team_id, entry.task_id, entry.attempt_id, entry.kind, entry.action, encode(entry.payload),
    entry.outcome, entry.error, entry.idempotency_key, entry.created_at,
  ]
}

function rowToRunState(row: Row): TeamRunState {
  return {
    teamId: text(row, 'team_id'),
    runId: text(row, 'run_id'),
    status: text(row, 'status') as TeamRunState['status'],
    currentStateVersion: textOrNull(row, 'current_state_version'),
    pendingActionIds: decode<readonly string[]>(row, 'pending_action_ids'),
    openTaskIds: decode<readonly TaskId[]>(row, 'open_task_ids'),
    unacknowledgedMessageIds: decode<readonly MessageId[]>(row, 'unacknowledged_message_ids'),
    lastCheckpointAt: text(row, 'last_checkpoint_at'),
    nextResumableAction: textOrNull(row, 'next_resumable_action'),
    revision: integer(row, 'revision'),
  }
}

function runStateValues(state: TeamRunState): readonly SqlValue[] {
  return [
    state.teamId, state.runId, state.status, state.currentStateVersion, encode(state.pendingActionIds),
    encode(state.openTaskIds), encode(state.unacknowledgedMessageIds), state.lastCheckpointAt,
    state.nextResumableAction, state.revision,
  ]
}

function rowToBudget(row: Row): BudgetUsage {
  return {
    teamId: text(row, 'team_id'),
    concurrentAgents: integer(row, 'concurrent_agents'),
    messages: integer(row, 'messages'),
    experimentRuns: integer(row, 'experiment_runs'),
    startedAt: textOrNull(row, 'started_at'),
  }
}

function budgetValues(usage: BudgetUsage): readonly SqlValue[] {
  return [usage.teamId, usage.concurrentAgents, usage.messages, usage.experimentRuns, usage.startedAt]
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * SQLite-backed {@link TeamStore}.
 *
 * Construct through {@link openTeamStore}; the constructor expects an injected
 * `DatabaseSync` constructor so this module never imports `node:sqlite` itself.
 * Instances hold one file handle and are not thread-safe, but they *are*
 * multi-instance safe: every mutation takes the file write lock first.
 */
export class SqliteTeamStore implements TeamStore {
  readonly path: string
  readonly schemaVersion: number
  #handle: DatabaseSync
  #statements = new Map<string, StatementSync>()
  #closed = false
  #clock: Clock
  /** Nesting level of a caller-owned transaction; nested bridge methods use savepoints. */
  #txDepth = 0

  constructor(options: SqliteTeamStoreOptions, databaseCtor: DatabaseCtor) {
    this.path = options.path
    this.schemaVersion = TEAM_STORE_SCHEMA_VERSION
    this.#clock = options.clock ?? systemClock
    let handle: DatabaseSync
    try {
      handle = new databaseCtor(options.path, { timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS })
    } catch (error) {
      throw new RtbError('STORE_CONFLICT', `cannot open team store at ${options.path}: ${messageOf(error)}`, {
        reason: 'OPEN_FAILED', path: options.path,
      })
    }
    this.#handle = handle
    try {
      this.#configure(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)
    } catch (error) {
      this.#closeHandle()
      this.#closed = true
      throw error instanceof RtbError
        ? error
        : new RtbError('SCHEMA_INVALID', `cannot initialise team store schema: ${messageOf(error)}`, { path: options.path })
    }
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Enable WAL + foreign keys, create the schema, verify the on-disk version and
   * check that the codecs still match the DDL. Any mismatch aborts the open.
   */
  #configure(busyTimeoutMs: number): void {
    const db = this.#handle
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(busyTimeoutMs))}`)
    // The version is checked BEFORE any DDL. Running the schema first and refusing
    // afterwards mutated a database this build does not support (creating tables and
    // indexes in it) and, on any SQLite file that merely lacked a `meta` table,
    // silently adopted it and stamped v1. Verification must not change the file.
    this.#verifySchemaVersion()
    db.exec(DDL)
    this.#verifyColumns()
  }

  /** Whether this file already carries this store's metadata table. */
  #hasMetaTable(): boolean {
    const row = this.#handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get() as Row | undefined
    return row !== undefined
  }

  #verifySchemaVersion(): void {
    const db = this.#handle
    if (!this.#hasMetaTable()) {
      // A file with no metadata table is not necessarily ours. It is only a fresh
      // store if it is empty of tables; anything else is refused rather than
      // adopted, because the DDL below would otherwise take ownership of it.
      const existing = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as readonly Row[]
      if (existing.length > 0) {
        throw new RtbError('SCHEMA_INVALID',
          `team store at ${this.path} holds tables but no schema metadata; refusing to adopt it`, {
            reason: 'SCHEMA_UNRECOGNISED', found: existing.map(row => String(row['name'])),
          })
      }
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      insert.run('schema_version', String(TEAM_STORE_SCHEMA_VERSION))
      insert.run('created_at', isoNow(this.#clock))
      return
    }
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as Row | undefined
    if (row === undefined) {
      throw new RtbError('SCHEMA_INVALID',
        `team store at ${this.path} has a meta table but no schema_version; refusing to guess`, {
          reason: 'SCHEMA_UNRECOGNISED',
        })
    }
    const found = Number(text(row, 'value'))
    if (found > TEAM_STORE_SCHEMA_VERSION) {
      throw new RtbError(
        'SCHEMA_INVALID',
        `team store at ${this.path} uses schema version ${found}, newer than this build supports (${TEAM_STORE_SCHEMA_VERSION})`,
        { reason: 'SCHEMA_TOO_NEW', found, supported: TEAM_STORE_SCHEMA_VERSION },
      )
    }
    if (found < TEAM_STORE_SCHEMA_VERSION) {
      // No migrations exist yet: v1 is the first schema. Refuse to guess.
      throw new RtbError(
        'SCHEMA_INVALID',
        `team store at ${this.path} uses schema version ${found}; no migration path to ${TEAM_STORE_SCHEMA_VERSION} exists`,
        { reason: 'SCHEMA_MIGRATION_MISSING', found, supported: TEAM_STORE_SCHEMA_VERSION },
      )
    }
  }

  /** Column drift between the codecs and the physical table must fail loudly. */
  #verifyColumns(): void {
    for (const table of TABLES) {
      const found = this.#handle.prepare(`SELECT * FROM ${table.name} LIMIT 0`).columns().map(column => column.name)
      const expected = physicalColumnNames(table.name)
      const mismatch = found.length !== expected.length || expected.some(name => !found.includes(name))
      if (mismatch) {
        throw new RtbError('SCHEMA_INVALID', `table ${table.name} does not match the store codecs`, {
          reason: 'SCHEMA_DRIFT', table: table.name, found, expected,
        })
      }
    }
  }

  #closeHandle(): void {
    this.#statements.clear()
    try {
      if (this.#handle.isOpen) this.#handle.close()
    } catch {
      // Closing an already-closed handle is not an error worth surfacing.
    }
  }

  /** Idempotent: closing twice is a no-op. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeHandle()
  }

  /** True once the handle is released. Lets a host or an acceptance probe verify teardown. */
  get closed(): boolean {
    return this.#closed
  }

  #assertOpen(): void {
    if (this.#closed) throw closedStore()
  }

  #stmt(sql: string): StatementSync {
    this.#assertOpen()
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      statement = this.#handle.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  #all(sql: string, params: readonly SqlValue[] = []): readonly Row[] {
    return this.#stmt(sql).all(...params) as Row[]
  }

  #one(sql: string, params: readonly SqlValue[] = []): Row | undefined {
    return this.#stmt(sql).get(...params) as Row | undefined
  }

  #run(sql: string, params: readonly SqlValue[] = []): void {
    try {
      this.#stmt(sql).run(...params)
    } catch (error) {
      throw wrapSqliteError(error, writeContext(sql))
    }
  }

  /**
   * Run `work` inside `BEGIN IMMEDIATE`.
   *
   * `IMMEDIATE` takes the write lock before the first read, which is what makes
   * compare-and-set safe: no other writer can slip between our `SELECT revision`
   * and our `UPDATE`. Everything else (idempotency checks, budget counters,
   * lease release) inherits the same guarantee.
   */
  #tx<T>(work: () => T): T {
    this.#assertOpen()
    // A public `transaction()` composes bridge methods that each open their own
    // transaction. Nested work uses a savepoint so one outer commit keeps the
    // whole Mesh mutation atomic without changing any existing call site.
    if (this.#txDepth > 0) {
      const savepoint = `mesh_sp_${this.#txDepth}`
      this.#handle.exec(`SAVEPOINT ${savepoint}`)
      this.#txDepth += 1
      try {
        const value = work()
        this.#handle.exec(`RELEASE ${savepoint}`)
        return value
      } catch (error) {
        try {
          this.#handle.exec(`ROLLBACK TO ${savepoint}`)
          this.#handle.exec(`RELEASE ${savepoint}`)
        } catch {
          // SQLite may have already rolled back the savepoint.
        }
        throw wrapSqliteError(error, 'transaction')
      } finally {
        this.#txDepth -= 1
      }
    }
    const db = this.#handle
    db.exec('BEGIN IMMEDIATE')
    this.#txDepth = 1
    let value: T
    try {
      value = work()
    } catch (error) {
      this.#rollback()
      this.#txDepth = 0
      throw wrapSqliteError(error, 'transaction')
    }
    try {
      db.exec('COMMIT')
    } catch (error) {
      this.#rollback()
      this.#txDepth = 0
      throw wrapSqliteError(error, 'commit')
    }
    this.#txDepth = 0
    return value
  }

  /**
   * Run a caller-owned unit of work atomically on this store's connection.
   *
   * Mesh metadata lives in extra tables in the same database file. Exposing the
   * connection for the duration of one transaction lets team, task, workspace and
   * lease rows commit or roll back together. Callers must not retain the handle.
   * @param work - synchronous work executed inside `BEGIN IMMEDIATE`.
   * @returns the work result.
   */
  transaction<T>(work: (db: DatabaseSync) => T): T {
    return this.#tx(() => work(this.#handle))
  }

  /**
   * Read through this store's connection without taking the write lock.
   * @param work - synchronous read-only work.
   * @returns the work result.
   */
  read<T>(work: (db: DatabaseSync) => T): T {
    this.#assertOpen()
    return work(this.#handle)
  }

  #rollback(): void {
    try {
      this.#handle.exec('ROLLBACK')
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
  }

  // -- teams ---------------------------------------------------------------

  listTeams(): readonly TeamRecord[] {
    return this.#all('SELECT * FROM teams ORDER BY created_at, team_id').map(rowToTeam)
  }

  upsertTeam(team: TeamRecord): TeamRecord {
    this.#tx(() => this.#run(TEAM_UPSERT, teamValues(team)))
    return team
  }

  getTeam(teamId: TeamId): TeamRecord | undefined {
    const row = this.#one('SELECT * FROM teams WHERE team_id = ?', [teamId])
    return row === undefined ? undefined : rowToTeam(row)
  }

  // -- members -------------------------------------------------------------

  upsertMember(member: TeamMember): TeamMember {
    this.#tx(() => this.#run(MEMBER_UPSERT, memberValues(member)))
    return member
  }

  getMember(teamId: TeamId, agentId: string): TeamMember | undefined {
    const row = this.#one('SELECT * FROM members WHERE team_id = ? AND agent_id = ?', [teamId, agentId])
    return row === undefined ? undefined : rowToMember(row)
  }

  listMembers(teamId: TeamId): readonly TeamMember[] {
    // rowid keeps the insertion order the in-memory fake also exhibits.
    return this.#all('SELECT * FROM members WHERE team_id = ? ORDER BY rowid', [teamId]).map(rowToMember)
  }

  // -- tasks ---------------------------------------------------------------

  insertTask(task: ResearchTask): ResearchTask {
    return this.#tx(() => {
      if (this.#one('SELECT task_id FROM tasks WHERE task_id = ?', [task.task_id]) !== undefined) {
        throw duplicateRow('task', task.task_id)
      }
      this.#run(TASK_UPSERT, taskValues(task))
      return task
    })
  }

  getTask(taskId: TaskId): ResearchTask | undefined {
    const row = this.#one('SELECT * FROM tasks WHERE task_id = ?', [taskId])
    return row === undefined ? undefined : rowToTask(row)
  }

  listTasks(teamId: TeamId, query: TaskQuery = {}): readonly ResearchTask[] {
    const statuses = query.status
    if (statuses !== undefined && statuses.length === 0) return []
    const clauses = ['team_id = ?']
    const params: SqlValue[] = [teamId]
    if (statuses !== undefined) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    if (query.role !== undefined) {
      clauses.push('role = ?')
      params.push(query.role)
    }
    if (query.assignedAgent !== undefined) {
      clauses.push('assigned_agent = ?')
      params.push(query.assignedAgent)
    }
    let sql = `SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at, task_id`
    if (query.limit !== undefined) {
      // `LIMIT -1` is unlimited in SQL while `Array.slice(0, -1)` drops the last row
      // in the fake; a negative limit is refused so the two cannot disagree.
      if (!Number.isSafeInteger(query.limit) || query.limit < 0) {
        throw new RtbError('SCHEMA_INVALID',
          `limit must be a non-negative integer, received ${String(query.limit)}`, {
            reason: 'INVALID_LIMIT', limit: query.limit,
          })
      }
      sql += ' LIMIT ?'
      params.push(query.limit)
    }
    return this.#all(sql, params).map(rowToTask)
  }

  /** Compare-and-set: the expected revision is verified inside the transaction. */
  updateTask(task: ResearchTask, expectedRevision: number): ResearchTask {
    return this.#tx(() => {
      const current = this.#one('SELECT revision FROM tasks WHERE task_id = ?', [task.task_id])
      if (current === undefined) throw revisionConflict('task', task.task_id, expectedRevision, -1)
      const actual = integer(current, 'revision')
      if (actual !== expectedRevision) throw revisionConflict('task', task.task_id, expectedRevision, actual)
      this.#run(TASK_UPSERT, taskValues(task))
      return task
    })
  }

  /**
   * Atomic exclusive claim. `BEGIN IMMEDIATE` plus the in-transaction lease check
   * means a second owner can never win, even from another store instance or
   * another process on the same file.
   */
  claimTask(taskId: TaskId, owner: string, attemptId: string, expectedRevision: number, expiresAt: Timestamp): ResearchTask {
    return this.claimTaskAtStatus(taskId, owner, attemptId, expectedRevision, expiresAt, 'running')
  }

  /**
   * Atomic exclusive claim that records either Mesh's `claimed` hand-off state
   * or the bridge's `running` state. The Mesh state machine distinguishes the
   * two: a claimed task is owned by a worker but has not started execution.
   * @param taskId - task to claim.
   * @param owner - worker identity holding the lease.
   * @param attemptId - stable identity of this execution attempt.
   * @param expectedRevision - compare-and-set revision.
   * @param expiresAt - lease expiry timestamp.
   * @param status - state recorded by the claim.
   * @returns the updated task.
   */
  claimTaskAtStatus(
    taskId: TaskId,
    owner: string,
    attemptId: string,
    expectedRevision: number,
    expiresAt: Timestamp,
    status: 'claimed' | 'running',
  ): ResearchTask {
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM tasks WHERE task_id = ?', [taskId])
      if (row === undefined) throw revisionConflict('task', taskId, expectedRevision, -1)
      const current = rowToTask(row)
      if (current.revision !== expectedRevision) throw revisionConflict('task', taskId, expectedRevision, current.revision)
      // Exclusivity is absolute on purpose: an expired lease still blocks until
      // `expireLeases` names it and a release frees it. That keeps one place
      // responsible for expiry, and it keeps a claim from depending on wall-clock
      // time the store was never given.
      if (current.lease !== null && current.lease.owner !== owner) {
        throw alreadyClaimed(taskId, current.lease.owner, expectedRevision, current.revision)
      }
      const next: ResearchTask = {
        ...current,
        status,
        assigned_agent: owner,
        attempt_id: attemptId,
        attempt_count: current.attempt_count + 1,
        lease: { owner, attemptId, acquiredAt: current.updated_at, expiresAt },
        progress: { ...current.progress, startedAt: current.progress.startedAt ?? current.updated_at },
        revision: current.revision + 1,
      }
      this.#run(TASK_UPSERT, taskValues(next))
      return next
    })
  }

  /** Compare-and-set lease release; attempt history is preserved. */
  releaseTask(taskId: TaskId, expectedRevision: number, reason: string | null): ResearchTask {
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM tasks WHERE task_id = ?', [taskId])
      if (row === undefined) throw revisionConflict('task', taskId, expectedRevision, -1)
      const current = rowToTask(row)
      if (current.revision !== expectedRevision) throw revisionConflict('task', taskId, expectedRevision, current.revision)
      const next: ResearchTask = {
        ...current,
        status: reason === null ? 'ready' : 'blocked',
        assigned_agent: null,
        // `attempt_count` is the attempt history and survives; `attempt_id` names the
        // attempt that is currently in flight, and there is none after a release.
        attempt_id: null,
        lease: null,
        failure_reason: reason,
        revision: current.revision + 1,
      }
      this.#run(TASK_UPSERT, taskValues(next))
      return next
    })
  }

  // -- messages ------------------------------------------------------------

  /** Idempotent on `(team_id, idempotency_key)`: the stored row wins. */
  appendMessage(message: TeamMessage): TeamMessage {
    return this.#tx(() => {
      const existing = this.#one('SELECT * FROM messages WHERE team_id = ? AND idempotency_key = ? ORDER BY rowid LIMIT 1', [
        message.team_id, message.idempotency_key,
      ])
      if (existing !== undefined) return rowToMessage(existing)
      if (this.#one('SELECT message_id FROM messages WHERE message_id = ?', [message.message_id]) !== undefined) {
        throw duplicateRow('message', message.message_id)
      }
      this.#run(MESSAGE_INSERT, messageValues(message))
      return message
    })
  }

  getMessage(messageId: MessageId): TeamMessage | undefined {
    const row = this.#one('SELECT * FROM messages WHERE message_id = ?', [messageId])
    return row === undefined ? undefined : rowToMessage(row)
  }

  listMessages(teamId: TeamId, query: MessageQuery = {}): readonly TeamMessage[] {
    const clauses = ['team_id = ?']
    const params: SqlValue[] = [teamId]
    if (query.recipientAgentId !== undefined) { clauses.push('recipient_agent_id = ?'); params.push(query.recipientAgentId) }
    if (query.senderAgentId !== undefined) { clauses.push('sender_agent_id = ?'); params.push(query.senderAgentId) }
    if (query.taskId !== undefined) { clauses.push('task_id = ?'); params.push(query.taskId) }
    if (query.status !== undefined) { clauses.push('delivery_status = ?'); params.push(query.status) }
    let sql = `SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY created_at, message_id`
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(query.limit) }
    return this.#all(sql, params).map(rowToMessage)
  }

  /** Compare-and-set patch; only the defined patch fields change. */
  updateMessage(messageId: MessageId, expectedRevision: number, patch: MessagePatch): TeamMessage {
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM messages WHERE message_id = ?', [messageId])
      if (row === undefined) throw revisionConflict('message', messageId, expectedRevision, -1)
      const current = rowToMessage(row)
      if (current.revision !== expectedRevision) throw revisionConflict('message', messageId, expectedRevision, current.revision)
      const next: TeamMessage = {
        ...current,
        ...patch.delivery_status === undefined ? {} : { delivery_status: patch.delivery_status },
        ...patch.routing === undefined ? {} : { routing: patch.routing },
        ...patch.attempt === undefined ? {} : { attempt: patch.attempt },
        ...patch.failure_reason === undefined ? {} : { failure_reason: patch.failure_reason },
        revision: current.revision + 1,
      }
      this.#run(MESSAGE_UPSERT, messageValues(next))
      return next
    })
  }

  findByMessageIdempotencyKey(teamId: TeamId, key: string): TeamMessage | undefined {
    const row = this.#one('SELECT * FROM messages WHERE team_id = ? AND idempotency_key = ? ORDER BY rowid LIMIT 1', [teamId, key])
    return row === undefined ? undefined : rowToMessage(row)
  }

  // -- artifacts -----------------------------------------------------------

  /** Idempotent on `(team_id, idempotency_key)`: the stored row wins. */
  putArtifact(artifact: ResearchArtifact): ResearchArtifact {
    return this.#tx(() => {
      const existing = this.#one('SELECT * FROM artifacts WHERE team_id = ? AND idempotency_key = ? ORDER BY rowid LIMIT 1', [
        artifact.team_id, artifact.idempotency_key,
      ])
      if (existing !== undefined) return rowToArtifact(existing)
      if (this.#one('SELECT artifact_id FROM artifacts WHERE artifact_id = ?', [artifact.artifact_id]) !== undefined) {
        throw duplicateRow('artifact', artifact.artifact_id)
      }
      this.#run(ARTIFACT_INSERT, artifactValues(artifact))
      return artifact
    })
  }

  getArtifact(artifactId: ArtifactId): ResearchArtifact | undefined {
    const row = this.#one('SELECT * FROM artifacts WHERE artifact_id = ?', [artifactId])
    return row === undefined ? undefined : rowToArtifact(row)
  }

  listArtifacts(teamId: TeamId, query: ArtifactQuery = {}): readonly ResearchArtifact[] {
    const clauses = ['team_id = ?']
    const params: SqlValue[] = [teamId]
    if (query.kind !== undefined) { clauses.push('kind = ?'); params.push(query.kind) }
    if (query.taskId !== undefined) { clauses.push('task_id = ?'); params.push(query.taskId) }
    if (query.producerAgentId !== undefined) { clauses.push('producer_agent_id = ?'); params.push(query.producerAgentId) }
    let sql = `SELECT * FROM artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at, artifact_id`
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(query.limit) }
    return this.#all(sql, params).map(rowToArtifact)
  }

  findArtifactByIdempotencyKey(teamId: TeamId, key: string): ResearchArtifact | undefined {
    const row = this.#one('SELECT * FROM artifacts WHERE team_id = ? AND idempotency_key = ? ORDER BY rowid LIMIT 1', [teamId, key])
    return row === undefined ? undefined : rowToArtifact(row)
  }

  // -- journal -------------------------------------------------------------

  /**
   * Append-only. Duplicate rows are *not* collapsed: recovery must be able to
   * see every intent that was written, exactly like the in-memory fake.
   */
  appendJournal(entry: JournalEntry): JournalEntry {
    return this.#tx(() => {
      this.#run(JOURNAL_INSERT, journalValues(entry))
      return entry
    })
  }

  listJournal(teamId: TeamId): readonly JournalEntry[] {
    return this.#all('SELECT * FROM journal WHERE team_id = ? ORDER BY seq', [teamId]).map(rowToJournal)
  }

  findJournalByActionId(actionId: string): JournalEntry | undefined {
    const row = this.#one('SELECT * FROM journal WHERE action_id = ? ORDER BY seq LIMIT 1', [actionId])
    return row === undefined ? undefined : rowToJournal(row)
  }

  findJournalByIdempotencyKey(teamId: TeamId, key: string): JournalEntry | undefined {
    const row = this.#one('SELECT * FROM journal WHERE team_id = ? AND idempotency_key = ? ORDER BY seq LIMIT 1', [teamId, key])
    return row === undefined ? undefined : rowToJournal(row)
  }

  // -- run state + budget --------------------------------------------------

  saveRunState(state: TeamRunState): TeamRunState {
    this.#tx(() => this.#run(RUN_STATE_UPSERT, runStateValues(state)))
    return state
  }

  getRunState(teamId: TeamId): TeamRunState | undefined {
    const row = this.#one('SELECT * FROM run_states WHERE team_id = ?', [teamId])
    return row === undefined ? undefined : rowToRunState(row)
  }

  /** Additive counters inside one transaction; `startedAt` is set once. */
  recordBudget(teamId: TeamId, delta: Partial<Omit<BudgetUsage, 'teamId'>>): BudgetUsage {
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM budgets WHERE team_id = ?', [teamId])
      const current: BudgetUsage = row === undefined
        ? { teamId, concurrentAgents: 0, messages: 0, experimentRuns: 0, startedAt: null }
        : rowToBudget(row)
      const next: BudgetUsage = {
        teamId,
        concurrentAgents: current.concurrentAgents + (delta.concurrentAgents ?? 0),
        messages: current.messages + (delta.messages ?? 0),
        experimentRuns: current.experimentRuns + (delta.experimentRuns ?? 0),
        startedAt: delta.startedAt === undefined ? current.startedAt : delta.startedAt,
      }
      this.#run(BUDGET_UPSERT, budgetValues(next))
      return next
    })
  }

  getBudgetUsage(teamId: TeamId): BudgetUsage {
    const row = this.#one('SELECT * FROM budgets WHERE team_id = ?', [teamId])
    return row === undefined
      ? { teamId, concurrentAgents: 0, messages: 0, experimentRuns: 0, startedAt: null }
      : rowToBudget(row)
  }
}

/**
 * Open (and initialise) a durable team store.
 *
 * Synchronous on purpose: `TeamStore` is a synchronous interface and the plugin
 * composes it inside a synchronous `apply()`. The `node:sqlite` module is loaded
 * here — and only here — so importing this file never triggers the
 * `ExperimentalWarning`.
 */
export function openTeamStore(options: OpenTeamStoreOptions): SqliteTeamStore {
  const path = options?.path
  if (typeof path !== 'string' || path.length === 0) {
    throw new RtbError('CONFIG_INVALID', 'openTeamStore requires a non-empty { path }', { field: 'path' })
  }
  let databaseCtor: DatabaseCtor
  try {
    const require = createRequire(import.meta.url)
    databaseCtor = (require('node:sqlite') as { DatabaseSync: DatabaseCtor }).DatabaseSync
  } catch (error) {
    throw new RtbError('HOST_CAPABILITY_MISSING', `node:sqlite is unavailable in this runtime: ${messageOf(error)}`, {
      reason: 'SQLITE_UNAVAILABLE',
    })
  }
  // The store does not invent directories: a path whose parent is missing is a
  // caller error, so it fails as OPEN_FAILED instead of silently creating a tree
  // somewhere the operator did not ask for. The plugin creates its own data dir.
  return new SqliteTeamStore({ ...options, path }, databaseCtor)
}
