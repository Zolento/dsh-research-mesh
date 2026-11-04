/**
 * Static GPU lease manager for one workstation.
 *
 * A lease only constrains jobs submitted through this Mesh. It is not an
 * operating-system lock: another user on the workstation can occupy the device.
 * Acquisition therefore requires a positive availability probe. When no probe
 * is configured the manager fails closed and the task stays blocked.
 */

import { MeshError } from '../errors.ts';
import type { MeshConfig, WorkerConfig } from '../config/types.ts';
import { MeshStore } from '../storage/mesh-store.ts';
import type { GpuLeaseRecord } from '../storage/types.ts';
import type { MeshLogger } from '../util/logger.ts';
import { nowIso } from '../util/time.ts';

/** Result of asking whether one GPU is free. */
export type GpuAvailability = 'available' | 'busy' | 'unknown';

/** Probe seam; production and tests share this interface. */
export interface GpuProbe {
  /**
   * Probe one device.
   * @param worker - worker configuration.
   * @param gpuId - device id in that worker.
   * @returns availability.
   */
  probe(worker: WorkerConfig, gpuId: number): Promise<GpuAvailability>;
}

/** Fail-closed probe used when no reliable device inspection exists. */
export class UnknownGpuProbe implements GpuProbe {
  async probe(): Promise<GpuAvailability> {
    return 'unknown';
  }
}

/** Deterministic probe used by unit, integration and end-to-end tests. */
export class StaticGpuProbe implements GpuProbe {
  readonly #map: Map<string, GpuAvailability>;

  /**
   * @param entries - map of `workerId:gpuId` to availability; missing keys are unknown.
   */
  constructor(entries: Readonly<Record<string, GpuAvailability>> = {}) {
    this.#map = new Map(Object.entries(entries));
  }

  /**
   * Set one device's availability.
   * @param workerId - worker id.
   * @param gpuId - device id.
   * @param value - availability.
   */
  set(workerId: string, gpuId: number, value: GpuAvailability): void {
    this.#map.set(`${workerId}:${gpuId}`, value);
  }

  async probe(worker: WorkerConfig, gpuId: number): Promise<GpuAvailability> {
    return this.#map.get(`${worker.workerId}:${gpuId}`) ?? 'unknown';
  }
}

/** Acquired lease plus the worker it belongs to. */
export interface AcquiredGpuLease {
  readonly lease: GpuLeaseRecord;
  readonly worker: WorkerConfig;
}

/** Static GPU lease manager. */
export class GpuLeaseManager {
  readonly #config: MeshConfig;
  readonly #store: MeshStore;
  readonly #probe: GpuProbe;
  readonly #logger: MeshLogger;

  /**
   * @param config - resolved Mesh configuration.
   * @param store - Mesh metadata store.
   * @param probe - device availability probe.
   * @param logger - structured logger.
   */
  constructor(config: MeshConfig, store: MeshStore, probe: GpuProbe, logger: MeshLogger) {
    this.#config = config;
    this.#store = store;
    this.#probe = probe;
    this.#logger = logger;
  }

