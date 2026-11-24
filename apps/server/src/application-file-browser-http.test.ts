import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { registerApplicationFileBrowserHttp } from './application-file-browser-http.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { loadConfig } from './config.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext, role: 'hub' | 'standalone' = 'hub', mode: 'json' | 'sqlite' = 'sqlite', keyed = true,
  requestWaitMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), 'original-file-browser-')), home = join(root, 'openclaw');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const link = createApplicationTransactionLink(), session = 'd'.repeat(43), key = 'isolated-original-file-key';
  const auth = originalApplicationAuthFixture(root, role, mode, keyed ? key : undefined, diagnostics, link.auth);
  const saved = [process.env.AOD_OPENCLAW_HOME, process.env.OPENCLAW_CONFIG_FILE];
  const releases = new Set<() => void>();
  let close: (() => Promise<void>) | undefined, closeCommands: (() => Promise<void>) | undefined;
  t.after(async () => {
    for (const release of releases) release();
    try { await close?.(); await closeCommands?.(); await auth.closeForShutdown(); }
    finally {
      link.closeUnused();
      for (const [i, name] of ['AOD_OPENCLAW_HOME', 'OPENCLAW_CONFIG_FILE'].entries()) {
        if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(join(home, 'workspace-main', 'docs'), { recursive: true });
  await writeFile(join(home, 'workspace-main', 'note.md'), 'original contents');
  await writeFile(join(home, 'workspace-main', '.env'), 'not-public');
  await writeFile(join(home, 'openclaw.json'), '{}');
  process.env.AOD_OPENCLAW_HOME = home; process.env.OPENCLAW_CONFIG_FILE = join(home, 'openclaw.json');
  await auth.open(); if (keyed) await auth.issueSession(session);
  let available = true, beforeMutation: (() => Promise<void>) | undefined;
  const commands = createApplicationCommandScopes({ authorize: async request => await auth.authorize(request),
    assertAvailable() { if (!available) throw Error('unavailable'); }, diagnostics });
  closeCommands = commands.close;
  const app = new Hono();
  const http = registerApplicationFileBrowserHttp(app, {
    roots: loadConfig({ AOD_OPENCLAW_HOME: home }).nativeFileRoots,
    commands: { run: async (request, intent, work) => { await beforeMutation?.(); return commands.run(request, intent, work); } },
    observeActor: async request => await auth.authorize(request) ? 'original-admin' : undefined,
    available: () => available, requestWaitMs, diagnostics,
  });
  close = http.close;
  app.all('*', c => c.json({ fallback: true }, 404));
  const headers = keyed ? { cookie: `agentopsdeck_session=${session}` } : {};
  const request = (path: string, init: RequestInit = {}) => app.request(`/api/files/${path}`, {
    ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) },
  });
  const upload = (name = 'upload.txt', signal?: AbortSignal) => {
    const body = new FormData(); body.set('file', new File(['new file contents'], name));
    return request('agents/main/upload', { method: 'POST', body, ...(signal ? { signal } : {}) });
  };
  const gate = () => {
    let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
    releases.add(release); return { promise, release };
  };
  return { app, http, home, logs, commands, gate, request, upload, revoke: () => auth.revokeSession(session),
    mutation(value: typeof beforeMutation) { beforeMutation = value; }, available(value: boolean) { available = value; } };
}

test('file wrapper keeps injected instance roots despite later ambient environment changes', async t => {
  const state = await fixture(t);
  const other = join(state.home, 'other-instance');
  await mkdir(join(other, 'workspace-main'), { recursive: true });
  await writeFile(join(other, 'workspace-main', 'note.md'), 'other-instance-marker');
  process.env.AOD_OPENCLAW_HOME = other;
  const previous = process.env.AOD_OPENCLAW_CONFIG_FILE;
  process.env.AOD_OPENCLAW_CONFIG_FILE = join(other, 'missing.json');
  try {
    const response = await state.request('agents/main/preview?path=note.md');
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { text: string }).text, 'original contents');
    assert.equal((await state.request('gateway')).status, 200);
    assert.equal((await state.upload()).status, 200);
    assert.equal(await readFile(join(state.home, 'workspace-main', 'upload.txt'), 'utf8'), 'new file contents');
    await assert.rejects(readFile(join(other, 'workspace-main', 'upload.txt')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.AOD_OPENCLAW_CONFIG_FILE;
    else process.env.AOD_OPENCLAW_CONFIG_FILE = previous;
  }
});

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false])
  test(`${role}/${mode}/${keyed ? 'Cookie' : 'no Key'} original file browser complete read and mutation wire`, async t => {
    const f = await fixture(t, role, mode, keyed);
    const roots = await f.request('roots'); assert.equal(roots.status, 200); assert.ok((await roots.json()).roots.length >= 2);
    assert.equal(roots.headers.get('cache-control'), 'no-store');
    for (const path of ['gateway', 'agents/main']) {
      assert.equal((await f.request(path)).status, 200);
      const prefix = path === 'gateway' ? 'workspace-main/' : '';
      const preview = await f.request(`${path}/preview?path=${prefix}note.md`);
      assert.equal(preview.status, 200); assert.match(await preview.text(), /original contents/);
      const download = await f.request(`${path}/download?path=${prefix}note.md`);
      assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /attachment/);
      assert.equal(await download.text(), 'original contents'); assert.equal(download.headers.get('cache-control'), 'no-store');
      assert.equal((await f.request(`${path}/preview?path=${prefix}.env`)).status, 403);
      assert.equal((await f.request(`${path}/download?path=..%2Foutside`)).status, 403);
      const body = new FormData(); body.set('file', new File(['new file contents'], 'upload.txt'));
      const uploaded = await f.request(`${path}/upload?path=${prefix || '.'}`, { method: 'POST', body });
      assert.equal(uploaded.status, 200); assert.equal((await uploaded.json()).entry.name, 'upload.txt');
      assert.equal(await readFile(join(f.home, 'workspace-main', 'upload.txt'), 'utf8'), 'new file contents');
      const renamed = await f.request(`${path}/rename`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `${prefix}upload.txt`, name: 'renamed.txt' }) });
      assert.equal(renamed.status, 200); assert.equal((await renamed.json()).entry.name, 'renamed.txt');
      assert.equal((await f.request(`${path}?path=${prefix}renamed.txt`, { method: 'DELETE' })).status, 200);
      await assert.rejects(readFile(join(f.home, 'workspace-main', 'renamed.txt')), { code: 'ENOENT' });
    }
    assert.equal((await f.request('gateway/download?path=openclaw.json')).status, 403);
    assert.equal((await f.request('agents/main?path=.', { method: 'DELETE' })).status, 400);
    for (const name of ['x-agentopsdeck-execution-grant', EXPECTED_NODE_HEADER])
      assert.equal((await f.request('roots', { headers: { [name]: 'not-user-authority' } })).status, 403);
    if (keyed) assert.equal((await f.request('roots', { headers: { cookie: '', authorization: 'Bearer machine-only' } })).status, 403);
    assert.equal((await f.request('missing')).status, 404);
    assert.doesNotMatch(f.logs.join('\n'), /isolated-original-file-key|agentopsdeck_session|new file contents/);
  });

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const)
  test(`${role}/${mode} logout after parsing prevents original file mutation without replay`, async t => {
    const f = await fixture(t, role, mode), entered = f.gate(), held = f.gate(); let admissions = 0;
    f.mutation(async () => { admissions++; entered.release(); await held.promise; });
    try {
      const request = f.upload(); await awaitHttpAdmission(entered.promise, request); await f.revoke(); held.release();
      assert.equal((await request).status, 403); assert.equal(admissions, 1);
      await assert.rejects(readFile(join(f.home, 'workspace-main', 'upload.txt')), { code: 'ENOENT' });
      assert.equal((await f.request('roots')).status, 403);
    } finally { held.release(); }
  });

