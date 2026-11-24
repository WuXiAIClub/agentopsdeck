import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeRawMediaDirectives, MediaBridgeCache } from './media-bridge.js';
import { openBoundedMediaFile, openPrivateMediaDirectory } from './private-media-file.js';

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'aod-pinned-media-'));
  const allowed = join(root, 'allowed'), inboundDir = join(root, 'inbound'), outside = join(root, 'outside');
  for (const directory of [allowed, inboundDir, outside]) await fs.mkdir(directory, { mode: 0o700 });
  const filePath = join(allowed, 'fixture.txt');
  await fs.writeFile(filePath, 'hi'); await fs.writeFile(join(outside, 'fixture.txt'), 'outside-synthetic');
  const config = { enabled: true, allowedDirs: [allowed], maxBytes: 4, inboundDir };
  return { root, allowed, inboundDir, outside, filePath, config,
    bridge: (cache?: MediaBridgeCache) => bridgeRawMediaDirectives({ MediaPath: filePath }, 'assistant', config, cache),
    close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('after-authorization symlink, regular-file and parent replacement cannot publish outside bytes', async context => {
  for (const replacement of ['symlink', 'regular-file', 'parent-symlink', 'parent-same-inode']) {
    const current = await fixture();
    const original = fs.lstat; let replaced = false;
    context.mock.method(fs, 'lstat', async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
      const info = await original(target, options);
      if (target === current.filePath && !replaced) {
        replaced = true;
        if (replacement.startsWith('parent')) {
          const moved = join(current.root, 'moved'); await fs.rename(current.allowed, moved);
          if (replacement === 'parent-symlink') await fs.symlink(current.outside, current.allowed);
          else {
            await fs.mkdir(current.allowed, { mode: 0o700 });
            await fs.rename(join(moved, 'fixture.txt'), current.filePath);
          }
        } else {
          await fs.rename(current.filePath, join(current.allowed, 'original.txt'));
          if (replacement === 'symlink') await fs.symlink(join(current.outside, 'fixture.txt'), current.filePath);
          else await fs.copyFile(join(current.outside, 'fixture.txt'), current.filePath);
        }
      }
      return info;
    });
    syncBuiltinESMExports();
    try {
      const result = await current.bridge();
      assert.equal(replaced, true, replacement);
      assert.equal(result.media.length, 0, replacement);
      assert.equal(result.bridgedReferences.size, 0, replacement);
      assert.deepEqual(await fs.readdir(current.inboundDir), [], replacement);
    } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await current.close(); }
  }
});

test('descriptor read pins original inode and rejects file or parent replacement after opening', async () => {
  for (const replaceParent of [false, true]) {
    const current = await fixture();
    const source = await openBoundedMediaFile(current.filePath, [current.allowed], 4);
    try {
      if (replaceParent) {
        await fs.rename(current.allowed, join(current.root, 'moved'));
        await fs.symlink(current.outside, current.allowed);
      } else {
        await fs.rename(current.filePath, join(current.allowed, 'original.txt'));
        await fs.symlink(join(current.outside, 'fixture.txt'), current.filePath);
      }
      await assert.rejects(source.read(), /changed/);
    } finally { await source.close(); await current.close(); }
  }
});

