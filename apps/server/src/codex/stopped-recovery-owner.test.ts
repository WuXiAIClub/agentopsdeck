import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { initializeStoppedCodexRecovery } from './stopped-recovery.js';
import { recordStoppedRecoveryOwned, StoppedRecoveryOwnerUnavailable, type StoppedRecoveryOwnerRequest } from './stopped-recovery-owner.js';

const run = { sessionKey: 'codex:synthetic', commandId: 'synthetic-command', connectionId: 'synthetic-connection', runId: 'synthetic-turn', revision: 2 };
function request(): StoppedRecoveryOwnerRequest {
  return { file: '/synthetic/private.sqlite', dev: 1, ino: 2, deadline: Date.now() + 60_000,
    runs: [run], proof: { nodeId: 'node', jobId: 'job', fenceId: 'fence', backupId: 'backup', verifiedAt: Date.now() } };
}
class Owner extends EventEmitter {
  terminations = 0;
  terminate() { this.terminations++; return Promise.resolve(1); }
  asWorker() { return this as unknown as Worker; }
}

for (const fault of ['thrown', 'rejected'] as const) test(`termination ${fault} cannot escape or replace stopped recovery exit proof`, async () => {
  const owner = new Owner(), logs: string[] = [];
  owner.terminate = () => {
    if (fault === 'thrown') throw Error('private-termination');
    return Promise.reject(Error('private-termination'));
  };
  let settled = false;
  const result = recordStoppedRecoveryOwned(request(), new PerformanceDiagnostics(line => logs.push(line)), () => owner.asWorker());
  const rejected = assert.rejects(result, StoppedRecoveryOwnerUnavailable).then(() => { settled = true; });
  assert.doesNotThrow(() => owner.emit('error', Error('private-owner')));
  await delay(1); assert.equal(settled, false);
  assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
  assert.doesNotMatch(logs.join('\n'), /private-|synthetic/);
  owner.emit('exit', 1); await rejected;
  const events = logs.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.phase, event.step]), [['pending', 3], ['pending', 3], ['finished', 4]]);
  assert.ok(events.every(event => event.sequence === events[0].sequence));
  assert.equal(events.at(-1).unknown, 1);
  assert.equal(events.at(-1).ownerFailureCode, 5);
});

for (const fault of ['thrown', 'rejected'] as const) test(`stopped recovery retries refused ${fault} cleanup only on the original owner`, async t => {
  const owner = new Owner(), logs: string[] = [];
  owner.terminate = () => {
    owner.terminations++;
    if (owner.terminations > 1) return Promise.resolve(1);
    if (fault === 'thrown') throw Error('private-stop');
    return Promise.reject(Error('private-stop'));
  };
  let settled = false;
  const result = recordStoppedRecoveryOwned(request(), new PerformanceDiagnostics(line => logs.push(line)), () => owner.asWorker());
  const rejected = assert.rejects(result, StoppedRecoveryOwnerUnavailable).then(() => { settled = true; });
  t.after(async () => { owner.emit('exit', 1); await rejected; });
  owner.emit('error', Error('private-owner'));
  await delay(20);
  assert.equal(owner.terminations, 1, 'cooldown must prevent a termination loop');
  await delay(1100);
  assert.equal(owner.terminations, 2);
  assert.equal(settled, false, 'even a successful physical stop ACK is not exit');
  owner.emit('exit', 1); await rejected;
  await delay(20);
  assert.equal(owner.terminations, 2);
  assert.equal(logs.map(line => JSON.parse(line)).at(-1).step, 4);
  assert.doesNotMatch(logs.join(''), /private-|synthetic/);
});

test('stopped owner waits for actual exit after ACK and never equates termination ACK with ownership release', async () => {
  const owner = new Owner(), logs: string[] = [];
  let settled = false;
  const result = recordStoppedRecoveryOwned(request(), new PerformanceDiagnostics(line => logs.push(line)), () => owner.asWorker());
  void result.then(() => { settled = true; });
  owner.emit('message', { kind: 'stopped-recovery', ok: true });
  await delay(1);
  assert.equal(settled, false);
  owner.emit('exit', 0); await result;
  assert.equal(owner.terminations, 0);
  assert.equal(JSON.parse(logs[0]!).settled, 1);
  assert.equal(JSON.parse(logs[0]!).step, 4);
});

for (const message of [null, [], { kind: 'stopped-recovery', ok: true, file: 'private-secret' },
  { kind: 'stopped-recovery', ok: false }, { kind: 'other', ok: true }, { kind: 'stopped-recovery', ok: 'true' }]) {
  test(`stopped owner malformed ACK is unknown, never replayed (${JSON.stringify(message)})`, async () => {
    const owner = new Owner(), logs: string[] = [];
    let launches = 0, settled = false;
    const result = recordStoppedRecoveryOwned(request(), new PerformanceDiagnostics(line => logs.push(line)),
      () => { launches++; return owner.asWorker(); });
    const rejection = assert.rejects(result, StoppedRecoveryOwnerUnavailable).then(() => { settled = true; });
    owner.emit('message', message);
    await delay(1);
    assert.equal(settled, false); assert.equal(owner.terminations, 1);
    assert.equal(JSON.parse(logs[0]!).unknown, 1);
    owner.emit('exit', 1); await rejection;
    assert.equal(launches, 1);
    assert.doesNotMatch(logs.join('\n'), /private-secret|synthetic|\.sqlite|fence|backup/);
  });
}

