import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Evaluate the actual ESM entrypoint in an isolated child. Only service/config
// factories are synthetic; ProcessLifetime and diagnostics are real modules.
// No live service, journal, credential, native effect or process signal is used.
const harness = String.raw`
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require(process.argv[1]), entry = process.argv[2], mode = process.argv[3];
const realProcess = process, fakeProcess = new EventEmitter();
fakeProcess.argv = [realProcess.execPath, entry, '/synthetic/config'];
fakeProcess.getuid = () => realProcess.getuid?.();
const state = { opens: 0, hostClose: 0, failedClose: 0, unhandled: 0, ready: 0,
  rawError: false, beforeRelease: 0, startupSignals: 0, failures: 0 };
realProcess.on('unhandledRejection', () => { state.unhandled++; });
const config = { format: 1, nodeId: 'node:1', sessionKey: 'codex:history',
  connectorUrl: 'http://127.0.0.1:8792', releasesDirectory: '/synthetic/releases',
  activeReleaseFile: '/synthetic/settings/active.json', workDirectory: '/synthetic/work',
  backupRoots: ['/synthetic/runtime', '/synthetic/settings'], tar: '/usr/bin/tar',
  credentialFile: '/synthetic/settings/credential', tokenFile: '/synthetic/runtime/tokens',
  journalFile: '/synthetic/journal/db', listener: { hostname: '127.0.0.1', port: 8793 },
  service: { unit: 'synthetic.service', controlGroup: '/synthetic', systemctl: '/usr/bin/systemctl' } };
let acceptStart, refuseStart, releaseClose, closeState = 'open', flight;
const startup = new Promise((resolve, reject) => { acceptStart = resolve; refuseStart = reject; });
const host = { close: Object.assign(() => {
  state.hostClose++;
  if (mode === 'close-refusal' && state.hostClose === 1) {
    closeState = 'cleanup-required'; return Promise.reject(Error('private-owner-error'));
  }
  if (mode === 'drain-failure') {
    closeState = 'drain-failed'; return Promise.reject(Error('private-owner-error'));
  }
  if (mode === 'close-refusal') { closeState = 'closed'; return Promise.resolve(); }
  closeState = 'cleaning';
  flight = new Promise(resolve => { releaseClose = () => { closeState = 'closed'; resolve(); }; });
  return flight;
}, { snapshot: () => ({ state: closeState }) }) };
const early = mode === 'early-term' || mode === 'early-int' || mode === 'startup-failure';
const failedStartup = mode === 'startup-failure' || mode === 'startup-failure-no-signal';
const signals = () => {
  fakeProcess.emit(mode === 'early-int' ? 'SIGINT' : 'SIGTERM');
  fakeProcess.emit(mode === 'early-int' ? 'SIGINT' : 'SIGTERM');
  fakeProcess.emit('SIGINT'); state.startupSignals++;
};
const mocks = {
  'node:fs/promises': { realpath: async file => file, open: async file => {
    if (early && file === '/synthetic/config') signals();
    return { stat: async () => ({ isFile: () => true, nlink: 1, size: 100, mode: 0o600,
      uid: fakeProcess.getuid() }), readFile: async () => file === '/synthetic/config'
        ? JSON.stringify(config) : 'synthetic-token', close: async () => {} };
  } },
  '../auth/connector-token.js': { ConnectorTokenStore: class {} },
  './maintenance-connector-client.js': { MaintenanceConnectorClient: class {} },
  './maintenance-node-adapter.js': { NodeMaintenanceAdapter: class {} },
  './maintenance-systemd.js': { SystemdConnectorService: class {} },
  './maintenance-host.js': {
    startMaintenanceHost: () => { state.opens++; return startup; },
    closeFailedMaintenanceStartup: () => {
      state.failedClose++;
      return state.failedClose === 1 ? Promise.reject(Error('private-owner-error')) : Promise.resolve();
    },
    maintenanceHostStartupRecovery: () => ({ pending: 1, retryable: 1 }),
  },
};
const consoleMock = { log() {}, warn() {}, info(...args) {
  if (args.includes('Independent Connector maintenance host ready')) state.ready++;
}, error(...args) {
  state.failures++;
  if (args.some(arg => String(arg).includes('private-'))) state.rawError = true;
} };
const context = vm.createContext({ process: fakeProcess, console: consoleMock, performance,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone, Request });
const cache = new Map();
function synthetic(key, values) {
  if (cache.has(key)) return cache.get(key);
  const names = Object.keys(values);
  const module = new vm.SyntheticModule(names, function() {
    for (const name of names) this.setExport(name, values[name]);
  }, { context, identifier: key });
  cache.set(key, module); return module;
}
function source(file) {
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = new vm.SourceTextModule(compiled, { context, identifier: file,
    initializeImportMeta: meta => { meta.url = require('node:url').pathToFileURL(file).href; } });
  cache.set(file, module); return module;
}
async function link(specifier, parent) {
  if (parent.identifier === entry && Object.hasOwn(mocks, specifier))
    return synthetic('mock:' + specifier, mocks[specifier]);
  if (!specifier.startsWith('.')) return synthetic(specifier, require(specifier));
  let target = path.resolve(path.dirname(parent.identifier), specifier);
  if (!fs.existsSync(target)) target = target.replace(/\.js$/, '.ts');
  return source(target);
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function run() {
  const module = source(entry); await module.link(link);
  const evaluation = module.evaluate();
  // Startup is waiting on the original factory after the private-file awaits.
  await turn();
  if (failedStartup) refuseStart(Error('private-startup-error'));
  else acceptStart(host);
  await evaluation; await turn();
  if (failedStartup || mode === 'close-refusal') {
    if (mode === 'close-refusal') signals();
    // Only the original cleanup protocol is retried, no ad-hoc second signal.
    await new Promise(resolve => setTimeout(resolve, 1250));
  } else if (mode === 'drain-failure') {
    signals(); await turn(); signals(); await turn();
  } else {
    if (!early) signals();
    await turn(); signals(); await turn();
    state.beforeRelease = state.hostClose;
    state.pendingExitCode = fakeProcess.exitCode ?? null;
    releaseClose(); await turn();
  }
  state.exitCode = fakeProcess.exitCode ?? null;
  state.termHandlers = fakeProcess.listenerCount('SIGTERM');
  state.intHandlers = fakeProcess.listenerCount('SIGINT');
  realProcess.stdout.write(JSON.stringify(state)); realProcess.exit(0);
}
void run().catch(() => { realProcess.stderr.write('Synthetic entrypoint harness failed'); realProcess.exit(1); });
`;

