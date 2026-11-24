import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AuthRoutePersistence } from './route-persistence.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createDeckSession } from './passkeys.js';

class OwnerTransport extends EventEmitter {
  readonly messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
  reply(index: number) {
    const message = this.messages[index]!;
    this.emit('message', { id: message.id, kind: message.kind, ok: true,
      body: message.kind === 'close' ? 'null' : 'false' });
    if (message.kind === 'close') this.emit('exit', 0);
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('diagnostic clock close drains the accepted original command before SQL close', async t => {
  const worker = new OwnerTransport();
  let observe: (() => void) | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    const callback = observe; observe = undefined; callback?.(); return performance.now();
  });
  const owner = new AsyncSqliteAuthOwner({ file: 'isolated-admission-fixture', legacyFiles: [] }, diagnostics,
    () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  worker.emit('message', { kind: 'ready' });
  let close: Promise<void> | undefined;
  observe = () => { close = owner.close(); void close.catch(() => {}); };
  const command = owner.command('sessionCurrent', { token: createDeckSession() });
  void command.catch(() => {});
  await turn();
  assert.ok(close);
  assert.equal(owner.snapshot().accepted, 1);
  assert.deepEqual(worker.messages.map(message => message.kind), ['sessionCurrent']);
  worker.reply(0); assert.equal(await command, false);
  await turn();
  assert.deepEqual(worker.messages.map(message => message.kind), ['sessionCurrent', 'close']);
  worker.reply(1); await close;
  assert.equal(owner.snapshot().acceptedBytes, 0);
});

test('diagnostic clock reentry cannot admit request 257 before worker readiness', async t => {
  const worker = new OwnerTransport();
  let observe: (() => void) | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    const callback = observe; observe = undefined; callback?.(); return performance.now();
  });
  const owner = new AsyncSqliteAuthOwner({ file: 'isolated-capacity-fixture', legacyFiles: [] }, diagnostics,
    () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  const token = createDeckSession(), nested: Promise<boolean>[] = [];
  observe = () => {
    for (let i = 0; i < 256; i++) {
      const command = owner.command('sessionCurrent', { token });
      void command.catch(() => {}); nested.push(command);
    }
  };
  const original = owner.command('sessionCurrent', { token }); void original.catch(() => {});
  await turn();
  assert.equal(owner.snapshot().accepted, 256);
  assert.equal(worker.messages.length, 0);
  worker.emit('exit', 1);
  const results = await Promise.allSettled([original, ...nested]);
  assert.equal(results.length, 257);
  await turn();
  assert.equal(owner.snapshot().accepted, 0);
  assert.equal(owner.snapshot().acceptedBytes, 0);
});

test('input Proxy cannot execute a reentrant close before command reservation or dispatch', async t => {
  const worker = new OwnerTransport();
  const owner = new AsyncSqliteAuthOwner({ file: 'isolated-input-fixture', legacyFiles: [] },
    new PerformanceDiagnostics(() => {}), () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  worker.emit('message', { kind: 'ready' });
  let close: Promise<void> | undefined, traps = 0;
  const input = new Proxy({ token: createDeckSession() }, {
    getPrototypeOf(target) { traps++; close ??= owner.close(); void close.catch(() => {}); return Reflect.getPrototypeOf(target); },
  });
  const command = owner.command('sessionCurrent', input); void command.catch(() => {});
  await assert.rejects(command, AuthPersistenceError);
  await turn();
  assert.equal(traps, 0); assert.equal(close, undefined);
  assert.equal(owner.snapshot().closing, false);
  assert.equal(worker.messages.length, 0);
  close = owner.close(); await turn();
  assert.deepEqual(worker.messages.map(message => message.kind), ['close']);
  worker.reply(0); await close;
  assert.equal(owner.snapshot().accepted, 0);
  assert.equal(owner.snapshot().acceptedBytes, 0);
});

test('full auth owner refuses caller metadata before Proxy inspection and retains all original slots', async t => {
  const worker = new OwnerTransport();
  const owner = new AsyncSqliteAuthOwner({ file: 'isolated-capacity-fixture', legacyFiles: [] },
    new PerformanceDiagnostics(() => {}), () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  const accepted = Array.from({ length: 256 }, () => {
    const command = owner.command('sessionCurrent', { token: createDeckSession() }); void command.catch(() => {}); return command;
  });
  let inspections = 0;
  const input = new Proxy({ token: createDeckSession() }, {
    getPrototypeOf(target) { inspections++; return Reflect.getPrototypeOf(target); },
  });
  await assert.rejects(owner.command('sessionCurrent', input), AuthPersistenceError);
  assert.equal(inspections, 0); assert.equal(owner.snapshot().accepted, 256);
  assert.equal(worker.messages.length, 0);
  worker.emit('exit', 1); await Promise.allSettled(accepted);
  await turn(); assert.equal(owner.snapshot().acceptedBytes, 0);
});

test('route persistence reserves capacity before diagnostic clock reentry', async () => {
  let observe: (() => void) | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    const callback = observe; observe = undefined; callback?.(); return performance.now();
  });
  const persistence = new AuthRoutePersistence(diagnostics);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const nested: Promise<unknown>[] = [];
  let dispatches = 0;
  const work = () => { dispatches++; return pending; };
  observe = () => {
    for (let i = 0; i < 256; i++) {
      const command = persistence.run(6, work); void command.catch(() => {}); nested.push(command);
    }
  };
  const original = persistence.run(6, work); void original.catch(() => {});
  const accepted = persistence.pending;
  release();
  const results = await Promise.allSettled([original, ...nested]);
  assert.equal(accepted, 256);
  assert.equal(dispatches, 256);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(persistence.pending, 0);
});
