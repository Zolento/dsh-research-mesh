/**
 * Root-session binding for groups.
 *
 * Production uses the host's `SessionController`/`ctx.agents` services so each
 * group owns a real DSH session and each member identity is a durable DSH
 * session. SessionController sessions are workspace-backed and Web-openable;
 * the AgentRegistry fallback can create a true child agent when no controller
 * is available. The Mesh never invents a chat log; session persistence, context
 * and model routing stay with DSH.
 */

import { MeshError } from '../errors.ts';
import type { SessionBinding } from '../config/types.ts';
import { ID_PREFIX, newId, requireSlug } from '../util/ids.ts';

/** Input for creating one group root session. */
export interface CreateRootSessionInput {
  readonly teamId: string;
  readonly projectId: string;
  readonly name: string;
  readonly cwd: string;
  readonly title: string;
  readonly provider?: string;
  readonly model?: string;
}

/** Input for creating one real child-agent identity. */
export interface CreateSubagentIdentityInput {
  readonly teamId: string;
  readonly rootSessionId: string;
  readonly name: string;
  readonly role: string;
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
}

/** Session binding seam used by the Team Manager. */
export interface SessionHost {
  /** Binding mode recorded in the group registry. */
  readonly binding: SessionBinding | 'test';
  /**
   * Create a root session for a group.
   * @param input - identity, cwd and model route.
   * @returns the durable session id.
   */
  createRoot(input: CreateRootSessionInput): Promise<{ sessionId: string }>;
  /**
   * Create a standalone control session (a normal DSH chat) with no team parent.
   * @param input - identity, cwd and model route.
   * @returns the durable session id.
   */
  createControl(input: CreateRootSessionInput): Promise<{ sessionId: string }>;
  /**
   * Create a child agent identity under a live root.
   * @param input - parent, identity and role.
   * @returns the durable child session id.
   */
  createSubagent(input: CreateSubagentIdentityInput): Promise<{ sessionId: string }>;
  /**
   * Resume a persisted root session after a process restart.
   * @param sessionId - durable session id.
   */
  resumeRoot(sessionId: string, provider?: string, model?: string): Promise<void>;
  /**
   * Release the live handle for a root session. The persisted session is kept.
   * @param sessionId - durable session id.
   */
  disposeRoot(sessionId: string): Promise<void>;
  /** Release every live handle owned by this host. */
  disposeAll(): Promise<void>;
}

/** Minimal structural view of the DSH services this adapter uses. */
export interface DshAgentsLike {
  create(options: {
    sessionId: string;
    agentOptions?: { provider: string; model: string };
    meta?: { cwd?: string; parentSession?: string; origin?: 'subagent'; delegationDepth?: number };
    parentAgent?: unknown;
    setup?: (agentCtx: unknown, agent: unknown) => void;
  }): Promise<{ agent: DshAgentLike; dispose(): Promise<void> }>;
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider: string; model: string };
  }): Promise<{ agent: DshAgentLike; dispose(): Promise<void> }>;
  get?(id: string): DshAgentLike | undefined;
}

/** Minimal structural view of a live DSH Agent. */
export interface DshAgentLike {
  readonly id: string;
  readonly status?: string;
  cancel?: (cause: unknown, options?: { keepInbox?: boolean }) => void;
}

/** Structural subset of the Host SessionController used for Web-openable sessions. */
export interface DshSessionControllerLike {
  create(request: { cwd?: string; workspaceId?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>;
}

/** Structural subset of the Host WorkspaceController. */
export interface DshWorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: { workspaceId: string } }>;
  insertSessionBefore?(request: { workspaceId: string; sessionId: string; beforeSessionId?: string }): Promise<unknown>;
}

/** Host context subset used by {@link DshSessionHost}. */
export interface DshHostContext {
  readonly agents?: DshAgentsLike;
  readonly sessionController?: DshSessionControllerLike;
  readonly workspaceController?: DshWorkspaceControllerLike;
}

/** Production session host backed by DSH's AgentRegistry. */
export class DshSessionHost implements SessionHost {
  readonly binding = 'dsh' as const;
  readonly #ctx: DshHostContext;
  #agents: DshAgentsLike | undefined;
  readonly #handles = new Map<string, { agent: DshAgentLike; dispose(): Promise<void> }>();
  readonly #controllerSessions = new Set<string>();
  #sessionController: DshSessionControllerLike | undefined;
  #workspaceController: DshWorkspaceControllerLike | undefined;

  /** Attach the Host AgentRegistry when it appears after plugin activation. */
  attachAgents(agents: DshAgentsLike): void {
    this.#agents = agents;
  }

  /** Attach the Host SessionController when it appears after plugin activation. */
  attachSessionController(controller: DshSessionControllerLike): void {
    this.#sessionController = controller;
  }

  /** Attach the Host WorkspaceController when it appears after plugin activation. */
  attachWorkspaceController(controller: DshWorkspaceControllerLike): void {
    this.#workspaceController = controller;
  }

