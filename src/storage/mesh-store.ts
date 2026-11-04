/**
 * Mesh metadata store.
 *
 * The integrated bridge store owns research teams, members, tasks, artifacts and
 * the research journal. This store adds the execution-layer tables the Mesh
 * needs (groups, worktrees, GPU leases, job manifests, verified artifacts) to
 * the same SQLite file and, critically, the same connection. Multi-row changes
 * therefore commit in one transaction with the bridge rows.
 *
 * Every statement is parameterized; no identifier or value is interpolated.
 */

import type { DatabaseSync } from 'node:sqlite';
import { MeshError } from '../errors.ts';
import type { SqliteTeamStore } from '../bridge/runtime/persistence.ts';
import { nowIso } from '../util/time.ts';
import { newId } from '../util/ids.ts';
import type {
  GpuLeaseRecord,
  GpuLeaseState,
  MeshArtifactRecord,
  MeshEventRecord,
  MeshGroupRecord,
  MeshGroupStatus,
  MeshJobRecord,
  MeshJobStatus,
  AgentModelRecord,
  MeshOutcomeRecord,
  MeshProjectRecord,
  MeshProjectStatus,
  MeshSessionBinding,
  SessionRole,
  MeshTaskMeta,
  MeshTaskType,
  MeshWorkspaceRecord,
  MeshWorkspaceStatus,
} from './types.ts';

/** SQLite scalar accepted by this store. */
type SqlValue = string | number | null;
/** Untyped row returned by the driver; every read is narrowed by a codec. */
type Row = Record<string, unknown>;

