import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, chmodSync, symlinkSync, lstatSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';
import { createAsyncStandaloneAuthLayer } from './application-standalone-auth-async.js';
import { DeckStore } from './projection/deck-store.js';
import { startupDatabaseOwners } from './storage/startup-owner.js';
import type { AcceptedLocalPreference } from './auth/local-preference-domain.js';

const accessKey = 'isolated-preferences-key', origin = 'http://preferences.example';
async function fixture(t: TestContext, format: 'json' | 'sqlite' = 'sqlite', keyed = true,
  project?: (result: AcceptedLocalPreference) => void) {
  const root = mkdtempSync(join(tmpdir(), 'standalone-preferences-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    AOD_HIDDEN_SESSIONS_FILE: join(root, 'hidden.json'), AOD_ARCHIVED_SESSIONS_FILE: join(root, 'archived.json'),
    AOD_PINNED_SESSIONS_FILE: join(root, 'pinned.json'), ...(keyed ? { AOD_ACCESS_KEY: accessKey } : {}),
    ...(format === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
  // Projection owns no preference files and cannot become another sync writer.
  const store = new DeckStore();
  const accepted: AcceptedLocalPreference[] = [];
  let closing = false;
  const layer = await createAsyncStandaloneAuthLayer(config, { preferences: {
    assertAvailable() { if (closing) throw Error('parent_not_ready'); },
    project(result) {
      // A real file ACK precedes every projection. No path/evidence in result.
      if (result.enabled) assert.ok((JSON.parse(readFileSync(({ hidden: config.hiddenSessionsFile,
        archived: config.archivedSessionsFile, pinned: config.pinnedSessionsFile })[result.field], 'utf8')) as string[]).includes(result.key));
      project?.(result); store.projectLocalPreference(result); accepted.push(result);
    },
  } });
  t.after(async () => { try { await layer.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const request = (path: string, init?: RequestInit) => layer.app.request(origin + path, init);
  const change = (route: string, key: string, body = '{}', headers: Record<string, string> = { 'x-agentopsdeck-key': accessKey }) =>
    request(`/api/sessions/${encodeURIComponent(key)}/${route}`, { method: 'PATCH', headers, body });
  const login = async () => {
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find(v => v.startsWith('agentopsdeck_session='))?.split(';')[0];
    assert.ok(cookie); return cookie;
  };
  return { root, config, layer, store, accepted, request, change, login, freezeParent: () => { closing = true; } };
}

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`original preference HTTP ${format}/${keyed ? 'Key' : 'noKey'}: all three files, projection and concurrent reconciliation`, async t => {
    const h = await fixture(t, format, keyed);
    const headers = keyed ? { 'x-agentopsdeck-key': accessKey } : {};
    const key = 'agent:legacy:dashboard:existing-session';
    h.store.upsertSession({ sessionKey: key, agentId: 'legacy', title: 'existing', status: 'idle', lastActiveAt: 1 });
    for (const [route, field, file] of [ ['visibility', 'hidden', h.config.hiddenSessionsFile],
      ['archive', 'archived', h.config.archivedSessionsFile], ['pin', 'pinned', h.config.pinnedSessionsFile] ] as const) {
      writeFileSync(file, '["unrelated-existing"]');
      const response = await h.change(route, key, '{}', headers);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.sessionKey, key); assert.equal(body[field], true); assert.equal(body.ok, true);
      assert.equal(typeof body.updatedAt, 'number');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [key, 'unrelated-existing'].sort());
      const selected = () => field === 'hidden' ? h.store.isSessionHidden(key)
        : field === 'archived' ? h.store.isSessionArchived(key) : h.store.isSessionPinned(key);
      assert.equal(selected(), true);
      assert.equal((h.store.getEventsSince().at(-1)?.payload as Record<string, unknown>)[field], true);
      assert.equal((await h.change(route, key, JSON.stringify({ [field]: false }), headers)).status, 200);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['unrelated-existing']);
      assert.equal(selected(), false);
      assert.equal((h.store.getEventsSince().at(-1)?.payload as Record<string, unknown>)[field], false);
    }
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => h.change('pin', `concurrent-${i}`, '{}', headers)));
    assert.ok(responses.every(r => r.status === 200));
    assert.equal(new Set(JSON.parse(readFileSync(h.config.pinnedSessionsFile, 'utf8'))).size, 13);
    // On-disk state can be read by the unchanged original projection after close.
    await h.layer.close();
    const reopened = new DeckStore({ pinnedSessionsFile: h.config.pinnedSessionsFile });
    assert.equal(reopened.isSessionPinned('concurrent-7'), true);
    const release = startupDatabaseOwners.reserveExclusive(h.config.pinnedSessionsFile); release();
  });
}

for (const format of ['json', 'sqlite'] as const) {
  test(`${format}: original cookie wins over wrong Key, bearer alone is denied, write rechecks logout after body wait`, async t => {
    const h = await fixture(t, format), cookie = await h.login();
    assert.equal((await h.change('pin', 'cookie-ok', '{}', { cookie, 'x-agentopsdeck-key': 'wrong' })).status, 200);
    assert.equal((await h.change('pin', 'bearer-denied', '{}', { authorization: 'Bearer unrelated-connector-token' })).status, 401);
    let controller!: ReadableStreamDefaultController<Uint8Array>, began!: () => void;
    const waiting = new Promise<void>(resolve => { began = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { began(); } }, { highWaterMark: 0 });
    const pending = h.layer.app.fetch(new Request(origin + '/api/sessions/revoked/visibility', {
      method: 'PATCH', headers: { cookie }, body: stream, duplex: 'half',
    } as RequestInit));
    await waiting;
    assert.equal((await h.request('/api/auth/logout', { method: 'POST', headers: { cookie } })).status, 200);
    controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    assert.equal((await pending).status, 403);
    assert.equal(existsSync(h.config.hiddenSessionsFile), false);
    assert.equal(h.accepted.length, 1);
  });
}

