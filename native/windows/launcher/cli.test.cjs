'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { arguments_, verify, scheduleUninstall } = require('./cli.cjs');

test('CLI validates commands and explicit destructive confirmation without shell arguments', () => {
  for (const command of ['help', 'version', 'status', 'doctor', 'verify', 'paths', 'logs', 'start', 'stop', 'restart']) {
    assert.equal(arguments_([command, '--json']).command, command);
    assert.throws(() => arguments_([command, '--yes']));
  }
  assert.throws(() => arguments_(['uninstall']));
  assert.equal(arguments_(['uninstall', '--yes', '--json']).command, 'uninstall');
  for (const args of [['unknown'], ['start', '&calc'], ['status', '--json', '--json'], ['verify', '--force']]) {
    assert.throws(() => arguments_(args));
  }
});

test('CLI verifies exact payload bytes and refuses changed, missing and escaped entries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentopsdeck-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = Buffer.from('original');
  await fs.writeFile(path.join(root, 'file.txt'), content);
  const manifest = { format: 1, sourceRevision: 'b'.repeat(40),
    files: [{ path: 'file.txt', bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }] };
  const write = () => fs.writeFile(path.join(root, 'windows-payload-manifest.json'), JSON.stringify(manifest));
  await write();
  assert.equal((await verify(root)).filesVerified, 2);
  assert.equal((await verify(root)).vendorSignatureVerified, false);
  await fs.writeFile(path.join(root, 'file.txt'), 'changed');
  await assert.rejects(verify(root), /mismatch/);
  await fs.writeFile(path.join(root, 'file.txt'), content);
  manifest.files.push({ ...manifest.files[0], path: 'FILE.txt' }); await write();
  await assert.rejects(verify(root), /alias/);
  manifest.files.pop();
  for (const name of ['../file.txt', '/file.txt', 'x\\file.txt', 'C:/file.txt', 'x//file.txt']) {
    manifest.files[0].path = name; await write();
    await assert.rejects(verify(root), /Unsafe/);
  }
});

test('native uninstall scheduling refuses missing process identities before copying or launching', async () => {
  for (const parents of [[], [123], [0, 1], [1, -1], [1, 2, 3]]) {
    await assert.rejects(scheduleUninstall({ root: path.resolve('unused'), logs: path.resolve('unused'), parents }),
      /Exact CLI process identities required/);
  }
});