/** Current Mesh metadata schema version. */
export const MESH_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS mesh_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mesh_groups (
  team_id TEXT PRIMARY KEY REFERENCES teams(team_id),
  project_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  workspace_id TEXT,
  root_session_id TEXT NOT NULL,
  current_task_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_groups_project ON mesh_groups(project_id, status);
CREATE TABLE IF NOT EXISTS mesh_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  project_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enqueue_seq INTEGER NOT NULL,
  workspace_id TEXT,
  rsi_state_version TEXT,
  receipt_ref TEXT,
  job_id TEXT,
  gpu_id INTEGER,
  remote_status TEXT,
  error_code TEXT,
  error_message TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_tasks_project ON mesh_tasks(project_id);
CREATE TABLE IF NOT EXISTS mesh_workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  team_id TEXT,
  path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_workspaces_project ON mesh_workspaces(project_id);
CREATE TABLE IF NOT EXISTS mesh_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_no INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_attempts_task ON mesh_attempts(task_id, attempt_no);
CREATE TABLE IF NOT EXISTS mesh_gpu_leases (
  lease_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  gpu_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL,
  verified INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mesh_gpu_blocking
  ON mesh_gpu_leases(worker_id, gpu_id)
  WHERE state IN ('reserved', 'active', 'quarantined');
CREATE INDEX IF NOT EXISTS idx_mesh_gpu_task ON mesh_gpu_leases(task_id);
CREATE TABLE IF NOT EXISTS mesh_jobs (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  gpu_id INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  remote_dir TEXT NOT NULL,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_jobs_task ON mesh_jobs(task_id);
CREATE INDEX IF NOT EXISTS idx_mesh_jobs_status ON mesh_jobs(status);
CREATE TABLE IF NOT EXISTS mesh_artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES mesh_jobs(job_id),
  attempt_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, relative_path)
);
CREATE TABLE IF NOT EXISTS mesh_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_events_entity ON mesh_events(entity_type, entity_id, seq);
CREATE TABLE IF NOT EXISTS mesh_projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  rsi_state_ref TEXT NOT NULL UNIQUE,
  repository_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  runnable INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mesh_project_pauses (
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (project_id, team_id)
);
CREATE TABLE IF NOT EXISTS mesh_session_bindings (
  binding_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES mesh_projects(project_id),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  group_id TEXT,
  attached_at TEXT NOT NULL,
  detached_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mesh_binding_active_session
  ON mesh_session_bindings(session_id) WHERE detached_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mesh_binding_active_captain
  ON mesh_session_bindings(group_id) WHERE detached_at IS NULL AND role = 'captain';
CREATE INDEX IF NOT EXISTS idx_mesh_bindings_project ON mesh_session_bindings(project_id);
CREATE TABLE IF NOT EXISTS mesh_agent_models (
  session_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(team_id),
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mesh_outcomes (
  job_id TEXT PRIMARY KEY REFERENCES mesh_jobs(job_id),
  experiment_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  state_version TEXT NOT NULL,
  artifact_manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new MeshError('STORAGE_ERROR', `column ${key} is not TEXT`, { key });
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new MeshError('STORAGE_ERROR', `column ${key} is not TEXT`, { key });
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new MeshError('STORAGE_ERROR', `column ${key} is not an integer`, { key });
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function flag(row: Row, key: string): boolean {
  return integer(row, key) !== 0;
}

function groupRow(row: Row): MeshGroupRecord {
  return {
    teamId: text(row, 'team_id'),
    projectId: text(row, 'project_id'),
    routeId: text(row, 'route_id'),
    workspaceId: nullableText(row, 'workspace_id'),
    rootSessionId: text(row, 'root_session_id'),
    currentTaskId: nullableText(row, 'current_task_id'),
    status: text(row, 'status') as MeshGroupStatus,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function taskRow(row: Row): MeshTaskMeta {
  return {
    taskId: text(row, 'task_id'),
    projectId: text(row, 'project_id'),
    taskType: text(row, 'task_type') as MeshTaskType,
    priority: integer(row, 'priority'),
    enqueueSeq: integer(row, 'enqueue_seq'),
    workspaceId: nullableText(row, 'workspace_id'),
    rsiStateVersion: nullableText(row, 'rsi_state_version'),
    receiptRef: nullableText(row, 'receipt_ref'),
    jobId: nullableText(row, 'job_id'),
    gpuId: nullableInteger(row, 'gpu_id'),
    remoteStatus: nullableText(row, 'remote_status') as MeshTaskMeta['remoteStatus'],
    errorCode: nullableText(row, 'error_code'),
    errorMessage: nullableText(row, 'error_message'),
    payloadJson: text(row, 'payload_json'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function workspaceRow(row: Row): MeshWorkspaceRecord {
  return {
    workspaceId: text(row, 'workspace_id'),
    projectId: text(row, 'project_id'),
    teamId: nullableText(row, 'team_id'),
    path: text(row, 'path'),
    branch: text(row, 'branch'),
    baseCommit: text(row, 'base_commit'),
    status: text(row, 'status') as MeshWorkspaceStatus,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function leaseRow(row: Row): GpuLeaseRecord {
  return {
    leaseId: text(row, 'lease_id'),
    workerId: text(row, 'worker_id'),
    gpuId: integer(row, 'gpu_id'),
    taskId: text(row, 'task_id'),
    jobId: text(row, 'job_id'),
    attemptId: text(row, 'attempt_id'),
    state: text(row, 'state') as GpuLeaseState,
    verified: flag(row, 'verified'),
    acquiredAt: text(row, 'acquired_at'),
    releasedAt: nullableText(row, 'released_at'),
  };
}

function jobRow(row: Row): MeshJobRecord {
  return {
    jobId: text(row, 'job_id'),
    taskId: text(row, 'task_id'),
    attemptId: text(row, 'attempt_id'),
    projectId: text(row, 'project_id'),
    teamId: text(row, 'team_id'),
    workerId: text(row, 'worker_id'),
    gpuId: integer(row, 'gpu_id'),
    manifestJson: text(row, 'manifest_json'),
    manifestDigest: text(row, 'manifest_digest'),
    status: text(row, 'status') as MeshJobStatus,
    remoteDir: text(row, 'remote_dir'),
    submittedAt: nullableText(row, 'submitted_at'),
    updatedAt: text(row, 'updated_at'),
    errorCode: nullableText(row, 'error_code'),
    errorMessage: nullableText(row, 'error_message'),
  };
}

function projectRow(row: Row): MeshProjectRecord {
  return {
    projectId: text(row, 'project_id'),
    name: text(row, 'name'),
    description: text(row, 'description'),
    rsiStateRef: text(row, 'rsi_state_ref'),
    repositoryRef: text(row, 'repository_ref'),
    status: text(row, 'status') as MeshProjectStatus,
    runnable: flag(row, 'runnable'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function bindingRow(row: Row): MeshSessionBinding {
  return {
    bindingId: text(row, 'binding_id'),
    projectId: text(row, 'project_id'),
    sessionId: text(row, 'session_id'),
    role: text(row, 'role') as SessionRole,
    groupId: nullableText(row, 'group_id'),
    attachedAt: text(row, 'attached_at'),
    detachedAt: nullableText(row, 'detached_at'),
  };
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/** Durable Mesh metadata, stored in the integrated bridge database. */
export class MeshStore {
  readonly #store: SqliteTeamStore;

  /**
   * @param store - open integrated bridge store whose connection is reused.
   */
  constructor(store: SqliteTeamStore) {
    this.#store = store;
    this.#migrate();
  }

  /** The underlying bridge store. */
  get teamStore(): SqliteTeamStore {
    return this.#store;
  }

  #migrate(): void {
    this.#store.transaction(db => {
      db.exec(DDL);
      const found = db.prepare('SELECT value FROM mesh_meta WHERE key = ?').get('schema_version') as Row | undefined;
      if (found === undefined) {
        db.prepare('INSERT INTO mesh_meta (key, value) VALUES (?, ?)').run('schema_version', String(MESH_SCHEMA_VERSION));
        db.prepare('INSERT INTO mesh_meta (key, value) VALUES (?, ?)').run('created_at', nowIso());
      } else if (Number(text(found, 'value')) > MESH_SCHEMA_VERSION) {
        throw new MeshError('STORAGE_ERROR', 'mesh metadata schema is newer than this build', {
          found: Number(text(found, 'value')),
          supported: MESH_SCHEMA_VERSION,
        });
      }
    });
  }

  /** Execute a caller-owned transaction on the shared connection. */
  transaction<T>(work: () => T): T {
    return this.#store.transaction(() => work());
  }

  /** Read on the shared connection. */
  read<T>(work: (db: DatabaseSync) => T): T {
    return this.#store.read(work);
  }

  // -- projects and session bindings ---------------------------------------

  insertProject(record: MeshProjectRecord): void {
    this.#store.transaction(db => {
      try {
        db.prepare(`INSERT INTO mesh_projects
          (project_id, name, description, rsi_state_ref, repository_ref, status, runnable, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.projectId, record.name, record.description, record.rsiStateRef, record.repositoryRef,
            record.status, record.runnable ? 1 : 0, record.createdAt, record.updatedAt,
          );
      } catch (error) {
        if (uniqueViolation(error)) {
          throw new MeshError('PROJECT_CONFLICT', 'this RSI state is already registered to a project', {
            rsiStateRef: record.rsiStateRef,
          });
        }
        throw error;
      }
    });
  }

  getProject(projectId: string): MeshProjectRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_projects WHERE project_id = ?').get(projectId) as Row | undefined;
      return row === undefined ? undefined : projectRow(row);
    });
  }

  getProjectByState(rsiStateRef: string): MeshProjectRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_projects WHERE rsi_state_ref = ?').get(rsiStateRef) as Row | undefined;
      return row === undefined ? undefined : projectRow(row);
    });
  }

  listProjects(): readonly MeshProjectRecord[] {
    return this.#store.read(db => (db.prepare('SELECT * FROM mesh_projects ORDER BY created_at, project_id').all() as Row[]).map(projectRow));
  }

  updateProject(projectId: string, patch: {
    name?: string;
    description?: string;
    status?: MeshProjectStatus;
    runnable?: boolean;
    updatedAt?: string;
  }): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_projects WHERE project_id = ?').get(projectId) as Row | undefined;
      if (current === undefined) throw new MeshError('PROJECT_NOT_FOUND', `unknown project ${projectId}`, { projectId });
      db.prepare('UPDATE mesh_projects SET name = ?, description = ?, status = ?, runnable = ?, updated_at = ? WHERE project_id = ?')
        .run(
          patch.name ?? text(current, 'name'),
          patch.description ?? text(current, 'description'),
          patch.status ?? text(current, 'status'),
          patch.runnable === undefined ? integer(current, 'runnable') : (patch.runnable ? 1 : 0),
          patch.updatedAt ?? nowIso(),
          projectId,
        );
    });
  }

  insertBinding(record: MeshSessionBinding): void {
    this.#store.transaction(db => {
      try {
        db.prepare(`INSERT INTO mesh_session_bindings
          (binding_id, project_id, session_id, role, group_id, attached_at, detached_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.bindingId, record.projectId, record.sessionId, record.role,
            record.groupId, record.attachedAt, record.detachedAt,
          );
      } catch (error) {
        if (uniqueViolation(error)) {
          throw new MeshError('SESSION_BINDING_CONFLICT', 'session or captain binding is already active', {
            sessionId: record.sessionId,
            groupId: record.groupId,
          });
        }
        throw error;
      }
    });
  }

  getActiveBinding(sessionId: string): MeshSessionBinding | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_session_bindings WHERE session_id = ? AND detached_at IS NULL').get(sessionId) as Row | undefined;
      return row === undefined ? undefined : bindingRow(row);
    });
  }

  listBindings(projectId: string, activeOnly = false): readonly MeshSessionBinding[] {
    return this.#store.read(db => {
      const rows = activeOnly
        ? db.prepare('SELECT * FROM mesh_session_bindings WHERE project_id = ? AND detached_at IS NULL ORDER BY attached_at').all(projectId) as Row[]
        : db.prepare('SELECT * FROM mesh_session_bindings WHERE project_id = ? ORDER BY attached_at').all(projectId) as Row[];
      return rows.map(bindingRow);
    });
  }

  detachBinding(sessionId: string, detachedAt: string): boolean {
    return this.#store.transaction(db => {
      const result = db.prepare('UPDATE mesh_session_bindings SET detached_at = ? WHERE session_id = ? AND detached_at IS NULL')
        .run(detachedAt, sessionId);
      const changes = result.changes;
      return typeof changes === 'bigint' ? changes > 0n : changes > 0;
    });
  }

  // -- project pause bookkeeping -------------------------------------------

  recordProjectPauses(projectId: string, teamIds: readonly string[]): void {
    if (teamIds.length === 0) return;
    this.#store.transaction(db => {
      const statement = db.prepare('INSERT OR IGNORE INTO mesh_project_pauses (project_id, team_id) VALUES (?, ?)');
      for (const teamId of teamIds) statement.run(projectId, teamId);
    });
  }

  listProjectPauses(projectId: string): readonly string[] {
    return this.#store.read(db => (db.prepare('SELECT team_id FROM mesh_project_pauses WHERE project_id = ? ORDER BY team_id')
      .all(projectId) as Row[]).map(row => text(row, 'team_id')));
  }

  clearProjectPauses(projectId: string): void {
    this.#store.transaction(db => {
      db.prepare('DELETE FROM mesh_project_pauses WHERE project_id = ?').run(projectId);
    });
  }

  // -- groups --------------------------------------------------------------

  insertGroup(record: MeshGroupRecord): void {
    this.#store.transaction(db => {
      db.prepare(`INSERT INTO mesh_groups
        (team_id, project_id, route_id, workspace_id, root_session_id, current_task_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.teamId, record.projectId, record.routeId, record.workspaceId, record.rootSessionId,
          record.currentTaskId, record.status, record.createdAt, record.updatedAt,
        );
    });
  }

  getGroup(teamId: string): MeshGroupRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_groups WHERE team_id = ?').get(teamId) as Row | undefined;
      return row === undefined ? undefined : groupRow(row);
    });
  }

  listGroups(projectId?: string): readonly MeshGroupRecord[] {
    return this.#store.read(db => {
      const rows = projectId === undefined
        ? db.prepare('SELECT * FROM mesh_groups ORDER BY created_at, team_id').all() as Row[]
        : db.prepare('SELECT * FROM mesh_groups WHERE project_id = ? ORDER BY created_at, team_id').all(projectId) as Row[];
      return rows.map(groupRow);
    });
  }

  countGroups(projectId: string, statuses: readonly MeshGroupStatus[] = ['active', 'paused']): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => '?').join(',');
    return this.#store.read(db => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM mesh_groups WHERE project_id = ? AND status IN (${placeholders})`)
        .get(projectId, ...statuses) as Row;
      return integer(row, 'n');
    });
  }

  updateGroup(teamId: string, patch: {
    workspaceId?: string | null;
    currentTaskId?: string | null;
    status?: MeshGroupStatus;
    updatedAt?: string;
  }): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_groups WHERE team_id = ?').get(teamId) as Row | undefined;
      if (current === undefined) throw new MeshError('TEAM_NOT_FOUND', `unknown group ${teamId}`, { teamId });
      const next = {
        workspaceId: patch.workspaceId === undefined ? nullableText(current, 'workspace_id') : patch.workspaceId,
        currentTaskId: patch.currentTaskId === undefined ? nullableText(current, 'current_task_id') : patch.currentTaskId,
        status: patch.status ?? text(current, 'status'),
        updatedAt: patch.updatedAt ?? nowIso(),
      };
      db.prepare('UPDATE mesh_groups SET workspace_id = ?, current_task_id = ?, status = ?, updated_at = ? WHERE team_id = ?')
        .run(next.workspaceId, next.currentTaskId, next.status, next.updatedAt, teamId);
    });
  }

  // -- tasks ---------------------------------------------------------------

  insertTaskMeta(record: MeshTaskMeta): void {
    this.#store.transaction(db => {
      const next = db.prepare('SELECT COALESCE(MAX(enqueue_seq), 0) + 1 AS n FROM mesh_tasks').get() as Row;
      const enqueueSeq = integer(next, 'n');
      db.prepare(`INSERT INTO mesh_tasks
        (task_id, project_id, task_type, priority, enqueue_seq, workspace_id, rsi_state_version, receipt_ref,
         job_id, gpu_id, remote_status, error_code, error_message, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.taskId, record.projectId, record.taskType, record.priority, enqueueSeq, record.workspaceId,
          record.rsiStateVersion, record.receiptRef, record.jobId, record.gpuId, record.remoteStatus,
          record.errorCode, record.errorMessage, record.payloadJson, record.createdAt, record.updatedAt,
        );
    });
  }

  getTaskMeta(taskId: string): MeshTaskMeta | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_tasks WHERE task_id = ?').get(taskId) as Row | undefined;
      return row === undefined ? undefined : taskRow(row);
    });
  }

  listTaskMeta(projectId?: string): readonly MeshTaskMeta[] {
    return this.#store.read(db => {
      const rows = projectId === undefined
        ? db.prepare('SELECT * FROM mesh_tasks ORDER BY enqueue_seq, task_id').all() as Row[]
        : db.prepare('SELECT * FROM mesh_tasks WHERE project_id = ? ORDER BY enqueue_seq, task_id').all(projectId) as Row[];
      return rows.map(taskRow);
    });
  }

  updateTaskMeta(taskId: string, patch: {
    priority?: number;
    workspaceId?: string | null;
    rsiStateVersion?: string | null;
    receiptRef?: string | null;
    jobId?: string | null;
    gpuId?: number | null;
    remoteStatus?: MeshTaskMeta['remoteStatus'];
    errorCode?: string | null;
    errorMessage?: string | null;
    payloadJson?: string;
    updatedAt?: string;
  }): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_tasks WHERE task_id = ?').get(taskId) as Row | undefined;
      if (current === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown task ${taskId}`, { taskId });
      db.prepare(`UPDATE mesh_tasks SET priority = ?, workspace_id = ?, rsi_state_version = ?, receipt_ref = ?,
        job_id = ?, gpu_id = ?, remote_status = ?, error_code = ?, error_message = ?, payload_json = ?, updated_at = ? WHERE task_id = ?`)
        .run(
          patch.priority ?? integer(current, 'priority'),
          patch.workspaceId === undefined ? nullableText(current, 'workspace_id') : patch.workspaceId,
          patch.rsiStateVersion === undefined ? nullableText(current, 'rsi_state_version') : patch.rsiStateVersion,
          patch.receiptRef === undefined ? nullableText(current, 'receipt_ref') : patch.receiptRef,
          patch.jobId === undefined ? nullableText(current, 'job_id') : patch.jobId,
          patch.gpuId === undefined ? nullableInteger(current, 'gpu_id') : patch.gpuId,
          patch.remoteStatus === undefined ? nullableText(current, 'remote_status') : patch.remoteStatus,
          patch.errorCode === undefined ? nullableText(current, 'error_code') : patch.errorCode,
          patch.errorMessage === undefined ? nullableText(current, 'error_message') : patch.errorMessage,
          patch.payloadJson ?? text(current, 'payload_json'),
          patch.updatedAt ?? nowIso(),
          taskId,
        );
    });
  }

  // -- workspaces ----------------------------------------------------------

  insertWorkspace(record: MeshWorkspaceRecord): void {
    this.#store.transaction(db => {
      try {
        db.prepare(`INSERT INTO mesh_workspaces
          (workspace_id, project_id, team_id, path, branch, base_commit, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.workspaceId, record.projectId, record.teamId, record.path, record.branch,
            record.baseCommit, record.status, record.createdAt, record.updatedAt,
          );
      } catch (error) {
        if (uniqueViolation(error)) {
          throw new MeshError('PATH_CONFLICT', 'workspace path is already registered', { path: record.path });
        }
        throw error;
      }
    });
  }

  getWorkspace(workspaceId: string): MeshWorkspaceRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_workspaces WHERE workspace_id = ?').get(workspaceId) as Row | undefined;
      return row === undefined ? undefined : workspaceRow(row);
    });
  }

  getWorkspaceByPath(path: string): MeshWorkspaceRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_workspaces WHERE path = ?').get(path) as Row | undefined;
      return row === undefined ? undefined : workspaceRow(row);
    });
  }

  listWorkspaces(projectId?: string): readonly MeshWorkspaceRecord[] {
    return this.#store.read(db => {
      const rows = projectId === undefined
        ? db.prepare('SELECT * FROM mesh_workspaces ORDER BY created_at, workspace_id').all() as Row[]
        : db.prepare('SELECT * FROM mesh_workspaces WHERE project_id = ? ORDER BY created_at, workspace_id').all(projectId) as Row[];
      return rows.map(workspaceRow);
    });
  }

  updateWorkspace(workspaceId: string, patch: {
    teamId?: string | null;
    status?: MeshWorkspaceStatus;
    updatedAt?: string;
  }): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_workspaces WHERE workspace_id = ?').get(workspaceId) as Row | undefined;
      if (current === undefined) throw new MeshError('WORKSPACE_MISSING', `unknown workspace ${workspaceId}`, { workspaceId });
      db.prepare('UPDATE mesh_workspaces SET team_id = ?, status = ?, updated_at = ? WHERE workspace_id = ?')
        .run(
          patch.teamId === undefined ? nullableText(current, 'team_id') : patch.teamId,
          patch.status ?? text(current, 'status'),
          patch.updatedAt ?? nowIso(),
          workspaceId,
        );
    });
  }

  // -- attempts ------------------------------------------------------------

  insertAttempt(record: {
    attemptId: string;
    taskId: string;
    attemptNo: number;
    workerId: string;
    status: string;
    startedAt: string;
  }): void {
    this.#store.transaction(db => {
      db.prepare(`INSERT INTO mesh_attempts
        (attempt_id, task_id, attempt_no, worker_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(record.attemptId, record.taskId, record.attemptNo, record.workerId, record.status, record.startedAt);
    });
  }

  updateAttempt(attemptId: string, patch: {
    status?: string;
    finishedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_attempts WHERE attempt_id = ?').get(attemptId) as Row | undefined;
      if (current === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown attempt ${attemptId}`, { attemptId });
      db.prepare('UPDATE mesh_attempts SET status = ?, finished_at = ?, error_code = ?, error_message = ? WHERE attempt_id = ?')
        .run(
          patch.status ?? text(current, 'status'),
          patch.finishedAt === undefined ? nullableText(current, 'finished_at') : patch.finishedAt,
          patch.errorCode === undefined ? nullableText(current, 'error_code') : patch.errorCode,
          patch.errorMessage === undefined ? nullableText(current, 'error_message') : patch.errorMessage,
          attemptId,
        );
    });
  }

  // -- GPU leases ----------------------------------------------------------

  acquireLease(record: {
    workerId: string;
    gpuId: number;
    taskId: string;
    jobId: string;
    attemptId: string;
    now?: string;
  }): GpuLeaseRecord {
    const leaseId = newId('lease');
    const acquiredAt = record.now ?? nowIso();
    try {
      this.#store.transaction(db => {
        db.prepare(`INSERT INTO mesh_gpu_leases
          (lease_id, worker_id, gpu_id, task_id, job_id, attempt_id, state, verified, acquired_at, released_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reserved', 0, ?, NULL)`)
          .run(leaseId, record.workerId, record.gpuId, record.taskId, record.jobId, record.attemptId, acquiredAt);
      });
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new MeshError('GPU_LEASE_CONFLICT', `GPU ${record.gpuId} on ${record.workerId} already has a blocking lease`, {
          workerId: record.workerId,
          gpuId: record.gpuId,
        });
      }
      throw error;
    }
    return {
      leaseId, workerId: record.workerId, gpuId: record.gpuId, taskId: record.taskId,
      jobId: record.jobId, attemptId: record.attemptId, state: 'reserved', verified: false,
      acquiredAt, releasedAt: null,
    };
  }

  setLeaseState(leaseId: string, state: GpuLeaseState, verified?: boolean, releasedAt?: string | null): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_gpu_leases WHERE lease_id = ?').get(leaseId) as Row | undefined;
      if (current === undefined) throw new MeshError('GPU_LEASE_CONFLICT', `unknown lease ${leaseId}`, { leaseId });
      db.prepare('UPDATE mesh_gpu_leases SET state = ?, verified = ?, released_at = ? WHERE lease_id = ?')
        .run(
          state,
          verified === undefined ? integer(current, 'verified') : (verified ? 1 : 0),
          releasedAt === undefined ? nullableText(current, 'released_at') : releasedAt,
          leaseId,
        );
    });
  }

  getLease(leaseId: string): GpuLeaseRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_gpu_leases WHERE lease_id = ?').get(leaseId) as Row | undefined;
      return row === undefined ? undefined : leaseRow(row);
    });
  }

  getBlockingLease(workerId: string, gpuId: number): GpuLeaseRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare(`SELECT * FROM mesh_gpu_leases
        WHERE worker_id = ? AND gpu_id = ? AND state IN ('reserved','active','quarantined')`).get(workerId, gpuId) as Row | undefined;
      return row === undefined ? undefined : leaseRow(row);
    });
  }

  listLeases(taskId?: string): readonly GpuLeaseRecord[] {
    return this.#store.read(db => {
      const rows = taskId === undefined
        ? db.prepare('SELECT * FROM mesh_gpu_leases ORDER BY acquired_at, lease_id').all() as Row[]
        : db.prepare('SELECT * FROM mesh_gpu_leases WHERE task_id = ? ORDER BY acquired_at, lease_id').all(taskId) as Row[];
      return rows.map(leaseRow);
    });
  }

  countBlockingLeases(workerId: string): number {
    return this.#store.read(db => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM mesh_gpu_leases
        WHERE worker_id = ? AND state IN ('reserved','active','quarantined')`).get(workerId) as Row;
      return integer(row, 'n');
    });
  }

  // -- jobs ----------------------------------------------------------------

  insertJob(record: MeshJobRecord): void {
    this.#store.transaction(db => {
      db.prepare(`INSERT INTO mesh_jobs
        (job_id, task_id, attempt_id, project_id, team_id, worker_id, gpu_id, manifest_json,
         manifest_digest, status, remote_dir, submitted_at, updated_at, error_code, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.jobId, record.taskId, record.attemptId, record.projectId, record.teamId, record.workerId,
          record.gpuId, record.manifestJson, record.manifestDigest, record.status, record.remoteDir,
          record.submittedAt, record.updatedAt, record.errorCode, record.errorMessage,
        );
    });
  }

  getJob(jobId: string): MeshJobRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_jobs WHERE job_id = ?').get(jobId) as Row | undefined;
      return row === undefined ? undefined : jobRow(row);
    });
  }

  getJobByTask(taskId: string): MeshJobRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_jobs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as Row | undefined;
      return row === undefined ? undefined : jobRow(row);
    });
  }

  listJobs(statuses?: readonly MeshJobStatus[]): readonly MeshJobRecord[] {
    return this.#store.read(db => {
      const rows = statuses === undefined || statuses.length === 0
        ? db.prepare('SELECT * FROM mesh_jobs ORDER BY rowid').all() as Row[]
        : db.prepare(`SELECT * FROM mesh_jobs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY rowid`).all(...statuses) as Row[];
      return rows.map(jobRow);
    });
  }

  updateJob(jobId: string, patch: {
    status?: MeshJobStatus;
    remoteDir?: string;
    submittedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    updatedAt?: string;
  }): void {
    this.#store.transaction(db => {
      const current = db.prepare('SELECT * FROM mesh_jobs WHERE job_id = ?').get(jobId) as Row | undefined;
      if (current === undefined) throw new MeshError('TASK_NOT_FOUND', `unknown job ${jobId}`, { jobId });
      db.prepare(`UPDATE mesh_jobs SET status = ?, remote_dir = ?, submitted_at = ?, error_code = ?,
        error_message = ?, updated_at = ? WHERE job_id = ?`)
        .run(
          patch.status ?? text(current, 'status'),
          patch.remoteDir ?? text(current, 'remote_dir'),
          patch.submittedAt === undefined ? nullableText(current, 'submitted_at') : patch.submittedAt,
          patch.errorCode === undefined ? nullableText(current, 'error_code') : patch.errorCode,
          patch.errorMessage === undefined ? nullableText(current, 'error_message') : patch.errorMessage,
          patch.updatedAt ?? nowIso(),
          jobId,
        );
    });
  }

  // -- artifacts -----------------------------------------------------------

  insertArtifact(record: MeshArtifactRecord): void {
    this.#store.transaction(db => {
      try {
        db.prepare(`INSERT INTO mesh_artifacts
          (artifact_id, job_id, attempt_id, relative_path, sha256, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.artifactId, record.jobId, record.attemptId, record.relativePath,
            record.sha256, record.sizeBytes, record.createdAt,
          );
      } catch (error) {
        if (uniqueViolation(error)) {
          throw new MeshError('ARTIFACT_INVALID', 'artifact path is already recorded for this job', {
            jobId: record.jobId,
            path: record.relativePath,
          });
        }
        throw error;
      }
    });
  }

  listArtifacts(jobId: string): readonly MeshArtifactRecord[] {
    return this.#store.read(db => {
      const rows = db.prepare('SELECT * FROM mesh_artifacts WHERE job_id = ? ORDER BY relative_path').all(jobId) as Row[];
      return rows.map(row => ({
        artifactId: text(row, 'artifact_id'),
        jobId: text(row, 'job_id'),
        attemptId: text(row, 'attempt_id'),
        relativePath: text(row, 'relative_path'),
        sha256: text(row, 'sha256'),
        sizeBytes: integer(row, 'size_bytes'),
        createdAt: text(row, 'created_at'),
      }));
    });
  }

  // -- events and outcomes -------------------------------------------------

  appendEvent(entityType: string, entityId: string, kind: string, payload: unknown): void {
    this.#store.transaction(db => {
      db.prepare('INSERT INTO mesh_events (entity_type, entity_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(entityType, entityId, kind, JSON.stringify(payload), nowIso());
    });
  }

  listEvents(entityType: string, entityId: string): readonly MeshEventRecord[] {
    return this.#store.read(db => {
      const rows = db.prepare('SELECT * FROM mesh_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq')
        .all(entityType, entityId) as Row[];
      return rows.map(row => ({
        seq: integer(row, 'seq'),
        entityType: text(row, 'entity_type'),
        entityId: text(row, 'entity_id'),
        kind: text(row, 'kind'),
        payloadJson: text(row, 'payload_json'),
        createdAt: text(row, 'created_at'),
      }));
    });
  }

  recordAgentModel(record: AgentModelRecord): void {
    this.#store.transaction(db => {
      db.prepare(`INSERT INTO mesh_agent_models
        (session_id, team_id, role, name, provider, model, source, config_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.sessionId, record.teamId, record.role, record.name, record.provider,
          record.model, record.source, record.configVersion, record.createdAt,
        );
    });
  }

  getAgentModel(sessionId: string): AgentModelRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_agent_models WHERE session_id = ?').get(sessionId) as Row | undefined;
      if (row === undefined) return undefined;
      return {
        sessionId: text(row, 'session_id'),
        teamId: text(row, 'team_id'),
        role: text(row, 'role'),
        name: text(row, 'name'),
        provider: text(row, 'provider'),
        model: text(row, 'model'),
        source: text(row, 'source'),
        configVersion: text(row, 'config_version'),
        createdAt: text(row, 'created_at'),
      };
    });
  }

  listAgentModels(teamId?: string): readonly AgentModelRecord[] {
    return this.#store.read(db => {
      const rows = teamId === undefined
        ? db.prepare('SELECT * FROM mesh_agent_models ORDER BY created_at, session_id').all() as Row[]
        : db.prepare('SELECT * FROM mesh_agent_models WHERE team_id = ? ORDER BY created_at, session_id').all(teamId) as Row[];
      return rows.map(row => ({
        sessionId: text(row, 'session_id'),
        teamId: text(row, 'team_id'),
        role: text(row, 'role'),
        name: text(row, 'name'),
        provider: text(row, 'provider'),
        model: text(row, 'model'),
        source: text(row, 'source'),
        configVersion: text(row, 'config_version'),
        createdAt: text(row, 'created_at'),
      }));
    });
  }

  listRecentEvents(limit = 50): readonly MeshEventRecord[] {
    return this.#store.read(db => {
      const rows = db.prepare('SELECT * FROM mesh_events ORDER BY seq DESC LIMIT ?').all(limit) as Row[];
      return rows.map(row => ({
        seq: integer(row, 'seq'),
        entityType: text(row, 'entity_type'),
        entityId: text(row, 'entity_id'),
        kind: text(row, 'kind'),
        payloadJson: text(row, 'payload_json'),
        createdAt: text(row, 'created_at'),
      }));
    });
  }

  insertOutcome(record: MeshOutcomeRecord): void {
    this.#store.transaction(db => {
      db.prepare(`INSERT INTO mesh_outcomes
        (job_id, experiment_id, receipt_id, state_version, artifact_manifest_digest, status, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.jobId, record.experimentId, record.receiptId, record.stateVersion,
          record.artifactManifestDigest, record.status, record.payloadJson, record.createdAt,
        );
    });
  }

  getOutcome(jobId: string): MeshOutcomeRecord | undefined {
    return this.#store.read(db => {
      const row = db.prepare('SELECT * FROM mesh_outcomes WHERE job_id = ?').get(jobId) as Row | undefined;
      if (row === undefined) return undefined;
      return {
        jobId: text(row, 'job_id'),
        experimentId: text(row, 'experiment_id'),
        receiptId: text(row, 'receipt_id'),
        stateVersion: text(row, 'state_version'),
        artifactManifestDigest: text(row, 'artifact_manifest_digest'),
        status: text(row, 'status') as MeshOutcomeRecord['status'],
        payloadJson: text(row, 'payload_json'),
        createdAt: text(row, 'created_at'),
      };
    });
  }
}

/** Re-export the SQL value union for callers that build custom statements. */
export type { SqlValue };