for (const ending of ['timeout', 'disconnect', 'close'] as const)
  test(`original upload ${ending} retains dispatched physical FS and never replays`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, 'standalone', 'sqlite', true, ending === 'timeout' ? 250 : 5_000);
    const entered = f.gate(), held = f.gate(), destination = join(f.home, 'workspace-main', 'upload.txt');
    const original = fs.open; let calls = 0;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === destination) {
        const writeFile = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          calls++; entered.release(); await held.promise;
          return writeFile(...writeArgs);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const clock = ending === 'timeout' ? controlledHttpDeadline(t) : undefined;
    try {
      const controller = new AbortController(), request = f.upload('upload.txt', controller.signal);
      await awaitHttpAdmission(entered.promise, request);
      if (clock) assert.equal((await clock.expire(250, request)).status, 503);
      if (ending === 'disconnect') controller.abort();
      if (ending !== 'close') assert.notEqual((await request).status, 200);
      let drained = false; const closing = f.http.close().then(() => { drained = true; });
      await tick(); await tick(); assert.equal(drained, false); assert.equal(calls, 1);
      assert.equal(f.http.close(), f.http.close()); assert.equal((await f.request('roots')).status, 503);
      held.release(); await closing; assert.notEqual((await request).status, 200);
      assert.equal(await readFile(destination, 'utf8'), 'new file contents'); assert.equal(calls, 1);
      assert.equal(f.commands.pending, 0);
    } finally { clock?.restore(); held.release(); mocked.mock.restore(); syncBuiltinESMExports(); }
  });

test('logout after original file write suppresses delivery but preserves the actual single write', async t => {
  const f = await fixture(t), entered = f.gate(), held = f.gate(), destination = join(f.home, 'workspace-main', 'upload.txt');
  const original = fs.open; let calls = 0;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === destination) {
      const writeFile = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        const value = await writeFile(...writeArgs);
        calls++; entered.release(); await held.promise;
        return value;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const request = f.upload(); await awaitHttpAdmission(entered.promise, request);
    assert.equal(await readFile(destination, 'utf8'), 'new file contents');
    await f.revoke(); held.release(); assert.equal((await request).status, 403); assert.equal(calls, 1);
  } finally { held.release(); mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('file deadline before scope admission never dispatches an original FS write', { timeout: 15_000 }, async t => {
  const f = await fixture(t, 'hub', 'json', true, 250), entered = f.gate(), held = f.gate(); let calls = 0;
  f.mutation(async () => { calls++; entered.release(); await held.promise; });
  const clock = controlledHttpDeadline(t);
  try {
    const request = f.upload(); await awaitHttpAdmission(entered.promise, request); assert.equal((await clock.expire(250, request)).status, 503);
    let drained = false; const closing = f.http.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    held.release(); await closing; assert.equal(calls, 1);
    await assert.rejects(readFile(join(f.home, 'workspace-main', 'upload.txt')), { code: 'ENOENT' });
  } finally { clock.restore(); held.release(); }
});
