import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, stat, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileResponse, verifiedFileResponse } from './file-response.js';

test('verified file response rejects replaced inodes and symlinks and holds the opened inode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verified-file-'));
  try {
    const filePath = join(dir, 'file'), old = join(dir, 'old');
    await writeFile(filePath, 'original');
    const info = await stat(filePath);
    const base = { filePath, info, size: info.size, name: 'file', mimeType: 'text/plain', request: new Request('http://test') };
    const held = await verifiedFileResponse(base);
    await rename(filePath, old); await writeFile(filePath, 'replaced');
    assert.equal(await held.text(), 'original');
    await assert.rejects(verifiedFileResponse(base), /changed before opening/);
    await rm(filePath); await symlink(old, filePath);
    await assert.rejects(verifiedFileResponse(base), /ELOOP/);
    const current = { ...base, filePath: old, info: await stat(old) };
    for (const request of [new Request('http://test', { method: 'HEAD' }), new Request('http://test', { headers: { range: 'bytes=99-' } })]) {
      const response = await verifiedFileResponse({ ...current, request });
      assert.equal(response.body, null);
    }
    let calls = 0;
    await assert.rejects(verifiedFileResponse({ ...current, authorize() { if (++calls > 1) throw new Error('revoked while opening'); } }), /revoked while opening/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('file byte transport supports full, bounded, open, suffix and clamped ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-response-'));
  const filePath = join(dir, 'test');
  try {
    await writeFile(filePath, '0123456789EXTRA');
    for (const [range, expected, contentRange] of [
      [undefined, '0123456789', null], ['bytes=2-4', '234', 'bytes 2-4/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10'],
    ] as const) {
      const response = fileResponse({ filePath, size: 10, name: 'test', mimeType: 'text/plain', request: new Request('http://test', { headers: range ? { range } : {} }) });
      assert.equal(response.status, range ? 206 : 200);
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(response.headers.get('content-length'), String(expected.length));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), expected);
    }
    const response = fileResponse({ filePath, size: 10, name: 'test', mimeType: 'text/plain', request: new Request('http://test', { headers: { range: 'bytes=2-4', 'if-range': 'old' } }) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid ranges and HEAD never open a file; empty and unicode responses are safe', async () => {
  const base = { filePath: '/does-not-exist/test', size: 10, name: '报告"\r\n.zip', mimeType: 'application/zip' };
  for (const range of ['bytes=', 'bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=4-2', 'bytes=1-2,4-5', 'other=0-1', 'bytes=9007199254740992-', 'bytes=0-9007199254740992']) {
    const response = fileResponse({ ...base, request: new Request('http://test', { headers: { range } }) });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
  const head = fileResponse({ ...base, request: new Request('http://test', { method: 'HEAD', headers: { range: 'bytes=2-4' } }) });
  assert.equal(head.status, 206);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), '3');
  assert.match(head.headers.get('content-disposition')!, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A.zip/);
  const empty = fileResponse({ ...base, size: 0, request: new Request('http://test') });
  assert.equal(await empty.text(), '');
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(fileResponse({ ...base, size: 0, request: new Request('http://test', { headers: { range: 'bytes=0-' } }) }).status, 416);
});

test('file streams reject truncation and authorization changes and propagate abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-response-'));
  try {
    const filePath = join(dir, 'test');
    await writeFile(filePath, 'short');
    const base = { filePath, size: 10, name: 'test', mimeType: 'text/plain' };
    await assert.rejects(fileResponse({ ...base, request: new Request('http://test') }).text(), /declared length/);
    let allowed = true;
    const response = fileResponse({ ...base, request: new Request('http://test'), authorize() { if (!allowed) throw new Error('revoked'); } });
    allowed = false;
    await assert.rejects(response.text(), /revoked/);
    const controller = new AbortController();
    const aborted = fileResponse({ ...base, request: new Request('http://test', { signal: controller.signal }) });
    controller.abort(new Error('stopped'));
    await assert.rejects(aborted.text(), /stopped/);
    assert.throws(() => fileResponse({ ...base, request: new Request('http://test', { signal: controller.signal }) }), /stopped/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
