import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const scope = 'a'.repeat(64);
const snapshot = { principal: { userId: 'fixture-admin', admin: true }, recoveryScope: scope };
const page = { records: [], retentionDays: 90, maxRecords: 10000, persistent: true, startedAt: 1 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const port = (command: (...args: unknown[]) => Promise<unknown>) => ({ command }) as Pick<AsyncHubMemberOwner, 'command'>;
const quiet = new PerformanceDiagnostics(() => {});

test('abort and warning retain the original pruning operation until its real ACK, with no resend', async () => {
  const accepted = deferred<void>(), original = deferred<typeof page>(), logs: string[] = [];
  let writes = 0;
  const audit = new AsyncHubAuditLog(port(async kind => {
    if (kind === 'memberSnapshot') return snapshot;
    assert.equal(kind, 'auditPage'); writes++; accepted.resolve(); return original.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 10);
  const abort = new AbortController();
  const request = new Request('http://localhost/', { signal: abort.signal });
  let settled = false;
  const operation = audit.page({}, request);
  const rejected = assert.rejects(operation, error => error instanceof HubMemberRequestError && error.status === 499);
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await accepted.promise; abort.abort();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false); assert.equal(audit.pending, 1); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"')));
  original.resolve(page); await rejected; await tick();
  assert.equal(audit.pending, 0); assert.equal(writes, 1);
});

test('revocation after audit effect denies delivery without replay or pretending the effect rolled back', async () => {
  let revoked = false, writes = 0;
  const audit = new AsyncHubAuditLog(port(async kind => {
    if (kind === 'memberSnapshot') return revoked ? null : snapshot;
    assert.equal(kind, 'auditList'); writes++; revoked = true; return [];
  }), quiet);
  await assert.rejects(audit.list(100, new Request('http://localhost/')),
    error => error instanceof HubMemberRequestError && error.status === 401);
  assert.equal(writes, 1); assert.equal(audit.pending, 0);
});

test('audit options are snapshotted before any permission await and optional undefined stays wire-compatible', async () => {
  const first = deferred<typeof snapshot>(), started = deferred<void>();
  let reads = 0, captured: unknown;
  const audit = new AsyncHubAuditLog(port(async (kind, input) => {
    if (kind === 'memberSnapshot') { reads++; started.resolve(); return reads === 1 ? first.promise : snapshot; }
    assert.equal(kind, 'auditPage'); captured = input; return page;
  }), quiet);
  const options = { limit: 20, userId: undefined, before: undefined };
  const operation = audit.page(options, new Request('http://localhost/'));
  await started.promise; options.limit = 99; first.resolve(snapshot);
  await operation;
  assert.deepEqual(JSON.parse(JSON.stringify(captured)), { evidence: {}, expectedScope: scope, options: { limit: 20 } });
});

test('getters, proxies and toJSON never execute while validating audit facts or query options', async () => {
  let observed = 0, dispatched = 0;
  const audit = new AsyncHubAuditLog(port(async () => { dispatched++; return snapshot; }), quiet);
  const getter = Object.defineProperty({}, 'limit', { enumerable: true, get() { observed++; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { observed++; return []; } });
  const toJSON = { toJSON() { observed++; return {}; } };
  const request = new Request('http://localhost/');
  for (const value of [getter, proxy, toJSON]) {
    await assert.rejects(audit.page(value, request));
    await assert.rejects(audit.append(value as never));
  }
  assert.equal(observed, 0); assert.equal(dispatched, 0); assert.equal(audit.pending, 0);
});
