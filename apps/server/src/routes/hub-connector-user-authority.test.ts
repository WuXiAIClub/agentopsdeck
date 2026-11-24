import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { HubMemberKind, HubMemberCommands } from '../hub/member-owner-domain.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubConnectorUserDisplay } from './hub-connector-users.js';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: test.TestContext, admin = false, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'connector-directory-route-')), store = new HubStore(join(root, 'hub.sqlite'), 'private-vault');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const userId = admin ? 'default' : store.createUser('Member').id, key = store.identities.issueKey(userId);
  if (admin) db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
  for (let i = 0; i < count; i++) store.upsertConnection({ id: 'node'+i, ownerUserId: userId, label: 'Node'+i, connectorUrl: 'http://private.invalid' });
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const original = new OriginalHubAdministrativeCommands(store, diagnostics);
  let intercept = async (_kind: HubMemberKind, _input: unknown, work: () => unknown): Promise<unknown> => work();
  const members = new AsyncHubMemberRequests({ command: <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) =>
    intercept(kind, input, () => original.command(kind, input)) as Promise<HubMemberCommands[K]['output']> }, diagnostics);
  let actor = userId, resolved = 0, gets = 0, active = 0, maximum = 0;
  let onResolve = async (_id: string) => {}, onGet = async (_id: string) => {}, onPresent = (_id: string) => {};
  let access: Pick<AsyncHubMemberRequests, 'begin'> = members;
  const app = new Hono();
  app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : c.json({ error: 'unexpected' }, 500));
  registerHubConnectorUserDisplay(app, {
    store: {
      listUsersAsync: async () => { throw Error('PRIVATE legacy users fallback'); },
      listConnectionsAsync: async () => { throw Error('PRIVATE legacy connections fallback'); },
      connectionDirectoryVersion: () => { throw Error('PRIVATE sync version fallback'); },
      connectionAuthority: () => { throw Error('PRIVATE sync epoch fallback'); },
    },
    principal: () => ({ userId: actor, admin }),
    client: (() => { throw Error('PRIVATE sync client fallback'); }) as ConnectorClientResolver,
    asyncConnectorClient: async (_raw, id) => {
      resolved++; await onResolve(id);
      return { json: async () => { gets++; active++; maximum = Math.max(maximum, active);
        try { await onGet(id); return { users: [{ id: 'remote', label: 'PRIVATE response' }] }; }
        finally { active--; }
      } } as unknown as ReturnType<ConnectorClientResolver>;
    },
    access: { begin: raw => access.begin(raw) }, diagnostics,
    present: (connection, users, supported, remoteUsers) => {
      onPresent(connection.id); return { id: connection.id, label: connection.label, users, supported, remoteUsers };
    },
  });
  const request = async (signal?: AbortSignal) => app.request('/api/hub/v1/connector-users', {
    headers: { authorization: 'Bearer '+key.token }, ...(signal ? { signal } : {}),
  });
  t.after(async () => { await members.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, db, userId, key, request, logs, members,
    counts: () => ({ resolved, gets, active, maximum }), actor: (id: string) => { actor = id; },
    intercept: (fn: typeof intercept) => { intercept = fn; }, access: (value: typeof access) => { access = value; },
    resolve: (fn: typeof onResolve) => { onResolve = fn; }, get: (fn: typeof onGet) => { onGet = fn; }, present: (fn: typeof onPresent) => { onPresent = fn; },
  };
}
for (const admin of [false, true]) {
  test(`configured display uses original owner exclusively and preserves public data (admin=${admin})`, async t => {
    const f = fixture(t, admin, 2), foreign = f.store.createUser('Foreign');
    f.store.upsertConnection({ id: 'foreign', ownerUserId: foreign.id, label: 'Foreign', connectorUrl: 'http://foreign.invalid' });
    f.store.upsertConnection({ id: 'disabled', ownerUserId: f.userId, label: 'Disabled', connectorUrl: 'http://disabled.invalid', status: 'disabled' });
    const response = await f.request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { connections: { id: string; supported: boolean }[]; updatedAt: number };
    assert.deepEqual(body.connections.map(row => row.id), ['node0', 'node1']); assert.ok(body.updatedAt > 0);
    assert.ok(body.connections.every(row => row.supported)); assert.equal(f.counts().gets, 2);
    assert.doesNotMatch(f.logs.join(''), /PRIVATE|hub_key_|private.invalid|private-vault/);
  });
  for (const stage of ['begin', 'snapshot', 'resolve', 'get', 'present', 'final-proof'] as const)
    for (const change of ['key', 'actor', 'epoch'] as const)
      test(`display ${change} during ${stage} refuses stale delivery (admin=${admin})`, async t => {
        const f = fixture(t, admin); let presented = false, changed = false;
        const mutate = () => { if (changed) return; changed = true;
          if (change === 'key') f.store.identities.revokeKey(f.userId, f.key.id);
          else if (change === 'actor') f.actor('other');
          else f.db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('node0');
        };
        f.present(() => { presented = true; if (stage === 'present') mutate(); });
        f.intercept(async (kind, input, work) => {
          const value = await work();
          if (stage === 'begin' && kind === 'memberSnapshot') mutate();
          if (stage === 'snapshot' && kind === 'connectionDirectory'
            && (input as HubMemberCommands['connectionDirectory']['input']).command.action === 'read') mutate();
          if (stage === 'final-proof' && presented && kind === 'connectionDirectoryCheck') mutate();
          return value;
        });
        if (stage === 'resolve') f.resolve(async () => { mutate(); });
        if (stage === 'get') f.get(async () => { mutate(); });
        const response = await f.request();
        // An epoch changed before the initial snapshot is the snapshot's current fact.
        if (stage === 'begin' && change === 'epoch') assert.equal(response.status, 200);
        else { assert.equal(response.status, change === 'epoch' ? 503 : 401); assert.doesNotMatch(await response.text(), /PRIVATE|private.invalid/); }
        if (stage === 'resolve') assert.equal(f.counts().gets, 0);
        assert.ok(f.counts().gets <= 1, 'read is never replayed');
      });
}
test('epoch drift to an earlier-settled lane is caught by the final joint generation proof', async t => {
  const f = fixture(t, false, 2), node0Checked = deferred(); let changed = false;
  const reads = new Set<string>(), checks = new Map<string, number>();
  f.get(async id => { if (id === 'node1') await node0Checked.promise; reads.add(id); });
  f.intercept(async (kind, input, work) => {
    const value = await work();
    const command = (input as HubMemberCommands['connectionDirectory']['input']).command;
    if (kind === 'connectionDirectoryCheck' && command.action === 'check' && command.target && reads.has(command.target.id)) {
      const id = command.target.id, count = (checks.get(id) ?? 0) + 1; checks.set(id, count);
      // Each lane's post-read delivery proof has two joint gates. Let node0
      // finish both before node1 changes it; only the final all-lanes proof
      // can catch this drift. Do not count unrelated pre-GET SQL observations.
      if (id === 'node0' && count === 2) node0Checked.resolve();
      if (id === 'node1' && count === 2 && !changed) {
        changed = true; f.db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('node0');
      }
    }
    return value;
  });
  assert.equal((await f.request()).status, 503); assert.equal(changed, true); assert.equal(f.counts().gets, 2);
});
for (const stage of ['snapshot', 'resolve', 'get', 'present', 'final-proof'] as const)
  test(`cancel during ${stage} prevents delivery and duplicate GET`, async t => {
    const f = fixture(t), controller = new AbortController(); let presented = false;
    f.present(() => { presented = true; if (stage === 'present') controller.abort(); });
    f.intercept(async (kind, input, work) => {
      const value = await work();
      if (kind === 'connectionDirectory' && stage === 'snapshot'
        || kind === 'connectionDirectoryCheck' && stage === 'final-proof' && presented) controller.abort(); return value;
    });
    if (stage === 'resolve') f.resolve(async () => { controller.abort(); });
    if (stage === 'get') f.get(async () => { controller.abort(); });
    const response = await f.request(controller.signal); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE/); assert.ok(f.counts().gets <= 1);
    if (stage === 'resolve' || stage === 'snapshot') assert.equal(f.counts().gets, 0);
  });
