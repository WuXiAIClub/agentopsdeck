import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { startJointReadRelay } from './permissions-joint-relay.mjs';

const pathname = '/api/connector/v1/sessions/example/messages';
async function fixture(t) {
  const body = Buffer.from('original-private-upstream-bytes');
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }); res.end(body);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = await startJointReadRelay(`http://127.0.0.1:${upstream.address().port}`);
  t.after(async () => { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  return { relay, body, requests };
}

test('one-use body barrier preserves actual upstream bytes and exact query selection', { timeout: 5000 }, async t => {
  const { relay, body } = await fixture(t);
  const gate = relay.arm({ pathname, query: { limit: '7' } });
  const control = await fetch(relay.origin + pathname + '?limit=8');
  assert.deepEqual(Buffer.from(await control.arrayBuffer()), body);
  const response = await fetch(relay.origin + pathname + '?limit=7');
  assert.deepEqual(await gate.held, { status: 200, prefixBytes: 0 });
  const reader = response.body.getReader(); let settled = false;
  const first = reader.read().then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gate.release(); const chunks = [(await first).value];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  assert.deepEqual(Buffer.concat(chunks), body);
  const second = await fetch(relay.origin + pathname + '?limit=7');
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), body, 'barrier cannot capture another reader');
});

test('media barrier forwards only the explicit prefix until released; cancellation drains', { timeout: 5000 }, async t => {
  const { relay, body } = await fixture(t);
  const gate = relay.arm({ pathname, prefixBytes: 8 });
  const response = await fetch(relay.origin + pathname);
  assert.equal((await gate.held).prefixBytes, 8);
  const reader = response.body.getReader(); const prefix = await reader.read();
  assert.deepEqual(Buffer.from(prefix.value), body.subarray(0, 8));
  let settled = false; const tail = reader.read().then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gate.release(); const chunks = [prefix.value, (await tail).value];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  assert.deepEqual(Buffer.concat(chunks), body);
  const cancelled = relay.arm({ pathname, prefixBytes: 8 });
  const again = await fetch(relay.origin + pathname); await cancelled.held;
  await again.body.cancel(); cancelled.release();
});

test('ordinary POST bodies pass unchanged and invalid barrier scopes are rejected', { timeout: 5000 }, async t => {
  const { relay, body, requests } = await fixture(t);
  const response = await fetch(relay.origin + '/command', { method: 'POST', body: 'unchanged-request' });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.deepEqual(requests, [{ method: 'POST', url: '/command', body: 'unchanged-request' }]);
  assert.throws(() => relay.arm({ pathname: '/unscoped' }));
  assert.throws(() => relay.arm({ pathname, prefixBytes: 1024 }));
});

test('issuer outage closes only its real transport; restoration forwards the original revoke acknowledgment', { timeout: 5000 }, async t => {
  const { relay, body, requests } = await fixture(t);
  const outage = relay.isolateIssuer('disposable-fixture-issuer');
  const revoke = '/api/connector/v1/execution-grants/revoke';
  const options = { method: 'POST', headers: { authorization: 'Bearer disposable-fixture-issuer' }, body: 'original-binding' };
  await assert.rejects(fetch(relay.origin + revoke, options));
  assert.equal(outage.attempts, 1); assert.equal(outage.acknowledgments, 0); assert.equal(requests.length, 0);
  const maintenance = await fetch(relay.origin + pathname);
  assert.deepEqual(Buffer.from(await maintenance.arrayBuffer()), body);
  outage.restore(); const response = await fetch(relay.origin + revoke, options);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.equal(outage.acknowledgments, 1); assert.equal(outage.attempts, 1);
  assert.deepEqual(requests.at(-1), { method: 'POST', url: revoke, body: 'original-binding' });
});
