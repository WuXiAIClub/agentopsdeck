import { Worker } from 'node:worker_threads';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validStoppedUnknownDisposition, type StoppedUnknownDisposition } from './stopped-unknown-disposition.js';
import { validStoppedUnknownBatchDisposition, type StoppedUnknownBatchDisposition } from './stopped-unknown-batch.js';
import { validStoppedUnknownRetirement, type StoppedUnknownRetirement } from './stopped-unknown-retirement.js';
import { validStoppedOwnedLoadRecovery, type StoppedOwnedLoadRecovery } from './stopped-owned-load-recovery.js';

export type StoppedUnknownOwnerRequest = {
  file: string; dev: number | string; ino: number | string; deadline: number;
  disposition: StoppedUnknownDisposition | StoppedUnknownBatchDisposition | StoppedUnknownRetirement | StoppedOwnedLoadRecovery;
};
export class StoppedUnknownOwnerUnavailable extends Error {
  constructor() { super('Stopped unknown owner unavailable; inspect original audit before proceeding'); }
}

function validFileIdentity(value: number | string): boolean {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

export async function disposeStoppedUnknownOwned(request: StoppedUnknownOwnerRequest,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, launch?: () => Worker): Promise<void> {
  if ((!validStoppedUnknownDisposition(request.disposition) && !validStoppedUnknownBatchDisposition(request.disposition)
    && !validStoppedUnknownRetirement(request.disposition) && !validStoppedOwnedLoadRecovery(request.disposition))
    || !validFileIdentity(request.dev) || !validFileIdentity(request.ino) || !Number.isSafeInteger(request.deadline)
    || request.deadline <= Date.now()) throw new StoppedUnknownOwnerUnavailable();
  request = JSON.parse(JSON.stringify(request)) as StoppedUnknownOwnerRequest;
  const trace = diagnostics.start('codex-stopped-unknown-owner');
  const source = new URL(import.meta.url).pathname.endsWith('.ts');
  const entry = new URL(source ? './stopped-unknown-worker.ts' : './stopped-unknown-worker.js', import.meta.url);
  let worker: Worker;
  try {
    worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      request, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
  } catch { trace.finish(true); throw new StoppedUnknownOwnerUnavailable(); }
  await new Promise<void>((accept, reject) => {
    let failed = false, acknowledged = false;
    const stop = createOriginalWorkerStop(worker, () => trace.reportPending({ step: 1 }));
    const fail = () => {
      if (failed) return;
      failed = true; trace.add('unknown', 1); trace.reportPending({ step: 1 }); stop.request();
    };
    const timer = setTimeout(fail, Math.max(1, Math.min(30_000, request.deadline - Date.now())));
    worker.on('message', (message: unknown) => {
      if (failed) return;
      if (acknowledged || !message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).sort().join(',') !== 'kind,ok'
        || (message as { kind?: unknown }).kind !== 'stopped-unknown'
        || (message as { ok?: unknown }).ok !== true) { fail(); return; }
      acknowledged = true;
    });
    worker.on('error', fail);
    worker.once('exit', code => {
      clearTimeout(timer); stop.confirmExit();
      if (failed || !acknowledged || code !== 0 || request.deadline <= Date.now()) {
        trace.add('unknown', 1); trace.finish(true); reject(new StoppedUnknownOwnerUnavailable());
      } else { trace.add('settled', 1); trace.finish(); accept(); }
    });
  });
}
