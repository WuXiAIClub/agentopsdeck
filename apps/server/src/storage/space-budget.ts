import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { HistoryReadDeferred } from '../refresh/history.js';
import { asyncVolumeAdmission } from './async-volume-admission.js';
import { StorageAdmissionDeferred } from './work-admission.js';

const MiB = 1024 * 1024;
const reserve = 256n * BigInt(MiB);
const recoveryMargin = 64n * BigInt(MiB);

export class StorageSpaceDeferred extends HistoryReadDeferred {
  constructor() { super('Temporary projection deferred: insufficient free space'); this.name = 'StorageSpaceDeferred'; }
}
/** Advisory reserve, not a filesystem quota. Rechecked every 16MiB of writes
 * or after 5 seconds, whichever comes first (no background polling).
 * Low-space probes are retried on demand after 1s; recovery needs an additional
 * 64MiB margin to avoid threshold flapping. External writers can still exhaust
 * space and I/O errors propagate. This does not govern durable data writes. */
export class ProjectionSpaceBudget {
  private remaining = 0;
  private checkedAt = -Infinity;
  private checking: Promise<void> | undefined;
  private lowSpace = false;
  private deniedAt = -Infinity;
  constructor(private readonly root: string, private readonly freeBytes = async () => {
    const info = await statfs(root, { bigint: true }); return info.bavail * info.bsize;
  }, private readonly now = () => performance.now()) {}
  async consume(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid projection write size');
    if (bytes === 0) return;
    while (true) {
      const deniedAge = this.now() - this.deniedAt;
      if (this.lowSpace && deniedAge >= 0 && deniedAge < 1_000) throw new StorageSpaceDeferred();
      const age = this.now() - this.checkedAt;
      if (bytes <= this.remaining && age >= 0 && age < 5_000) {
        this.remaining -= bytes;
        return;
      }
      // Share the filesystem read, not write credits. Each waiter rechecks and
      // consumes synchronously after await; concurrent callers cannot each
      // reset the same 16MiB allowance. Failure invalidates previous credits.
      if (!this.checking) {
        this.remaining = 0;
        const allowance = Math.max(16 * MiB, bytes);
        this.checking = Promise.resolve().then(async () => {
          const required = reserve + BigInt(allowance) + (this.lowSpace ? recoveryMargin : 0n);
          if (await this.freeBytes() < required) {
            this.lowSpace = true;
            this.deniedAt = this.now();
            throw new StorageSpaceDeferred();
          }
          this.lowSpace = false;
          this.remaining = allowance;
          this.checkedAt = this.now();
        }).finally(() => { this.checking = undefined; });
      }
      await this.checking;
    }
  }
}

// All rollout builders spill to the same process temp filesystem. Share both
// probe work AND write credits across builders, including new retry builders.
// Constant-size state, no path-indexed registry or background timer.
export const temporaryProjectionSpaceBudget = new ProjectionSpaceBudget(tmpdir());

/** Reserve the actual in-flight write window across Hub/Connector processes;
 * the existing cheap budget still handles local probes and batching. */
export async function withTemporaryProjectionWrite<T>(bytes: number, write: () => Promise<T>): Promise<T> {
  try { return await asyncVolumeAdmission.run(tmpdir(), 'projection', bytes + 8192, write); }
  catch (e) { if (e instanceof StorageAdmissionDeferred) throw new StorageSpaceDeferred(); throw e; }
}