test('stopped owner absolute deadline logs before exit, then rejects despite a late success ACK', async () => {
  const owner = new Owner(), logs: string[] = [];
  const input = { ...request(), deadline: Date.now() + 25 };
  const result = recordStoppedRecoveryOwned(input, new PerformanceDiagnostics(line => logs.push(line)), () => owner.asWorker());
  const rejection = assert.rejects(result, StoppedRecoveryOwnerUnavailable);
  await delay(40);
  assert.equal(owner.terminations, 1);
  assert.equal(JSON.parse(logs[0]!).timedOut, 1);
  owner.emit('message', { kind: 'stopped-recovery', ok: true });
  owner.emit('exit', 0); await rejection;
  const events = logs.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.phase, event.step]), [['pending', 3], ['finished', 4]]);
  assert.equal(events[0].sequence, events[1].sequence);
  assert.equal(events[1].timedOut, 1);
  assert.equal(events[1].unknown, 1);
  assert.equal(events[1].ownerFailureCode, 6);
});

test('admission and launch refusal have bounded diagnostics without leaking request evidence', async () => {
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  for (const input of [{ ...request(), runs: [] }, { ...request(), deadline: NaN }, { ...request(), deadline: Date.now() - 1 }]) {
    await assert.rejects(recordStoppedRecoveryOwned(input, diagnostics, () => { throw Error('must-not-launch'); }), StoppedRecoveryOwnerUnavailable);
  }
  await assert.rejects(recordStoppedRecoveryOwned(request(), diagnostics, () => { throw Error('private-launch'); }), StoppedRecoveryOwnerUnavailable);
  assert.deepEqual(logs.map(line => { const event = JSON.parse(line); return [event.phase, event.step, event.ownerFailureCode]; }),
    [['finished', 1, 1], ['finished', 1, 1], ['finished', 1, 2], ['finished', 2, 3]]);
  assert.doesNotMatch(logs.join('\n'), /private-|synthetic|\.sqlite|fence|backup/);
});

test('ordinary polling saturation cannot hide stopped owner actual exit', async () => {
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line), () => 1);
  for (let index = 0; index < 70; index++) diagnostics.start('system-read-wait').finish(true);
  const owner = new Owner();
  const result = recordStoppedRecoveryOwned(request(), diagnostics, () => owner.asWorker());
  const rejected = assert.rejects(result, StoppedRecoveryOwnerUnavailable);
  owner.emit('error', Error('private-worker')); owner.emit('exit', 1); await rejected;
  const events = logs.map(line => JSON.parse(line)).filter(event => event.operation === 'codex-stopped-recovery-owner');
  assert.deepEqual(events.map(event => [event.phase, event.step]), [['pending', 3], ['finished', 4]]);
  assert.equal(diagnostics.snapshot().events.at(-1)?.step, 4);
});

test('stopped owner lost ACK, duplicate ACK and exit failure all stay unknown with a throwing logger', async () => {
  for (const kind of ['lost', 'duplicate', 'exit', 'error']) {
    const owner = new Owner();
    const result = recordStoppedRecoveryOwned(request(), new PerformanceDiagnostics(() => { throw Error('private-sink'); }), () => owner.asWorker());
    const rejection = assert.rejects(result, StoppedRecoveryOwnerUnavailable);
    if (kind !== 'lost') owner.emit('message', { kind: 'stopped-recovery', ok: true });
    if (kind === 'duplicate') owner.emit('message', { kind: 'stopped-recovery', ok: true });
    if (kind === 'error') owner.emit('error', Error('private-worker'));
    owner.emit('exit', kind === 'exit' ? 1 : 0); await rejection;
  }
});

test('stopped owner cannot launch for expired input and launch errors are sanitized', async () => {
  let launches = 0;
  await assert.rejects(recordStoppedRecoveryOwned({ ...request(), deadline: Date.now() - 1 }, undefined,
    () => { launches++; return new Owner().asWorker(); }), StoppedRecoveryOwnerUnavailable);
  assert.equal(launches, 0);
  await assert.rejects(recordStoppedRecoveryOwned(request(), undefined, () => { throw Error('private-launch'); }), StoppedRecoveryOwnerUnavailable);
});

test('caller mutations cannot revoke the admitted deadline or replace proof while awaiting exit', async () => {
  const owner = new Owner(), input = request();
  const result = recordStoppedRecoveryOwned(input, undefined, () => owner.asWorker());
  input.deadline = Date.now() - 1;
  input.proof.nodeId = 'replacement';
  owner.emit('message', { kind: 'stopped-recovery', ok: true });
  owner.emit('exit', 0); await result;
});

test('real stopped worker owns durable write and refuses replaced inode and nonprivate database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-stopped-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'connector.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE connector_identity(singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES(1, 'node');
    CREATE TABLE connector_codex_executions(session_key TEXT, fact TEXT);`);
  initializeStoppedCodexRecovery(db);
  db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run(run.sessionKey,
    JSON.stringify({ ...run, phase: 'interrupted', sync: 'error', updatedAt: Date.now() - 100 }));
  db.close(); chmodSync(file, 0o600);
  const stat = statSync(file), input = { ...request(), file, dev: stat.dev, ino: stat.ino };
  await assert.rejects(recordStoppedRecoveryOwned({ ...input, ino: input.ino + 1 }), StoppedRecoveryOwnerUnavailable);
  chmodSync(file, 0o644);
  await assert.rejects(recordStoppedRecoveryOwned(input), StoppedRecoveryOwnerUnavailable);
  chmodSync(file, 0o600);
  await recordStoppedRecoveryOwned(input);
  const read = new DatabaseSync(file, { readOnly: true });
  try {
    const proof = JSON.parse(read.prepare('SELECT record FROM connector_codex_stopped_recovery').get()!.record as string);
    assert.deepEqual(proof.run, run); assert.deepEqual(proof.proof, input.proof);
  } finally { read.close(); }
});
