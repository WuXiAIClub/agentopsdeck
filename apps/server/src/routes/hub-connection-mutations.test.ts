import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerSynchronousHubConnectionMutations } from './hub-connection-mutations.js';

function fixture(warningMs = 30_000, sinkFails = false) {
  const root = mkdtempSync(join(tmpdir(), 'hub-connections-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  let actor: HubPrincipal | undefined = { userId: 'default', admin: false };
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => {
    if (sinkFails) throw Error('PRIVATE diagnostic sink'); rows.push(JSON.parse(line));
  });
  const app = new Hono();
  app.onError((error, c) => error instanceof HTTPException
    ? c.json({ error: error.message }, error.status) : c.json({ error: 'unexpected' }, 500));
  registerSynchronousHubConnectionMutations(app, { store, diagnostics, warningMs,
    principal() { if (!actor) throw new HTTPException(401, { message: 'unauthorized' }); return actor; },
    present(connection, users) { return { id: connection.id, label: connection.label,
      connectorUrl: connection.connectorUrl, ownerLabel: users.find(u => u.id === connection.ownerUserId)?.label }; },
  });
  store.upsertConnection({ id: 'original', kind: 'remote', label: 'Original', connectorUrl: 'https://original.invalid', status: 'enabled', credentialToken: 'PRIVATE daily' });
  return { app, store, rows, diagnostics, revoke: () => { actor = undefined; },
    changeActor: (next: HubPrincipal) => { actor = next; },
    cleanup: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const request = (f: ReturnType<typeof fixture>, method = 'PATCH', body: unknown = { enabled: false }, path = '/api/hub/v1/connections/original') =>
  f.app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(method !== 'DELETE' ? { body: JSON.stringify(body) } : {}) });
const finished = (f: ReturnType<typeof fixture>) => f.rows.filter(row => row.operation === 'hub-connection-mutation' && row.phase === 'finished');

for (const fault of ['start', 'add', 'add-getter', 'pending', 'pending-getter', 'finish', 'finish-getter'] as const)
test('connection '+fault+' observation cannot prevent SQL or replace its ACK', async t => {
  const f=fixture(1);let writes=0;
  const original=f.store.upsertConnection.bind(f.store);
  t.mock.method(f.store,'upsertConnection',(...args:Parameters<HubStore['upsertConnection']>)=>{writes++;return original(...args);});
  const rename=f.store.renameConnection.bind(f.store);
  t.mock.method(f.store,'renameConnection',(...args:Parameters<HubStore['renameConnection']>)=>{writes++;return rename(...args);});
  t.mock.method(f.store,'listUsersAsync',async()=>{await new Promise(resolve=>setTimeout(resolve,10));return f.store.listUsers();});
  t.mock.method(f.diagnostics,'start',()=>{
    if(fault==='start')throw Error('PRIVATE log start');
    return {
      get add(){if(fault==='add-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='add')throw Error('PRIVATE add');};},
      get reportPending(){if(fault==='pending-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='pending')throw Error('PRIVATE pending');};},
      get finish(){if(fault==='finish-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='finish')throw Error('PRIVATE finish');};},
    };
  });
  try{const response=await request(f,'PATCH',{label:'Settled'});assert.equal(response.status,200);
    assert.equal(writes,1);assert.equal(f.store.getConnection('original')!.label,'Settled');}
  finally{await f.cleanup();}
});

test('connection saves preserve original member policy, frontend wire shape, credential and display-only epoch', async () => {
  const f = fixture();
  try {
    const epoch = f.store.connectionAuthority('original');
    const renamed = await request(f, 'PATCH', { label: 'Renamed', environmentLabel: 'Environment', frontendExtra: true });
    assert.equal(renamed.status, 200); const body = await renamed.json();
    assert.deepEqual(Object.keys(body).sort(), ['connection', 'updatedAt']); assert.equal(body.connection.label, 'Renamed');
    assert.equal(f.store.connectionAuthority('original'), epoch); assert.equal(f.store.getCredentialToken('original'), 'PRIVATE daily');
    const created = await request(f, 'POST', { id: 'created', connectorUrl: 'https://created.invalid', capabilities: ['sessions', 42], frontendExtra: true }, '/api/hub/v1/connections');
    assert.equal(created.status, 201); assert.deepEqual(f.store.getConnection('created')!.capabilities, ['sessions']);
    const disabled = await request(f); assert.equal(disabled.status, 200); assert.equal(f.store.getCredentialToken('original'), 'PRIVATE daily');
    assert.ok(f.store.connectionAuthority('original')! > epoch!);
    for (const response of [renamed, created, disabled]) { assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('retry-after'), null); }
    const maintenance = await request(f, 'PUT', { token: ' PRIVATE maintenance ' }, '/api/hub/v1/connections/original/maintenance-credential');
    assert.equal(maintenance.status, 200); assert.equal(f.store.getMaintenanceCredentialToken('original'), 'PRIVATE maintenance');
    assert.deepEqual(Object.keys(await maintenance.json()).sort(), ['hasMaintenanceCredential', 'ok', 'updatedAt']);
    const deleted = await request(f, 'DELETE'); assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { ok: true });
    assert.equal((await request(f, 'DELETE')).status, 404);
    assert.equal(f.store.getCredentialToken('original'), undefined); assert.equal(f.store.getMaintenanceCredentialToken('original'), undefined);
    assert.doesNotMatch(JSON.stringify(finished(f)), /PRIVATE|original.invalid|Renamed/);
  } finally { await f.cleanup(); }
});

for (const invalid of [null, [], 42, { connectorUrl: 42 }, { connectorUrl: {} }, { connectorUrl: 'local://aod-connector' }, { connectorUrl: 'invalid' }, { connectorUrl: 'https://valid.invalid', capabilities: 'sessions' }, { connectorUrl: 'https://valid.invalid', label: 42 }])
  test(`connection create rejects malformed body ${JSON.stringify(invalid)} before effect`, async t => {
    const f = fixture(); let writes = 0;
    t.mock.method(f.store, 'upsertConnection', () => { writes++; throw Error('must not write'); });
    try { const response = await request(f, 'POST', invalid, '/api/hub/v1/connections'); assert.equal(response.status, 400); assert.equal(writes, 0); assert.equal(finished(f)[0].unknown, undefined); }
    finally { await f.cleanup(); }
  });

for (const change of ['revoked', 'other-owner', 'role', 'aborted', 'epoch', 'sql', 'revoked-sql'] as const)
  test(`connection readonly delivery denies ${change} without retrying a settled write`, async t => {
    const f = fixture(), signal = new AbortController(); let writes = 0;
    const original = f.store.upsertConnection.bind(f.store);
    t.mock.method(f.store, 'upsertConnection', (...args: Parameters<HubStore['upsertConnection']>) => { writes++; return original(...args); });
    t.mock.method(f.store, 'listUsers', () => { throw Error('PRIVATE sync directory'); });
    t.mock.method(f.store, 'listUsersAsync', async () => {
      if (change.startsWith('revoked')) f.revoke();
      if (change === 'other-owner') f.changeActor({ userId: 'other', admin: false });
      if (change === 'role') f.changeActor({ userId: 'default', admin: true });
      if (change === 'aborted') signal.abort();
      if (change === 'epoch') original({ id: 'original', kind: 'remote', label: 'Replacement', connectorUrl: 'https://replacement.invalid', status: 'enabled' });
      if (change.endsWith('sql')) throw Error('PRIVATE SQL');
      return [];
    });
    try {
      const response = await f.app.fetch(new Request('http://fixture.invalid/api/hub/v1/connections/original', { method: 'PATCH', body: '{"enabled":false}', signal: signal.signal }));
      assert.equal(response.status, ['revoked', 'other-owner', 'role', 'revoked-sql'].includes(change) ? 401 : change === 'epoch' ? 409 : change === 'sql' ? 200 : 503);
      assert.equal(writes, 1); assert.doesNotMatch(await response.text(), /PRIVATE|replacement.invalid/);
      const [row] = finished(f); assert.equal(row.settled, 1); assert.equal(row.unknown, undefined); assert.equal(row.category, 'failed');
      if (change === 'sql') assert.equal(row.deferred, 1);
      assert.equal(f.store.getCredentialToken('original'), 'PRIVATE daily');
    } finally { await f.cleanup(); }
  });

for (const after of [false, true])
  test(`connection original effect failure afterCommit=${after} logs unknown and never replays`, async t => {
    const f = fixture(); let writes = 0;
    const original = f.store.upsertConnection.bind(f.store);
    t.mock.method(f.store, 'upsertConnection', (...args: Parameters<HubStore['upsertConnection']>) => { writes++; if (after) original(...args); throw Error('PRIVATE COMMIT ACK'); });
    try {
      const response = await request(f); assert.ok([409, 503].includes(response.status)); assert.equal(writes, 1);
      assert.equal(f.store.getConnection('original')!.status, after ? 'disabled' : 'enabled');
      assert.equal(finished(f)[0].unknown, 1); assert.equal(finished(f)[0].settled, undefined);
      assert.doesNotMatch(await response.text(), /PRIVATE/); assert.doesNotMatch(JSON.stringify(finished(f)), /PRIVATE/);
    } finally { await f.cleanup(); }
  });

test('connection epoch SQL failures remain sanitized even when final current proof also fails', async t => {
  const f = fixture(); let reads = 0;
  t.mock.method(f.store, 'connectionAuthority', () => { if (++reads > 1) throw Error('PRIVATE credential SELECT'); return 1; });
  try {
    const response = await request(f); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'hub_connections_unavailable' });
    assert.equal(finished(f)[0].unknown, undefined); assert.equal(f.store.getConnection('original')!.status, 'enabled');
  } finally { await f.cleanup(); }
});

for (const epoch of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
  test(`connection invalid original authority ${epoch} never admits a write`, async t => {
    const f = fixture(); let writes = 0;
    t.mock.method(f.store, 'connectionAuthority', () => epoch as number | undefined);
    t.mock.method(f.store, 'upsertConnection', () => { writes++; throw Error('must not write'); });
    try {
      const response = await request(f); assert.equal(response.status, 503); assert.equal(writes, 0);
      assert.equal(finished(f)[0].admitted, undefined); assert.equal(finished(f)[0].unknown, undefined);
    } finally { await f.cleanup(); }
  });

test('connection create retains successful ACK when only optional owner display lookup fails', async t => {
  const f = fixture(); let writes = 0;
  const upsert = f.store.upsertConnection.bind(f.store);
  t.mock.method(f.store, 'upsertConnection', (...args: Parameters<HubStore['upsertConnection']>) => { writes++; return upsert(...args); });
  t.mock.method(f.store, 'listUsersAsync', async () => { throw Error('PRIVATE display SQL'); });
  try {
    const response = await request(f, 'POST', { connectorUrl: 'https://new.invalid', token: 'PRIVATE newly saved' }, '/api/hub/v1/connections');
    assert.equal(response.status, 201); assert.equal(writes, 1);
    const body = await response.json(); assert.ok(body.connection.id); assert.equal(body.connection.ownerLabel, undefined);
    assert.equal(f.store.getCredentialToken(body.connection.id), 'PRIVATE newly saved');
    const [row] = finished(f); assert.equal(row.settled, 1); assert.equal(row.deferred, 1); assert.equal(row.unknown, undefined);
    assert.equal(row.category, 'failed'); assert.doesNotMatch(JSON.stringify(body), /PRIVATE/);
    assert.doesNotMatch(JSON.stringify(finished(f)), /PRIVATE|new.invalid/);
  } finally { await f.cleanup(); }
});

test('connection final pre-effect proof failure never records an unknown write', async t => {
  const f = fixture(); let reads = 0, writes = 0;
  const authority = f.store.connectionAuthority.bind(f.store);
  t.mock.method(f.store, 'connectionAuthority', (...args: Parameters<HubStore['connectionAuthority']>) => {
    if (++reads >= 3) throw Error('PRIVATE final proof SELECT');
    return authority(...args);
  });
  t.mock.method(f.store, 'upsertConnection', () => { writes++; throw Error('must not write'); });
  try {
    const response = await request(f); assert.equal(response.status, 503); assert.equal(writes, 0);
    const [row] = finished(f); assert.equal(row.step, 4); assert.equal(row.admitted, undefined);
    assert.equal(row.unknown, undefined); assert.equal(row.settled, undefined);
    assert.equal(f.store.getConnection('original')!.status, 'enabled');
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  } finally { await f.cleanup(); }
});

test('connection post-effect epoch read failure retains settlement without unknown or replay', async t => {
  const f = fixture(); let reads = 0, writes = 0;
  const authority = f.store.connectionAuthority.bind(f.store), upsert = f.store.upsertConnection.bind(f.store);
  t.mock.method(f.store, 'connectionAuthority', (...args: Parameters<HubStore['connectionAuthority']>) => {
    if (++reads >= 4) throw Error('PRIVATE post-effect SELECT');
    return authority(...args);
  });
  t.mock.method(f.store, 'upsertConnection', (...args: Parameters<HubStore['upsertConnection']>) => { writes++; return upsert(...args); });
  try {
    const response = await request(f); assert.equal(response.status, 503); assert.equal(writes, 1);
    const [row] = finished(f); assert.equal(row.step, 5); assert.equal(row.admitted, 1);
    assert.equal(row.unknown, undefined); assert.equal(row.settled, 1);
    assert.equal(f.store.getConnection('original')!.status, 'disabled');
    assert.doesNotMatch(await response.text(), /PRIVATE/); assert.doesNotMatch(JSON.stringify(finished(f)), /PRIVATE/);
  } finally { await f.cleanup(); }
});

for (const sinkFails of [false, true])
  test(`connection pending observation retains the original write and sink failure is harmless=${sinkFails}`, async t => {
    const f = fixture(1, sinkFails); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    t.mock.method(f.store, 'listUsersAsync', async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return []; });
    const pending = request(f);
    try {
      await waiting; await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(f.store.getConnection('original')!.status, 'disabled');
      const observations = f.diagnostics.snapshot().events.filter(row => row.operation === 'hub-connection-mutation');
      assert.equal(observations.length, 1); assert.equal(observations[0]!.phase, 'pending'); assert.equal(observations[0]!.step, 5);
      release(); assert.equal((await pending).status, 200);
      assert.equal(f.diagnostics.snapshot().events.filter(row => row.operation === 'hub-connection-mutation').length, 2);
    } finally { release?.(); await pending; await f.cleanup(); }
  });
