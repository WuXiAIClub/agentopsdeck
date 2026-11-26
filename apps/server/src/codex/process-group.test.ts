import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { linuxProcessGroupRunning, waitForLinuxProcessGroupExit } from './process-group.js';

test('absent native process group drains without requiring global proc visibility', async t => {
  t.mock.method(process, 'kill', (pid: number, signal: number) => {
    assert.equal(pid, -1234); assert.equal(signal, 0);
    throw Object.assign(new Error('Gone'), { code: 'ESRCH' });
  });
  t.mock.method(fs, 'readdir', async () => { throw Object.assign(new Error('hidden proc'), { code: 'EACCES' }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await linuxProcessGroupRunning(1234), false);
});

test('permission uncertainty cannot certify a process group as drained', async t => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('Denied'), { code: 'EPERM' }); });
  await assert.rejects(linuxProcessGroupRunning(1234), /Denied/);
  for (const id of [0, -1, NaN, 1.5]) await assert.rejects(linuxProcessGroupRunning(id), /Invalid/);
});

test('process group scans batch bounded reads and share only in-flight evidence', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, reads = 0, listings = 0, probes = 0;
  t.mock.method(process, 'kill', () => { probes++; return true; });
  t.mock.method(fs, 'readdir', async () => { listings++; return [...Array.from({ length: 40 }, (_, i) => String(i + 1)), 'self']; });
  t.mock.method(fs, 'readFile', async () => {
    reads++; active++; peak = Math.max(peak, active);
    await gate; active--;
    return '1 (synthetic name) Z 0 1234 0';
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = linuxProcessGroupRunning(1234);
  const second = linuxProcessGroupRunning(1234);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 16, 'reads begin together instead of waiting for the first stat');
  assert.equal(listings, 1);
  assert.equal(probes, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(reads, 40);
  assert.equal(peak, 16);
  assert.equal(active, 0);
  assert.equal(await linuxProcessGroupRunning(1234), false);
  assert.equal(listings, 2, 'completed evidence is never cached for a later lifetime');
  assert.equal(probes, 2);
});

for (const stat of ['broken', '1 (name) ? 0 1234', '1 (name) S 0 invalid', '1 (name) S 0 9007199254740992']) {
  test(`malformed proc status cannot prove drain: ${stat}`, async t => {
    t.mock.method(process, 'kill', () => true);
    t.mock.method(fs, 'readdir', async () => ['1']);
    t.mock.method(fs, 'readFile', async () => stat);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(linuxProcessGroupRunning(1234), /Invalid native process status/);
  });
}

test('failed batch settles its reads and a later scan can retry without cached failure', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let denied = true, active = 0;
  t.mock.method(process, 'kill', () => true);
  t.mock.method(fs, 'readdir', async () => ['1', '2']);
  t.mock.method(fs, 'readFile', async (file: string) => {
    if (file === '/proc/1/stat' && denied) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
    active++; await gate; active--;
    return '2 (name with ) embedded) Z 0 1234';
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  let settled = false;
  const rejected = assert.rejects(linuxProcessGroupRunning(1234), /synthetic denied/).then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(active, 1);
  release(); await rejected;
  assert.equal(active, 0);
  denied = false;
  assert.equal(await linuxProcessGroupRunning(1234), false);
});

test('live group member is positive evidence despite unrelated unreadable entries', async t => {
  t.mock.method(process, 'kill', () => true);
  t.mock.method(fs, 'readdir', async () => ['1', '2', '3']);
  t.mock.method(fs, 'readFile', async (file: string) => {
    if (file === '/proc/1/stat') throw Object.assign(new Error('hidden'), { code: 'EACCES' });
    if (file === '/proc/2/stat') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return '3 (synthetic name with ) parentheses) S 0 1234';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await linuxProcessGroupRunning(1234), true);
});

test('waitForLinuxProcessGroupExit escalates to SIGKILL after grace period when group ignores SIGTERM', async t => {
  let alive = true;
  const signals: Array<number | string> = [];
  t.mock.method(process, 'kill', (pid: number, signal: number | NodeJS.Signals) => {
    assert.equal(pid, -4321);
    signals.push(signal);
    if (signal === 'SIGKILL') {
      alive = false;
      return true;
    }
    if (!alive) throw Object.assign(new Error('Gone'), { code: 'ESRCH' });
    return true;
  });
  t.mock.method(fs, 'readdir', async () => ['1']);
  t.mock.method(fs, 'readFile', async () => '1 (hung-descendant) S 0 4321 0');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await waitForLinuxProcessGroupExit(4321, { sigkillAfterMs: 15, pollMs: 5 });
  assert.ok(signals.includes('SIGKILL'), 'hung process group must escalate to SIGKILL');
});
