import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Run the actual entrypoint in a child VM with mocked SDK/service factories.
// No listening port, native agent, live database, signal, or process exit is used.
// The child, not the test runner, owns unhandled-rejection detection.
const harness = String.raw`
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require(process.argv[1]), entry = process.argv[2], mode = process.argv[3];
const realProcess = process, fakeProcess = new EventEmitter();
const state = { unhandled: 0, thrown: 0, appClose: 0, listenerClose: 0, watchdogStop: 0,
  startupClose: 0, factoryCalls: 0, exits: [], rawError: false };
realProcess.on('unhandledRejection', () => { state.unhandled++; });
let markListening, markExited, markClosing;
const listening = new Promise(resolve => { markListening = resolve; });
const exited = new Promise(resolve => { markExited = resolve; });
const closing = new Promise(resolve => { markClosing = resolve; });
fakeProcess.exit = code => { state.exits.push(code); markExited(); };
let cleanupState = 'open';
const appClose = Object.assign(() => {
  state.appClose++;
  if (mode === 'retry' && state.appClose === 1) {
    cleanupState = 'cleanup-required'; return Promise.reject(Error('private-db-path'));
  }
  cleanupState = 'closed'; return Promise.resolve();
}, { snapshot: () => ({ state: cleanupState }) });
const listeners = [];
function serve() {
  state.factoryCalls++;
  if (mode === 'partial-startup' && state.factoryCalls === 2) throw Error('private-db-path');
  const listener = new EventEmitter(); listener.listening = true;
  const originalOn = listener.on;
  listener.on = function(event, callback) {
    const result = originalOn.call(this, event, callback);
    // Factories now assemble asynchronously. Observe the actual retained
    // listener/error boundary, not elapsed wall time or transpiler speed.
    if (event === 'error') queueMicrotask(markListening);
    return result;
  };
  listener.close = callback => {
    state.listenerClose++; listener.listening = false;
    if (mode === 'listener-errors') listener.ack = () => callback(); else queueMicrotask(() => callback());
    markClosing();
  };
  listener.closeIdleConnections = () => {};
  listeners.push(listener); return listener;
}
const mocks = {
  '@hono/node-server': { serve },
  './config.js': { loadConfig: () => ({ port: 0 }) },
  './application-process.js': { createProcessApplication: () => ({ app: { fetch() {} }, close: appClose,
    websiteGateway: mode === 'partial-startup' ? { config: { port: 0 }, fetch() {} } : undefined }) },
  './hub/website-socket-gateway.js': { attachWebsiteSocketUpgrade: () => ({ close() {} }) },
  './diagnostics/event-loop-watchdog.js': { startEventLoopWatchdog: () => ({ stop: () => { state.watchdogStop++; } }) },
  './lifecycle/startup-cleanup.js': { startupApplicationCleanup: {
    closeRetainedOwners: async () => { state.startupClose++; }, snapshot: () => ({ retryable: 0 }) } },
};
const cache = new Map();
const consoleMock = { log() {}, info() {}, warn() {}, error(...args) {
  if (args.some(value => String(value).includes('private-db-path'))) state.rawError = true;
} };
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { module, exports: module.exports, process: fakeProcess, console: consoleMock,
    performance, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    require: specifier => {
      if (file === entry && Object.hasOwn(mocks, specifier)) return mocks[specifier];
      if (!specifier.startsWith('.')) return require(specifier);
      let target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target)) target = target.replace(/\.js$/, '.ts');
      return load(target);
    } };
  vm.runInNewContext(compiled, context, { filename: file }); return module.exports;
}
try { load(entry); } catch { state.thrown++; }
async function run() {
  if (mode === 'early-signal') {
    fakeProcess.emit('SIGTERM');
  } else if (mode === 'retry') {
    await listening;
    fakeProcess.emit('SIGTERM');
    // No ad-hoc second signal: require original-owner automatic cleanup retry.
  } else if (mode === 'listener-errors') {
    await listening;
    try { listeners[0].emit('error', Error('private-db-path')); } catch { state.thrown++; }
    // Observe the original close invocation before repeating the error while
    // its ACK is withheld. Shutdown may invoke close synchronously.
    await closing;
    try { listeners[0].emit('error', Error('private-db-path')); } catch { state.thrown++; }
    listeners[0].ack();
  }
  await exited;
  await new Promise(resolve => setImmediate(resolve));
  // Forced exit before the pipe write ACK can truncate a valid JSON receipt.
  realProcess.stdout.write(JSON.stringify(state), () => realProcess.exit(0));
}
void run();
`;

function probe(mode: string) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const entry = join(root, import.meta.url.endsWith('.ts') ? 'index.ts' : 'index.js');
  const result = spawnSync(process.execPath, ['-e', harness, createRequire(import.meta.url).resolve('typescript'), entry, mode],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { unhandled: number; thrown: number; appClose: number; listenerClose: number;
    watchdogStop: number; factoryCalls: number; exits: number[]; rawError: boolean };
}

test('actual entrypoint automatically resumes permitted cleanup after rejection without an unhandled rejection', () => {
  const s = probe('retry'); assert.equal(s.unhandled, 0); assert.equal(s.thrown, 0);
  assert.equal(s.appClose, 2); assert.equal(s.listenerClose, 1); assert.deepEqual(s.exits, [1]);
  assert.equal(s.watchdogStop, 1); assert.equal(s.rawError, false);
});

test('actual entrypoint early signal cancels deferred startup without constructing an application or listener', () => {
  const s = probe('early-signal'); assert.equal(s.unhandled, 0); assert.equal(s.thrown, 0);
  assert.equal(s.factoryCalls, 0); assert.equal(s.appClose, 0); assert.equal(s.listenerClose, 0);
  assert.equal(s.watchdogStop, 1); assert.deepEqual(s.exits, [0]); assert.equal(s.rawError, false);
});

test('actual entrypoint drains a returned application and first listener after second-listener construction failure', () => {
  const s = probe('partial-startup'); assert.equal(s.unhandled, 0); assert.equal(s.thrown, 0);
  assert.equal(s.factoryCalls, 2); assert.equal(s.appClose, 1); assert.equal(s.listenerClose, 1);
  assert.equal(s.watchdogStop, 1); assert.deepEqual(s.exits, [1]); assert.equal(s.rawError, false);
});

test('actual entrypoint handles repeated listener errors while its original listener is still draining', () => {
  const s = probe('listener-errors'); assert.equal(s.unhandled, 0); assert.equal(s.thrown, 0);
  assert.equal(s.appClose, 1); assert.equal(s.listenerClose, 1); assert.deepEqual(s.exits, [1]);
});
