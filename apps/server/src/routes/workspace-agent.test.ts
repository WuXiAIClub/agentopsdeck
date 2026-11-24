import assert from 'node:assert/strict';
import test from 'node:test';
import { BOARD_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../application.js';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';

const boardPath = '/api/hub/v1/workspace/boards/default';
const machinePath = '/api/workspace-agent/v1/board';
const notePath = '/api/hub/v1/notebooks/default';
const noteAgent = '/api/workspace-agent/v1/notebook';
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-agent-http-'));
  const config = loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub',
    AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic-test',
    AOD_PASSKEYS_FILE: join(directory, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(directory, 'sessions.json') });
  config.accessKey = 'synthetic-admin';
  const store = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  const alice = store.createUser('Alice'), bob = store.createUser('Bob');
  const aliceKey = store.identities.issueKey(alice.id), bobKey = store.identities.issueKey(bob.id);
  const taskId = randomUUID(), otherId = randomUUID();
  store.boards.save(alice.id, 'default', { title: 'Private board', tasks: [
    { id: taskId, title: 'Allowed', detail: 'private detail', status: 'todo' },
    { id: otherId, title: 'Other task', detail: 'hidden', status: 'todo' },
  ], revision: 0, mutationId: randomUUID() });
  const app = createApplication(config, () => { throw Error('No Connector/native/model calls'); });
  const request = (path: string, token?: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.app.request(path, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await request(`${boardPath}/capabilities`, aliceKey.token, 'POST', { taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 60_000 });
  assert.equal(response.status, 201);
  const issued = await response.json() as { token: string; capability: { id: string } };
  return { app, store, taskId, otherId, alice, bob, aliceKey, bobKey, issued, request,
    close: async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('notebook machine facets are explicit, private, bounded, revocable and cannot become human authority', async () => {
  const f = await fixture();
  try {
    const doc = await (await f.request(notePath, f.aliceKey.token)).json() as { resourceId: string; revision: number };
    assert.equal((await f.request(notePath, f.aliceKey.token, 'PUT', { resourceId: doc.resourceId, revision: doc.revision, text: 'hot text' })).status, 200);
    assert.equal((await f.request(notePath + '/archive', f.aliceKey.token, 'PUT', { resourceId: doc.resourceId, revision: 0, text: 'cold secret' })).status, 200);
    const issue = async (facets: string[]) => {
      const response = await f.request(notePath + '/capabilities', f.aliceKey.token, 'POST', { facets, expiresAt: Date.now() + 60000 });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json() as Promise<{ token: string; capability: { id: string } }>;
    };
    const hot = await issue(['hot:read']), cold = await issue(['cold:read']);
    assert.equal((await f.request(noteAgent, hot.token)).status, 200);
    assert.equal((await f.request(noteAgent + '?area=cold', hot.token)).status, 403);
    assert.equal((await f.request(noteAgent, cold.token)).status, 403, 'cold grant does not imply hot');
    const read = await f.request(noteAgent + '?area=cold&start=0&limit=4&revision=1', cold.token);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal((await read.json() as { text: string }).text, 'cold');
    assert.equal((await f.request(noteAgent + '?area=cold&revision=0', cold.token)).status, 409);
    for (const query of ['?owner=bob', '?area=cold&limit=4001', '?area=cold&area=hot', '?area=both'])
      assert.ok([400,403].includes((await f.request(noteAgent + query, cold.token)).status));
    const search = await (await f.request(noteAgent + '?area=cold&q=secret', cold.token)).json() as { hotRevision: number | null; results: { area: string }[] };
    assert.equal(search.hotRevision, null); assert.equal(search.results[0]?.area, 'cold');
    for (const path of [boardPath, machinePath, notePath, '/api/hub/v1/users', noteAgent + '/escape'])
      assert.equal((await f.request(path, cold.token, 'GET', undefined, { cookie: 'agentopsdeck_access=synthetic-admin' })).status, 401);
    assert.equal((await f.request(noteAgent, f.issued.token)).status, 401);
    assert.equal((await f.request(noteAgent, f.aliceKey.token)).status, 401);
    assert.equal((await f.request(noteAgent + '?token=' + cold.token)).status, 401);
    assert.equal((await f.request(notePath + '/capabilities', f.aliceKey.token, 'POST', { facets: ['move'], expiresAt: Date.now() + 60000 })).status, 400);
    assert.equal((await f.request(notePath + '/capabilities/' + cold.capability.id, f.bobKey.token, 'DELETE')).status, 404);
    assert.deepEqual(await (await f.request(notePath + '/capabilities', f.bobKey.token)).json(), { capabilities: [] });
    const listing = await (await f.request(notePath + '/capabilities', f.aliceKey.token)).text();
    assert.ok(!listing.includes(cold.token)); assert.ok(!listing.includes('token_hash'));
    assert.equal((await f.request(notePath + '/capabilities/' + cold.capability.id, f.aliceKey.token, 'DELETE')).status, 200);
    assert.equal((await f.request(noteAgent + '?area=cold', cold.token)).status, 401);
  } finally { await f.close(); }
});

test('notebook machine moves recover original receipt without replay and revoke during body consumption', async () => {
  const f = await fixture();
  try {
    const doc = await (await f.request(notePath, f.aliceKey.token)).json() as { resourceId: string; revision: number };
    assert.equal((await f.request(notePath, f.aliceKey.token, 'PUT', { resourceId: doc.resourceId, revision: doc.revision, text: 'move me' })).status, 200);
    const issued = await (await f.request(notePath + '/capabilities', f.aliceKey.token, 'POST', { facets: ['hot:read', 'cold:read', 'move'], expiresAt: Date.now() + 60000 })).json() as { token: string; capability: { id: string } };
    const input = { requestId: randomUUID(), hotRevision: 1, coldRevision: 0, direction: 'archive', ranges: [{ start: 0, end: 7, sha256: createHash('sha256').update('move me').digest('hex') }] };
    assert.equal((await f.request(noteAgent + '/moves', issued.token, 'POST', input, { origin: 'https://untrusted.invalid' })).status, 403);
    const first = await f.request(noteAgent + '/moves', issued.token, 'POST', input); assert.equal(first.status, 200);
    const result = await first.json();
    assert.deepEqual(await (await f.request(noteAgent + '/moves/' + input.requestId, issued.token)).json(), result);
    assert.deepEqual(await (await f.request(noteAgent + '/moves', issued.token, 'POST', input)).json(), result);
    assert.equal((await f.request(noteAgent + '/moves', issued.token, 'POST', { ...input, direction: 'restore' })).status, 409);
    assert.equal(f.store.notebooks.getArchive(f.alice.id, doc.resourceId).text, 'move me');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const pending = f.app.app.fetch(new Request('http://localhost' + noteAgent + '/moves', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token },
      body: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), duplex: 'half' } as RequestInit));
    await new Promise(resolve => setTimeout(resolve, 0));
    await f.request(notePath + '/capabilities/' + issued.capability.id, f.aliceKey.token, 'DELETE');
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...input, requestId: randomUUID(), direction: 'restore', hotRevision: 2, coldRevision: 1 }))); controller.close();
    assert.equal((await pending).status, 403);
    assert.equal(f.store.notebooks.getArchive(f.alice.id, doc.resourceId).text, 'move me');
    assert.equal((await f.request(noteAgent + '/moves/' + input.requestId, issued.token)).status, 401);
  } finally { await f.close(); }
});

