import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { isolatedGateway } from './isolated-gateway.mjs';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { WebSocket } = require('ws');
for (const method of ['sessions.list', 'agent']) test(`isolated migration Gateway ${method}`, async () => {
  const gateway = await isolatedGateway();
  const socket = new WebSocket(gateway.url);
  try {
    const [challenge] = await once(socket, 'message');
    assert.equal(JSON.parse(challenge.toString()).event, 'connect.challenge');
    const result = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'original-request', method }));
    const [raw] = await result;
    const response = JSON.parse(raw.toString());
    assert.equal(response.id, 'original-request');
    assert.equal(response.ok, method === 'sessions.list');
    if (method === 'sessions.list') assert.deepEqual(response.payload, { sessions: [] });
  } finally {
    socket.terminate();
    if (method === 'agent') await assert.rejects(gateway.close(), /never dispatch a native effect/);
    else { await gateway.close(); await gateway.close(); }
  }
});
