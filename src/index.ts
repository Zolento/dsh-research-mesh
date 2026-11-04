/**
 * `dsh-research-mesh` Cordis plugin entry.
 *
 * The plugin owns one Mesh service bound to a research project root. It is
 * deliberately dependency-light: it reads optional host services structurally,
 * so the same package loads in a headless profile, a Web profile, or a minimal
 * test composition. Registrations are effect-scoped, and unloading closes the
 * SQLite handle, session handles and scheduler timers.
 */

import { resolveConfig } from './config/index.ts';
import { MeshError } from './errors.ts';
import { MeshService } from './service.ts';
import { FileModelSettingsStore } from './teams/settings-store.ts';
import { ConfigModelSettingsStore, type SettingsFormsLike, type VolatileLike } from './teams/config-settings-store.ts';
import { registerMeshApi } from './host/web-api.ts';
import { createLogger, type MeshLogger } from './util/logger.ts';
import type { DshAgentsLike, DshSessionControllerLike, DshWorkspaceControllerLike } from './teams/session-host.ts';
import type { DshLlmLike } from './dsh/model-catalog.ts';

/** Cordis plugin name used in diagnostics. */
export const name = 'research-mesh';

/** Structural subset of a Cordis context; no `@deepseek-ai/*` import is required. */
export interface MeshPluginContext {
  get(service: string): unknown;
  provide(service: string, value: unknown): void;
  effect(body: () => void | Promise<void> | (() => void | Promise<void>), label?: string): unknown;
  inject(services: readonly string[], callback: (child: {
    get(service: string): unknown;
    effect(body: () => (() => void) | Promise<() => void>, label: string): unknown;
    webServer: import('./host/web-api.ts').WebServerLike;
  }) => void): unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void };
}

/** Public service key registered on the host context. */
export const SERVICE_KEY = 'researchMesh';

function asAgents(value: unknown): DshAgentsLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DshAgentsLike>;
  if (typeof candidate.create !== 'function' || typeof candidate.resume !== 'function') return undefined;
  return candidate as DshAgentsLike;
}

function asLlm(value: unknown): DshLlmLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DshLlmLike>;
  if (typeof candidate.listProviders !== 'function' || typeof candidate.listModels !== 'function') return undefined;
  return candidate as DshLlmLike;
}

function asWorkspaceController(value: unknown): DshWorkspaceControllerLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DshWorkspaceControllerLike>;
  if (typeof candidate.create !== 'function') return undefined;
  return candidate as DshWorkspaceControllerLike;
}

function asSessionController(value: unknown): DshSessionControllerLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DshSessionControllerLike>;
  if (typeof candidate.create !== 'function' || typeof candidate.selectModel !== 'function') return undefined;
  return candidate as DshSessionControllerLike;
}

function asSettings(value: unknown): SettingsFormsLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<SettingsFormsLike>;
  if (typeof candidate.describe !== 'function' || typeof candidate.update !== 'function') return undefined;
  return candidate as SettingsFormsLike;
}

/**
 * Apply the plugin.
 * @param ctx - Cordis context.
 * @param rawConfig - raw plugin configuration from the profile patch.
 * @returns the initialized service.
 */
export async function apply(ctx: MeshPluginContext, rawConfig?: unknown): Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger: MeshLogger = createLogger(config.logLevel, console, 'dsh-research-mesh');
  let rawSettings: unknown;
  try { rawSettings = ctx.get('settings') } catch { rawSettings = undefined }
  const settings = asSettings(rawSettings);
  const assignments = (rawConfig as { modelAssignments?: VolatileLike<unknown> } | undefined)?.modelAssignments;
  const modelSettings = settings !== undefined && assignments !== undefined
    ? new ConfigModelSettingsStore({ settings, namespace: 'dsh-research-mesh', ref: assignments })
    : new FileModelSettingsStore(config.modelSettingsPath);
  const service = new MeshService({
    config,
    logger,
    modelSettings,
    host: {
      ...(asAgents(ctx.get('agents')) === undefined ? {} : { agents: asAgents(ctx.get('agents')) }),
      ...(asLlm(ctx.get('llm')) === undefined ? {} : { llm: asLlm(ctx.get('llm')) }),
      ...(asSessionController(ctx.get('sessionController')) === undefined ? {} : { sessionController: asSessionController(ctx.get('sessionController')) }),
      ...(asWorkspaceController(ctx.get('workspaceController')) === undefined ? {} : { workspaceController: asWorkspaceController(ctx.get('workspaceController')) }),
    },
  });
  await service.init();
  ctx.provide(SERVICE_KEY, service);
  registerMeshApi(ctx, service);
  ctx.inject(['sessionController'], child => {
    const controller = asSessionController(child.get('sessionController'));
    if (controller !== undefined) service.attachSessionController(controller);
  });
  ctx.inject(['workspaceController'], child => {
    const controller = asWorkspaceController(child.get('workspaceController'));
    if (controller !== undefined) service.attachWorkspaceController(controller);
  });
  ctx.effect(() => async () => {
    await service.close();
  }, 'dsh-research-mesh lifecycle');
  ctx.logger?.info?.('dsh-research-mesh initialized');
}

export { Config } from './config/schema.ts';
export { MeshService, resolveConfig, MeshError };
export type { MeshConfig } from './config/types.ts';
export type { MeshServiceStatus, SubmitExperimentTaskInput } from './service.ts';
export type { SubmitTaskInput } from './scheduler/scheduler.ts';
export type { TeamView, CreateTeamInput, RegisterSubagentInput, SubagentView } from './teams/manager.ts';
export type { MeshTaskView, ClaimedTask } from './scheduler/scheduler.ts';
export type { JobManifest } from './executors/manifest.ts';
export type { ModelSettingsDocument, ModelCatalogEntry } from './teams/models.ts';
export type { RsiAuthorization, RsiDiscovery } from './rsi/adapter.ts';
