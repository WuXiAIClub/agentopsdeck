import { Worker } from 'node:worker_threads';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validStoppedCodexRuns, type StoppedCodexRun, type StoppedCodexProof } from './stopped-recovery.js';

export type StoppedRecoveryOwnerRequest = { file: string; dev: number; ino: number; deadline: number;
  runs: readonly StoppedCodexRun[]; proof: StoppedCodexProof };
export class StoppedRecoveryOwnerUnavailable extends Error {
  constructor() { super('Stopped recovery owner unavailable; inspect original proof before proceeding'); }
}

/** One shot, one database owner, no SQL RPC or business retry. Completion includes owner
 * exit, so the caller cannot sync/close its proof descriptor while SQL runs.
 * A deadline requests termination, but never treats that request as exit proof.
 */
export async function recordStoppedRecoveryOwned(request: StoppedRecoveryOwnerRequest,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, launch?: () => Worker): Promise<void> {
  // Fixed numeric diagnostics only: step 1 admission rejected, 2 launch failed,
  // 3 awaiting actual exit, 4 exit observed. Never log proof, paths or payloads.
  const trace = diagnostics.start('codex-stopped-recovery-owner');
  if (!validStoppedCodexRuns(request.runs) || !Number.isSafeInteger(request.deadline)) {
    trace.add('step', 1); trace.add('ownerFailureCode', 1); trace.finish(true);
    throw new StoppedRecoveryOwnerUnavailable();
  }
  if (request.deadline <= Date.now()) {
    trace.add('step', 1); trace.add('ownerFailureCode', 2); trace.add('timedOut', 1); trace.finish(true);
    throw new StoppedRecoveryOwnerUnavailable();
  }
  // Keep post-await deadline/identity checks bound to the admitted request,
  // never to caller-owned mutable data.
  request = { ...request, runs: request.runs.map(run => ({ ...run })), proof: { ...request.proof } };
  const source = new URL(import.meta.url).pathname.endsWith('.ts');
  const entry = new URL(source ? './stopped-recovery-worker.ts' : './stopped-recovery-worker.js', import.meta.url);
  let worker: Worker;
  try {
    worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      request, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
  } catch {
    trace.add('step', 2); trace.add('ownerFailureCode', 3); trace.finish(true);
    throw new StoppedRecoveryOwnerUnavailable();
  }
  await new Promise<void>((resolve, reject) => {
    let failed = false, acknowledged = false;
    // Retry only refused physical cleanup on this exact worker, with cooldown.
    // Never replay SQL, reopen its database or infer exit from terminate ACK.
    const originalStop = createOriginalWorkerStop(worker, () => trace.reportPending({ step: 3 }));
    const fail = (failureCode: number, timedOut = false) => {
      if (failed) return;
      failed = true; trace.add('unknown', 1); trace.add('timedOut', Number(timedOut));
      trace.add('ownerFailureCode', failureCode);
      // Termination ACK is not owner exit. Keep the same trace pending until
      // the exit listener observes closure, including if terminate rejects.
      trace.reportPending({ step: 3 });
      // Keep waiting for exit: terminate() rejection is not ownership release.
      originalStop.request();
    };
    const timer = setTimeout(() => fail(6, true), Math.max(1, Math.min(30_000, request.deadline - Date.now())));
    worker.on('message', (message: unknown) => {
      if (failed) return;
      if (acknowledged || !message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).sort().join(',') !== 'kind,ok'
        || (message as { kind?: unknown }).kind !== 'stopped-recovery'
        || (message as { ok?: unknown }).ok !== true) { fail(4); return; }
      acknowledged = true;
    });
    worker.on('error', () => fail(5));
    worker.once('exit', code => {
      clearTimeout(timer);
      originalStop.confirmExit();
      trace.add('step', 4);
      if (failed || !acknowledged || code !== 0 || request.deadline <= Date.now()) {
        if (!failed) {
          trace.add('unknown', 1);
          trace.add('ownerFailureCode', !acknowledged ? 7 : code !== 0 ? 8 : 9);
          if (request.deadline <= Date.now()) trace.add('timedOut', 1);
        }
        trace.finish(true); reject(new StoppedRecoveryOwnerUnavailable());
      } else { trace.add('settled', 1); trace.finish(); resolve(); }
    });
  });
}
