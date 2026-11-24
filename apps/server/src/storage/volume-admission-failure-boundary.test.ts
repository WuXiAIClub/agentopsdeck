import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import { installVolumeAdmissionProtocol } from './volume-admission-protocol.js';
import type { VolumeAdmission } from './volume-admission.js';
import { StorageAdmissionDeferred } from './work-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
class Port extends EventEmitter {
  replies: unknown[] = [];
  postMessage(value: unknown) { this.replies.push(value); }
  close() {}
}
for (const phase of ['begin', 'finish', 'reconcile'] as const) {
  for (const failure of ['revoked-proxy', 'prototype-trap', 'message-getter', 'private-message', 'known-denial', 'refusal-like-fault', 'sql-busy'] as const) {
    test(`coordinator ${phase} failure ${failure} cannot stall or leak through classification`, async () => {
      let inspections = 0;
      let error: unknown;
      if (failure === 'revoked-proxy') { const pair = Proxy.revocable({}, {}); pair.revoke(); error = pair.proxy; }
      else if (failure === 'prototype-trap') error = new Proxy({}, { getPrototypeOf() { inspections++; throw Error('private-prototype'); } });
      else if (failure === 'sql-busy') error = Object.assign(Error('private-sql-path-and-query'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
      else {
        error = new StorageAdmissionDeferred(failure === 'known-denial' ? 'insufficient-space'
          : failure === 'refusal-like-fault' ? 'coordinator-unavailable' : 'private-lowercase-secret');
        if (failure === 'message-getter') Object.defineProperty(error, 'message', { get() { inspections++; throw Error('private-message-getter'); } });
      }
      const port = new Port(), rows: Record<string, unknown>[] = [];
      const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
      installVolumeAdmissionProtocol(port as unknown as MessagePort, () => ({
        run: async (_class: unknown, _bytes: unknown, write: () => Promise<void>) => {
          if (phase === 'finish') await write();
          throw error;
        },
        reconcileTransient: () => { throw error; },
      }) as unknown as VolumeAdmission, diagnostics);
      const kind = phase === 'reconcile' ? 'reconcile' : 'begin';
      port.emit('message', { id: 1, kind, root: '/private-root',
        ...(phase === 'reconcile' ? { full: false, volume: '42', lease: 'transient-12345678-1234-4123-8123-123456789abc' }
          : { workClass: 'durable', bytes: 1 }) });
      if (phase === 'finish') port.emit('message', { id: 1, kind: 'finish', full: false });
      await turn();
      assert.equal(inspections, 0, 'Do not invoke exception getters or Proxy traps');
      const reason = failure === 'known-denial' && phase !== 'finish' ? 'insufficient-space' : 'coordinator-unavailable';
      assert.deepEqual(port.replies.at(-1), { id: 1, kind: phase, ok: false, reason });
      assert.doesNotMatch(JSON.stringify([port.replies, rows]), /private-/);
      const row = rows.find(row => row.operation === 'storage-coordinator-recovery');
      assert.ok(row);
      assert.equal(row.step, phase === 'reconcile' ? 2 : phase === 'finish' ? 4 : 3);
      const uncertain = phase === 'reconcile' || reason === 'coordinator-unavailable';
      assert.equal(row[uncertain ? 'unknown' : 'deferred'], 1);
      if (failure === 'sql-busy') assert.equal(row.sqlErrorCode, 5);
      else if (uncertain) assert.equal(row.classificationUnknown, 1);
    });
  }
}
