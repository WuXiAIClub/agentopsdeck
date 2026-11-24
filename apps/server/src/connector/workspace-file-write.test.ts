import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { parseBoardFile, serializeBoardFile } from './workspace-board-file-format.js';
import { writeWorkspaceFile, retainedWorkspaceFileBytes } from './workspace-file-write.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-two-way-')), bindingId = randomUUID(), mutationId = randomUUID();
  await mkdir(join(root, bindingId), { mode: 0o700 });
  const path = join(root, bindingId, 'tasks.json'), original = serializeBoardFile({ title: 'Original', tasks: [] });
  const text = serializeBoardFile({ title: 'User edit', tasks: [] }), agent = serializeBoardFile({ title: 'Agent edit', tasks: [] });
  await writeFile(path, original, { mode: 0o600 });
  const input = { root, bindingId, mutationId, expectedHash: parseBoardFile(Buffer.from(original))!.hash, text,
    codec: { name: 'tasks.json' as const, maxBytes: BOARD_MAX_BODY_BYTES, parse: parseBoardFile }, authorized: () => {} };
  return { root, path, original, text, agent, input, captured: join(root, bindingId, `.write-${mutationId}`, 'original'),
    close: () => rm(root, { recursive: true, force: true }) };
}
test('two-way write captures original, installs exclusive candidate and cannot replay the same staging ID', async () => {
  const f = await fixture();
  try {
    assert.equal(await writeWorkspaceFile(f.input), 'saved');
    assert.equal(await readFile(f.path, 'utf8'), f.text);
    assert.equal(await readFile(f.captured, 'utf8'), f.original);
    await writeFile(f.path, f.original);
    assert.equal(await writeWorkspaceFile(f.input), 'uncertain');
    assert.equal(await readFile(f.path, 'utf8'), f.original);
  } finally { await f.close(); }
});
test('stale expected hash never touches the current file', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, f.agent);
    assert.equal(await writeWorkspaceFile(f.input), 'conflict');
    assert.equal(await readFile(f.path, 'utf8'), f.agent);
  } finally { await f.close(); }
});
test('awaited authority blocks the physical write until its original check settles', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
  try {
    const pending = writeWorkspaceFile({ ...f.input, authorized: async () => { entered(); await gate; } });
    await observed;
    assert.equal(await readFile(f.path, 'utf8'), f.original);
    release(); assert.equal(await pending, 'saved');
  } finally { release(); await f.close(); }
});
test('async authority rejection at every durable stage retains evidence and never restores or replays', async () => {
  for (const stopAt of ['initial', 'prepared', 'captured', 'installed'] as const) {
    const f = await fixture(); let allowed = stopAt !== 'initial';
    try {
      const result = await writeWorkspaceFile({ ...f.input, authorized: async () => {
        await Promise.resolve(); if (!allowed) throw Error('authority unavailable');
      }, checkpoint: async stage => { if (stage === stopAt) allowed = false; } });
      assert.equal(result, 'uncertain');
      assert.equal(await readFile(stopAt === 'captured' || stopAt === 'installed' ? f.captured : f.path, 'utf8'), f.original);
      if (stopAt === 'installed') assert.equal(await readFile(f.path, 'utf8'), f.text);
      if (stopAt === 'captured') await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    } finally { await f.close(); }
  }
});
test('Agent update between initial read and capture is restored, not overwritten', async () => {
  const f = await fixture();
  try {
    assert.equal(await writeWorkspaceFile({ ...f.input, checkpoint: async stage => {
      if (stage === 'prepared') await writeFile(f.path, f.agent);
    } }), 'conflict');
    assert.equal(await readFile(f.path, 'utf8'), f.agent);
  } finally { await f.close(); }
});
test('Agent recreating target after capture wins; user draft and original are preserved', async () => {
  const f = await fixture();
  try {
    assert.equal(await writeWorkspaceFile({ ...f.input, checkpoint: async stage => {
      if (stage === 'captured') await writeFile(f.path, f.agent, { flag: 'wx' });
    } }), 'conflict');
    assert.equal(await readFile(f.path, 'utf8'), f.agent);
    assert.equal(await readFile(f.captured, 'utf8'), f.original);
    assert.equal(await readFile(join(f.root, f.input.bindingId, `.write-${f.input.mutationId}`, 'candidate'), 'utf8'), f.text);
  } finally { await f.close(); }
});
test('an old open fd writing after replacement is retained and reported as conflict', async () => {
  const f = await fixture(), handle = await open(f.path, 'r+');
  try {
    assert.equal(await writeWorkspaceFile({ ...f.input, checkpoint: async stage => {
      if (stage === 'installed') { await handle.truncate(0); await handle.write(f.agent, 0); }
    } }), 'conflict');
    assert.equal(await readFile(f.captured, 'utf8'), f.agent);
    assert.equal(await readFile(f.path, 'utf8'), f.text);
  } finally { await handle.close(); await f.close(); }
});
test('revocation during preparation prevents mutation; revoked captured data is never deleted', async () => {
  for (const stopAt of ['prepared', 'captured'] as const) {
    const f = await fixture(); let allowed = true;
    try {
      assert.equal(await writeWorkspaceFile({ ...f.input, authorized: () => { if (!allowed) throw Error('revoked'); },
        checkpoint: async stage => { if (stage === stopAt) allowed = false; } }), 'uncertain');
      assert.equal(await readFile(stopAt === 'prepared' ? f.path : f.captured, 'utf8'), f.original);
    } finally { await f.close(); }
  }
});
test('symlinks and hardlinks are rejected without changing external data', async () => {
  for (const kind of ['symbolic', 'hard']) {
    const f = await fixture(), other = join(f.root, 'other');
    try {
      await writeFile(other, f.original); await rm(f.path);
      if (kind === 'symbolic') await symlink(other, f.path); else await link(other, f.path);
      assert.equal(await writeWorkspaceFile(f.input), 'uncertain');
      assert.equal(await readFile(other, 'utf8'), f.original);
    } finally { await f.close(); }
  }
});

test('retention accounting observes actual evidence, old fd growth and unsafe artifacts without deleting', async () => {
  const f = await fixture(), handle = await open(f.path, 'r+');
  try {
    assert.equal(await retainedWorkspaceFileBytes(f.root, f.input.bindingId, 10000), 0);
    assert.equal(await writeWorkspaceFile(f.input), 'saved');
    assert.equal(await retainedWorkspaceFileBytes(f.root, f.input.bindingId, 10000), Buffer.byteLength(f.original));
    await handle.truncate(20000);
    assert.equal(await retainedWorkspaceFileBytes(f.root, f.input.bindingId, 10000), 10001);
    await handle.truncate(Buffer.byteLength(f.original));
    const candidate = join(f.root, f.input.bindingId, `.write-${f.input.mutationId}`, 'candidate');
    await symlink(f.path, candidate);
    await assert.rejects(retainedWorkspaceFileBytes(f.root, f.input.bindingId, 10000), /Unsafe/);
    assert.equal(await readFile(f.path, 'utf8'), f.text);
    assert.equal(await readFile(f.captured, 'utf8'), f.original);
  } finally { await handle.close(); await f.close(); }
});