type Result = { opens: number; hostClose: number; failedClose: number; unhandled: number; ready: number;
  rawError: boolean; beforeRelease: number; startupSignals: number; failures: number; pendingExitCode: number | null;
  exitCode: number | null; termHandlers: number; intHandlers: number };
function probe(mode: string): Result {
  const entry = join(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith('.ts') ? 'maintenance-entry.ts' : 'maintenance-entry.js');
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '-e', harness,
    createRequire(import.meta.url).resolve('typescript'), entry, mode], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout) as Result;
  assert.equal(state.unhandled, 0); assert.equal(state.rawError, false);
  assert.equal(state.opens, 1); assert.equal(state.termHandlers, 1); assert.equal(state.intHandlers, 1);
  return state;
}

for (const mode of ['early-term', 'early-int', 'pending-close']) test(`actual maintenance entry retains original owners under repeated signals: ${mode}`, () => {
  const s = probe(mode);
  assert.equal(s.hostClose, 1); assert.equal(s.beforeRelease, 1);
  assert.equal(s.pendingExitCode, null); assert.equal(s.exitCode, 0); assert.equal(s.failedClose, 0);
  assert.equal(s.ready, mode === 'pending-close' ? 1 : 0);
  if (mode !== 'pending-close') assert.equal(s.startupSignals, 2);
});

test('actual maintenance entry automatically retries refused original host cleanup, not startup or drain', () => {
  const s = probe('close-refusal');
  assert.equal(s.hostClose, 2); assert.equal(s.failedClose, 0); assert.equal(s.exitCode, 1);
});

for (const mode of ['startup-failure', 'startup-failure-no-signal']) test(`actual maintenance entry retains failed startup owner and retries only its cleanup: ${mode}`, () => {
  const s = probe(mode);
  assert.equal(s.hostClose, 0); assert.equal(s.failedClose, 2); assert.equal(s.ready, 0); assert.equal(s.exitCode, 1);
});

test('actual maintenance entry does not retry a failed original effect drain when later signals arrive', () => {
  const s = probe('drain-failure');
  assert.equal(s.hostClose, 1); assert.equal(s.failedClose, 0); assert.equal(s.exitCode, 1);
});
