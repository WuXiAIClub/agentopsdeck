import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { boundedArchiveTransfer } from './bounded-archive-transfer.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'aod-transfer-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'archive');
}

function fakeTransfer(chunks, observe = () => {}) {
  return (command, args, options) => {
    assert.equal(command, 'curl');
    assert.equal(options.shell, false);
    observe(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    let closed = false;
    child.kill = signal => {
      if (!closed) { closed = true; child.stdout.destroy(); setImmediate(() => child.emit('close', null, signal)); }
    };
    setImmediate(() => {
      for (const chunk of chunks) child.stdout.write(Buffer.from(chunk));
      child.stdout.end();
      setImmediate(() => { if (!closed) { closed = true; child.emit('close', 0, null); } });
    });
    return child;
  };
}

test('archive transfer bounds actual streamed bytes and removes oversized partial files', async context => {
  const file = await fixture(context);
  await assert.rejects(boundedArchiveTransfer(['--output', file, 'https://example.invalid/archive'], file, 8, 1000,
    { spawn: fakeTransfer(['1234', '5678', '9'.repeat(64)]) }), /transfer byte bound/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('resumed archive includes prior bytes in the budget and preserves verified range offset', async context => {
  const file = await fixture(context);
  await writeFile(file, '1234', { mode: 0o600 });
  const args = ['--continue-at', '-', '--output', file, 'https://example.invalid/archive'];
  const result = await boundedArchiveTransfer(args, file, 8, 1000, { spawn: fakeTransfer(['56'], captured => {
    assert.equal(captured[captured.indexOf('--continue-at') + 1], '4');
    assert.equal(captured[captured.indexOf('--output') + 1], '-');
  }) });
  assert.equal(result.status, 0);
  assert.equal(await readFile(file, 'utf8'), '123456');
  await assert.rejects(boundedArchiveTransfer(args, file, 8, 1000,
    { spawn: fakeTransfer(['789']) }), /transfer byte bound/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('transfer timeout kills its downloader without declaring successful completion', async context => {
  const file = await fixture(context);
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = signal => { child.stdout.end(); setImmediate(() => child.emit('close', null, signal)); };
    return child;
  };
  const result = await boundedArchiveTransfer(['--output', file], file, 8, 10, { spawn });
  assert.equal(result.status, 28);
});

test('real loopback chunked download is cut off before exceeding the disk budget', async context => {
  const file = await fixture(context);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    const timer = setInterval(() => response.write(Buffer.alloc(4096)), 1);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/synthetic-archive`;
  await assert.rejects(boundedArchiveTransfer(['--fail', '--silent', '--output', file, url], file, 8192, 5000),
    /transfer byte bound/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});
