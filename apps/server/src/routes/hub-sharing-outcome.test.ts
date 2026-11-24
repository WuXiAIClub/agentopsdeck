import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from '../hub/identity.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { SessionShareConflict, SessionSharePolicyConflict } from '../hub/node-grants.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubSessionSharingRoutes } from './hub-session-sharing.js';
import { registerHubOwnedSessionSharingRoutes } from './hub-owned-session-sharing.js';
import { sharingOutcome, SHARING_UNKNOWN } from './hub-sharing-outcome.js';

function seed(store: HubStore, owned: boolean) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), creator = store.createUser('Creator'), recipient = store.createUser('Recipient');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Environment', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = (userId: string) => ({ ownerUserId: owner.id, connectionId: 'node', userId });
  for (const user of [creator, recipient]) {
    const t = target(user.id), previous = store.roles.membership(t);
    store.roles.save(LEGACY_HUB_PRINCIPAL, t, { ...previous, role: 'developer', migrateLegacy: true,
      nodeVersion: store.connectionAuthority('node', owner.id)!, environments: { codex: 'developer', openclaw: 'disabled' } });
  }
  const sessionKey = 'codex:' + randomUUID(), sessionId = encodeHubSessionId('node', sessionKey);
  const creation = store.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
  store.grants.acceptCreatedSession(creation, sessionKey, randomUUID(), randomUUID(), () => {});
  const proof = store.grants.authorize(target(creator.id), 'sessions:share', { runtime: 'codex', sessionKey })!;
  const app = new Hono(), principal = () => ({ userId: owned ? owner.id : creator.id, admin: false });
  if (owned) registerHubOwnedSessionSharingRoutes(app, { hubStore: store, principal });
  else registerHubSessionSharingRoutes(app, { hubStore: store, principal });
  const path = owned ? '/api/hub/v1/sessions/' + sessionId + '/collaborators'
    : '/api/hub/v1/shared/' + owner.id + '/sessions/' + sessionId + '/collaborators';
  const request = (method: string, body: object, id?: string) => app.request(path + (id ? '/' + id : ''), {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const effects = () => ['node_grants', 'node_grant_dependencies', 'connector_memberships', 'hub_session_owners', 'command_receipts', 'hub_execution_leases']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  const create = async () => {
    const response = await request('POST', { userId: recipient.id, role: 'observer' });
    assert.equal(response.status, 201); return (await response.json()).grant as { id: string; version: number };
  };
  return { store, db, owner, creator, recipient, target, proof, sessionKey, request, effects, create };
}
async function fixture(owned: boolean, work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'sharing-outcome-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store, owned)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}

for (const owned of [false, true]) {
  const label = owned ? 'owned' : 'shared';
  test(label + ' original successful wire shape and stale version refusal', () => fixture(owned, async f => {
    const grant = await f.create();
    const update = await f.request('PUT', { version: grant.version, role: 'collaborator', queue: false }, grant.id);
    assert.equal(update.status, 200); const updated = (await update.json()).grant;
    assert.equal(updated.id, grant.id); assert.equal(updated.version, grant.version + 1);
    const before = f.effects();
    assert.equal((await f.request('PUT', { version: grant.version, role: 'observer' }, grant.id)).status, 409);
    assert.deepEqual(f.effects(), before);
    assert.ok(f.store.grants.authorize(f.target(f.recipient.id), 'messages:read', {
      runtime: 'codex', sessionKey: f.sessionKey,
    }));
    const revoke = await f.request('DELETE', { version: updated.version }, grant.id);
    assert.equal(revoke.status, 200);
    assert.deepEqual(await revoke.json(), owned ? { ok: true }
      : { ok: true, revocation: { state: 'confirmed', pending: 0, confirmed: 0 } });
    assert.equal(f.store.grants.authorize(f.target(f.recipient.id), 'messages:read', {
      runtime: 'codex', sessionKey: f.sessionKey,
    }), undefined);
  }));
  test(label + ' definite duplicate/policy refusal stays409 without effects', () => fixture(owned, async f => {
    const grant = await f.create(), before = f.effects();
    assert.equal((await f.request('POST', { userId: f.recipient.id, role: 'observer' })).status, 409);
    assert.equal((await f.request('PUT', { version: grant.version, role: 'observer', queue: true }, grant.id)).status, 409);
    assert.deepEqual(f.effects(), before);
  }));
  test(label + ' original zero-row capacity refusal stays409 only after settlement', () => fixture(owned, async f => {
    f.db.prepare('UPDATE node_grant_usage SET rows=10000 WHERE singleton=1').run();
    const before = f.effects(), response = await f.request('POST', { userId: f.recipient.id, role: 'observer' });
    assert.equal(response.status, 409); assert.deepEqual(f.effects(), before); assert.equal(f.db.isTransaction, false);
    const original = f.db.exec.bind(f.db); let releases = 0;
    f.db.exec = sql => { if (sql === 'RELEASE session_share') { releases++; throw Error('capacity settlement unknown'); } return original(sql); };
    try {
      assert.equal((await f.request('POST', { userId: f.recipient.id, role: 'observer' })).status, 503);
      assert.equal(releases, 1); assert.deepEqual(f.effects(), before);
    } finally { f.db.exec = original; }
  }));
  for (const operation of ['create', 'update', 'delete'] as const) {
    test(label + ' SQL ' + operation + ' fault is503, not permission conflict or replay', () => fixture(owned, async f => {
      const grant = operation === 'create' ? undefined : await f.create(), before = f.effects();
      const verb = operation === 'create' ? 'INSERT' : 'UPDATE';
      f.db.exec(`CREATE TRIGGER fixture_fault BEFORE ${verb} ON node_grants BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END`);
      const response = await f.request(operation === 'create' ? 'POST' : operation === 'update' ? 'PUT' : 'DELETE',
        operation === 'create' ? { userId: f.recipient.id, role: 'observer' } : operation === 'update'
          ? { version: grant!.version, role: 'collaborator' } : { version: grant!.version }, grant?.id);
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: SHARING_UNKNOWN });
      assert.deepEqual(f.effects(), before); assert.equal(f.db.isTransaction, false);
    }));
  }
  for (const operation of ['create', 'update'] as const) {
    for (const phase of ['beforeRelease', 'afterRelease', 'refusalRelease'] as const) {
      test(label + ' ' + operation + ' ' + phase + ' remains unknown and never repeats SQL', () => fixture(owned, async f => {
        const grant = operation === 'create' ? undefined : await f.create();
        if (phase === 'refusalRelease' && operation === 'create') await f.create();
        const before = f.effects(), original = f.db.exec.bind(f.db); let releases = 0;
        f.db.exec = sql => {
          if (sql === 'RELEASE session_share') {
            releases++; if (phase === 'afterRelease') original(sql);
            throw Error('private RELEASE fault');
          }
          return original(sql);
        };
        try {
          const response = await f.request(operation === 'create' ? 'POST' : 'PUT', operation === 'create'
            ? { userId: f.recipient.id, role: 'observer' }
            : { version: grant!.version, role: 'observer', ...(phase === 'refusalRelease' ? { queue: true } : { media: true }) }, grant?.id);
          assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: SHARING_UNKNOWN });
          assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
          if (phase === 'afterRelease') assert.notDeepEqual(f.effects(), before);
          else assert.deepEqual(f.effects(), before);
        } finally { f.db.exec = original; }
      }));
    }
    test(label + ' ' + operation + ' missing readback rolls back, never returns success with null', () => fixture(owned, async f => {
      const grant = operation === 'create' ? undefined : await f.create(), before = f.effects(), original = f.store.grants.get.bind(f.store.grants);
      f.store.grants.get = (target, id) => id === f.proof.grantId ? original(target, id) : undefined;
      try {
        const response = await f.request(operation === 'create' ? 'POST' : 'PUT', operation === 'create'
          ? { userId: f.recipient.id, role: 'observer' } : { version: grant!.version, role: 'collaborator' }, grant?.id);
        assert.equal(response.status, 503); assert.deepEqual(f.effects(), before); assert.equal(f.db.isTransaction, false);
      } finally { f.store.grants.get = original; }
    }));
  }
  test(label + ' rollback fault leaves original transaction owned; no forced release or replay', () => fixture(owned, async f => {
    const original = f.db.exec.bind(f.db); let rollback = 0, releases = 0;
    f.db.exec = sql => {
      if (sql === 'ROLLBACK') { rollback++; throw Error('private rollback fault'); }
      if (sql === 'RELEASE session_share') { releases++; throw Error('private RELEASE fault'); }
      return original(sql);
    };
    try {
      const response = await f.request('POST', { userId: f.recipient.id, role: 'observer' });
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: SHARING_UNKNOWN });
      assert.equal(rollback, 1); assert.equal(releases, 1); assert.equal(f.db.isTransaction, true);
    } finally { f.db.exec = original; if (f.db.isTransaction) original('ROLLBACK'); }
  }));
}

