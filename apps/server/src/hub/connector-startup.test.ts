import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { ConnectorClient } from './connector-client.js';
import { ConnectorNotDispatchedError } from './connector-connect.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const path = '/sessions/codex%3Atest/messages';
const payload = JSON.stringify({ message: 'startup test', idempotencyKey: 'startup-key' });
const init = { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'idempotency-key': 'startup-key' } };
async function listen(server: Server, port = 0) {
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}
async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('native TCP startup window delivers exactly once with the original body, identity and node pin', async () => {
  const port = await unusedPort();
  let received = 0, checks = 0, started: Promise<number> | undefined;
  const server = createServer(async (request, response) => {
    received++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/api/connector/v1${path}`);
    assert.equal(request.headers[EXPECTED_NODE_HEADER.toLowerCase()], nodeId);
    assert.equal(request.headers.authorization, 'Bearer synthetic');
    assert.equal(request.headers['idempotency-key'], 'startup-key');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), payload);
    response.writeHead(200, { [NODE_ID_HEADER]: nodeId, 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const client = new ConnectorClient(`http://127.0.0.1:${port}`, 'synthetic', undefined, 5000, undefined, {
    nodeId, authorize: () => {
      // First outer guard + first attempt fail to connect. Start listening
      // only at the second attempt, so the test does not depend on a sleep.
      if (++checks === 3) started = listen(server, port);
    },
  });
  try {
    assert.deepEqual(await client.json(path, init), { ok: true });
    assert.equal(received, 1);
    assert.ok(checks >= 4);
  } finally { await started; await close(server); }
});

test('native TCP repeated refusal terminates as a proven non-dispatch', async () => {
  const client = new ConnectorClient(`http://127.0.0.1:${await unusedPort()}`, 'synthetic');
  await assert.rejects(client.json(path, init), ConnectorNotDispatchedError);
});

for (const failure of ['lost-ack', '503', 'wrong-node', 'malformed-json'] as const) {
  test(`native TCP ${failure} after receiving the command never retries`, async () => {
    let received = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* consume the full command */ }
      received++;
      if (failure === 'lost-ack') { request.socket.destroy(); return; }
      response.writeHead(failure === '503' ? 503 : 200, {
        [NODE_ID_HEADER]: failure === 'wrong-node' ? 'different-node' : nodeId,
        'content-type': 'application/json',
      });
      response.end(failure === 'malformed-json' ? '{' : '{}');
    });
    const port = await listen(server);
    try {
      const client = new ConnectorClient(`http://127.0.0.1:${port}`, 'synthetic', undefined, 1000, undefined, { nodeId });
      await assert.rejects(client.json(path, init), error => !(error instanceof ConnectorNotDispatchedError));
      assert.equal(received, 1);
    } finally { await close(server); }
  });
}

test('in-process dispatch is never retried even if it throws a connect-shaped error', async () => {
  let calls = 0;
  const client = new ConnectorClient('http://local', 'synthetic', () => {
    calls++;
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', syscall: 'connect' } });
  });
  await assert.rejects(client.json(path, init), TypeError);
  assert.equal(calls, 1);
});

test('the total deadline cancels startup backoff without a later connection attempt', async () => {
  let checks = 0;
  const client = new ConnectorClient(`http://127.0.0.1:${await unusedPort()}`, 'synthetic', undefined, 20, undefined,
    { authorize: () => { checks++; } });
  await assert.rejects(client.json(path, init), /Deadline exceeded/);
  const before = checks;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(checks, before);
});
