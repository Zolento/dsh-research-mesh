/**
 * Configuration resolution for one Research Mesh runtime.
 *
 * Configuration is a boundary: unknown fields, out-of-range limits and unsafe
 * fake/SSH modes fail loudly at load. Product limits (3 groups, 4 subagents per
 * group, 12 globally) are hard ceilings, not defaults that a deployment may
 * raise.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { MeshError } from '../errors.ts';
import type {
  ArtifactConfig,
  CondaConfig,
  MeshConfig,
  MeshLimits,
  RlpConfig,
  RsiConfig,
  SecurityConfig,
  SessionBinding,
  SshConfig,
  WorkerConfig,
  WorkerTransport,
} from './types.ts';

/** Hard product ceiling for research groups. */
export const MAX_TEAMS_CEILING = 3;
/** Hard product ceiling for subagents per group. */
export const MAX_SUBAGENTS_PER_TEAM_CEILING = 4;
/** Hard product ceiling for subagents across the Mesh. */
export const MAX_SUBAGENTS_TOTAL_CEILING = 12;

const DEFAULT_LIMITS: MeshLimits = {
  maxTeams: MAX_TEAMS_CEILING,
  maxSubagentsPerTeam: MAX_SUBAGENTS_PER_TEAM_CEILING,
  maxSubagentsTotal: MAX_SUBAGENTS_TOTAL_CEILING,
  maxConcurrentTasks: 4,
  maxConcurrentTasksPerTeam: 2,
  taskLeaseMs: 5 * 60 * 1000,
  schedulerPollMs: 5_000,
};

const DEFAULT_CONDA: CondaConfig = {
  executable: 'conda',
  defaultEnvironment: 'research',
};

const DEFAULT_SSH: SshConfig = {
  enabled: false,
  connectTimeoutSec: 30,
  serverAliveIntervalSec: 30,
};

const DEFAULT_RSI: RsiConfig = {
  enabled: true,
  pythonExecutable: 'python3',
  stateCheckTimeoutMs: 30_000,
  gateTimeoutMs: 60_000,
  allowTestStub: false,
};

const DEFAULT_ARTIFACTS: ArtifactConfig = {
  maxFiles: 1_000,
  maxBytes: 1024 * 1024 * 1024,
};

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONDA_ENV = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new MeshError('CONFIG_INVALID', message, details);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asObject(value, field);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${field} must be a non-empty string`, { field });
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringField(value, field);
}

function booleanField(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`, { field });
  return value;
}