test('full application: machine capability cannot become a human, authenticate by cookie, or escape exact endpoint', async () => {
  const f = await fixture();
  try {
    for (const token of [undefined, f.aliceKey.token, 'synthetic-admin', 'aod_board_invalid']) assert.equal((await f.request(machinePath, token)).status, 401);
    assert.equal((await f.request(machinePath, undefined, 'GET', undefined, { cookie: `agentopsdeck_access=${f.issued.token}` })).status, 401);
    assert.equal((await f.request(`${machinePath}?token=${encodeURIComponent(f.issued.token)}`)).status, 401);
    assert.equal((await f.request(machinePath, undefined, 'GET', undefined, { 'x-agentopsdeck-key': f.issued.token })).status, 401);
    for (const path of [boardPath, `${boardPath}/capabilities`, `${boardPath}/audit`, '/api/hub/v1/me', '/api/hub/v1/users', '/api/hub/v1/workspace/preferences',
      '/api/sessions', '/api/auth/status', `${machinePath}/extra`, '/api/workspace-agent/v1/other']) {
      assert.equal((await f.request(path, f.issued.token)).status, 401, path);
    }
    assert.equal((await f.request(machinePath, f.issued.token, 'PUT', {})).status, 401);
    assert.equal((await f.request(boardPath, f.issued.token, 'GET', undefined, { cookie: `agentopsdeck_access=synthetic-admin` })).status, 401);
    const response = await f.request(machinePath, f.issued.token);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { resourceId: 'default', revision: 1, tasks: [{ id: f.taskId, title: 'Allowed', status: 'todo' }] });
    // Unauthenticated read-only access is still not permitted on the machine endpoint.
    assert.equal((await f.request(machinePath)).status, 401);
  } finally { await f.close(); }
});

