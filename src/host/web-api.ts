/**
 * Plugin-owned HTTP API for the Research Mesh console.
 *
 * The DSH launch-token gate protects the application index, not plugin routes.
 * Every mutation therefore enforces same-origin, `application/json`, a bounded
 * body and an explicit JSON envelope. Reads never expose credentials; the model
 * catalog contains provider/model identifiers only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { MeshError } from '../errors.ts';
import type { MeshService } from '../service.ts';

/** Structural subset of DSH's public `ctx.webServer` service. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/** Route prefix owned by this plugin. */
export const API_PREFIX = '/dsh-research-mesh/api';

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 256 * 1024;

const STATUS_FOR: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  CONFIG_INVALID: 400,
  MODEL_CONFIG_INVALID: 400,
  PATH_ESCAPE: 400,
  PATH_CONFLICT: 409,
  PROJECT_NOT_FOUND: 404,
  PROJECT_CONFLICT: 409,
  TEAM_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  WORKSPACE_MISSING: 404,
  SESSION_BINDING_CONFLICT: 409,
  SESSION_NOT_FOUND: 404,
  RSI_STATE_UNAVAILABLE: 409,
  RSI_INVALID: 409,
  TEAM_LIMIT: 409,
  TEAM_CONFLICT: 409,
  TEAM_STATE_INVALID: 409,
  SUBAGENT_BUSY: 409,
  GPU_LEASE_CONFLICT: 409,
  EXECUTOR_DISABLED: 409,
  SUBAGENT_LIMIT: 409,
  GPU_UNAVAILABLE: 409,
  MANDATE_REVOKED: 409,
  MANDATE_SCOPE_VIOLATION: 409,
  MANDATE_REVALIDATION_REQUIRED: 409,
  RLP_GATE_HOLD: 409,
  AUTONOMY_DENIED: 409,
  POLICY_BLOCKED: 409,
};

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function fail(res: ServerResponse, error: unknown): void {
  const meshError = error instanceof MeshError
    ? error
    : new MeshError('INTERNAL', error instanceof Error ? error.message : String(error));
  const status = STATUS_FOR[meshError.code] ?? (meshError.code === 'INTERNAL' ? 500 : 400);
  send(res, status, { ok: false, error: { code: meshError.code, message: meshError.message } });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin');
  if (origin === undefined) return true;
  const host = header(req, 'host');
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new MeshError('INVALID_ARGUMENT', 'request body is too large');
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new MeshError('INVALID_ARGUMENT', 'request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MeshError('INVALID_ARGUMENT', 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MeshError('INVALID_ARGUMENT', `${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Build the HTTP handler over one Mesh service.
 * @param service - initialized Mesh service.
 * @returns Node request handler.
 */
export function createMeshApiHandler(service: MeshService): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://mesh.local');
      if (!url.pathname.startsWith(API_PREFIX)) {
        send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown research mesh route' } });
        return;
      }
      const path = url.pathname.slice(API_PREFIX.length) || '/';
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'only GET and POST are supported' } });
        return;
      }
      if (method === 'POST') {
        if (!sameOrigin(req)) {
          send(res, 403, { ok: false, error: { code: 'CROSS_ORIGIN', message: 'cross-origin mutations are refused' } });
          return;
        }
        if (!(header(req, 'content-type') ?? '').toLowerCase().startsWith('application/json')) {
          send(res, 415, { ok: false, error: { code: 'CONTENT_TYPE', message: 'content-type must be application/json' } });
          return;
        }
      }
      if (path === '/bootstrap' && method === 'GET') {
        const projects = service.listProjects();
        const modelSettings = service.getModelSettings();
        const catalog = await service.listModelCatalog();
        send(res, 200, {
          ok: true,
          value: {
            projects,
            modelSettings,
            catalog,
            modelErrors: await service.modelSettingsDiagnostics(),
            worker: service.workerStatus(),
            generatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      if (path === '/workbench' && method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        if (projectId === null) throw new MeshError('INVALID_ARGUMENT', 'projectId is required');
        send(res, 200, { ok: true, value: await service.projectWorkbench(projectId) });
        return;
      }
      if (path === '/projects/inspect' && method === 'POST') {
        const body = await readJson(req);
        send(res, 200, { ok: true, value: service.inspectProjectRepository(stringField(body, 'repositoryRef')) });
        return;
      }
      if (path === '/projects/initialize' && method === 'POST') {
        const body = await readJson(req);
        send(res, 200, { ok: true, value: service.initializeProjectRuntime(stringField(body, 'repositoryRef')) });
        return;
      }
      if (path === '/projects' && method === 'POST') {
        const body = await readJson(req);
        const project = service.createProject({
          name: stringField(body, 'name'),
          description: typeof body.description === 'string' ? body.description : '',
          rsiStateRef: stringField(body, 'rsiStateRef'),
          repositoryRef: stringField(body, 'repositoryRef'),
        });
        send(res, 200, { ok: true, value: project });
        return;
      }
      if (path === '/projects/status' && method === 'POST') {
        const body = await readJson(req);
        const status = stringField(body, 'status');
        if (status !== 'active' && status !== 'paused' && status !== 'archived' && status !== 'registered') {
          throw new MeshError('INVALID_ARGUMENT', 'invalid project status');
        }
        send(res, 200, { ok: true, value: service.setProjectStatus(stringField(body, 'projectId'), status) });
        return;
      }
      if (path === '/sessions/control' && method === 'POST') {
        const body = await readJson(req);
        const projectId = stringField(body, 'projectId');
        const result = await service.createControlSession(projectId);
        send(res, 200, { ok: true, value: result });
        return;
      }
      if (path === '/sessions/attach' && method === 'POST') {
        const body = await readJson(req);
        const result = service.attachSession(stringField(body, 'projectId'), stringField(body, 'sessionId'));
        send(res, 200, { ok: true, value: result });
        return;
      }
      if (path === '/sessions/detach' && method === 'POST') {
        const body = await readJson(req);
        send(res, 200, { ok: true, value: { detached: service.detachSession(stringField(body, 'sessionId')) } });
        return;
      }
      if (path === '/groups' && method === 'POST') {
        const body = await readJson(req);
        const projectId = stringField(body, 'projectId');
        const name = stringField(body, 'name');
        const routeId = stringField(body, 'routeId');
        const rootSessionId = body.rootSessionId;
        if (rootSessionId !== undefined && (typeof rootSessionId !== 'string' || rootSessionId.trim() === '')) {
          throw new MeshError('INVALID_ARGUMENT', 'rootSessionId must be a non-empty string');
        }
        const team = await service.createGroup({
          projectId, routeId, name,
          ...(typeof rootSessionId === 'string' ? { rootSessionId } : {}),
        });
        send(res, 200, { ok: true, value: team });
        return;
      }
      if (path === '/groups/state' && method === 'POST') {
        const body = await readJson(req);
        const teamId = stringField(body, 'teamId');
        const action = stringField(body, 'action');
        if (action === 'pause') {
          send(res, 200, { ok: true, value: { team: service.pauseTeam(teamId) } });
          return;
        }
        if (action === 'resume') {
          send(res, 200, { ok: true, value: { team: service.resumeTeam(teamId) } });
          return;
        }
        if (action === 'stop') {
          send(res, 200, { ok: true, value: service.stopTeam(teamId) });
          return;
        }
        if (action === 'destroy') {
          if (body.confirm !== true) {
            throw new MeshError('INVALID_ARGUMENT', 'group destruction requires explicit confirmation');
          }
          send(res, 200, { ok: true, value: { team: await service.destroyTeam(teamId) } });
          return;
        }
        throw new MeshError('INVALID_ARGUMENT', 'group action must be pause, resume, stop or destroy');
      }
      if (path === '/subagents' && method === 'POST') {
        const body = await readJson(req);
        const teamId = stringField(body, 'teamId');
        const name = stringField(body, 'name');
        const role = stringField(body, 'role');
        if (!['discovery', 'theory', 'literature', 'experiment', 'assurance', 'synthesis'].includes(role)) {
          throw new MeshError('INVALID_ARGUMENT', 'invalid subagent role');
        }
        const sessionId = body.sessionId;
        if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.trim() === '')) {
          throw new MeshError('INVALID_ARGUMENT', 'sessionId must be a non-empty string');
        }
        const subagent = await service.registerSubagent({
          teamId,
          name,
          role: role as 'discovery' | 'theory' | 'literature' | 'experiment' | 'assurance' | 'synthesis',
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
        });
        send(res, 200, { ok: true, value: subagent });
        return;
      }
      if (path === '/model-settings' && method === 'GET') {
        send(res, 200, {
          ok: true,
          value: {
            document: service.getModelSettings(),
            catalog: await service.listModelCatalog(),
            errors: await service.modelSettingsDiagnostics(),
          },
        });
        return;
      }
      if (path === '/model-settings' && method === 'POST') {
        const body = await readJson(req);
        if (body.document === undefined) throw new MeshError('INVALID_ARGUMENT', 'document is required');
        const document = await service.saveModelSettings(body.document);
        send(res, 200, {
          ok: true,
          value: { document, catalog: await service.listModelCatalog(), errors: await service.modelSettingsDiagnostics() },
        });
        return;
      }
      if (path === '/simulate' && method === 'POST') {
        const body = await readJson(req);
        const projectId = stringField(body, 'projectId');
        const teamId = typeof body.teamId === 'string' && body.teamId !== '' ? body.teamId : undefined;
        send(res, 200, { ok: true, value: await service.simulateLocalTask(projectId, teamId) });
        return;
      }
      if (path === '/autonomy' && method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        if (projectId === null) throw new MeshError('INVALID_ARGUMENT', 'projectId is required');
        send(res, 200, {
          ok: true,
          value: {
            status: service.autonomyStatus(projectId),
            tickets: service.listTickets(projectId),
            triggers: service.listTriggers(projectId, 50),
            rlp: service.rlpStatus(),
          },
        });
        return;
      }
      if (path === '/triggers' && method === 'POST') {
        const body = await readJson(req);
        const source = stringField(body, 'source');
        if (!['user', 'session', 'ticket_followup', 'team_task', 'compute_job', 'artifact', 'rlp_outcome', 'rlp_assurance', 'resource', 'policy', 'resume'].includes(source)) {
          throw new MeshError('INVALID_ARGUMENT', 'invalid trigger source');
        }
        const kind = stringField(body, 'kind');
        const result = service.recordTrigger({
          source: source as never,
          eventId: stringField(body, 'eventId'),
          projectId: stringField(body, 'projectId'),
          kind: kind as never,
          explicit: body.explicit === true,
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.ticketId === 'string' ? { ticketId: body.ticketId } : {}),
          ...(typeof body.threadKey === 'string' ? { threadKey: body.threadKey } : {}),
          ...(typeof body.payload === 'object' && body.payload !== null ? { payload: body.payload as Record<string, unknown> } : {}),
        });
        send(res, 200, { ok: true, value: result });
        return;
      }
      if (path === '/tickets' && method === 'POST') {
        const body = await readJson(req);
        const ticket = service.createTicket({
          projectId: stringField(body, 'projectId'),
          routeId: stringField(body, 'routeId'),
          title: stringField(body, 'title'),
          triggerId: stringField(body, 'triggerId'),
          explicit: body.explicit === true,
          ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
          ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
          ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
          ...(body.kind === 'research' || body.kind === 'engineering' ? { kind: body.kind } : {}),
        });
        send(res, 200, { ok: true, value: ticket });
        return;
      }
      if (path === '/tickets/state' && method === 'POST') {
        const body = await readJson(req);
        const ticketId = stringField(body, 'ticketId');
        const action = stringField(body, 'action');
        if (action === 'stop') {
          send(res, 200, { ok: true, value: service.stopTicket(ticketId, typeof body.reason === 'string' ? body.reason : 'operator stop') });
          return;
        }
        if (action === 'resume') {
          send(res, 200, { ok: true, value: service.resumeTicket(ticketId, body.explicit === true) });
          return;
        }
        if (action === 'assign') {
          send(res, 200, { ok: true, value: service.assignTicket(ticketId, stringField(body, 'teamId')) });
          return;
        }
        if (action === 'start') {
          send(res, 200, { ok: true, value: service.startTicketAssignment(stringField(body, 'assignmentId')) });
          return;
        }
        if (action === 'finish') {
          send(res, 200, {
            ok: true,
            value: service.finishTicketAssignment(stringField(body, 'assignmentId'), {
              ok: body.ok === true,
              ...(typeof body.errorCode === 'string' ? { errorCode: body.errorCode } : {}),
              ...(typeof body.errorMessage === 'string' ? { errorMessage: body.errorMessage } : {}),
            }),
          });
          return;
        }
        if (action === 'wait') {
          send(res, 200, { ok: true, value: service.waitTicketForHuman(ticketId, stringField(body, 'reason')) });
          return;
        }
        if (action === 'end') {
          const reason = stringField(body, 'reason');
          if (reason !== 'completed' && reason !== 'failed' && reason !== 'cancelled') {
            throw new MeshError('INVALID_ARGUMENT', 'end reason must be completed, failed or cancelled');
          }
          send(res, 200, { ok: true, value: service.endTicket(ticketId, reason) });
          return;
        }
        throw new MeshError('INVALID_ARGUMENT', 'ticket action must be stop, resume, assign, start, finish, wait or end');
      }
      if (path === '/autonomy/mode' && method === 'POST') {
        const body = await readJson(req);
        const mode = stringField(body, 'mode');
        if (mode !== 'off' && mode !== 'observe' && mode !== 'auto') {
          throw new MeshError('INVALID_ARGUMENT', 'mode must be off, observe or auto');
        }
        send(res, 200, { ok: true, value: service.setAutonomyMode(mode) });
        return;
      }
      if (path === '/rlp' && method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        const storage = projectId === null ? null : await service.rlpStorage();
        send(res, 200, { ok: true, value: { status: service.rlpStatus(), storage } });
        return;
      }
      if (path === '/native-delegation' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null) throw new MeshError('INVALID_ARGUMENT', 'sessionId is required');
        send(res, 200, {
          ok: true,
          value: {
            sessionId,
            denial: service.nativeSubagentDenial(sessionId) ?? null,
          },
        });
        return;
      }
      if (path === '/session' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null) throw new MeshError('INVALID_ARGUMENT', 'sessionId is required');
        const binding = service.sessionBinding(sessionId) ?? null;
        let projectName: string | null = null;
        if (binding !== null) {
          try { projectName = service.getProject(binding.projectId).name } catch { projectName = null }
        }
        send(res, 200, {
          ok: true,
          value: {
            binding,
            projectName,
            liveStatus: service.agentStatus(sessionId) ?? null,
          },
        });
        return;
      }
      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown research mesh route' } });
    } catch (error) {
      fail(res, error);
    }
  };
}

/**
 * Register the API while a `webServer` service exists.
 * @param ctx - plugin context exposing `inject` and `effect`.
 * @param service - initialized Mesh service.
 * @returns the injection disposer.
 */
export function registerMeshApi(
  ctx: {
    inject(services: readonly string[], callback: (child: {
      effect(body: () => (() => void) | Promise<() => void>, label: string): unknown;
      webServer: WebServerLike;
    }) => void): unknown;
  },
  service: MeshService,
): unknown {
  return ctx.inject(['webServer'], child => {
    const handler = createMeshApiHandler(service);
    child.effect(
      () => child.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'dsh-research-mesh HTTP API',
    );
  });
}