function integerField(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${field} must be an integer in [${min}, ${max}]`, { field, value });
  }
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return integerField(value, field, min, min, max);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function absolutePath(value: unknown, field: string, base?: string): string {
  const raw = stringField(value, field);
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base ?? process.cwd(), expanded);
}

function ensureDirectory(path: string, field: string): string {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) invalid(`${field} must be an existing directory`, { field, path });
  return path;
}

function insideRoot(root: string, candidate: string, field: string): string {
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    invalid(`${field} must stay inside the project root`, { field, root, candidate });
  }
  return candidate;
}

function resolveWorkers(
  raw: unknown,
  conda: CondaConfig,
  ssh: SshConfig,
  allowFakeTransport: boolean,
): Readonly<Record<string, WorkerConfig>> {
  if (raw === undefined) {
    return {
      workstation: {
        workerId: 'workstation',
        transport: 'ssh',
        enabled: false,
        port: 22,
        gpuIds: [0, 1],
        maxGpuJobs: 2,
        condaEnvironment: conda.defaultEnvironment,
        remoteRoot: '',
      },
    };
  }
  const record = asObject(raw, 'workers');
  const output: Record<string, WorkerConfig> = {};
  for (const [workerId, value] of Object.entries(record)) {
    if (!WORKER_ID.test(workerId)) invalid('worker id is not a safe slug', { workerId });
    const worker = asObject(value, `workers.${workerId}`);
    const transportRaw = optionalString(worker.transport, `workers.${workerId}.transport`) ?? 'ssh';
    if (transportRaw !== 'ssh' && transportRaw !== 'fake') {
      invalid(`workers.${workerId}.transport must be 'ssh' or 'fake'`, { workerId, transport: transportRaw });
    }
    const transport = transportRaw as WorkerTransport;
    const enabled = booleanField(worker.enabled, `workers.${workerId}.enabled`, false);
    const gpuRaw = worker.gpuIds ?? [0, 1];
    if (!Array.isArray(gpuRaw) || gpuRaw.length === 0) {
      invalid(`workers.${workerId}.gpuIds must be a non-empty array`, { workerId });
    }
    const gpuIds: number[] = [];
    for (const entry of gpuRaw) {
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
        invalid(`workers.${workerId}.gpuIds entries must be non-negative integers`, { workerId });
      }
      if (gpuIds.includes(entry)) invalid(`workers.${workerId}.gpuIds contains a duplicate`, { workerId, gpuId: entry });
      gpuIds.push(entry);
    }
    const maxGpuJobs = integerField(worker.maxGpuJobs, `workers.${workerId}.maxGpuJobs`, gpuIds.length, 1, gpuIds.length);
    const condaEnvironment = optionalString(worker.condaEnvironment, `workers.${workerId}.condaEnvironment`)
      ?? conda.defaultEnvironment;
    if (!CONDA_ENV.test(condaEnvironment)) {
      invalid(`workers.${workerId}.condaEnvironment is not a safe environment name`, { workerId, condaEnvironment });
    }
    const remoteRootRaw = optionalString(worker.remoteRoot, `workers.${workerId}.remoteRoot`);
    const remoteRoot = remoteRootRaw === undefined ? '' : absolutePath(remoteRootRaw, `workers.${workerId}.remoteRoot`);
    const fakeRootRaw = optionalString(worker.fakeRemoteRoot, `workers.${workerId}.fakeRemoteRoot`);
    const fakeRemoteRoot = fakeRootRaw === undefined ? undefined : absolutePath(fakeRootRaw, `workers.${workerId}.fakeRemoteRoot`);

    if (transport === 'fake') {
      if (!allowFakeTransport) {
        invalid(`workers.${workerId} uses the fake transport but allowFakeTransport is false`, { workerId });
      }
      if (fakeRemoteRoot === undefined) {
        invalid(`workers.${workerId}.fakeRemoteRoot is required for the fake transport`, { workerId });
      }
    }
    if (enabled && transport === 'ssh') {
      if (!ssh.enabled) {
        invalid(`workers.${workerId} is enabled but the global ssh.enabled switch is false`, { workerId });
      }
      if (remoteRoot === '') invalid(`workers.${workerId}.remoteRoot is required for an enabled ssh worker`, { workerId });
      if (worker.host === undefined) invalid(`workers.${workerId}.host is required for an enabled ssh worker`, { workerId });
    }
    const host = optionalString(worker.host, `workers.${workerId}.host`);
    const user = optionalString(worker.user, `workers.${workerId}.user`);
    const port = integerField(worker.port, `workers.${workerId}.port`, 22, 1, 65_535);
    output[workerId] = {
      workerId,
      transport,
      enabled,
      ...(host === undefined ? {} : { host }),
      ...(user === undefined ? {} : { user }),
      port,
      gpuIds,
      maxGpuJobs,
      condaEnvironment,
      remoteRoot,
      ...(fakeRemoteRoot === undefined ? {} : { fakeRemoteRoot }),
    };
  }
  if (Object.keys(output).length === 0) invalid('workers must declare at least one worker');
  return output;
}

/**
 * Resolve and validate raw Cordis configuration.
 * @param raw - raw plugin config.
 * @param options - process cwd used for relative paths.
 * @returns frozen, fully resolved configuration.
 */
export function resolveConfig(raw: unknown, options: { cwd?: string } = {}): MeshConfig {
  const input = raw === undefined || raw === null ? {} : asObject(raw, 'config');
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = ensureDirectory(
    absolutePath(input.projectRoot, 'projectRoot', cwd),
    'projectRoot',
  );

  const sourceDir = insideRoot(
    projectRoot,
    absolutePath(optionalString(input.sourceDir, 'sourceDir') ?? 'source', 'sourceDir', projectRoot),
    'sourceDir',
  );
  // Whole-repository projects (sourceDir === projectRoot) are common: an
  // existing RSI Git checkout is the project itself, so control state and
  // worktrees must be allowed to live beside it instead of inside it.
  const wholeRepo = sourceDir === projectRoot;
  const controlRaw = absolutePath(
    optionalString(input.controlDir, 'controlDir')
      ?? (wholeRepo
        ? join(projectRoot, '..', '.mesh', basename(projectRoot), 'control')
        : '.research-mesh'),
    'controlDir',
    projectRoot,
  );
  const controlDir = wholeRepo ? controlRaw : insideRoot(projectRoot, controlRaw, 'controlDir');
  const worktreesRaw = absolutePath(
    optionalString(input.worktreesDir, 'worktreesDir') ?? (wholeRepo ? join(controlDir, 'worktrees') : 'worktrees'),
    'worktreesDir',
    projectRoot,
  );
  const worktreesDir = wholeRepo ? worktreesRaw : insideRoot(projectRoot, worktreesRaw, 'worktreesDir');
  if (sourceDir === worktreesDir) invalid('sourceDir and worktreesDir must differ');
  if (controlDir === sourceDir) invalid('controlDir must differ from sourceDir');
  // Whole-repository Mesh policy: control state and worktrees are outside the
  // canonical checkout so solo Git status is never polluted by Mesh metadata.
  if (wholeRepo && controlDir.startsWith(sourceDir + sep)) {
    invalid('controlDir must be outside sourceDir for a whole-repository project', { controlDir, sourceDir });
  }
  if (worktreesDir === sourceDir || worktreesDir.startsWith(sourceDir + sep)) {
    invalid('worktreesDir must not be inside sourceDir');
  }
  if (sourceDir.startsWith(worktreesDir + sep)) invalid('sourceDir must not be inside worktreesDir');

  const limitsRaw = optionalObject(input.limits, 'limits') ?? {};
  const limits: MeshLimits = {
    maxTeams: integerField(limitsRaw.maxTeams, 'limits.maxTeams', MAX_TEAMS_CEILING, 1, MAX_TEAMS_CEILING),
    maxSubagentsPerTeam: integerField(
      limitsRaw.maxSubagentsPerTeam,
      'limits.maxSubagentsPerTeam',
      MAX_SUBAGENTS_PER_TEAM_CEILING,
      1,
      MAX_SUBAGENTS_PER_TEAM_CEILING,
    ),
    maxSubagentsTotal: integerField(
      limitsRaw.maxSubagentsTotal,
      'limits.maxSubagentsTotal',
      MAX_SUBAGENTS_TOTAL_CEILING,
      1,
      MAX_SUBAGENTS_TOTAL_CEILING,
    ),
    maxConcurrentTasks: integerField(limitsRaw.maxConcurrentTasks, 'limits.maxConcurrentTasks', DEFAULT_LIMITS.maxConcurrentTasks, 1, 64),
    maxConcurrentTasksPerTeam: integerField(
      limitsRaw.maxConcurrentTasksPerTeam,
      'limits.maxConcurrentTasksPerTeam',
      DEFAULT_LIMITS.maxConcurrentTasksPerTeam,
      1,
      64,
    ),
    taskLeaseMs: integerField(limitsRaw.taskLeaseMs, 'limits.taskLeaseMs', DEFAULT_LIMITS.taskLeaseMs, 1_000, 24 * 60 * 60 * 1000),
    schedulerPollMs: integerField(limitsRaw.schedulerPollMs, 'limits.schedulerPollMs', DEFAULT_LIMITS.schedulerPollMs, 100, 60 * 60 * 1000),
  };
  if (limits.maxSubagentsPerTeam > limits.maxSubagentsTotal) {
    invalid('limits.maxSubagentsPerTeam cannot exceed limits.maxSubagentsTotal');
  }

  const condaRaw = optionalObject(input.conda, 'conda') ?? {};
  const conda: CondaConfig = {
    executable: optionalString(condaRaw.executable, 'conda.executable') ?? DEFAULT_CONDA.executable,
    defaultEnvironment: optionalString(condaRaw.defaultEnvironment, 'conda.defaultEnvironment')
      ?? DEFAULT_CONDA.defaultEnvironment,
  };
  if (!CONDA_ENV.test(conda.defaultEnvironment)) invalid('conda.defaultEnvironment is not a safe name');

  const sshRaw = optionalObject(input.ssh, 'ssh') ?? {};
  const ssh: SshConfig = {
    enabled: booleanField(sshRaw.enabled, 'ssh.enabled', DEFAULT_SSH.enabled),
    ...(optionalString(sshRaw.knownHostsFile, 'ssh.knownHostsFile') === undefined
      ? {}
      : { knownHostsFile: absolutePath(sshRaw.knownHostsFile, 'ssh.knownHostsFile') }),
    connectTimeoutSec: integerField(sshRaw.connectTimeoutSec, 'ssh.connectTimeoutSec', DEFAULT_SSH.connectTimeoutSec, 1, 600),
    serverAliveIntervalSec: integerField(
      sshRaw.serverAliveIntervalSec,
      'ssh.serverAliveIntervalSec',
      DEFAULT_SSH.serverAliveIntervalSec,
      1,
      600,
    ),
  };

  const allowFakeTransport = booleanField(input.allowFakeTransport, 'allowFakeTransport', false);
  const nativeMembers = booleanField(input.nativeMembers, 'nativeMembers', false);
  const workers = resolveWorkers(input.workers, conda, ssh, allowFakeTransport);

  // `rlp` is canonical; `rsi` is the deprecated alias for the same block.
  const rlpRaw = optionalObject(input.rlp ?? input.rsi, 'rlp') ?? {};
  const skillPathRaw = optionalString(rlpRaw.skillPath, 'rlp.skillPath');
  const skillPath = skillPathRaw === undefined
    ? undefined
    : ensureDirectory(expandHome(skillPathRaw), 'rlp.skillPath');
  const pythonExecutable = optionalString(rlpRaw.pythonExecutable, 'rlp.pythonExecutable')
    ?? DEFAULT_RSI.pythonExecutable;
  const allowTestStub = booleanField(rlpRaw.allowTestStub, 'rlp.allowTestStub', false);
  const autonomyModeRaw = optionalString(rlpRaw.autonomyMode, 'rlp.autonomyMode') ?? 'observe';
  if (autonomyModeRaw !== 'off' && autonomyModeRaw !== 'observe' && autonomyModeRaw !== 'auto') {
    invalid("rlp.autonomyMode must be 'off', 'observe' or 'auto'", { autonomyMode: autonomyModeRaw });
  }
  const rlp: RlpConfig = {
    enabled: booleanField(rlpRaw.enabled, 'rlp.enabled', DEFAULT_RSI.enabled),
    ...(skillPath === undefined ? {} : { skillPath }),
    pythonExecutable,
    timeoutMs: integerField(rlpRaw.timeoutMs, 'rlp.timeoutMs', 60_000, 1_000, 30 * 60 * 1000),
    allowTestStub,
    autonomyMode: autonomyModeRaw,
    autonomyPolicyVersion: optionalString(rlpRaw.autonomyPolicyVersion, 'rlp.autonomyPolicyVersion') ?? 'policy-1',
  };
  const rsi: RsiConfig = {
    enabled: rlp.enabled,
    ...(skillPath === undefined ? {} : { skillPath }),
    pythonExecutable,
    stateCheckTimeoutMs: integerField(rlpRaw.stateCheckTimeoutMs, 'rsi.stateCheckTimeoutMs', DEFAULT_RSI.stateCheckTimeoutMs, 1_000, 10 * 60 * 1000),
    gateTimeoutMs: integerField(rlpRaw.gateTimeoutMs, 'rsi.gateTimeoutMs', DEFAULT_RSI.gateTimeoutMs, 1_000, 30 * 60 * 1000),
    allowTestStub,
  };

  const artifactsRaw = optionalObject(input.artifacts, 'artifacts') ?? {};
  const artifacts: ArtifactConfig = {
    maxFiles: integerField(artifactsRaw.maxFiles, 'artifacts.maxFiles', DEFAULT_ARTIFACTS.maxFiles, 1, 100_000),
    maxBytes: integerField(artifactsRaw.maxBytes, 'artifacts.maxBytes', DEFAULT_ARTIFACTS.maxBytes, 1, 100 * 1024 * 1024 * 1024),
  };

  const sessionBindingRaw = optionalString(input.sessionBinding, 'sessionBinding') ?? 'dsh';
  if (sessionBindingRaw !== 'dsh' && sessionBindingRaw !== 'external') {
    invalid("sessionBinding must be 'dsh' or 'external'", { sessionBinding: sessionBindingRaw });
  }
  const sessionBinding = sessionBindingRaw as SessionBinding;

  const agentRaw = optionalObject(input.agent, 'agent');
  let agent: { provider: string; model: string } | undefined;
  if (agentRaw !== undefined) {
    agent = {
      provider: stringField(agentRaw.provider, 'agent.provider'),
      model: stringField(agentRaw.model, 'agent.model'),
    };
  }

  const securityRaw = optionalObject(input.security, 'security') ?? {};
  const adminToken = optionalString(securityRaw.adminToken, 'security.adminToken');
  if (adminToken !== undefined && adminToken.length < 16) {
    invalid('security.adminToken must be at least 16 characters', { field: 'security.adminToken' });
  }
  const security = { ...(adminToken === undefined ? {} : { adminToken }) };

  const logLevelRaw = optionalString(input.logLevel, 'logLevel') ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    invalid('logLevel must be debug, info, warn or error', { logLevel: logLevelRaw });
  }

  const databaseRaw = absolutePath(
    optionalString(input.databasePath, 'databasePath') ?? `${controlDir}${sep}runtime.sqlite`,
    'databasePath',
    projectRoot,
  );
  const databasePath = wholeRepo ? databaseRaw : insideRoot(projectRoot, databaseRaw, 'databasePath');
  const artifactsPathRaw = absolutePath(
    optionalString(input.artifactsDir, 'artifactsDir') ?? join(controlDir, 'artifacts'),
    'artifactsDir',
    projectRoot,
  );
  const artifactsDir = wholeRepo ? artifactsPathRaw : insideRoot(projectRoot, artifactsPathRaw, 'artifactsDir');
  const modelSettingsPath = absolutePath(
    optionalString(input.modelSettingsPath, 'modelSettingsPath') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-research-mesh', 'model-settings.json'),
    'modelSettingsPath',
  );

  const config: MeshConfig = {
    projectRoot,
    controlDir,
    sourceDir,
    worktreesDir,
    databasePath,
    artifactsDir,
    modelSettingsPath,
    nativeMembers,
    sessionBinding,
    ...(agent === undefined ? {} : { agent }),
    limits,
    workers,
    conda,
    ssh,
    rlp,
    rsi,
    artifacts,
    allowFakeTransport,
    security,
    autoStartScheduler: booleanField(input.autoStartScheduler, 'autoStartScheduler', false),
    startupRecovery: booleanField(input.startupRecovery, 'startupRecovery', true),
    logLevel: logLevelRaw as MeshConfig['logLevel'],
  };
  return config;
}

/**
 * Assert that the source checkout exists and looks like a Git repository root.
 * @param config - resolved configuration.
 */
export function assertGitSource(config: MeshConfig): void {
  const gitDir = resolve(config.sourceDir, '.git');
  if (!existsSync(gitDir)) {
    throw new MeshError('CONFIG_INVALID', 'sourceDir must contain a Git checkout', { sourceDir: config.sourceDir });
  }
  if (!existsSync(config.controlDir)) {
    // The Mesh owns its control directory; creating it is the documented
    // setup path for a whole-repository project. RSI state is never created.
    try {
      mkdirSync(config.controlDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new MeshError('CONFIG_INVALID', 'controlDir does not exist and could not be created', {
        controlDir: config.controlDir,
        error: String(error),
      });
    }
  }
}
