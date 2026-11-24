import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverStoppedHomeLease } from './lib/stopped-home-recovery.mjs';

async function fixture(t, runtime = 'claude-code') {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-stopped-home-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, 'home'), storeFile = join(root, 'connector.sqlite');
  await mkdir(home, { mode: 0o700 }); await writeFile(storeFile, '', { mode: 0o600 });
  const pid = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 }).pid;
  assert.ok(pid > 1);
  const proof = { jobId: randomUUID(), nodeId: 'node_' + randomUUID(), ownerPid: pid,
    backupId: randomUUID(), serviceInvocation: randomUUID().replaceAll('-', ''), verifiedAt: Date.now() };
  const stem = runtime === 'ghcp' ? 'copilot' : 'claude';
  const ownerFile = join(home, '.agentopsdeck-' + stem + '-owner'), bindingFile = join(home, '.agentopsdeck-' + stem + '-binding');
  const owner = JSON.stringify({ format: 1, token: randomUUID(), pid, nodeId: proof.nodeId });
  const binding = JSON.stringify({ format: 1, nodeId: proof.nodeId, storeFile });
  await writeFile(ownerFile, owner, { mode: 0o600 }); await writeFile(bindingFile, binding, { mode: 0o600 });
  const sha = value => createHash('sha256').update(value).digest('hex');
  const request = { runtime, home, storeFile, proof, expected: { ownerSha256: sha(owner), bindingSha256: sha(binding) } };
  const calls = [];
  const gates = Object.fromEntries(['verifyStopped', 'verifyWriters', 'verifyBackup'].map(name => [name, async () => { calls.push(name); }]));
  return { root, request, gates, calls, ownerFile, bindingFile, owner, binding };
}

for (const runtime of ['claude-code', 'ghcp']) {
  test(runtime + ' stopped recovery preserves the exact marker and binding with a durable one-shot audit', async t => {
    const f = await fixture(t, runtime), result = await recoverStoppedHomeLease(f.request, f.gates);
    await assert.rejects(lstat(f.ownerFile), { code: 'ENOENT' });
    assert.equal(await readFile(join(result.directory, 'original-owner'), 'utf8'), f.owner);
    assert.equal(await readFile(f.bindingFile, 'utf8'), f.binding);
    assert.equal((await lstat(join(result.directory, 'original-owner'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(result.directory, 'completed.json'))).nativeCalls, 0);
    assert.equal(result.nativeCalls, 0); assert.equal(f.calls.length, 9);
    await writeFile(f.ownerFile, f.owner, { mode: 0o600 });
    await assert.rejects(recoverStoppedHomeLease(f.request, f.gates), { code: 'EEXIST' });
    assert.equal(await readFile(f.ownerFile, 'utf8'), f.owner);
  });
}

for (const name of ['verifyStopped', 'verifyWriters', 'verifyBackup']) {
  test(name + ' rejection retains the original fence', async t => {
    const f = await fixture(t); f.gates[name] = async () => { throw Error('unverified'); };
    await assert.rejects(recoverStoppedHomeLease(f.request, f.gates), /unverified/);
    assert.equal(await readFile(f.ownerFile, 'utf8'), f.owner);
  });
}

test('a live original PID or expired stop proof never authorizes recovery', async t => {
  const f = await fixture(t);
  f.request.proof.ownerPid = process.pid;
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  f.request.proof.verifiedAt = Date.now() - 120_001;
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  assert.equal(await readFile(f.ownerFile, 'utf8'), f.owner);
});

test('foreign binding, altered expected bytes and insecure ownership fail closed', async t => {
  const f = await fixture(t);
  f.request.expected.ownerSha256 = '0'.repeat(64);
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  f.request.expected.ownerSha256 = createHash('sha256').update(f.owner).digest('hex');
  await chmod(f.ownerFile, 0o644);
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  await chmod(f.ownerFile, 0o600); f.request.proof.nodeId = 'node_' + randomUUID();
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  assert.equal(await readFile(f.ownerFile, 'utf8'), f.owner);
});

test('mutation between proof and rename retains the original owner', async t => {
  const f = await fixture(t); let checks = 0;
  f.gates.verifyBackup = async () => { if (++checks === 2) await writeFile(f.bindingFile, 'changed'); };
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  assert.equal(await readFile(f.ownerFile, 'utf8'), f.owner);
});

test('lost final proof preserves the original marker audit without claiming completion or retrying', async t => {
  const f = await fixture(t); let checks = 0;
  f.gates.verifyBackup = async () => { if (++checks === 3) throw Error('final-proof-lost'); };
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates), /final-proof-lost/);
  const directory = join(f.request.home, '.agentopsdeck-offline-recovery-' + f.request.proof.jobId);
  assert.equal(await readFile(join(directory, 'original-owner'), 'utf8'), f.owner);
  assert.equal(await readFile(f.bindingFile, 'utf8'), f.binding);
  await assert.rejects(lstat(join(directory, 'completed.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(f.ownerFile), { code: 'ENOENT' });
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  assert.equal(checks, 4);
});

test('foreign-runtime and symlink markers are not adopted', async t => {
  const f = await fixture(t);
  const foreign = join(f.request.home, '.agentopsdeck-copilot-owner');
  await symlink(f.ownerFile, foreign);
  await assert.rejects(recoverStoppedHomeLease(f.request, f.gates));
  assert.equal(await readFile(f.ownerFile, 'utf8'), f.owner);
});
