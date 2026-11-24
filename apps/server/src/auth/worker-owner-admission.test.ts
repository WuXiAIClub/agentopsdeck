import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, chmodSync, linkSync, unlinkSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
class Transport extends EventEmitter {
  messages: {id: number; kind: string}[] = []; stops = 0;
  postMessage(message: {id: number; kind: string}) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
  acknowledgeClose() {
    const message = this.messages.at(-1)!;
    assert.equal(message.kind, 'close');
    this.emit('message', { id: message.id, kind: 'close', ok: true, body: 'null' });
  }
}
const next = () => new Promise(resolve => setImmediate(resolve));
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-runtime-admission-')); chmodSync(directory, 0o700);
  const owners: AsyncSqliteAuthOwner[] = [];
  t.after(async () => {
    for (const owner of owners) await owner.closeForShutdown();
    rmSync(directory, { recursive: true });
  });
  return { directory, config: { file: join(directory, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: 'a'.repeat(64) },
    track(owner: AsyncSqliteAuthOwner) { owners.push(owner); return owner; } };
}
test('real same-file worker refuses before launch and reopens only after confirmed exit', async t => {
  const h = fixture(t), lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const original = h.track(new AsyncSqliteAuthOwner(h.config, diagnostics));
  await original.open();
  let launches = 0;
  assert.throws(() => new AsyncSqliteAuthOwner(h.config, diagnostics, () => { launches++; return new Transport() as unknown as Worker; }));
  assert.equal(launches, 0); assert.equal(original.snapshot().unavailable, false);
  const alias = join(h.directory, 'alias.sqlite'); linkSync(h.config.file, alias);
  assert.throws(() => new AsyncSqliteAuthOwner({ ...h.config, file: alias }, diagnostics));
  await original.closeForShutdown();
  // Private SQLite policy rejects multiply-linked files independently of the
  // runtime gate. Preserve that security policy during the real reopen.
  unlinkSync(alias);
  const reopened = h.track(new AsyncSqliteAuthOwner(h.config, diagnostics));
  await reopened.open(); await reopened.closeForShutdown();
  assert.equal(reopened.snapshot().ownerExitConfirmed, true);
  const refusal = lines.map(line => JSON.parse(line)).find(event => event.step === 7);
  assert.ok(refusal); assert.equal(refusal.deferred, 1); assert.equal(refusal.unknown, undefined);
  assert.equal(lines.join('').includes(h.directory), false);
  assert.equal(lines.join('').includes(h.config.accessKeyDigest), false);
});
test('close ACK, elapsed warning and terminate resolution never admit a replacement', async t => {
  const h = fixture(t), transport = new Transport(), diagnostics = new PerformanceDiagnostics(() => {});
  const original = new AsyncSqliteAuthOwner(h.config, diagnostics, () => transport as unknown as Worker, 5);
  transport.emit('message', { kind: 'ready' }); await original.open();
  const close = original.close(); await next(); transport.acknowledgeClose(); await next();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(original.snapshot().closeAcknowledged, true);
  assert.equal(original.snapshot().ownerExitConfirmed, false);
  assert.throws(() => new AsyncSqliteAuthOwner(h.config, diagnostics, () => new Transport() as unknown as Worker));
  transport.emit('exit', 0); await close;
  const failedTransport = new Transport();
  const failed = new AsyncSqliteAuthOwner(h.config, diagnostics, () => failedTransport as unknown as Worker, 5);
  failedTransport.emit('error', Error('private-original-failure'));
  const physical = failed.closeForShutdown(); await next();
  assert.equal(failedTransport.stops, 1);
  assert.throws(() => new AsyncSqliteAuthOwner(h.config, diagnostics, () => new Transport() as unknown as Worker));
  failedTransport.emit('exit', 1); await physical;
  const finalTransport = new Transport(), final = new AsyncSqliteAuthOwner(h.config, diagnostics, () => finalTransport as unknown as Worker);
  finalTransport.emit('exit', 1); await final.closeForShutdown();
});
test('native worker construction failure does not leave a phantom reservation', async t => {
  const h = fixture(t), diagnostics = new PerformanceDiagnostics(() => {});
  assert.throws(() => new AsyncSqliteAuthOwner(h.config, diagnostics, () => { throw Error('private-launch-failure'); }));
  const transport = new Transport(), owner = new AsyncSqliteAuthOwner(h.config, diagnostics, () => transport as unknown as Worker);
  transport.emit('exit', 1); await owner.closeForShutdown();
});
test('real worker pins database and legacy paths before asynchronous startup', async t => {
  const h = fixture(t), initial = process.cwd(), other = join(h.directory, 'other');
  mkdirSync(other, { mode: 0o700 }); writeFileSync(join(other, 'legacy.json'), 'offline-fixture');
  let owner: AsyncSqliteAuthOwner | undefined;
  try {
    process.chdir(h.directory);
    owner = h.track(new AsyncSqliteAuthOwner({ ...h.config, file: 'auth.sqlite', legacyFiles: ['legacy.json', ''] }, new PerformanceDiagnostics(() => {})));
    process.chdir(other);
    await owner.open();
    assert.equal(existsSync(h.config.file), true);
    assert.equal(existsSync(join(other, 'auth.sqlite')), false);
  } finally {
    process.chdir(initial);
    await owner?.closeForShutdown();
  }
});
