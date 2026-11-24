import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { SdkAttachmentStore } from './sdk-attachment-store.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { SdkCommands } from './sdk-commands.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { registerSessionMediaRoutes } from './session-media-http.js';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { DeckStore } from '../projection/deck-store.js';

const file = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('private file body').toString('base64') };
test('attachment bodies are atomic, scoped, metadata-only and install a lazy old-writer fence', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE connector_users(id TEXT)');
  try {
    const store = new SdkAttachmentStore(db), files = store.prepare([file]);
    assert.throws(() => store.save('a', 'message', files), /atomic/);
    db.exec('BEGIN'); store.save('a', 'message', files); db.exec('ROLLBACK');
    assert.deepEqual(store.media('a', 'message'), []);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get(), undefined);
    db.exec('BEGIN'); store.save('a', 'message', files); db.exec('COMMIT');
    const media = store.media('a', 'message'); assert.equal(media.length, 1);
    assert.ok(!JSON.stringify(media).includes(file.data));
    const id = mediaResourceId(media[0]!.url);
    assert.equal(store.read('b', 'message', id), undefined); assert.equal(store.read('a', 'other', id), undefined);
    assert.equal(Buffer.from(store.read('a', 'message', id)!.bytes).toString(), 'private file body');
    db.function('agentopsdeck_connector_sdk_media_writer_epoch', () => 0);
    assert.throws(() => db.prepare('INSERT INTO connector_users VALUES (?)').run('old'), /Incompatible/);
    store.remove('a', 'message'); assert.equal(store.read('a', 'message', id), undefined);
  } finally { db.close(); }
});
for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime} attachment admission/edit/cancel is atomic with queue/receipt`, () => {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  try {
    const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal, key = `${runtime}:fixture`;
    journal.create({ key, nativeSessionId: 'native', title: 'Test', createdAt: 1 });
    const commands = new SdkCommands({ runtime, store, journal, driver: { wake: async () => {}, interrupt: async () => 'accepted' },
      assertAvailable() {}, authorize: () => true, changed() {}, models: { model: 'test' } });
    assert.throws(() => commands.send(key, 'test', { actorId: 'owner', accept: () => () => { throw Error('lost'); } }, [file]), /lost/);
    assert.equal(store.turns.hasPending(runtime, key), false);
    const sent = commands.send(key, '', { actorId: 'owner', accept: () => () => {} }, [file]);
    assert.equal(sent.media.length, 1);
    const entry = store.turns.head(runtime, key)!;
    assert.ok(!JSON.stringify(entry).includes(file.data));
    const execution = { key, members: [entry.id] } as Parameters<SdkAttachmentStore['forExecution']>[0];
    assert.deepEqual(store.sdkAttachments.forExecution(execution), [file]);
    const version = store.turns.version(runtime, key, sent.idempotencyKey)!;
    const id = mediaResourceId(sent.media[0]!.url);
    assert.ok(store.sdkAttachments.read(key, sent.idempotencyKey, id));
    assert.ok(commands.editQueued(key, sent.idempotencyKey, 'edited', version, { actorId: 'owner' }));
    assert.ok(store.sdkAttachments.read(key, sent.idempotencyKey, id));
    const next = store.turns.version(runtime, key, sent.idempotencyKey)!;
    assert.throws(() => commands.cancelQueued(key, sent.idempotencyKey, next, { actorId: 'other' }));
    assert.throws(() => commands.cancelQueued(key, sent.idempotencyKey, next, { actorId: 'owner' }, () => { throw Error('lost'); }), /lost/);
    assert.ok(store.sdkAttachments.read(key, sent.idempotencyKey, id));
    assert.ok(commands.cancelQueued(key, sent.idempotencyKey, next, { actorId: 'owner' }));
    assert.equal(store.sdkAttachments.read(key, sent.idempotencyKey, id), undefined);
    assert.throws(() => store.sdkAttachments.forExecution(execution), /unavailable/);
  } finally { store.close(); }
});

for (const revoke of ['token', 'membership'] as const) test(`attachment HTTP download is exact-scoped and stops on ${revoke} revocation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-attachment-http-'));
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE connector_users(id TEXT)');
  try {
    const sdkAttachments = new SdkAttachmentStore(db), tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
    const token = tokens.create({ label: 'fixture', scopes: ['messages:read', 'media:read'] });
    const readOnly = tokens.create({ label: 'fixture-no-media', scopes: ['messages:read'] });
    const bytes = Buffer.alloc(400_000, 1); bytes.set(Buffer.from('89504e470d0a1a0a', 'hex'));
    const files = sdkAttachments.prepare([{ name: 'image.png', mimeType: 'image/png', data: bytes.toString('base64') }]);
    db.exec('BEGIN'); sdkAttachments.save('claude-code:test', 'message', files); db.exec('COMMIT');
    const resource = mediaResourceId(sdkAttachments.media('claude-code:test', 'message')[0]!.url);
    const app = new Hono();
    registerSessionMediaRoutes(app, { tokens, sdkAttachments, store: new DeckStore(), inboundDir: dir,
      artifactConfig: { enabled: false, allowedDirs: [], maxBytes: 1, indexFile: join(dir, 'artifacts.json'), injectCapability: false, allowGatewayClient: false },
      refreshMessages: async () => {} });
    const path = (key = 'claude-code:test', message = 'message') => `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages/${message}/media/${resource}`;
    const request = (url = path(), credential = token.token) => app.request(url, { headers: { authorization: `Bearer ${credential}` } });
    assert.equal((await request(path(), readOnly.token)).status, 403);
    assert.equal((await request(path('ghcp:test'))).status, 404);
    assert.equal((await request(path(undefined, 'foreign'))).status, 404);
    const complete = await request(); assert.equal(complete.status, 200);
    assert.equal(complete.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await complete.arrayBuffer()), bytes);
    const response = await request(), reader = response.body!.getReader();
    assert.ok((await reader.read()).value?.length);
    if (revoke === 'token') assert.equal(tokens.revoke(token.record.id), true); else sdkAttachments.remove('claude-code:test');
    await assert.rejects(async () => { while (!(await reader.read()).done) { /* bounded prebuffer may drain */ } });
    assert.equal((await request()).status, revoke === 'token' ? 403 : 404);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('stopped database backup restores attachment bodies and queue references; missing body fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-attachment-backup-'));
  const original = join(dir, 'original.db'), backup = join(dir, 'backup.db');
  let store = new ConnectorUserStore(original, undefined, { runtimeOwner: true });
  try {
    const key = 'claude-code:backup';
    store.claudeJournal.create({ key, nativeSessionId: 'native-backup', title: 'Backup', createdAt: 1 });
    const commands = new SdkCommands({ runtime: 'claude-code', store, journal: store.claudeJournal,
      driver: { wake: async () => {}, interrupt: async () => 'accepted' }, assertAvailable() {},
      authorize: () => true, changed() {}, models: { model: 'test' } });
    const sent = await commands.sendAsync(key, 'file', { actorId: 'owner', accept: () => () => {} }, [file]);
    const execution = { key, members: [sent.idempotencyKey] } as Parameters<SdkAttachmentStore['forExecution']>[0];
    const before = store.sdkAttachments.media(key, sent.idempotencyKey);
    store.close();
    copyFileSync(original, backup);
    store = new ConnectorUserStore(backup, undefined, { runtimeOwner: true });
    assert.deepEqual(store.sdkAttachments.media(key, sent.idempotencyKey), before);
    assert.deepEqual(store.sdkAttachments.forExecution(execution), [file]);
    assert.equal(Buffer.from(store.sdkAttachments.read(key, sent.idempotencyKey, mediaResourceId(before[0]!.url))!.bytes).toString(), 'private file body');
    store.sdkAttachments.remove(key, sent.idempotencyKey);
    assert.ok(store.turns.head('claude-code', key), 'Admission still exists');
    assert.throws(() => store.sdkAttachments.forExecution(execution), /incomplete/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