test('phone remote requires human identity, isolates accounts and rejects capability credentials', async () => {
  const f = await fixture(), base = '/api/hub/v1/workspace/remote/devices';
  try {
    for (const token of [undefined, f.issued.token]) assert.equal((await f.request(base, token)).status, 401);
    const created = await f.request(base, f.aliceKey.token, 'POST', { name: 'Computer', targets: [], active: null });
    assert.equal(created.status, 200);
    const { device, hostToken } = await created.json() as { device: { id: string }; hostToken: string };
    for (const token of [f.bobKey.token, 'synthetic-admin']) {
      assert.deepEqual(await (await f.request(base, token)).json(), { devices: [] });
      assert.equal((await f.request(`${base}/${device.id}/receive`, token, 'GET', undefined, { 'X-Workspace-Host': hostToken })).status, 404);
    }
    assert.equal((await f.request(base, f.aliceKey.token, 'POST', { name: 'Bad origin', targets: [], active: null }, { origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await f.request(`${base}/${device.id}`, f.issued.token, 'DELETE')).status, 401);
    assert.equal((await f.request(`${base}/${device.id}`, f.aliceKey.token, 'DELETE')).status, 200);
  } finally { await f.close(); }
});

test('full application: owner-only management, scoped updates, audit and idempotent recovery', async () => {
  const f = await fixture();
  try {
    for (const token of [f.bobKey.token, 'synthetic-admin']) {
      assert.deepEqual(await (await f.request(`${boardPath}/capabilities`, token)).json(), { capabilities: [] });
      assert.deepEqual(await (await f.request(`${boardPath}/audit`, token)).json(), { events: [] });
      assert.equal((await f.request(`${boardPath}/capabilities/${f.issued.capability.id}`, token, 'DELETE')).status, 404);
      assert.equal((await f.request(`${boardPath}/capabilities`, token, 'POST', { taskIds: [f.taskId], fields: ['status'], expiresAt: Date.now() + 10000 })).status, 409);
    }
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' }] };
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', { ...write, tasks: [{ id: f.otherId, status: 'done' }] })).status, 403);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', { ...write, tasks: [{ id: f.taskId, detail: 'not allowed' }] })).status, 403);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', { ...write, userId: f.bob.id })).status, 400);
    const saved = await (await f.request(machinePath, f.issued.token, 'POST', write)).json();
    assert.deepEqual(saved, { status: 'saved', revision: 2, mutationId: write.mutationId });
    assert.deepEqual(await (await f.request(machinePath, f.issued.token, 'POST', write)).json(), saved);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', { ...write, tasks: [{ id: f.taskId, status: 'doing' }] })).status, 409);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', { ...write, mutationId: randomUUID() })).status, 409);
    const events = await (await f.request(`${boardPath}/audit`, f.aliceKey.token)).text();
    assert.ok(!events.includes(f.issued.token)); assert.ok(!events.includes('private detail'));
    const list = await (await f.request(`${boardPath}/capabilities`, f.aliceKey.token)).text();
    assert.ok(!list.includes(f.issued.token)); assert.ok(!list.includes('token_hash'));
    assert.equal((await f.request(`${boardPath}/capabilities/${f.issued.capability.id}`, f.aliceKey.token, 'DELETE')).status, 200);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', write)).status, 401);
    assert.equal((await f.request(machinePath, f.issued.token)).status, 401);
    assert.equal(f.store.boards.get(f.alice.id, 'default').revision, 2);
  } finally { await f.close(); }
});

