import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncFileResponse, fileResponse, verifiedFileResponse } from './file-response.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const base = { filePath: '/synthetic/not-opened', size: 4, name: 'file', mimeType: 'text/plain' };

test('async preflight must settle before creating the byte stream', async () => {
  let release!: () => void, opens = 0;
  const permission = new Promise<void>(resolve => { release = resolve; });
  const pending = asyncFileResponse({ ...base, request: new Request('http://fixture'),
    authorize: () => permission, openStream() { opens++; return Readable.from([Buffer.from('data')]); } });
  await tick(); assert.equal(opens, 0);
  release(); const response = await pending;
  assert.equal(await response.text(), 'data'); assert.equal(opens, 1);
});

for (const kind of ['HEAD', 'range', 'empty'] as const) {
  test(`async ${kind} response still checks authority and never opens bytes`, async () => {
    let calls = 0, opens = 0;
    const params = { ...base, size: kind === 'empty' ? 0 : base.size,
      request: new Request('http://fixture', kind === 'HEAD' ? { method: 'HEAD' } : kind === 'range' ? { headers: { range: 'bytes=99-' } } : {}),
      async authorize() { calls++; }, openStream() { opens++; throw Error('must not open'); } };
    const response = await asyncFileResponse(params);
    assert.equal(response.status, kind === 'range' ? 416 : 200);
    assert.equal(await response.text(), ''); assert.equal(calls, 1); assert.equal(opens, 0);
    await assert.rejects(asyncFileResponse({ ...params, async authorize() { throw Error('revoked'); } }), /revoked/);
  });
}

test('legacy synchronous API fails closed for async permission and observes its late rejection', async () => {
  let reject!: (error: Error) => void, opens = 0;
  const permission = new Promise<void>((_, no) => { reject = no; });
  assert.throws(() => fileResponse({ ...base, request: new Request('http://fixture'),
    authorize: () => permission, openStream() { opens++; return Readable.from([]); } }), /requires asyncFileResponse/);
  reject(Error('late denial')); await tick(); assert.equal(opens, 0);
});

test('preflight abort does not open bytes or replay late permission work', async () => {
  const abort = new AbortController(); let release!: () => void, calls = 0, opens = 0;
  const permission = new Promise<void>(resolve => { release = resolve; });
  const rejected = assert.rejects(asyncFileResponse({ ...base, request: new Request('http://fixture', { signal: abort.signal }),
    authorize: () => { calls++; return permission; }, openStream() { opens++; return Readable.from([]); } }), /cancelled/);
  abort.abort(Error('cancelled')); await rejected;
  release(); await tick(); assert.equal(calls, 1); assert.equal(opens, 0);
});

test('never-settling file authority is bounded without cancelling or replaying original work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reject!: (error: Error) => void, calls = 0;
  const permission = new Promise<void>((_, no) => { reject = no; });
  const rejected = assert.rejects(asyncFileResponse({ ...base, request: new Request('http://fixture'),
    authorize: () => { calls++; return permission; } }), /authorization deadline/);
  t.mock.timers.tick(45_000); await rejected;
  reject(Error('late owner failure')); await tick(); assert.equal(calls, 1);
});

test('each byte delivery rechecks async authority after reading, denying prefetched bytes', async () => {
  let calls = 0, destroyed = 0;
  const response = await asyncFileResponse({ ...base, request: new Request('http://fixture'),
    async authorize() { if (++calls === 3) throw Error('revoked after read'); },
    openStream() { const stream = Readable.from([Buffer.from('data')]); stream.once('close', () => { destroyed++; }); return stream; } });
  await assert.rejects(response.text(), /revoked after read/);
  await tick(); assert.equal(calls, 3); assert.equal(destroyed, 1);
});

test('cancelling a body aborts pending async authority and does not deliver its late result', async () => {
  let calls = 0, reject!: (error: Error) => void, waitSignal!: AbortSignal;
  const late = new Promise<void>((_, no) => { reject = no; });
  const response = await asyncFileResponse({ ...base, request: new Request('http://fixture'),
    authorize(signal) { calls++; if (calls > 1) { waitSignal = signal; return late; } },
    openStream: () => Readable.from([Buffer.from('data')]) });
  const reader = response.body!.getReader(), read = reader.read();
  await tick(); assert.equal(calls, 2);
  await reader.cancel('cancelled'); assert.equal(waitSignal.aborted, true);
  assert.equal((await read).done, true);
  reject(Error('late denial')); await tick(); assert.equal(calls, 2);
});

test('opened inode is closed after async revoke or abort before response headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-async-authority-'));
  try {
    const filePath = join(root, 'fixture'); await writeFile(filePath, 'data');
    const info = await stat(filePath);
    let calls = 0;
    await assert.rejects(verifiedFileResponse({ ...base, filePath, info, request: new Request('http://fixture'),
      async authorize() { if (++calls === 2) throw Error('revoked while opening'); } }), /revoked while opening/);
    const abort = new AbortController(); calls = 0;
    const denied = assert.rejects(verifiedFileResponse({ ...base, filePath, info, request: new Request('http://fixture', { signal: abort.signal }),
      authorize() { if (++calls === 2) { abort.abort(Error('stopped after stat')); return new Promise<void>(() => {}); } } }), /stopped after stat/);
    await denied;
    // A fresh authorized inode read remains usable after either failure.
    assert.equal(await (await verifiedFileResponse({ ...base, filePath, info, request: new Request('http://fixture') })).text(), 'data');
  } finally { await rm(root, { recursive: true, force: true }); }
});
