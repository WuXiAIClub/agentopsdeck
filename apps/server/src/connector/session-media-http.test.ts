import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { DeckStore } from '../projection/deck-store.js';
import { ArtifactRegistry } from '../messages/artifact-receiver.js';
import { localMediaResource, mediaResourceId } from '../messages/media-resource.js';
import { registerSessionMediaRoutes } from './session-media-http.js';
import { sourceReferenceMedia } from '../messages/source-preview.js';

async function fixture(mode: 'local' | 'http' = 'local') {
  const dir = mkdtempSync(join(tmpdir(), 'session-media-')), inboundDir = join(dir, 'inbound');
  mkdirSync(inboundDir);
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') }), tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
  const token = tokens.create({ label: 'synthetic', scopes: ['messages:read', 'media:read'] });
  const artifactConfig = { enabled: true, allowedDirs: [dir], maxBytes: 64 * 1024 * 1024, indexFile: join(dir, 'artifacts.json'), injectCapability: false, allowGatewayClient: false };
  const registry = new ArtifactRegistry(artifactConfig.indexFile);
  const app = new Hono();
  const sourcePreview = { allowedDirs: [dir], approvalDirs: [] as string[] };
  let refresh = async () => {};
  let sourceMessage: ((key: string, id: string) => ChatMessage | null | undefined) | undefined;
  registerSessionMediaRoutes(app, { tokens, store, inboundDir, artifactConfig, artifactRegistry: registry, sourcePreview, sourceMessage: (key, id) => sourceMessage?.(key, id), refreshMessages: () => refresh() });
  const server = mode === 'http' ? serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
  const message: ChatMessage = { id: 'message:1', sessionKey: 'codex:synthetic', role: 'assistant', text: 'files', createdAt: 1,
    media: [{ type: 'file', name: 'test.bin', url: '/api/media/inbound/test.bin' }] };
  writeFileSync(join(inboundDir, 'test.bin'), Buffer.alloc(1024 * 1024, 7)); store.addMessage(message);
  const path = (sessionKey = message.sessionKey, messageId = message.id, url = message.media![0]!.url) => `/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/messages/${encodeURIComponent(messageId)}/media/${mediaResourceId(url)}`;
  const request = (url = path(), credential = token.token, headers: Record<string, string> = {}, method = 'GET') => {
    const init = { method, headers: { authorization: `Bearer ${credential}`, ...headers } };
    return server ? fetch(origin + url, init) : app.request(origin + url, init);
  };
  return { dir, inboundDir, store, tokens, token, registry, artifactConfig, sourcePreview, message, path, request,
    refresh: (fn: () => Promise<void>) => { refresh = fn; },
    sourceMessage: (fn: (key: string, id: string) => ChatMessage | null | undefined) => { sourceMessage = fn; },
    async close() {
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const mode of ['local', 'http'] as const) test(`${mode}: durable evidence bypasses history refresh but never revives stale membership`, async () => {
  const f = await fixture(mode);
  try {
    const file = join(f.dir, 'durable.ts'); writeFileSync(file, 'const durable = true;');
    const message: ChatMessage = { ...f.message, media: [], role: 'tool', toolPhase: 'result', status: 'sent', sourceFiles: [{ path: file, kind: 'modified' }] };
    let reads = 0; f.refresh(async () => { reads++; });
    f.sourceMessage(() => message);
    const url = f.path(undefined, undefined, sourceReferenceMedia(message)[0]!.url);
    assert.equal((await f.request(url)).status, 200);
    assert.equal(reads, 0);
    assert.equal((await f.request(f.path('codex:other', message.id, sourceReferenceMedia(message)[0]!.url))).status, 404);
    f.store.addMessage(message);
    f.sourceMessage(() => null);
    assert.equal((await f.request(url)).status, 404);
    assert.equal(reads, 0);
    f.sourceMessage(() => message);
    f.sourcePreview.allowedDirs = [];
    assert.equal((await f.request(url)).status, 404);
    f.sourcePreview.allowedDirs = [f.dir];
    const noMedia = f.tokens.create({ label: 'no-media', scopes: ['messages:read'] });
    assert.equal((await f.request(url, noMedia.token)).status, 403);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: native file change preview requires exact message membership and existing roots/scopes`, async () => {
  const f = await fixture(mode);
  try {
    const file = join(f.dir, 'changed.ts'); writeFileSync(file, 'const changed = true;');
    const message: ChatMessage = { ...f.message, media: [], role: 'tool', toolPhase: 'result', status: 'sent', sourceFiles: [{ path: file, kind: 'modified' }] };
    f.store.addMessage(message);
    const media = sourceReferenceMedia(message)[0]!;
    const url = f.path(undefined, undefined, media.url);
    assert.equal((await f.request(url)).status, 200);
    assert.equal((await f.request(f.path('codex:other', message.id, media.url))).status, 404);
    assert.equal((await f.request(f.path(message.sessionKey, 'other-message', media.url))).status, 404);
    const noMedia = f.tokens.create({ label: 'no-media', scopes: ['messages:read'] });
    assert.equal((await f.request(url, noMedia.token)).status, 403);
    f.sourcePreview.allowedDirs = [];
    assert.equal((await f.request(url)).status, 404);
    f.sourcePreview.allowedDirs = [f.dir];
    f.store.addMessage({ ...message, sourceFiles: [] });
    assert.equal((await f.request(url)).status, 404);
    f.store.addMessage({ ...message, status: 'failed' });
    assert.equal((await f.request(url)).status, 404);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: temporary preview approval is opt-in, token-bound, reference-bound and revocable`, async () => {
  const f = await fixture(mode);
  try {
    const file = join(f.dir, 'example.ts'); writeFileSync(file, 'one\ntwo\nthree');
    const message = { ...f.message, text: `[source](${file}:2)`, media: [] };
    f.store.addMessage(message);
    const url = f.path(undefined, undefined, sourceReferenceMedia(message)[0]!.url);
    const owner = f.tokens.create({ label: 'approver', scopes: ['messages:read', 'media:read', 'source:approve'] });
    f.sourcePreview.allowedDirs = [];
    assert.equal((await f.request(url + '/approval', owner.token, {}, 'POST')).status, 409);
    f.sourcePreview.approvalDirs = [f.dir];
    const denied = await f.request(url, owner.token);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get('X-AgentOpsDeck-Source-Error'), 'outside-roots');
    assert.equal(denied.headers.get('X-AgentOpsDeck-Source-Approval'), 'available');
    assert.equal((await f.request(url)).headers.get('X-AgentOpsDeck-Source-Approval'), null);
    assert.equal((await f.request(url + '/approval', f.token.token, {}, 'POST')).status, 403);
    assert.equal((await f.request(url + '/approval', owner.token, {}, 'POST')).status, 200);
    const read = await f.request(url, owner.token);
    assert.equal(read.status, 200); assert.equal((await read.json()).temporaryApproval, true);
    assert.equal((await f.request(url)).status, 404);
    assert.equal((await f.request(url + '/approval', owner.token, {}, 'DELETE')).status, 200);
    assert.equal((await f.request(url, owner.token)).status, 404);
    f.store.addMessage({ ...message, text: 'removed' });
    assert.equal((await f.request(url + '/approval', owner.token, {}, 'POST')).status, 404);
    f.store.addMessage(message); f.tokens.revoke(owner.record.id);
    assert.equal((await f.request(url + '/approval', owner.token, {}, 'POST')).status, 403);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: source preview requires exact assistant reference, scopes and opted-in Connector directory`, async () => {
  const f = await fixture(mode);
  try {
    const file = join(f.dir, 'example.ts'); writeFileSync(file, 'one\ntwo\nthree');
    const message = { ...f.message, text: `[source](${file}:2)`, media: [] };
    f.store.addMessage(message);
    const source = sourceReferenceMedia(message)[0]!;
    const url = f.path(undefined, undefined, source.url);
    const response = await f.request(url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { path: file, line: 2, startLine: 1, totalLines: 3, text: 'one\ntwo\nthree', modifiedAt: statSync(file).mtimeMs });
    assert.equal((await f.request(f.path('other', undefined, source.url))).status, 404);
    assert.equal((await f.request(f.path(undefined, 'other', source.url))).status, 404);
    const readOnly = f.tokens.create({ label: 'messages only', scopes: ['messages:read'] });
    assert.equal((await f.request(url, readOnly.token)).status, 403);
    f.sourcePreview.allowedDirs = []; assert.equal((await f.request(url)).status, 404);
    f.sourcePreview.allowedDirs = [f.dir];
    f.store.addMessage({ ...message, role: 'user' }); assert.equal((await f.request(url)).status, 404);
    f.store.addMessage({ ...message, text: 'reference removed' }); assert.equal((await f.request(url)).status, 404);
    f.store.addMessage(message);
    f.refresh(async () => { f.tokens.revoke(f.token.record.id); });
    assert.equal((await f.request(url)).status, 403);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: session media binds exact message and supports inbound/artifact ranges`, async () => {
  const f = await fixture(mode);
  try {
    const partial = await f.request(undefined, undefined, { range: 'bytes=2-4' });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 2-4/1048576');
    assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), new Uint8Array([7, 7, 7]));
    const invalid = await f.request(undefined, undefined, { range: 'bytes=9999999-' });
    assert.equal(invalid.status, 416); assert.equal(await invalid.text(), '');
    assert.equal((await f.request(f.path('codex:other'))).status, 404);
    assert.equal((await f.request(f.path(undefined, 'other'))).status, 404);
    assert.equal((await f.request(f.path(undefined, undefined, '/api/media/inbound/absent.bin'))).status, 404);
    const filePath = join(f.dir, 'report.zip'), id = 'a'.repeat(32);
    writeFileSync(filePath, 'artifact'); const info = statSync(filePath);
    f.registry.upsert({ id, path: filePath, name: 'report.zip', mimeType: 'application/zip', size: info.size, mtimeMs: info.mtimeMs, createdAt: 1 });
    const url = `/api/artifacts/${id}`;
    assert.equal((await f.request(f.path(undefined, undefined, url))).status, 404, 'registry presence alone grants nothing');
    f.store.addMessage({ ...f.message, media: [{ type: 'file', name: 'report.zip', url }] });
    const artifact = await f.request(f.path(undefined, undefined, url), undefined, { range: 'bytes=-4' });
    assert.equal(artifact.status, 206); assert.equal(await artifact.text(), 'fact');
    f.artifactConfig.enabled = false;
    assert.equal((await f.request(f.path(undefined, undefined, url))).status, 404);
  } finally { await f.close(); }
});

test('session media rejects absent scopes and rechecks token after history await', async () => {
  const f = await fixture();
  try {
    for (const scopes of [['messages:read'], ['media:read']] as const) {
      const token = f.tokens.create({ label: 'incomplete', scopes: [...scopes] });
      assert.equal((await f.request(undefined, token.token)).status, 403);
    }
    f.refresh(async () => { f.tokens.revoke(f.token.record.id); });
    assert.equal((await f.request()).status, 403);
  } finally { await f.close(); }
});

for (const change of ['revoke', 'delete', 'replace'] as const) test(`session media cancels streaming after ${change}`, async () => {
  const f = await fixture();
  try {
    const response = await f.request(); assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.ok((await reader.read()).value!.length > 0);
    if (change === 'revoke') f.tokens.revoke(f.token.record.id);
    else if (change === 'delete') f.store.removeMessage(f.message.sessionKey, f.message.id);
    else f.store.addMessage({ ...f.message, media: [] });
    await assert.rejects(reader.read(), /scope|membership/);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  } finally { await f.close(); }
});

test('session media refuses traversal, external sources and symlink escapes without fetching them', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.dir, 'private.bin'), 'private');
    symlinkSync(join(f.dir, 'private.bin'), join(f.inboundDir, 'escape.bin'));
    for (const url of ['/api/media/inbound/escape.bin', '/api/media/inbound/..', '/api/media/inbound/%2e%2e%2fprivate.bin', '/api/media/inbound/%5cprivate.bin', '/api/media/inbound/%ZZ', '/api/media/inbound/test.bin?token=secret', 'http://127.0.0.1/private', 'file:///private', 'data:text/plain,secret']) {
      f.store.addMessage({ ...f.message, media: [{ type: 'file', name: 'invalid', url }] });
      const response = await f.request(f.path(undefined, undefined, url));
      assert.equal(response.status, 404, url); assert.doesNotMatch(await response.text(), /private|secret/);
    }
    assert.equal(localMediaResource('/api/media/inbound/a%2Ebin')?.id, 'a.bin');
    assert.equal(localMediaResource('/api/media/inbound/.'), undefined);
  } finally { await f.close(); }
});