test('owned session mutation refuses a changed captured node version without effects', () => fixture(true, f => {
  const before = f.effects(), version = f.store.connectionAuthority('node', f.owner.id)!;
  assert.throws(() => f.store.grants.saveSessionAccess(f.target(f.recipient.id), { runtime: 'codex', sessionKey: f.proof.resource.sessionKey! },
    'observer', {}, version + 1), SessionShareConflict);
  assert.deepEqual(f.effects(), before); assert.equal(f.db.isTransaction, false);
}));

test('sharing classifications log numeric outcomes with no IDs/error/body leakage and no replay', () => {
  const lines: string[] = [], logs = new PerformanceDiagnostics(line => lines.push(line)); let calls = 0;
  for (const error of [new SessionShareConflict('private id'), new SessionSharePolicyConflict('private token'), Error('private SQL')]) {
    const outcome = sharingOutcome(1, () => { calls++; throw error; }, logs);
    assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.status, error instanceof SessionShareConflict ? 409 : 503);
  }
  assert.equal(calls, 3); assert.equal(lines.length, 3);
  const values = lines.map(line => JSON.parse(line)); assert.equal(values[0].deferred, 1); assert.equal(values[2].unknown, 1);
  assert.equal(values[1].unknown, 1); // A policy exception alone does not prove settlement.
  assert.equal(lines.join('').includes('private'), false); assert.ok(values.every(value => value.step === 1 && value.phase === 'finished'));
});
test('throwing diagnostics sink cannot change success or unknown and never invokes work twice', () => {
  const logs = new PerformanceDiagnostics(() => { throw Error('sink unavailable'); }); let calls = 0;
  assert.deepEqual(sharingOutcome(6, () => { calls++; return true; }, logs), { ok: true, value: true });
  assert.deepEqual(sharingOutcome(6, () => { calls++; throw Error('private'); }, logs), { ok: false, status: 503 });
  assert.equal(calls, 2);
});
for(const fault of ['start','add','add-getter','finish','finish-getter'] as const)
test('sharing '+fault+' observation preserves success, definite refusal and unknown without replay',t=>{
  const logs=new PerformanceDiagnostics(()=>{});let calls=0;
  t.mock.method(logs,'start',()=>{
    if(fault==='start')throw Error('PRIVATE log start');
    return {
      get add(){if(fault==='add-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='add')throw Error('PRIVATE add');};},
      reportPending(){},
      get finish(){if(fault==='finish-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='finish')throw Error('PRIVATE finish');};},
    };
  });
  assert.deepEqual(sharingOutcome(1,()=>{calls++;return true;},logs),{ok:true,value:true});
  assert.deepEqual(sharingOutcome(2,()=>{calls++;throw new SessionShareConflict('PRIVATE');},logs),{ok:false,status:409});
  assert.deepEqual(sharingOutcome(3,()=>{calls++;throw Error('PRIVATE SQL');},logs),{ok:false,status:503});
  assert.equal(calls,3);
});
