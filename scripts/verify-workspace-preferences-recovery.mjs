// Source-component acceptance with synthetic HTTP only. No live Hub, model,
// database, account, deploy or message endpoints are reachable by this fixture.
import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from '../apps/web/node_modules/vite/dist/node/index.js';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const preferencesPath = '/api/hub/v1/workspace/preferences';
const digest = value => createHash('sha256').update(value).digest('hex');
async function inventory() {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push({ path, sha256: digest(await readFile(join(repository, path))) });
    }
  }
  await visit('apps/web/src'); await visit('packages/shared/src');
  for (const path of ['scripts/verify-workspace-preferences-recovery.mjs', 'apps/web/package.json',
    'apps/web/tsconfig.json', 'pnpm-lock.yaml', 'packages/shared/package.json'])
    result.push({ path, sha256: digest(await readFile(join(repository, path))) });
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
const before = await inventory();
const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspacePreferencesProvider, useWorkspacePreferences} from '/src/components/WorkspacePreferences';
import {setRecoveryScope} from '/src/api';
setRecoveryScope('a'.repeat(64));
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input, window.location.href);
  if (url.origin !== window.location.origin || url.pathname !== '${preferencesPath}') {
    window.fixtureUnexpected.push(url.pathname); return Promise.reject(new Error('Fixture refuses non-preference HTTP'));
  }
  return originalFetch(input, init);
};
window.fixtureUnexpected = []; window.fixtureErrors = [];
window.addEventListener('error', event => window.fixtureErrors.push(event.message));
window.addEventListener('unhandledrejection', () => window.fixtureErrors.push('unhandled rejection'));
function Probe() {
  const state = useWorkspacePreferences();
  window.preferenceState = state;
  return <pre id="state">{JSON.stringify({value:state.value,ready:state.ready,saving:state.saving,error:state.error})}</pre>;
}
function Fixture() {
  const [paused,setPaused] = useState(false), [scope,setScope] = useState('a');
  window.pausePreferences = setPaused;
  window.changeScope = next => { setRecoveryScope(next.repeat(64)); setScope(next); };
  return <div data-scope={scope}><WorkspacePreferencesProvider paused={paused}><Probe/></WorkspacePreferencesProvider></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
let document = { revision: 7, groups: [{ id: 'legacy-group', name: '  Legacy group  ', collapsed: false }],
  sessions: { 'fixture:Y29kZXg6bGVnYWN5': { groupId: 'legacy-group', color: '#22aaff' } } };
let readStatus = 200, saveMode = 'ok', holdReads = false, holdSaves = false;
const requests = [], heldReads = [], heldSaves = [];
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = await createServer({ root: join(repository, 'apps/web'), configFile: false,
  // The virtual entry cannot be scanned before navigation. Predeclare its
  // runtime dependencies so Vite cannot reload the page during a CAS scenario.
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@agentopsdeck/shared'] },
  server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'workspace-preferences-recovery-fixture',
    resolveId(id) { if (id === '/__preferences_fixture.tsx') return '\0preferences-fixture.tsx'; },
    async load(id) { if (id === '\0preferences-fixture.tsx') return transformWithEsbuild(fixture, 'preferences-fixture.tsx', { loader: 'tsx', jsx: 'transform' }); },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/__preferences_fixture') {
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(path, '<html><body><div id="root"></div><script>window.fixtureLoadErrors=[];window.addEventListener("error",e=>window.fixtureLoadErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.fixtureLoadErrors.push(String(e.reason)));</script><script type="module" src="/__preferences_fixture.tsx"></script></body></html>')); return;
      }
      if (!path.startsWith('/api/')) return next();
      requests.push({ method: req.method, path });
      if (path !== preferencesPath) { reply(res, 405, { error: 'Fixture refuses non-preference API' }); return; }
      if (req.method === 'GET') {
        const body = structuredClone(document), status = readStatus;
        const finish = () => reply(res, status, status === 200 ? body : { error: 'Synthetic read unavailable' });
        if (holdReads) heldReads.push(finish); else finish(); return;
      }
      if (req.method === 'PUT') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        assert.ok(raw.length < 1_000_000);
        const input = JSON.parse(raw); requests.at(-1).value = input;
        if (saveMode === 'conflict' || input.revision !== document.revision) { reply(res, 409, { error: 'Synthetic conflict. Reload before editing.' }); return; }
        document = { ...input, revision: input.revision + 1 };
        const body = structuredClone(document), status = saveMode === 'unknown' ? 503 : 200;
        const finish = () => reply(res, status, status === 200 ? body : { error: 'Synthetic response unavailable after commit' });
        if (holdSaves) heldSaves.push(finish); else finish(); return;
      }
      reply(res, 405, { error: 'Fixture rejects method' });
    }); },
  }] });
