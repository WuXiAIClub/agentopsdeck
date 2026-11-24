import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs, { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { registerApplicationMediaHttp } from './application-media-http.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { AsyncArtifactRegistry } from './messages/async-artifact-registry.js';
import { MediaLibrary } from './routes/media-library.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext, role: 'hub' | 'standalone' = 'hub', mode: 'json' | 'sqlite' = 'sqlite', keyed = true,
  requestWaitMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), 'original-application-media-')), inboundDir = join(root, 'inbound'), videos = join(root, 'videos');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const link = createApplicationTransactionLink(), session = 'b'.repeat(43), key = 'isolated-original-media-key';
  const auth = originalApplicationAuthFixture(root, role, mode, keyed ? key : undefined, diagnostics, link.auth);
  const releases = new Set<() => void>();
  let close: (() => Promise<void>) | undefined, closeCommands: (() => Promise<void>) | undefined;
  let registry: AsyncArtifactRegistry | undefined;
  t.after(async () => {
    for (const release of releases) release();
    try { await close?.(); await closeCommands?.(); await registry?.close(); await auth.closeForShutdown(); }
    finally { link.closeUnused(); await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(inboundDir); await mkdir(videos);
  await writeFile(join(videos, 'original.mp4'), '0123456789abcdef');
  await writeFile(join(inboundDir, 'original.txt'), 'original inbound');
  const artifact = join(root, 'report.zip'); await writeFile(artifact, 'original artifact');
  registry = await AsyncArtifactRegistry.open(join(root, 'artifacts.json'));
  const info = await stat(artifact), id = 'e'.repeat(24);
  await registry.upsert({ id, path: artifact, name: 'report.zip', mimeType: 'application/zip', size: info.size,
    mtimeMs: info.mtimeMs, createdAt: Date.now() });
  const library = new MediaLibrary({ enabled: true, allowedDirs: [videos], linkTtlSeconds: 60, signingSecret: 'isolated-media-signing-secret' });
  await auth.open(); if (keyed) await auth.issueSession(session);
  let available = true, beforeMutation: (() => Promise<void>) | undefined, actor = 'original-admin';
  const commands = createApplicationCommandScopes({ authorize: async request => await auth.authorize(request),
    assertAvailable() { if (!available) throw Error('unavailable'); }, diagnostics });
  closeCommands = commands.close;
  const app = new Hono();
  const http = registerApplicationMediaHttp(app, {
    inboundDir, artifactConfig: { enabled: true, allowedDirs: [root], maxBytes: 1024, indexFile: join(root, 'artifacts.json'),
      injectCapability: false, allowGatewayClient: true }, artifactRegistry: registry, library,
    commands: { run: async (request, intent, work) => { await beforeMutation?.(); return commands.run(request, intent, work); } },
    observeActor: async request => await auth.authorize(request) ? actor : undefined,
    available: () => available, diagnostics, requestWaitMs,
  });
  close = http.close;
  app.all('*', c => c.json({ fallback: true }, 404));
  const headers = keyed ? { cookie: `agentopsdeck_session=${session}` } : {};
  const request = (url: string, init: RequestInit = {}) => app.request(url, {
    ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) },
  });
  const publish = (signal?: AbortSignal) => request('/api/media/publish', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'upload.txt', mimeType: 'text/plain',
      contentBase64: Buffer.from('original media upload').toString('base64') }), ...(signal ? { signal } : {}) });
  const playback = async () => (await (await request('/api/media-library?root=0')).json()).entries[0].playbackUrl as string;
  const gate = () => {
    let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
    releases.add(release); return { promise, release };
  };
  return { app, http, root, inboundDir, registry, library, logs, request, publish, playback, gate, revoke: () => auth.revokeSession(session),
    mutation(work: typeof beforeMutation) { beforeMutation = work; }, actor(value: string) { actor = value; },
    available(value: boolean) { available = value; } };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false])
  test(`${role}/${mode}/${keyed ? 'Cookie' : 'no Key'} media publication, original artifact and signed GET/HEAD/Range wire`, async t => {
    const f = await fixture(t, role, mode, keyed);
    const list = await f.request('/api/media-library'); assert.equal(list.status, 200); assert.equal((await list.json()).enabled, true);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const published = await f.publish(); assert.equal(published.status, 200, await published.clone().text());
    const body = await published.json(); assert.match(body.downloadUrl, /^http:\/\/localhost\/api\/media\/inbound\//);
    assert.equal(body.markdownUrl, `[upload.txt](${body.downloadUrl})`);
    const inbound = await f.request(body.media.url); assert.equal(inbound.status, 200); assert.equal(await inbound.text(), 'original media upload');
    const artifact = await f.request('/api/artifacts/' + 'e'.repeat(24)); assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'original artifact');
    const signed = await f.playback();
    const stream = await f.app.request(signed, { headers: { range: 'bytes=2-5' } });
    assert.equal(stream.status, 206); assert.equal(stream.headers.get('content-range'), 'bytes 2-5/16'); assert.equal(await stream.text(), '2345');
    const head = await f.app.request(signed, { method: 'HEAD' }); assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '16'); assert.equal(await head.text(), '');
    const invalid = await f.app.request(signed, { headers: { range: 'bytes=90-' } });
    assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), 'bytes */16');
    const expired = new URL(signed, 'http://localhost'); expired.searchParams.set('expires', '1');
    assert.equal((await f.app.request(expired.toString())).status, 403);
    assert.equal((await f.request('/api/media/publish', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await f.request('/api/artifacts/missing')).status, 404);
    for (const header of ['x-agentopsdeck-execution-grant', 'x-agentopsdeck-expected-node-id'])
      assert.equal((await f.request('/api/media-library', { headers: { [header]: 'not-user-authority' } })).status, 403);
    if (keyed) assert.equal((await f.app.request('/api/media-library', { headers: { authorization: 'Bearer machine-only' } })).status, 403);
    assert.doesNotMatch(f.logs.join('\n'), /isolated-original-media-key|isolated-media-signing-secret|original media upload|agentopsdeck_session/);
  });

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const)
  test(`${role}/${mode} revoke before original media write prevents effects without replay`, async t => {
    const f = await fixture(t, role, mode), entered = f.gate(), held = f.gate(); let calls = 0;
    f.mutation(async () => { calls++; entered.release(); await held.promise; });
    const pending = f.publish(); await entered.promise; await f.revoke(); held.release();
    assert.equal((await pending).status, 403); assert.equal(calls, 1);
    assert.deepEqual(await readdir(f.inboundDir), ['original.txt']);
  });

