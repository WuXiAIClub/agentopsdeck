// Isolated deployed-code integration: projection -> message -> card -> download.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { preview } from 'vite';

const release = process.env.AOD_TEST_RELEASE;
assert.ok(release, 'AOD_TEST_RELEASE must point to a verified local release');
const load = name => import(pathToFileURL(`${release}/apps/server/dist/${name}.js`).href);
const requireServer = createRequire(`${release}/apps/server/package.json`);
const { Hono } = requireServer('hono');
const { ArtifactRegistry, bridgeArtifactReferences } = await load('messages/artifact-receiver');
const { normalizeMessageText } = await load('messages/normalize');
const { mediaResourceId } = await load('messages/media-resource');
const { ConnectorTokenStore } = await load('auth/connector-token');
const { DeckStore } = await load('projection/deck-store');
const { registerSessionMediaRoutes } = await load('connector/session-media-http');
const { loadConfig } = await load('config');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const dir = await mkdtemp(join(tmpdir(), 'agentopsdeck-artifact-browser-'));
const output = join(dir, 'outputs');
await mkdir(output);
const filename = '下载测试.txt';
const file = join(output, filename);
const bytes = Buffer.from('AgentOpsDeck v2 文件下载测试\nAGENTOPSDECK_DOWNLOAD_OK\n');
await writeFile(file, bytes);
const config = loadConfig({ HOME: dir, AOD_ARTIFACT_RECEIVER_ENABLED: 'true',
  AOD_ARTIFACT_ALLOWED_DIRS: output, AOD_ARTIFACT_ALLOWED_DIRECT_CHILD_DIRS: '',
  AOD_ARTIFACT_INDEX_FILE: join(dir, 'artifacts.json'), AOD_ARTIFACT_CAPABILITY_INJECTION: 'false',
  AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false' }).artifactReceiver;
assert.deepEqual(config.allowedDirs, [output]);
assert.deepEqual(config.allowedDirectChildDirs, []);
const registry = new ArtifactRegistry(config.indexFile);
const project = text => bridgeArtifactReferences({ role: 'assistant', text }, 'assistant', config, registry);
// Reproduce the old setting, then prove the same Markdown becomes an attachment.
assert.equal((await bridgeArtifactReferences({ text: `[下载]( ${file})` }, 'assistant', { ...config, enabled: false }, registry)).media.length, 0);
const row = { role: 'assistant', text: `[下载]( ${file})` };
const projected = await project(row.text);
assert.equal(projected.media.length, 1);
assert.ok(!normalizeMessageText(row, { bridgedRawMediaReferences: projected.bridgedReferences }).includes(file));
const outside = join(dir, 'private.txt');
await writeFile(outside, 'synthetic private');
await symlink(outside, join(output, 'escape.txt'));
for (const path of [outside, join(output, 'escape.txt')]) assert.equal((await project(path)).media.length, 0);
const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
const token = tokens.create({ label: 'isolated browser fixture', scopes: ['messages:read', 'media:read'] });
const app = new Hono();
registerSessionMediaRoutes(app, { tokens, store, inboundDir: output, artifactConfig: config, artifactRegistry: registry, refreshMessages: async () => {} });
const sessionKey = 'local:c3ludGhldGlj';
const native = 'codex:synthetic';
const message = { id: 'artifact-1', sessionKey: native, role: 'assistant', text: '测试附件', createdAt: 1, media: projected.media };
store.addMessage(message);
const downloadPath = `/api/connector/v1/sessions/${encodeURIComponent(native)}/messages/${message.id}/media/${mediaResourceId(projected.media[0].url)}`;
const request = (path = downloadPath, credential = token.token) => app.request(path, { headers: { authorization: `Bearer ${credential}` } });
assert.equal((await request(downloadPath, 'invalid')).status, 403);
assert.equal((await request(downloadPath.replace('artifact-1', 'other-message'))).status, 404);
const session = { sessionKey, envConnectionId: 'local', title: 'Artifact fixture', agentId: 'main', source: 'codex', status: 'idle', lastActiveAt: 1 };
const web = await preview({ root: `${release}/apps/web/dist`, configFile: false, build: { outDir: `${release}/apps/web/dist` }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
    const errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/test-artifact') {
        const response = await request();
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ groups: [{ agentId: 'main', sessions: [session] }], updatedAt: 1, revision: '1' });
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ ...message, sessionKey, media: [{ ...projected.media[0], url: '/api/test-artifact' }] }], hiddenCount: 0, updatedAt: 1, revision: '1' });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'main', name: 'Main' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Not part of fixture' } });
    });
    await context.addInitScript(() => { localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin); window.EventSource = class extends EventTarget { close() {} }; });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByText(session.title, { exact: true }).first().click();
    const card = page.getByRole('button', { name: new RegExp(filename) });
    await card.waitFor({ state: 'visible' });
    const downloaded = page.waitForEvent('download');
    await card.click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), filename);
    assert.deepEqual(await readFile(await download.path()), bytes);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}px: actual attachment button, filename and downloaded bytes`);
    await context.close();
  }
  tokens.revoke(token.record.id);
  assert.equal((await request()).status, 403);
  console.log(`PASS disabled regression, output allowlist, symlink rejection, wrong message, missing/revoked authorization; fixture=${dir}`);
} finally { await browser?.close(); await new Promise(resolve => web.httpServer.close(resolve)); }
