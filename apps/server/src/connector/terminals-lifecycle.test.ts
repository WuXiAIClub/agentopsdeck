import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { TerminalSessions, type TerminalPty, type TerminalTarget } from './terminals.js';

const target: TerminalTarget = { id: 'synthetic', label: 'Synthetic', tokenIds: [], kind: 'local', cwd: '/synthetic', home: '/synthetic', path: '/synthetic', executable: '/synthetic/shell', args: [] };
class SyntheticPty implements TerminalPty {
  kills = 0;
  exitListeners = new Set<(event: { exitCode: number }) => void>();
  dataListeners = new Set<(text: string) => void>();
  constructor(private failure = false, private synchronous = false) {}
  write() {}
  resize() {}
  kill() { this.kills++; if (this.synchronous) this.exit(); if (this.failure) throw Error('synthetic kill failure'); }
  onData(listener: (text: string) => void) { this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } }; }
  exit() { for (const listener of [...this.exitListeners]) listener({ exitCode: 0 }); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const failure of [false, true]) test(`unconfirmed kill (${failure ? 'throws' : 'returns'}) retains quota and observers until exit`, async () => {
  const processes: SyntheticPty[] = [];
  const sessions = new TerminalSessions(async () => { const process = new SyntheticPty(failure); processes.push(process); return process; });
  try {
    const first = await sessions.start('owner', target, randomUUID(), 80, 24);
    await sessions.start('owner', target, randomUUID(), 80, 24);
    assert.throws(() => sessions.stop('owner', first.id), { status: 503 });
    assert.equal(processes[0]!.exitListeners.size, 1);
    assert.equal(processes[0]!.dataListeners.size, 1);
    assert.throws(() => sessions.write('owner', first.id, 1, 'x'), { status: 409 });
    assert.throws(() => sessions.resize('owner', first.id, 80, 24), { status: 409 });
    const read = await sessions.read('owner', first.id, 0, new AbortController().signal, 0);
    assert.equal(read.running, true); assert.equal(read.reason, 'cleanup_unconfirmed');
    await assert.rejects(sessions.start('owner', target, randomUUID(), 80, 24), { status: 429 });
    assert.equal(processes.length, 2);
    processes[0]!.exit();
    assert.equal(processes[0]!.exitListeners.size, 0);
    assert.equal((await sessions.read('owner', first.id, 0, new AbortController().signal, 0)).running, false);
    await sessions.start('owner', target, randomUUID(), 80, 24);
    let closed = false;
    const closing = sessions.close().then(() => { closed = true; });
    await turn(); assert.equal(closed, false);
    for (const process of processes) process.exit();
    await closing; assert.equal(closed, true);
  } finally { const closing = sessions.close(); for (const process of processes) process.exit(); await closing; }
});

test('synchronous exit proves stop even if kill subsequently throws', async () => {
  const process = new SyntheticPty(true, true), sessions = new TerminalSessions(async () => process);
  try {
    const { id } = await sessions.start('owner', target, randomUUID(), 80, 24);
    sessions.stop('owner', id);
    const read = await sessions.read('owner', id, 0, new AbortController().signal, 0);
    assert.equal(read.running, false); assert.equal(read.reason, 'stopped');
  } finally { await sessions.close(); }
});

test('shutdown retains a pending spawn and drains only after the late process exits', async () => {
  let spawn!: (process: TerminalPty) => void, spawning!: () => void;
  const started = new Promise<void>(resolve => { spawning = resolve; });
  const process = new SyntheticPty(), sessions = new TerminalSessions(() => { spawning(); return new Promise(resolve => { spawn = resolve; }); });
  const starting = sessions.start('owner', target, randomUUID(), 80, 24);
  const rejected = assert.rejects(starting, { status: 403 });
  await started;
  let closed = false;
  const closing = sessions.close().then(() => { closed = true; });
  spawn(process); await rejected; await turn();
  assert.equal(closed, false); assert.ok(process.kills > 0); assert.equal(process.exitListeners.size, 1);
  process.exit(); await closing;
});
