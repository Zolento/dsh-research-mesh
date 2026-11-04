/** Validated process-wide configuration for one Research Mesh runtime. */

/** How the Mesh binds a research group to a DSH root session. */
export type SessionBinding = 'dsh' | 'external';

/** Static transport selection for one worker. */
export type WorkerTransport = 'ssh' | 'fake';

/** One statically configured execution worker. */
export interface WorkerConfig {
  /** Stable worker id used by manifests and GPU leases. */
  readonly workerId: string;
  /** Transport used to reach the worker. */
  readonly transport: WorkerTransport;
  /** False keeps every job submission blocked. */
  readonly enabled: boolean;
  /** SSH host; required when enabled and transport is `ssh`. */
  readonly host?: string;
  /** SSH user; required when enabled and transport is `ssh`. */
  readonly user?: string;
  /** SSH port. */
  readonly port: number;
  /** GPU device ids managed on this worker. */
  readonly gpuIds: readonly number[];
  /** Maximum simultaneous Mesh GPU jobs on this worker. */
  readonly maxGpuJobs: number;
  /** Conda environment used when a manifest does not override it. */
  readonly condaEnvironment: string;
  /** Remote job root; required when enabled. Absolute POSIX path. */
  readonly remoteRoot: string;
  /** Local directory used by the fake transport; test-only. */
  readonly fakeRemoteRoot?: string;
}

/** Resource and scheduler limits. */
export interface MeshLimits {
  /** Maximum non-destroyed groups; hard-capped at 3. */
  readonly maxTeams: number;
  /** Maximum subagents per group; hard-capped at 4. */
  readonly maxSubagentsPerTeam: number;
  /** Maximum subagents across all groups; hard-capped at 12. */
  readonly maxSubagentsTotal: number;
  /** Global concurrent claimed/running jobs. */
  readonly maxConcurrentTasks: number;
  /** Per-group concurrent claimed/running jobs. */
  readonly maxConcurrentTasksPerTeam: number;
  /** Claim lease duration before recovery treats a worker as lost. */
  readonly taskLeaseMs: number;
  /** Delay between scheduler ticks when started by the host. */
  readonly schedulerPollMs: number;
}

/** Conda invocation policy. */
export interface CondaConfig {
  /** Conda executable name or absolute path. */
  readonly executable: string;
  /** Default environment name for local and remote experiments. */
  readonly defaultEnvironment: string;
}

/** SSH transport policy shared by workers. */
export interface SshConfig {
  /** Global kill switch; the plugin defaults to false. */
  readonly enabled: boolean;
  /** Optional known_hosts file; host-key verification is never disabled. */
  readonly knownHostsFile?: string;
  /** Connection timeout in seconds. */
  readonly connectTimeoutSec: number;
  /** SSH server keepalive interval in seconds. */
  readonly serverAliveIntervalSec: number;
}

/** RSI adapter policy. */
export interface RsiConfig {
  /** Whether RSI authorization is required for experiment manifests. */
  readonly enabled: boolean;
  /** Explicit skill path; otherwise discovery uses the env var and the installed skill. */
  readonly skillPath?: string;
  /** Python interpreter used for read-only RSI validators. */
  readonly pythonExecutable: string;
  /** Timeout for `state_check.py`. */
  readonly stateCheckTimeoutMs: number;
  /** Timeout for receipt verification. */
  readonly gateTimeoutMs: number;
  /** Test-only escape hatch; production defaults to false. */
  readonly allowTestStub: boolean;
}

/** Artifact ingestion limits. */
export interface ArtifactConfig {
  /** Maximum number of files in one artifact manifest. */
  readonly maxFiles: number;
  /** Maximum total artifact bytes. */
  readonly maxBytes: number;
}

/** Complete validated configuration. */
export interface MeshConfig {
  /** Absolute research project root. */
  readonly projectRoot: string;
  /** Absolute control directory. */
  readonly controlDir: string;
  /** Absolute source checkout directory. */
  readonly sourceDir: string;
  /** Absolute worktree parent directory. */
  readonly worktreesDir: string;
  /** Absolute SQLite database path. */
  readonly databasePath: string;
  /** Durable model-assignment document outside the project database. */
  readonly modelSettingsPath: string;
  /** Session binding mode. */
  readonly sessionBinding: SessionBinding;
  /** Optional default model route for Mesh-created root sessions. */
  readonly agent?: { readonly provider: string; readonly model: string };
  /** Limits. */
  readonly limits: MeshLimits;
  /** Workers keyed by id. */
  readonly workers: Readonly<Record<string, WorkerConfig>>;
  /** Conda policy. */
  readonly conda: CondaConfig;
  /** SSH policy. */
  readonly ssh: SshConfig;
  /** RSI policy. */
  readonly rsi: RsiConfig;
  /** Artifact limits. */
  readonly artifacts: ArtifactConfig;
  /** Test-only fake transport gate. */
  readonly allowFakeTransport: boolean;
  /** Start the scheduler loop automatically on plugin load. */
  readonly autoStartScheduler: boolean;
  /** Run crash recovery when the service starts. */
  readonly startupRecovery: boolean;
  /** Minimum log level. */
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}