test('growth during descriptor read uses at most the cap plus one sentinel byte and publishes nothing', async context => {
  const current = await fixture();
  const original = fs.open; let requestedBytes = 0, grew = false;
  context.mock.method(fs, 'open', async (target: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    const handle = await original(target, flags, mode);
    if (target === current.filePath) {
      const read = handle.read.bind(handle);
      context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (!grew) { grew = true; await fs.appendFile(current.filePath, Buffer.alloc(64)); }
        requestedBytes += length;
        return read(buffer, offset, length, position);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = await current.bridge();
    assert.equal(grew, true); assert.equal(requestedBytes, 5);
    assert.equal(result.media.length, 0); assert.deepEqual(await fs.readdir(current.inboundDir), []);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await current.close(); }
});

test('bounded descriptor reads handle short reads, exact caps and smaller configured caps', async context => {
  const current = await fixture();
  const original = fs.open;
  context.mock.method(fs, 'open', async (target: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    const handle = await original(target, flags, mode);
    if (target === current.filePath) {
      const read = handle.read.bind(handle);
      context.mock.method(handle, 'read', (buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 1), position));
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const source = await openBoundedMediaFile(current.filePath, [current.allowed], 2);
    try { assert.deepEqual(await source.read(), Buffer.from('hi')); } finally { await source.close(); }
    await assert.rejects(openBoundedMediaFile(current.filePath, [current.allowed], 1), /Invalid media file/);
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) {
      await assert.rejects(openBoundedMediaFile(current.filePath, [current.allowed], maxBytes), /Invalid media read/);
    }
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await current.close(); }
});

test('bridge rejects pre-existing symbolic links and multiply linked source files', async () => {
  const current = await fixture();
  try {
    await fs.link(current.filePath, join(current.allowed, 'hardlink.txt'));
    assert.equal((await current.bridge()).media.length, 0);
    await fs.unlink(join(current.allowed, 'hardlink.txt'));
    await fs.unlink(current.filePath); await fs.symlink(join(current.outside, 'fixture.txt'), current.filePath);
    assert.equal((await current.bridge()).media.length, 0);
    assert.deepEqual(await fs.readdir(current.inboundDir), []);
  } finally { await current.close(); }
});

test('exclusive private writes reject existing files, symlinks and hardlinks without overwriting', async () => {
  const current = await fixture();
  const directory = await openPrivateMediaDirectory(current.inboundDir);
  try {
    const existing = join(current.inboundDir, 'existing.txt'); await fs.writeFile(existing, 'original', { mode: 0o600 });
    await fs.symlink(existing, join(current.inboundDir, 'symlink.txt'));
    await fs.link(existing, join(current.inboundDir, 'hardlink.txt'));
    for (const filename of ['existing.txt', 'symlink.txt', 'hardlink.txt']) {
      await assert.rejects(directory.write(filename, Buffer.from('replacement')), { code: 'EEXIST' });
    }
    assert.equal(await fs.readFile(existing, 'utf8'), 'original');
    await fs.rename(current.inboundDir, join(current.root, 'moved-inbound'));
    await fs.symlink(current.outside, current.inboundDir);
    await assert.rejects(directory.write('new.txt', Buffer.from('hi')), /parent directory changed/);
    assert.deepEqual(await fs.readdir(current.outside), ['fixture.txt']);
  } finally { await directory.close(); await current.close(); }
});

test('private root and source ownership mismatches fail closed', async context => {
  const current = await fixture();
  const differentUid = process.getuid!() + 1;
  context.mock.method(process as { getuid: () => number }, 'getuid', () => differentUid);
  try {
    await assert.rejects(openPrivateMediaDirectory(current.inboundDir), /owned/);
    await assert.rejects(openBoundedMediaFile(current.filePath, [current.allowed], 4), /Invalid media file/);
    assert.deepEqual(await fs.readdir(current.inboundDir), []);
  } finally { context.mock.restoreAll(); await current.close(); }
});

test('cache bounds aggregate revisions with LRU eviction, absolute TTL and explicit lifecycle clear', async () => {
  const current = await fixture(); let now = 0;
  const cache = new MediaBridgeCache(2, 10, () => now);
  const urls: string[] = [];
  try {
    for (const index of [0, 1, 2]) {
      const filePath = join(current.allowed, `revision-${index}.txt`); await fs.writeFile(filePath, 'hi');
      const result = await bridgeRawMediaDirectives({ MediaPath: filePath }, 'assistant', current.config, cache);
      urls.push(result.media[0]!.url); assert.ok(cache.size <= 2);
    }
    assert.equal(cache.size, 2);
    const result = await bridgeRawMediaDirectives({ MediaPath: join(current.allowed, 'revision-0.txt') }, 'assistant', current.config, cache);
    assert.notEqual(result.media[0]!.url, urls[0]); assert.equal(cache.size, 2);
    now = 10; assert.equal(cache.size, 0);
    await current.bridge(cache); assert.equal(cache.size, 1);
    cache.clear(); assert.equal(cache.size, 0);
  } finally { await current.close(); }
});

test('cache validates retired artifacts and isolates destination roots and same-size source replacements', async () => {
  const current = await fixture(), cache = new MediaBridgeCache();
  const publishedPath = (url: string) => join(current.inboundDir, decodeURIComponent(url.split('/').at(-1)!));
  try {
    const first = (await current.bridge(cache)).media[0]!;
    assert.equal((await current.bridge(cache)).media[0]!.url, first.url);
    await fs.unlink(publishedPath(first.url));
    const second = (await current.bridge(cache)).media[0]!;
    assert.notEqual(second.url, first.url); assert.equal(cache.size, 1);
    await fs.writeFile(publishedPath(second.url), 'xx');
    const third = (await current.bridge(cache)).media[0]!;
    assert.notEqual(third.url, second.url);
    const previous = await fs.stat(current.filePath);
    await fs.unlink(current.filePath); await fs.writeFile(current.filePath, 'ok');
    await fs.utimes(current.filePath, previous.atime, previous.mtime);
    const replaced = (await current.bridge(cache)).media[0]!;
    assert.notEqual(replaced.url, third.url); assert.equal(await fs.readFile(publishedPath(replaced.url), 'utf8'), 'ok');
    const otherRoot = join(current.root, 'other-inbound');
    const other = await bridgeRawMediaDirectives({ MediaPath: current.filePath }, 'assistant', { ...current.config, inboundDir: otherRoot }, cache);
    assert.notEqual(other.media[0]!.url, replaced.url); assert.equal((await fs.readdir(otherRoot)).length, 1);
  } finally { await current.close(); }
});

test('a cached artifact changed during verification is evicted and republished from the authorized source', async context => {
  const current = await fixture(), cache = new MediaBridgeCache();
  try {
    const first = (await current.bridge(cache)).media[0]!;
    const cachedPath = join(current.inboundDir, decodeURIComponent(first.url.split('/').at(-1)!));
    const original = fs.lstat;
    let artifactChecks = 0;
    context.mock.method(fs, 'lstat', async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
      const info = await original(target, options);
      if (target === cachedPath && ++artifactChecks === 3) await fs.writeFile(cachedPath, 'xx');
      return info;
    });
    syncBuiltinESMExports();
    const second = (await current.bridge(cache)).media[0]!;
    assert.equal(artifactChecks, 3);
    assert.notEqual(second.url, first.url);
    const published = join(current.inboundDir, decodeURIComponent(second.url.split('/').at(-1)!));
    assert.deepEqual(await fs.readFile(published), await fs.readFile(current.filePath));
    assert.equal(cache.size, 1);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await current.close(); }
});

test('a replaced write parent never redirects attachment bytes through its pathname', async context => {
  const current = await fixture();
  const directory = await openPrivateMediaDirectory(current.inboundDir);
  const original = fs.open;
  let replaced = false;
  context.mock.method(fs, 'open', async (target: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    if (String(target).endsWith('/attachment.txt') && !replaced) {
      replaced = true;
      await fs.rename(current.inboundDir, join(current.root, 'moved-inbound'));
      await fs.symlink(current.outside, current.inboundDir);
    }
    return original(target, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(directory.write('attachment.txt', Buffer.from('synthetic')), /directory|changed/);
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(current.outside), ['fixture.txt']);
    assert.equal((await fs.stat(join(current.root, 'moved-inbound', 'attachment.txt'))).size, 0);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await directory.close(); await current.close(); }
});
