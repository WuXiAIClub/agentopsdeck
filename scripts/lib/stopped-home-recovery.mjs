import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const names = { 'claude-code': 'claude', ghcp: 'copilot' };
const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink, stat.uid];

async function privatePath(file, directory = false) {
  assert.ok(isAbsolute(file) && resolve(file) === file && await realpath(file) === file);
  const stat = await lstat(file);
  assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid());
  assert.equal(stat.mode & 0o777, directory ? 0o700 : 0o600);
  assert.ok(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
  return stat;
}

async function snapshot(file) {
  const before = await privatePath(file);
  assert.ok(before.size > 0 && before.size <= 8192);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(identity(await handle.stat()), identity(before));
    const bytes = await handle.readFile();
    assert.equal(bytes.length, before.size);
    assert.deepEqual(identity(await handle.stat()), identity(before));
    assert.deepEqual(identity(await privatePath(file)), identity(before));
    return { bytes, sha256: digest(bytes), identity: identity(before) };
  } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exclusiveJSON(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(dirname(file));
}

export async function recoverStoppedHomeLease(request, gates) {
  assert.equal(process.platform, 'linux');
  const { runtime, home, storeFile, expected, proof } = request;
  assert.ok(Object.hasOwn(names, runtime) && uuid.test(proof.jobId));
  assert.ok(/^node_[a-f0-9-]{36}$/i.test(proof.nodeId));
  assert.ok(Number.isSafeInteger(proof.ownerPid) && proof.ownerPid > 1);
  assert.ok(typeof proof.backupId === 'string' && proof.backupId.length > 0 && proof.backupId.length <= 256);
  assert.ok(typeof proof.serviceInvocation === 'string' && /^[a-f0-9]{32}$/.test(proof.serviceInvocation));
  assert.ok(/^[a-f0-9]{64}$/.test(expected.ownerSha256) && /^[a-f0-9]{64}$/.test(expected.bindingSha256));
  for (const gate of ['verifyStopped', 'verifyWriters', 'verifyBackup']) assert.equal(typeof gates[gate], 'function');
  const verify = async () => {
    assert.ok(Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt <= Date.now() && Date.now() - proof.verifiedAt < 120_000);
    await gates.verifyStopped(); await gates.verifyWriters(); await gates.verifyBackup();
    assert.throws(() => process.kill(proof.ownerPid, 0), error => error.code === 'ESRCH');
  };
  await verify();
  const homeIdentity = identity(await privatePath(home, true));
  const storeIdentity = identity(await privatePath(storeFile));
  assert.ok(!storeFile.startsWith(home + '/') && !home.startsWith(storeFile + '/'));
  const stem = '.agentopsdeck-' + names[runtime];
  const ownerFile = join(home, stem + '-owner'), bindingFile = join(home, stem + '-binding');
  const owner = await snapshot(ownerFile), binding = await snapshot(bindingFile);
  assert.equal(owner.sha256, expected.ownerSha256); assert.equal(binding.sha256, expected.bindingSha256);
  const marker = JSON.parse(owner.bytes);
  assert.deepEqual(Object.keys(marker).sort(), ['format', 'nodeId', 'pid', 'token']);
  assert.equal(marker.format, 1); assert.equal(marker.nodeId, proof.nodeId);
  assert.equal(marker.pid, proof.ownerPid); assert.ok(uuid.test(marker.token));
  assert.deepEqual(JSON.parse(binding.bytes), { format: 1, nodeId: proof.nodeId, storeFile });
  for (const other of Object.values(names).filter(name => name !== names[runtime])) {
    for (const suffix of ['owner', 'binding']) {
      await assert.rejects(lstat(join(home, '.agentopsdeck-' + other + '-' + suffix)), error => error.code === 'ENOENT');
    }
  }
  const directory = join(home, '.agentopsdeck-offline-recovery-' + proof.jobId);
  await mkdir(directory, { mode: 0o700 }); await syncDirectory(home);
  const receipt = { format: 1, runtime, home, storeFile, proof, expected, ownerIdentity: owner.identity,
    bindingIdentity: binding.identity, action: 'preserve-stopped-owner-marker-without-native-replay' };
  await exclusiveJSON(join(directory, 'intent.json'), receipt);
  await verify();
  const currentHome = await privatePath(home, true);
  assert.deepEqual([currentHome.dev, currentHome.ino, currentHome.mode, currentHome.uid],
    [homeIdentity[0], homeIdentity[1], homeIdentity[5], homeIdentity[7]]);
  assert.deepEqual(identity(await privatePath(storeFile)), storeIdentity);
  assert.deepEqual(await snapshot(ownerFile), owner); assert.deepEqual(await snapshot(bindingFile), binding);
  await privatePath(directory, true);
  await rename(ownerFile, join(directory, 'original-owner'));
  await syncDirectory(directory); await syncDirectory(home);
  const preserved = await snapshot(join(directory, 'original-owner'));
  assert.equal(preserved.sha256, owner.sha256);
  assert.deepEqual(await snapshot(bindingFile), binding);
  await verify();
  await exclusiveJSON(join(directory, 'completed.json'), { ...receipt, completedAt: Date.now(), nativeCalls: 0 });
  return { directory, ownerSha256: owner.sha256, bindingSha256: binding.sha256, nativeCalls: 0 };
}