test('machine body consumption rechecks revocation, keeps origin protection and byte limits', async () => {
  const f = await fixture();
  try {
    const body = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' }] };
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', body, { origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', body, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', { ...body, junk: 'x'.repeat(BOARD_MAX_BODY_BYTES) })).status, 413);
    let consumed = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      consumed = true;
      f.store.boardCapabilities.revoke(f.alice.id, 'default', f.issued.capability.id);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.app.app.request(machinePath, { method: 'POST', headers: { authorization: `Bearer ${f.issued.token}` }, body: stream, duplex: 'half' } as RequestInit);
    assert.equal(consumed, true); assert.equal(response.status, 401);
    assert.equal(f.store.boards.get(f.alice.id, 'default').revision, 1);
  } finally { await f.close(); }
});

test('owner identity revoked during capability issuance cannot mint a credential', async () => {
  const f = await fixture();
  try {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      f.store.identities.revokeKey(f.alice.id, f.aliceKey.id);
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ taskIds: [f.taskId], fields: ['detail'], expiresAt: Date.now() + 10000 })));
      controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.app.app.request(`${boardPath}/capabilities`, { method: 'POST', headers: { authorization: `Bearer ${f.aliceKey.token}` }, body: stream, duplex: 'half' } as RequestInit);
    assert.equal(response.status, 401);
    assert.equal(f.store.boardCapabilities.list(f.alice.id, 'default').length, 1);
  } finally { await f.close(); }
});

test('machine request rate is bounded per credential, with explicit retry guidance', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 120; i++) assert.equal((await f.request(machinePath, f.issued.token)).status, 200);
    const response = await f.request(machinePath, f.issued.token);
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await f.request(boardPath, f.aliceKey.token)).status, 200, 'machine quota cannot block the owner');
  } finally { await f.close(); }
});

test('slow machine bodies have a bounded reader budget that is released after completion', async () => {
  const f = await fixture();
  const releases: (() => void)[] = [], responses: Promise<Response>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      let started!: () => void;
      const reading = new Promise<void>(resolve => { started = resolve; });
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        releases.push(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' }] }))); controller.close(); });
        started();
        return new Promise<void>(resolve => { const release = releases.pop()!; releases.push(() => { release(); resolve(); }); });
      } }, { highWaterMark: 0 });
      responses.push(Promise.resolve(f.app.app.request(machinePath, { method: 'POST', headers: { authorization: `Bearer ${f.issued.token}` }, body: stream, duplex: 'half' } as RequestInit)));
      await reading;
    }
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', {})).status, 429);
    for (const release of releases.splice(0)) release();
    assert.deepEqual((await Promise.all(responses)).map(r => r.status).sort(), [200, 409]);
    assert.equal((await f.request(machinePath, f.issued.token, 'POST', {})).status, 400, 'released reader reaches body validation');
  } finally { for (const release of releases.splice(0)) release(); await Promise.all(responses); await f.close(); }
});