const reservation = createNetServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const driverPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
// Snap Firefox cannot access host /tmp. A unique, disposable profile directory
// under the user's home avoids any existing browser profile or live state.
// The coding environment may override HOME to a hidden directory. Snap cannot
// write there; the OS account home (not an existing browser profile) is needed.
const profileRoot = await mkdtemp(join(userInfo().homedir, 'agentopsdeck-preferences-browser-'));
const driver = spawn('geckodriver', ['--port', String(driverPort), '--profile-root', profileRoot], { stdio: ['ignore', 'ignore', 'pipe'] });
driver.stderr.on('data', chunk => process.stderr.write(chunk));
let driverError, session;
driver.on('error', error => { driverError = error; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(path, method = 'GET', body) {
  if (driverError) throw driverError;
  const res = await fetch(`http://127.0.0.1:${driverPort}${path}`, { method,
    signal: AbortSignal.timeout(method === 'DELETE' ? 30_000 : 15_000),
    headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await res.json(); if (!res.ok) throw Error(JSON.stringify(result)); return result.value;
}
const evaluate = script => command(`/session/${session}/execute/sync`, 'POST', { script, args: [] });
const snapshot = () => evaluate('return JSON.parse(document.getElementById("state").textContent)');
async function until(predicate) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await predicate()) return; await delay(100); }
  throw Error('Synthetic browser state did not settle');
}
const ready = () => until(async () => (await snapshot()).ready === true);
const settledFailure = () => until(async () => { const s = await snapshot(); return !s.ready && !s.saving && !!s.error; });
const reload = () => evaluate('void window.preferenceState.reload(); return true;');
const edit = name => evaluate(`void window.preferenceState.change(v=>({...v,groups:v.groups.map(g=>({...g,name:${JSON.stringify(name)}}))})); return true;`);
const puts = () => requests.filter(r => r.method === 'PUT').length;
const cases = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await until(async () => { try { await command('/status'); return true; } catch { return false; } });
  session = (await command('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'firefox',
    'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await command(`/session/${session}/url`, 'POST', { url: origin + '/__preferences_fixture' });
  await until(async () => await evaluate('return !!window.preferenceState'));
  await ready(); assert.deepEqual((await snapshot()).value, document); cases.push('legacy-wire-and-style-preserved');

  const original = structuredClone(document); readStatus = 503; await reload(); await settledFailure();
  assert.deepEqual((await snapshot()).value, original); await edit('refused'); assert.equal(puts(), 0);
  cases.push('read-unavailable-retains-display-and-refuses-edit');
  readStatus = 200; await reload(); await ready();

  saveMode = 'unknown'; await edit('committed-with-lost-response'); await settledFailure();
  assert.deepEqual((await snapshot()).value, original); assert.equal(puts(), 1); assert.equal(document.revision, 8);
  await edit('must-not-replay'); assert.equal(puts(), 1);
  await reload(); await ready(); assert.deepEqual((await snapshot()).value, document);
  cases.push('unknown-save-reloads-original-commit-without-replay');

  saveMode = 'conflict'; const beforeConflict = structuredClone(document);
  document = { ...document, revision: 9, groups: document.groups.map(g => ({ ...g, name: 'concurrent-save' })) };
  await edit('conflicting-edit'); await settledFailure(); assert.deepEqual((await snapshot()).value, beforeConflict);
  await edit('blocked-after-conflict'); assert.equal(puts(), 2);
  await reload(); await ready(); assert.deepEqual((await snapshot()).value, document);
  cases.push('cas-conflict-retains-display-and-requires-reload');

  saveMode = 'ok'; await edit('successful-save'); await until(async () => (await snapshot()).value.revision === 10 && !(await snapshot()).saving);
  assert.deepEqual((await snapshot()).value, document); assert.equal(puts(), 3);
  assert.equal(requests.filter(r => r.method === 'PUT').at(-1).value.revision, 9);
  cases.push('successful-save-keeps-original-cas-and-session-style');

  holdReads = true; await reload(); await until(() => heldReads.length === 1);
  await evaluate('window.pausePreferences(true); return true;'); await until(async () => !(await snapshot()).ready);
  document = { ...document, revision: 11 }; holdReads = false;
  await evaluate('window.pausePreferences(false); return true;'); await ready();
  heldReads.shift()(); await delay(150); assert.equal((await snapshot()).value.revision, 11); assert.equal(puts(), 3);
  cases.push('late-read-after-pause-cannot-replace-current-state');

  holdReads = true; await reload(); await until(() => heldReads.length === 1);
  document = { revision: 1, groups: [{ id: 'other', name: 'other-scope' }], sessions: {} }; holdReads = false;
  await evaluate('window.changeScope("b"); return true;'); await ready();
  heldReads.shift()(); await delay(150); assert.deepEqual((await snapshot()).value, document); assert.equal(puts(), 3);
  cases.push('late-read-after-identity-switch-cannot-leak-old-display');

  holdSaves = true; await edit('committed-before-pause'); await until(() => heldSaves.length === 1);
  await evaluate('window.pausePreferences(true); return true;'); await until(async () => !(await snapshot()).ready);
  holdSaves = false; await evaluate('window.pausePreferences(false); return true;'); await ready();
  heldSaves.shift()(); await delay(150); assert.deepEqual((await snapshot()).value, document); assert.equal(puts(), 4);
  cases.push('aborted-save-not-replayed-and-explicit-resume-reloads-commit');

  assert.deepEqual(await evaluate('return window.fixtureErrors'), []);
  assert.deepEqual(await evaluate('return window.fixtureUnexpected'), []);
  assert.equal(requests.every(r => r.path === preferencesPath && ['GET', 'PUT'].includes(r.method)), true);
  assert.deepEqual(await inventory(), before, 'Inputs drifted during browser acceptance');
  console.log(JSON.stringify({ passed: true, sourceComponentBrowser: true, wholeFrontendAcceptance: false,
    liveDatabaseWrites: false, windowsNativeAcceptance: false, cases, requests: { reads: requests.length - puts(), saves: puts(), messageWrites: 0 },
    inputInventorySha256: digest(JSON.stringify(before)), inputs: before }, null, 2));
} catch (error) {
  if (session) {
    try { console.error(JSON.stringify(await evaluate('return {loadErrors:window.fixtureLoadErrors,errors:window.fixtureErrors,state:document.getElementById("state")?.textContent,body:document.body.innerText}'))); }
    catch { console.error('Synthetic browser diagnostics unavailable'); }
  }
  throw error;
} finally {
  for (const finish of [...heldReads, ...heldSaves]) finish();
  try { if (session) await command(`/session/${session}`, 'DELETE'); }
  finally {
    driver.kill('SIGTERM'); await server.close();
    // Only this run's mkdtemp profile tree, after confirmed driver termination.
    if (driver.exitCode === null && driver.signalCode === null)
      await Promise.race([new Promise(resolve => driver.once('exit', resolve)), delay(5_000)]);
    if (driver.exitCode !== null || driver.signalCode !== null) await rm(profileRoot, { recursive: true, force: true });
  }
}
