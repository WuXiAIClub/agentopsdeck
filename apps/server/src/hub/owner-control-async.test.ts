import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { asyncVolumeAdmission } from '../storage/async-volume-admission.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubCreationRoutes } from './creation-http.js';
import { registerHubDeletionRoutes } from './deletion-http.js';
import { registerHubSettingsRoutes } from './settings-http.js';
import { registerHubCompactRoutes } from './compact-http.js';
import { registerHubQueueRoutes } from './queue-http.js';
import { registerHubMessageRoutes } from './message-http.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

const operations = ['message', 'create', 'delete', 'settings', 'compact', 'queue'] as const;
for (const operation of operations) {
  test(`Hub ${operation} async admission rechecks authority before owner SQL and after commit`, { timeout: 10_000 }, async t => {
    const f = fixture(); t.after(() => f.close());
    for (const committed of [false, true]) {
      const entered = gate(), release = gate(); let writes = 0;
      t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
        const result = committed ? (writes++, await write()) : undefined;
        entered.release(); await release.promise;
        return committed ? result : (writes++, await write());
      });
      const key = `${operation}-${committed}`, request = f.request(operation, key);
      await entered.promise;
      assert.equal(f.db.isTransaction, false, 'no transaction may span the admission/release await');
      assert.equal(f.rows(), committed ? 1 : 0);
      // A different owner's observation remains responsive while admission waits.
      assert.equal(f.store.getConnection('node', 'owner')?.label, 'node');
      f.bump(); release.release();
      assert.equal((await request).status, 403);
      assert.equal(f.calls.length, 0, 'revocation must not deliver or look up on the new generation');
      assert.equal(writes, 1);
      assert.equal(f.rows(), committed ? 1 : 0);
      if (committed) {
        assert.equal(f.db.prepare('SELECT state FROM command_receipts WHERE command_key = ?').get(key)?.state, 'outcome_unknown');
        assert.equal((await f.request(operation, key)).status, operation === 'message' ? 202 : 409,
          'ordinary messages retain original no-authority receipts; controls remain bound to original node authority');
        assert.deepEqual(f.calls, operation === 'message' ? ['GET'] : []);
      }
      t.mock.restoreAll();
    }
  });

  test(`Hub ${operation} reports deferred async storage as unavailable without delivery`, async t => {
    const f = fixture(); t.after(() => f.close());
    t.mock.method(asyncVolumeAdmission, 'run', async () => { throw new StorageAdmissionDeferred('synthetic'); });
    const response = await f.request(operation, 'deferred');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Command storage admission unavailable' });
    assert.equal(f.calls.length, 0); assert.equal(f.rows(), 0);
  });

  test(`Hub ${operation} lost release acknowledgment retains original receipt and retries observation only`, async t => {
    const f = fixture(); t.after(() => f.close());
    const logs: any[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
    let admissions = 0;
    t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
      admissions++; await write(); throw new StorageAdmissionDeferred('synthetic lost release');
    });
    assert.equal((await f.request(operation, 'lost-release')).status, 503);
    const original = f.db.prepare('SELECT id, state FROM command_receipts WHERE command_key = ?').get('lost-release')!;
    assert.equal(original.state, 'outcome_unknown'); assert.equal(f.calls.length, 0);
    assert.equal((await f.request(operation, 'lost-release')).status, 202);
    assert.equal(admissions, 1, 'duplicate bypasses storage pressure and never requests another admission');
    assert.deepEqual(f.calls, ['GET'], 'retry may only observe the original Connector receipt');
    assert.deepEqual(f.db.prepare('SELECT id, state FROM command_receipts WHERE command_key = ?').get('lost-release'), original);
    const failed = logs.find(row => row.operation === 'command-receipt-admission' && row.category === 'failed');
    assert.equal(failed?.unknown, 1, 'committed uncertainty has a diagnostic distinct from pre-admission deferral');
    assert.equal(JSON.stringify(logs).includes('lost-release'), false, 'logs never expose command keys');
  });
}

test('Hub store closed during async admission cannot run its delayed SQL writer', async t => {
  const f = fixture(); t.after(() => f.close());
  const entered = gate(), release = gate();
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    entered.release(); await release.promise; return write();
  });
  const request = f.request('queue', 'closed');
  await entered.promise; f.close(); release.release();
  assert.equal((await request).status, 502); assert.equal(f.calls.length, 0);
});

test('Hub cancelled during admission never commits or dispatches its original command', async t => {
  const f = fixture(); t.after(() => f.close());
  const entered = gate(), release = gate(), controller = new AbortController();
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    entered.release(); await release.promise; return write();
  });
  const request = f.request('delete', 'cancelled', controller.signal);
  await entered.promise; controller.abort(); release.release();
  assert.equal((await request).status, 502); assert.equal(f.rows(), 0); assert.equal(f.calls.length, 0);
});

function fixture() {
  const store = new HubStore(join(mkdtempSync(join(tmpdir(), 'agentopsdeck-owner-async-')), 'hub.sqlite'), 'synthetic');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const bump = () => {
    store.upsertConnection({ id: 'node', ownerUserId: 'owner', label: 'node', connectorUrl: 'http://synthetic', kind: 'remote' });
    store.pinConnectionNode('node', 'owner', store.connectionAuthority('node', 'owner')!, 'node_00000000-0000-4000-8000-000000000001');
  };
  bump();
  const calls: string[] = [], app = new Hono();
  const deps = { store, owner: () => 'owner', client: (() => ({
    json: async () => { calls.push('GET'); throw new Error('Synthetic unavailable observation'); },
    jsonResponse: async () => { calls.push('MUTATION'); throw new Error('No delivery allowed'); },
  })) as any, error: (c: any) => c.json({ error: 'synthetic failure' }, 502) };
  registerHubCreationRoutes(app, deps); registerHubDeletionRoutes(app, deps);
  registerHubSettingsRoutes(app, deps); registerHubCompactRoutes(app, deps);
  registerHubQueueRoutes(app, '/api/hub/v1/sessions/:hubSessionId', deps);
  registerHubMessageRoutes(app, '/api/hub/v1/sessions/:hubSessionId', deps);
  const session = encodeURIComponent(encodeHubSessionId('node', 'codex:s'));
  let closed = false;
  return { store, db, calls, bump, rows: () => Number(db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n),
    close: () => { if (!closed) { closed = true; store.close(); } },
    request: (operation: typeof operations[number], key: string, signal?: AbortSignal) => {
      const path = operation === 'create' ? '/api/hub/v1/connections/node/agents/codex/sessions'
        : operation === 'delete' || operation === 'settings' ? `/api/sessions/${session}`
        : `/api/hub/v1/sessions/${session}${operation === 'message' ? '/messages' : operation === 'compact' ? '/compact' : operation === 'queue' ? '/queue/q' : ''}`;
      return app.request(path, { method: operation === 'delete' ? 'DELETE' : operation === 'queue' || operation === 'settings' ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, 'if-match': '"1:1"' }, ...(signal ? { signal } : {}),
        ...(operation === 'delete' ? {} : { body: JSON.stringify(operation === 'queue' ? { message: 'text' } : {}) }) });
    } };
}