test('legacy malformed/default body, whitespace key, oversized and interrupted body never default into a write', async t => {
  const h = await fixture(t);
  assert.equal((await h.change('pin', 'default', '{')).status, 200);
  assert.equal((await h.change('pin', ' space ', '{}')).status, 200);
  assert.equal((await h.change('archive', 'null', 'null')).status, 400);
  assert.equal((await h.change('archive', 'oversized', ' '.repeat(65537))).status, 413);
  const abort = new AbortController(); abort.abort();
  const response = await h.request('/api/sessions/aborted/archive', { method: 'PATCH', headers: { 'x-agentopsdeck-key': accessKey }, body: '{}', signal: abort.signal });
  assert.equal(response.status, 408);
  assert.equal(existsSync(h.config.archivedSessionsFile), false);
});

test('config Key fence after body wait and parent not-ready deny without original file effects', async t => {
  const h = await fixture(t);
  let controller!: ReadableStreamDefaultController<Uint8Array>, began!: () => void;
  const waiting = new Promise<void>(resolve => { began = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { began(); } }, { highWaterMark: 0 });
  const pending = h.layer.app.fetch(new Request(origin + '/api/sessions/changed/pin', {
    method: 'PATCH', headers: { 'x-agentopsdeck-key': accessKey }, body: stream, duplex: 'half',
  } as RequestInit));
  await waiting; h.config.accessKey = 'replacement-key';
  controller.enqueue(new TextEncoder().encode('{}')); controller.close();
  assert.equal((await pending).status, 503);
  h.config.accessKey = accessKey; h.freezeParent();
  assert.equal((await h.change('pin', 'not-ready')).status, 503);
  assert.equal(existsSync(h.config.pinnedSessionsFile), false);
});

test('closing freezes admissions, drains a held request, retains files until physical cleanup', async t => {
  const h = await fixture(t);
  let controller!: ReadableStreamDefaultController<Uint8Array>, began!: () => void;
  const waiting = new Promise<void>(resolve => { began = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { began(); } }, { highWaterMark: 0 });
  const pending = h.layer.app.fetch(new Request(origin + '/api/sessions/closing/pin', {
    method: 'PATCH', headers: { 'x-agentopsdeck-key': accessKey }, body: stream, duplex: 'half',
  } as RequestInit));
  await waiting;
  let closed = false; const closing = h.layer.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => startupDatabaseOwners.reserveExclusive(h.config.pinnedSessionsFile));
  assert.equal((await h.change('pin', 'late')).status, 503);
  controller.enqueue(new TextEncoder().encode('{}')); controller.close();
  assert.equal((await pending).status, 503); await closing;
  assert.equal(existsSync(h.config.pinnedSessionsFile), false);
});

test('projection failure is unknown, never repeats file effect; next explicit request reconciles', async t => {
  let attempts = 0;
  const h = await fixture(t, 'sqlite', true, () => { if (++attempts === 1) throw Error('private-source-error'); });
  const response = await h.change('pin', 'unknown');
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-source/);
  assert.equal(attempts, 1); assert.equal(h.store.isSessionPinned('unknown'), false);
  assert.deepEqual(JSON.parse(readFileSync(h.config.pinnedSessionsFile, 'utf8')), ['unknown']);
  assert.equal((await h.change('pin', 'next')).status, 200);
  assert.equal(h.store.isSessionPinned('unknown'), true); assert.equal(attempts, 2);
});

test('corrupt original preference refuses safely without overwriting; duplicate owner cannot acquire files', async t => {
  const h = await fixture(t);
  assert.throws(() => startupDatabaseOwners.reserveExclusive(h.config.hiddenSessionsFile));
  writeFileSync(h.config.hiddenSessionsFile, '{corrupt-private-path');
  const response = await h.change('visibility', 'refused');
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /corrupt-private/);
  assert.equal(readFileSync(h.config.hiddenSessionsFile, 'utf8'), '{corrupt-private-path');
  assert.equal(h.accepted.length, 0);
});

test('original worker file writer preserves Linux symlink/mode and refuses hardlink/dangling link', { skip: process.platform === 'win32' }, async t => {
  const h = await fixture(t), target = join(h.root, 'target.json');
  writeFileSync(target, '["existing"]'); chmodSync(target, 0o640); symlinkSync(target, h.config.pinnedSessionsFile);
  assert.equal((await h.change('pin', 'symlink')).status, 200);
  assert.equal(lstatSync(h.config.pinnedSessionsFile).isSymbolicLink(), true);
  assert.equal(statSync(target).mode & 0o777, 0o640);
  linkSync(target, h.config.archivedSessionsFile);
  assert.equal((await h.change('archive', 'hardlink')).status, 503);
  symlinkSync(join(h.root, 'missing.json'), h.config.hiddenSessionsFile);
  assert.equal((await h.change('visibility', 'dangling')).status, 503);
  assert.equal(lstatSync(h.config.hiddenSessionsFile).isSymbolicLink(), true);
});
