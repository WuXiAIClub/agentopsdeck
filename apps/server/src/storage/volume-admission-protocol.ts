import type { MessagePort } from 'node:worker_threads';
import type { VolumeAdmission } from './volume-admission.js';
import { StorageAdmissionDeferred, type StorageWorkClass } from './work-admission.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from './sql-failure-diagnostics.js';
import { volumeAdmissionRefusal } from './volume-admission-refusal.js';

/** Shared by the production owner and disposable, isolated SQLite tests. */
export function installVolumeAdmissionProtocol(port: MessagePort, select: (root: string) => VolumeAdmission,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
  const active = new Map<number, { settle(full: boolean): void }>();
  // Count queued acquisition and release work too, not just admitted writers.
  const inFlight = new Set<number>();
  let highest = 0;
  let unavailable = false;
  const failTransport = () => {
    if (unavailable) return;
    unavailable = true;
    const trace = diagnostics.start('storage-coordinator-recovery');
    trace.add('pending', inFlight.size); trace.add('unknown', active.size); trace.finish(true);
    // Closing transport is not proof that original writers are quiescent.
    // Leave their callbacks and ledger charges unsettled; the parent confirms
    // termination and original-writer settlement before replacing this owner.
    try { port.close(); } catch { /* Parent's bounded request deadline still fences us. */ }
  };
  const reply = (id: number, kind: 'begin' | 'finish' | 'reconcile', ok: boolean, error?: unknown, volume?: string) => {
    if (unavailable) return;
    try { port.postMessage({ id, kind, ok, ...(volume === undefined ? {} : { volume }),
      ...(ok ? {} : { reason: kind === 'finish' ? 'coordinator-unavailable'
        : volumeAdmissionRefusal(error) ?? 'coordinator-unavailable' }) }); }
    catch { failTransport(); }
  };
  port.on('message', (value: { id: number; kind: string; root?: string; workClass?: StorageWorkClass; bytes?: number; full?: boolean; lease?: string; volume?: string; unstarted?: true }) => {
    if (unavailable) return;
    if (!value || !Number.isSafeInteger(value.id) || value.id < 1) { process.exitCode = 1; port.close(); return; }
    if (value.kind === 'finish') {
      const entry = active.get(value.id);
      if (!entry || typeof value.full !== 'boolean') { reply(value.id, 'finish', false); return; }
      active.delete(value.id); entry.settle(value.full); return;
    }
    if (value.kind === 'reconcile') {
      if (value.id <= highest || inFlight.size || active.size || typeof value.root !== 'string' || !value.root.length || value.root.includes('\0') ||
        typeof value.lease !== 'string' || !/^transient-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.lease) ||
        typeof value.volume !== 'string' || !/^[0-9]{1,32}$/.test(value.volume) || typeof value.full !== 'boolean'
        || (value.unstarted !== undefined && (value.unstarted !== true || value.full
          || !['recovery', 'durable', 'projection', 'export'].includes(value.workClass!)
          || !Number.isSafeInteger(value.bytes) || value.bytes! < 1 || value.bytes! > 4 * 1024 ** 3))
        || (value.unstarted === undefined && (value.workClass !== undefined || value.bytes !== undefined))) {
        reply(value.id, 'reconcile', false); return;
      }
      highest = value.id;
      const trace = diagnostics.start('storage-coordinator-recovery');
      trace.add('step', 2);
      try {
        const removed = select(value.root).reconcileTransient(value.lease, value.volume, value.full,
          value.unstarted ? { workClass: value.workClass!, bytes: value.bytes! } : undefined);
        // An absent row is idempotent confirmation, not capacity released.
        trace.add(removed ? 'recovered' : 'settled', 1); trace.finish(); reply(value.id, 'reconcile', true);
      } catch (error) {
        trace.add('unknown', 1); addSqlFailure(trace, error);
        trace.finish(true); reply(value.id, 'reconcile', false, error);
      }
      return;
    }
    if (value.kind !== 'begin') { process.exitCode = 1; port.close(); return; }
    if (value.id <= highest) { reply(value.id, 'begin', false); return; }
    highest = value.id;
    if (inFlight.size >= 256) {
      reply(value.id, 'begin', false, new StorageAdmissionDeferred('coordinator-capacity')); return;
    }
    if (typeof value.root !== 'string' || !value.root.length || value.root.includes('\0') ||
      !['recovery', 'durable', 'projection', 'export'].includes(value.workClass!) ||
      !Number.isSafeInteger(value.bytes) || value.bytes! < 1 || value.bytes! > 4 * 1024 ** 3 ||
      (value.volume !== undefined && (typeof value.volume !== 'string' || !/^[0-9]{1,32}$/.test(value.volume) || value.lease === undefined)) ||
      (value.lease !== undefined && (typeof value.lease !== 'string' || !/^transient-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.lease)))) {
      reply(value.id, 'begin', false, new StorageAdmissionDeferred('estimate')); return;
    }
    inFlight.add(value.id);
    void (async () => {
      let admitted = false;
      let volume: string | undefined;
      try {
        await select(value.root!).run(value.workClass!, value.bytes!, () => new Promise<void>((resolve, reject) => {
          active.set(value.id, { settle: full => full ? reject(Object.assign(new Error('write-full'), { code: 'ENOSPC' })) : resolve() });
          admitted = true;
          reply(value.id, 'begin', true, undefined, volume);
        }), value.lease === undefined ? undefined : { requestId: value.lease, acquired: device => { volume = device; },
          ...(value.volume === undefined ? {} : { expectedVolume: value.volume }) });
        reply(value.id, 'finish', true);
      } catch (error) {
        // Report before transport failure can terminate the original owner.
        // Numeric classification is observation only, never release/retry proof.
        const trace = diagnostics.start('storage-coordinator-recovery');
        trace.add('step', admitted ? 4 : 3); trace.add('pending', inFlight.size);
        // Once admitted, a failed release is uncertain even if the thrown
        // object resembles an ordinary pre-admission capacity refusal.
        if (!admitted && volumeAdmissionRefusal(error) !== undefined) trace.add('deferred', 1);
        else { trace.add('unknown', 1); addSqlFailure(trace, error); }
        trace.finish(true);
        reply(value.id, admitted ? 'finish' : 'begin', false, error);
      }
      finally { inFlight.delete(value.id); }
    })();
  });
}