for (const fault of ['begin-undefined', 'begin-rejected', 'snapshot-rejected', 'check-rejected'] as const)
  test(`configured ${fault} never uses legacy fallback`, async t => {
    const f = fixture(t);
    if (fault === 'begin-undefined') f.access({ begin: async () => undefined as never });
    else if (fault === 'begin-rejected') f.access({ begin: async () => { throw Error('PRIVATE owner unavailable'); } });
    else f.intercept(async (kind, input, work) => {
      if (kind === (fault === 'snapshot-rejected' ? 'connectionDirectory' : 'connectionDirectoryCheck')) throw Error('PRIVATE owner unavailable');
      return work();
    });
    const response = await f.request(); assert.equal(response.status, 503); assert.equal(f.counts().gets, 0);
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  });
test('four-lane fan-in drains all accepted reads after cancellation without replay', async t => {
  const f = fixture(t, false, 9), gate = deferred(), started = deferred(), controller = new AbortController();
  f.get(async () => { if (f.counts().gets === 4) started.resolve(); await gate.promise; });
  let settled = false; const response = f.request(controller.signal).then(value => { settled = true; return value; });
  await started.promise; assert.equal(f.counts().active, 4); controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gate.resolve(); assert.equal((await response).status, 503);
  assert.deepEqual(f.counts(), { resolved: 4, gets: 4, active: 0, maximum: 4 });
});