  #discardControllerSession(sessionId: string, reason: string): void {
    this.#controllerSessions.delete(sessionId);
    try {
      this.#agents?.get?.(sessionId)?.cancel?.({ kind: 'mesh-controller-failure', reason });
    } catch {
      // Session persistence remains; no better cleanup primitive is exposed.
    }
  }

  /**
   * @param ctx - host context exposing `agents`.
   */
  constructor(ctx: DshHostContext) {
    this.#ctx = ctx;
    this.#agents = ctx.agents;
    this.#sessionController = ctx.sessionController;
    this.#workspaceController = ctx.workspaceController;
  }

  /**
   * Create a root agent with its own persisted session.
   * @param input - group identity, cwd and model route.
   * @returns session id.
   */
  async createRoot(input: CreateRootSessionInput): Promise<{ sessionId: string }> {
    const agents = this.#agents;
    if (agents === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'DSH agents service is unavailable; cannot create a root session', {
        teamId: input.teamId,
      });
    }
    if (input.provider === undefined || input.model === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'agent.provider and agent.model are required to create a DSH root session', {
        teamId: input.teamId,
      });
    }
    const controller = this.#sessionController;
    if (controller !== undefined) {
      let workspaceId: string | undefined;
      if (this.#workspaceController !== undefined) {
        try {
          const workspace = await this.#workspaceController.create({ path: input.cwd });
          workspaceId = workspace.workspace.workspaceId;
        } catch {
          workspaceId = undefined;
        }
      }
      const created = await controller.create(workspaceId === undefined ? { cwd: input.cwd } : { workspaceId });
      try {
        await controller.selectModel({
          sessionId: created.sessionId,
          provider: input.provider,
          model: input.model,
        });
      } catch (error) {
        this.#discardControllerSession(created.sessionId, 'root model selection failed');
        throw error;
      }
      this.#controllerSessions.add(created.sessionId);
      return { sessionId: created.sessionId };
    }
    const sessionId = `mesh-${requireSlug(input.name, 'group name')}-${newId(ID_PREFIX.team).slice(-13)}`;
    const handle = await agents.create({
      sessionId,
      agentOptions: { provider: input.provider, model: input.model },
      meta: { cwd: input.cwd },
    });
    this.#handles.set(sessionId, handle);
    return { sessionId };
  }

  /**
   * Create a real child agent under the group root. This is a DSH agent
   * identity; Mesh quotas govern it, and the native `subagent` tool remains a
   * separate creation path documented as not globally intercepted.
   * @param input - parent, identity and model route.
   * @returns child session id.
   */
  async createControl(input: CreateRootSessionInput): Promise<{ sessionId: string }> {
    const agents = this.#agents;
    if (agents === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'DSH agents service is unavailable; cannot create a control session', {
        teamId: input.teamId,
      });
    }
    if (input.provider === undefined || input.model === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'agent.provider and agent.model are required to create a DSH control session', {
        teamId: input.teamId,
      });
    }
    const controller = this.#sessionController;
    if (controller !== undefined) {
      let workspaceId: string | undefined;
      if (this.#workspaceController !== undefined) {
        try {
          const workspace = await this.#workspaceController.create({ path: input.cwd });
          workspaceId = workspace.workspace.workspaceId;
        } catch {
          workspaceId = undefined;
        }
      }
      const created = await controller.create(workspaceId === undefined ? { cwd: input.cwd } : { workspaceId });
      try {
        await controller.selectModel({
          sessionId: created.sessionId,
          provider: input.provider,
          model: input.model,
        });
      } catch (error) {
        this.#discardControllerSession(created.sessionId, 'root model selection failed');
        throw error;
      }
      this.#controllerSessions.add(created.sessionId);
      return { sessionId: created.sessionId };
    }
    const sessionId = `mesh-control-${newId(ID_PREFIX.team).slice(-13)}`;
    const handle = await agents.create({
      sessionId,
      agentOptions: { provider: input.provider, model: input.model },
      meta: { cwd: input.cwd },
    });
    this.#handles.set(sessionId, handle);
    return { sessionId };
  }

  async createSubagent(input: CreateSubagentIdentityInput): Promise<{ sessionId: string }> {
    if (input.provider === undefined || input.model === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'agent.provider and agent.model are required to create a DSH subagent', {
        teamId: input.teamId,
      });
    }
    const controller = this.#sessionController;
    if (controller !== undefined) {
      // SessionController-owned member sessions survive a restart without
      // requiring the Captain Agent to be live first.
      let workspaceId: string | undefined;
      if (this.#workspaceController !== undefined) {
        try {
          const workspace = await this.#workspaceController.create({ path: input.cwd });
          workspaceId = workspace.workspace.workspaceId;
        } catch {
          workspaceId = undefined;
        }
      }
      const created = await controller.create(workspaceId === undefined ? { cwd: input.cwd } : { workspaceId });
      try {
        await controller.selectModel({
          sessionId: created.sessionId,
          provider: input.provider,
          model: input.model,
        });
      } catch (error) {
        this.#discardControllerSession(created.sessionId, 'member model selection failed');
        throw error;
      }
      this.#controllerSessions.add(created.sessionId);
      return { sessionId: created.sessionId };
    }
    const agents = this.#agents;
    if (agents === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'DSH agents service is unavailable; cannot create a subagent', {
        teamId: input.teamId,
      });
    }
    const rootHandle = this.#handles.get(input.rootSessionId);
    const parentAgent = rootHandle?.agent ?? agents.get?.(input.rootSessionId);
    if (parentAgent === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'root session is not live in this runtime', {
        teamId: input.teamId,
        rootSessionId: input.rootSessionId,
      });
    }
    const sessionId = `mesh-${requireSlug(input.name, 'subagent name')}-${newId(ID_PREFIX.subagent).slice(-13)}`;
    const handle = await agents.create({
      sessionId,
      parentAgent,
      agentOptions: { provider: input.provider, model: input.model },
      meta: {
        cwd: input.cwd,
        parentSession: input.rootSessionId,
        origin: 'subagent',
        delegationDepth: 1,
      },
    });
    this.#handles.set(sessionId, handle);
    if (this.#workspaceController !== undefined && this.#workspaceController.insertSessionBefore !== undefined) {
      try {
        const workspace = await this.#workspaceController.create({ path: input.cwd });
        await this.#workspaceController.insertSessionBefore({
          workspaceId: workspace.workspace.workspaceId,
          sessionId,
        });
      } catch {
        // Workspace grouping is a presentation association; the child Session
        // and its parent relationship remain valid without it.
      }
    }
    return { sessionId };
  }

  /**
   * Resume a persisted root session.
   * @param sessionId - durable session id.
   * @param provider - model provider.
   * @param model - model id.
   */
  async resumeRoot(sessionId: string, provider?: string, model?: string): Promise<void> {
    const agents = this.#agents;
    if (agents === undefined) {
      throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'DSH agents service is unavailable; cannot resume a root session', {
        sessionId,
      });
    }
    if (this.#handles.has(sessionId)) return;
    const options = provider !== undefined && model !== undefined
      ? { resumeSessionId: sessionId, agentOptions: { provider, model } }
      : { resumeSessionId: sessionId };
    const handle = await agents.resume(options);
    this.#handles.set(sessionId, handle);
  }

  /**
   * Release one live handle; the persisted session remains on disk.
   * @param sessionId - session id.
   */
  async disposeRoot(sessionId: string): Promise<void> {
    if (this.#controllerSessions.delete(sessionId)) {
      // Stop the live Agent but retain the durable Session and its history.
      const resumedHandle = this.#handles.get(sessionId);
      if (resumedHandle !== undefined) {
        this.#handles.delete(sessionId);
        try { await resumedHandle.dispose(); } catch { /* retain */ }
      }
      try { this.#agents?.get?.(sessionId)?.cancel?.({ kind: 'mesh-group-disposed' }); } catch { /* retain */ }
      return;
    }
    const handle = this.#handles.get(sessionId);
    if (handle === undefined) return;
    this.#handles.delete(sessionId);
    await handle.dispose();
  }

  /** Release every live handle owned by this host. */
  async disposeAll(): Promise<void> {
    // SessionController owns these Agents. Plugin reload must not cancel live
    // research conversations; explicit group destruction disposes one session.
    this.#controllerSessions.clear();
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    const failures: unknown[] = [];
    for (const handle of handles) {
      try { await handle.dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new MeshError('INTERNAL', 'one or more DSH session handles failed to dispose', { failures: failures.length });
    }
  }
}

/**
 * Explicit external binding: the caller supplies a durable root session id.
 * Use only when another trusted component owns session creation.
 */
export class ExternalSessionHost implements SessionHost {
  readonly binding = 'external' as const;
  readonly #roots = new Map<string, string>();

  /**
   * Register the caller-supplied root id for a group.
   * @param input - includes a required `rootSessionId`.
   */
  async createRoot(input: CreateRootSessionInput & { rootSessionId?: string }): Promise<{ sessionId: string }> {
    throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'external binding requires a caller-supplied root session id', {
      teamId: input.teamId,
    });
  }

  /** External control sessions are created by their owner. */
  async createControl(): Promise<{ sessionId: string }> {
    throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'external binding cannot create a control session');
  }

  /** External identities are supplied by the caller, never created here. */
  async createSubagent(): Promise<{ sessionId: string }> {
    throw new MeshError('SESSION_BINDING_UNAVAILABLE', 'external binding cannot create subagent sessions');
  }

  /** No live handle is owned by this host. */
  async resumeRoot(): Promise<void> {
    // The external owner is responsible for resuming its own session.
  }

  /** No live handle is owned by this host. */
  async disposeRoot(): Promise<void> {
    // The external owner is responsible for teardown.
  }

  /** No live handles. */
  async disposeAll(): Promise<void> {
    this.#roots.clear();
  }

  /**
   * Bind one caller-supplied root session id.
   * @param teamId - group id.
   * @param sessionId - durable root session id.
   */
  bind(teamId: string, sessionId: string): void {
    this.#roots.set(teamId, sessionId);
  }

  /**
   * Read a bound root id.
   * @param teamId - group id.
   * @returns the id, when bound.
   */
  get(teamId: string): string | undefined {
    return this.#roots.get(teamId);
  }
}