for (const ending of ['timeout', 'disconnect', 'close'] as const)
  test(`media ${ending} retains already dispatched write and never replays`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, 'standalone', 'sqlite', true, ending === 'timeout' ? 250 : 5_000);
    const entered = f.gate(), held = f.gate(), original = fs.writeFile; let calls = 0;
    const mocked = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).startsWith(f.inboundDir)) { calls++; entered.release(); await held.promise; }
      return original(...args);
    });
    syncBuiltinESMExports();
    const abort = new AbortController(); let drained = false;
    try {
      const pending = f.publish(abort.signal); await entered.promise;
      if (ending === 'disconnect') abort.abort();
      const closing = ending === 'close' ? f.http.close().then(() => { drained = true; }) : undefined;
      if (ending !== 'close') assert.equal((await pending).status, ending === 'timeout' ? 503 : 408);
      const drain = closing ?? f.http.close().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(calls, 1);
      held.release(); await pending; await drain; assert.equal(calls, 1);
      const uploaded = (await readdir(f.inboundDir)).filter(name => name !== 'original.txt'); assert.equal(uploaded.length, 1);
      assert.equal(await readFile(join(f.inboundDir, uploaded[0]!), 'utf8'), 'original media upload');
    } finally { held.release(); mocked.mock.restore(); syncBuiltinESMExports(); }
  });

test('delivered inbound stream rechecks original actor on every pull and close cancels idle signed bodies', async t => {
  const f = await fixture(t);
  const inbound = await f.request('/api/media/inbound/original.txt'); assert.equal(inbound.status, 200);
  f.actor('different-original-admin');
  await assert.rejects(inbound.text());
  const signed = await f.playback();
  const idle = await f.app.request(signed); assert.equal(idle.status, 200);
  await f.http.close(); await assert.rejects(idle.text());
  assert.equal((await f.app.request(signed)).status, 503);
});

test('logout does not revoke original signed-link playback but never authorizes list or publication', async t => {
  const f = await fixture(t), signed = await f.playback(); await f.revoke();
  const stream = await f.app.request(signed); assert.equal(stream.status, 200); assert.equal(await stream.text(), '0123456789abcdef');
  assert.equal((await f.request('/api/media-library')).status, 403);
  assert.equal((await f.publish()).status, 403);
});
