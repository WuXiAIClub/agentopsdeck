import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AuthPersistenceError } from './private-store.js';
import { createDeckSession } from './passkeys.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

class Transport extends EventEmitter {
  readonly messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
  reply(index: number, body = 'false') {
    const message = this.messages[index]!;
    this.emit('message', { id: message.id, kind: message.kind, ok: true, body });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const digest = 'a'.repeat(64);

for (const stage of ['startup', 'command', 'close'] as const) {
  test(`explicit ${stage} retirement freezes admission, preserves unknown outcomes and requires actual exit`, async t => {
    const transport = new Transport(), lines: string[] = [];
    const owner = new AsyncSqliteAuthOwner({ file: 'private-retirement-fixture', legacyFiles: [], accessKeyDigest: digest },
      new PerformanceDiagnostics(line => lines.push(line)), () => transport as unknown as Worker);
    t.after(async () => { transport.emit('exit', 1); await owner.closeForShutdown(); });
    if (stage !== 'startup') transport.emit('message', { kind: 'ready' });
    const token = createDeckSession();
    const command = stage === 'close' ? undefined : owner.command('sessionCurrent', { token });
    if (command) void command.catch(() => {});
    await turn();
    const originalClose = owner.close();
    void originalClose.catch(() => {});
    await turn();
    assert.equal(transport.stops, 0, 'ordinary close must not retire a stuck original automatically');
    if (stage === 'close') assert.deepEqual(transport.messages.map(m => m.kind), ['close']);
    const physical = owner.retireForShutdown();
    assert.equal(owner.retireForShutdown(), physical, 'one explicit retirement owns one original physical wait');
    assert.equal(owner.close(), originalClose, 'retirement must not replace the original SQL close result');
    assert.equal(owner.snapshot().closing, true, 'freeze before the first await');
    let exited = false;
    void physical.then(() => { exited = true; });
    await assert.rejects(owner.command('status', {}), AuthPersistenceError);
    if (command) await assert.rejects(command, AuthPersistenceError);
    await turn();
    assert.equal(transport.stops, 1);
    assert.equal(exited, false, 'fulfilled terminate request is not exit proof');
    assert.equal(owner.snapshot().ownerExitConfirmed, false);
    assert.equal(owner.snapshot().acceptedBytes, 0);
    assert.equal(transport.messages.length, stage === 'startup' ? 0 : 1, 'never replay SQL or send another close');
    if (transport.messages.length) transport.reply(0, stage === 'close' ? 'null' : 'true');
    else transport.emit('message', { kind: 'ready' });
    await turn();
    assert.equal(exited, false);
    assert.equal(owner.snapshot().closeAcknowledged, false, 'late ACK cannot revive a retired SQL owner');
    transport.emit('exit', 1);
    await physical;
    await assert.rejects(originalClose, AuthPersistenceError);
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
    assert.equal(owner.snapshot().unavailable, true);
    assert.ok(lines.some(line => JSON.parse(line).ownerFailureCode === 11));
    for (const secret of [token, digest, 'private-retirement-fixture']) assert.equal(lines.join('').includes(secret), false);
  });
}

test('retirement after proven normal close neither invents failure nor requests a second exit', async () => {
  const transport = new Transport(), lines: string[] = [];
  const owner = new AsyncSqliteAuthOwner({ file: 'private-fixture', legacyFiles: [] },
    new PerformanceDiagnostics(line => lines.push(line)), () => transport as unknown as Worker);
  transport.emit('message', { kind: 'ready' });
  const original = owner.close();
  await turn(); transport.reply(0, 'null'); transport.emit('exit', 0);
  await original;
  await owner.retireForShutdown();
  assert.equal(owner.close(), original);
  assert.equal(transport.stops, 0);
  assert.equal(owner.snapshot().unavailable, false);
  assert.equal(lines.some(line => JSON.parse(line).ownerFailureCode === 11), false);
});

test('diagnostic reentry cannot admit a replacement command or change explicit retirement ownership', async t => {
  const transport = new Transport();
  let owner!: AsyncSqliteAuthOwner, reenter: (() => void) | undefined;
  const diagnostics = new PerformanceDiagnostics(() => { const call = reenter; reenter = undefined; call?.(); });
  owner = new AsyncSqliteAuthOwner({ file: 'private-fixture', legacyFiles: [] }, diagnostics,
    () => transport as unknown as Worker);
  t.after(async () => { transport.emit('exit', 1); await owner.closeForShutdown(); });
  transport.emit('message', { kind: 'ready' });
  const command = owner.command('sessionCurrent', { token: createDeckSession() });
  void command.catch(() => {}); await turn();
  const physical = owner.retireForShutdown();
  let nested: Promise<void> | undefined, refused: Promise<unknown> | undefined;
  reenter = () => { nested = owner.retireForShutdown(); refused = owner.command('status', {}); void refused.catch(() => {}); };
  await assert.rejects(command, AuthPersistenceError); await turn();
  assert.equal(nested, physical); assert.ok(refused); await assert.rejects(refused, AuthPersistenceError);
  assert.equal(transport.messages.length, 1); assert.equal(transport.stops, 1);
  transport.emit('exit', 1); await physical;
});

test('explicit retirement after real COMMIT but no ACK preserves the original session on stopped-data reopen without replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-explicit-retirement-')); chmodSync(dir, 0o700);
  const file = join(dir, 'auth.sqlite'), token = createDeckSession(), lines: string[] = [];
  const entry = new URL(import.meta.url.endsWith('.ts') ? './sqlite-owner-worker.ts' : './sqlite-owner-worker.js', import.meta.url);
  const original = new Worker(`(async () => {
    const { workerData } = require('node:worker_threads');
    if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
    else await import(workerData.entry);
  })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
    file, legacyFiles: [], accessKeyDigest: digest, entry: entry.href,
    loader: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined,
  } });
  const transport = new EventEmitter(); let issues = 0, stops = 0, heldAck: unknown;
  let commit!: () => void;
  const committed = new Promise<void>(resolve => { commit = resolve; });
  Object.assign(transport, {
    postMessage(message: { kind: string }) { if (message.kind === 'issueAdministratorSession') issues++; original.postMessage(message); },
    terminate() { stops++; return original.terminate(); },
  });
  original.on('message', message => {
    if (message.kind === 'issueAdministratorSession' && message.ok === true) { heldAck = message; commit(); }
    else transport.emit('message', message);
  });
  original.on('error', error => transport.emit('error', error));
  original.on('exit', code => transport.emit('exit', code));
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest: digest },
    new PerformanceDiagnostics(line => lines.push(line)), () => transport as unknown as Worker);
  t.after(async () => { await owner.retireForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open();
  const command = owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
  void command.catch(() => {});
  await committed;
  assert.equal(owner.snapshot().pending, 1); assert.equal(owner.snapshot().unavailable, false);
  const physical = owner.retireForShutdown();
  await assert.rejects(command, AuthPersistenceError);
  await physical;
  assert.equal(owner.snapshot().ownerExitConfirmed, true); assert.equal(stops, 1); assert.equal(issues, 1);
  await assert.rejects(owner.close(), AuthPersistenceError);
  transport.emit('message', heldAck);
  assert.equal(owner.snapshot().closeAcknowledged, false);
  const next = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest: digest }, new PerformanceDiagnostics(() => {}));
  try {
    await next.open(); assert.equal(await next.command('sessionCurrent', { token }), true);
    assert.equal(await next.command('accessKeySession', { token }), true);
  } finally { await next.closeForShutdown(); }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='administrator-issued'").get()!.n, 1);
  } finally { db.close(); }
  assert.equal(issues, 1);
  assert.ok(lines.some(line => { const event = JSON.parse(line); return event.operation === 'auth-sqlite-command' && event.step === 6 && event.unknown === 1; }));
  for (const secret of [file, token, digest]) assert.equal(lines.join('').includes(secret), false);
});