  /**
   * Acquire an exclusive Mesh lease on one GPU.
   * @param input - task/job/attempt identity and optional preferred device.
   * @returns the active lease.
   */
  async acquire(input: {
    workerId: string;
    taskId: string;
    jobId: string;
    attemptId: string;
    gpuId?: number;
  }): Promise<AcquiredGpuLease> {
    const worker = this.#worker(input.workerId);
    if (!worker.enabled) {
      throw new MeshError('EXECUTOR_DISABLED', `worker ${worker.workerId} is disabled`, { workerId: worker.workerId });
    }
    if (input.gpuId !== undefined && !worker.gpuIds.includes(input.gpuId)) {
      throw new MeshError('GPU_UNAVAILABLE', `GPU ${input.gpuId} is not managed on ${worker.workerId}`, {
        workerId: worker.workerId,
        gpuId: input.gpuId,
      });
    }
    const owned = this.#store.listLeases(input.taskId)
      .find(lease => lease.state === 'active' || lease.state === 'reserved' || lease.state === 'quarantined');
    if (owned !== undefined) {
      throw new MeshError('GPU_LEASE_CONFLICT', `task ${input.taskId} already owns a GPU lease`, {
        taskId: input.taskId,
        leaseId: owned.leaseId,
        gpuId: owned.gpuId,
      });
    }
    if (this.#store.countBlockingLeases(worker.workerId) >= worker.maxGpuJobs) {
      throw new MeshError('GPU_UNAVAILABLE', `worker ${worker.workerId} already has ${worker.maxGpuJobs} blocking GPU leases`, {
        workerId: worker.workerId,
        maxGpuJobs: worker.maxGpuJobs,
      });
    }
    const candidates = input.gpuId === undefined ? worker.gpuIds : [input.gpuId];
    let lastError: MeshError | undefined;
    for (const gpuId of candidates) {
      if (this.#store.getBlockingLease(worker.workerId, gpuId) !== undefined) {
        lastError = new MeshError('GPU_LEASE_CONFLICT', `GPU ${gpuId} is already leased by Mesh`, {
          workerId: worker.workerId,
          gpuId,
        });
        continue;
      }
      const lease = this.#store.acquireLease({
        workerId: worker.workerId,
        gpuId,
        taskId: input.taskId,
        jobId: input.jobId,
        attemptId: input.attemptId,
      });
      let availability: GpuAvailability;
      try {
        availability = await this.#probe.probe(worker, gpuId);
      } catch (error) {
        this.#store.setLeaseState(lease.leaseId, 'released', false, nowIso());
        throw new MeshError('GPU_PROBE_FAILED', `GPU probe failed for ${worker.workerId}:${gpuId}`, {
          workerId: worker.workerId,
          gpuId,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (availability !== 'available') {
        this.#store.setLeaseState(lease.leaseId, 'released', false, nowIso());
        lastError = new MeshError(
          availability === 'busy' ? 'GPU_UNAVAILABLE' : 'GPU_AVAILABILITY_UNKNOWN',
          availability === 'busy'
            ? `GPU ${gpuId} on ${worker.workerId} is busy`
            : `GPU ${gpuId} on ${worker.workerId} cannot be verified as free`,
          { workerId: worker.workerId, gpuId, availability },
        );
        continue;
      }
      this.#store.setLeaseState(lease.leaseId, 'active', true, null);
      this.#store.appendEvent('gpu-lease', lease.leaseId, 'acquired', {
        workerId: worker.workerId,
        gpuId,
        taskId: input.taskId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        verified: true,
      });
      this.#logger.info('GPU lease acquired', { workerId: worker.workerId, gpuId, taskId: input.taskId, jobId: input.jobId });
      return { lease: { ...lease, state: 'active', verified: true }, worker };
    }
    throw lastError ?? new MeshError('GPU_UNAVAILABLE', `no GPU is available on ${worker.workerId}`, {
      workerId: worker.workerId,
    });
  }

  /**
   * Verify that an active lease belongs to the exact job/attempt.
   * @param leaseId - lease identity.
   * @param jobId - job identity.
   * @param attemptId - attempt identity.
   * @returns the lease.
   */
  assertLease(leaseId: string, jobId: string, attemptId: string): GpuLeaseRecord {
    const lease = this.#store.getLease(leaseId);
    if (lease === undefined) throw new MeshError('GPU_LEASE_CONFLICT', `unknown GPU lease ${leaseId}`, { leaseId });
    if (lease.jobId !== jobId || lease.attemptId !== attemptId) {
      throw new MeshError('GPU_LEASE_CONFLICT', 'GPU lease does not belong to this job/attempt', {
        leaseId,
        jobId,
        attemptId,
      });
    }
    if (lease.state !== 'active') {
      throw new MeshError('GPU_LEASE_CONFLICT', 'GPU lease is not active', { leaseId, state: lease.state });
    }
    return lease;
  }

  /**
   * Release one lease.
   * @param leaseId - lease identity.
   * @param reason - audit reason.
   */
  release(leaseId: string, reason: string): void {
    const lease = this.#store.getLease(leaseId);
    if (lease === undefined) return;
    if (lease.state === 'released') return;
    this.#store.setLeaseState(leaseId, 'released', lease.verified, nowIso());
    this.#store.appendEvent('gpu-lease', leaseId, 'released', { reason });
    this.#logger.info('GPU lease released', { leaseId, reason });
  }

  /**
   * Quarantine a lease whose remote execution is unknown. It blocks reuse until
   * an operator resolves the remote state.
   * @param leaseId - lease identity.
   * @param reason - audit reason.
   */
  quarantine(leaseId: string, reason: string): void {
    const lease = this.#store.getLease(leaseId);
    if (lease === undefined) return;
    this.#store.setLeaseState(leaseId, 'quarantined', lease.verified, null);
    this.#store.appendEvent('gpu-lease', leaseId, 'quarantined', { reason });
    this.#logger.warn('GPU lease quarantined', { leaseId, reason });
  }

  /**
   * Release every active lease for one task after it reaches a terminal state.
   * @param taskId - task identity.
   * @param reason - audit reason.
   */
  releaseForTask(taskId: string, reason: string): void {
    for (const lease of this.#store.listLeases(taskId)) {
      if (lease.state === 'active' || lease.state === 'reserved') this.release(lease.leaseId, reason);
    }
  }

  /**
   * Reconcile leases after restart. Terminal tasks release their leases; unknown
   * remote tasks are quarantined; everything else is left untouched.
   * @returns counts.
   */
  reconcile(): { released: number; quarantined: number; retained: number } {
    let released = 0;
    let quarantined = 0;
    let retained = 0;
    for (const lease of this.#store.listLeases()) {
      if (lease.state !== 'active' && lease.state !== 'reserved' && lease.state !== 'quarantined') continue;
      const task = this.#store.teamStore.getTask(lease.taskId);
      const meta = this.#store.getTaskMeta(lease.taskId);
      if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.release(lease.leaseId, 'task reached a terminal state');
        released += 1;
        continue;
      }
      if (meta?.remoteStatus === 'RECONCILE_REQUIRED') {
        if (lease.state !== 'quarantined') {
          this.quarantine(lease.leaseId, 'remote execution state is unknown; reconcile before reuse');
          quarantined += 1;
        } else {
          retained += 1;
        }
        continue;
      }
      retained += 1;
    }
    return { released, quarantined, retained };
  }

  /**
   * List leases, optionally for one worker.
   * @param workerId - optional worker filter.
   * @returns leases.
   */
  list(workerId?: string): readonly GpuLeaseRecord[] {
    return this.#store.listLeases().filter(lease => workerId === undefined || lease.workerId === workerId);
  }

  #worker(workerId: string): WorkerConfig {
    const worker = this.#config.workers[workerId];
    if (worker === undefined) {
      throw new MeshError('EXECUTOR_DISABLED', `unknown worker ${workerId}`, { workerId });
    }
    return worker;
  }
}
