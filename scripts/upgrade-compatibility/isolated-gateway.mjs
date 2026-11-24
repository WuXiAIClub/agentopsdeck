import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

/** Only test transport: never connect startup discovery to the host Gateway.
 * It has no native execution methods and fails if a migration tries to send. */
export async function isolatedGateway() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const unexpected = [];
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      const allowed = ['connect', 'sessions.list', 'agents.list', 'health', 'status'].includes(request.method);
      if (!allowed) unexpected.push(request.method);
      const payload = request.method === 'sessions.list' ? { sessions: [] }
        : request.method === 'agents.list' ? { agents: [] } : {};
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: allowed, payload,
        ...(!allowed ? { error: { message: 'Unexpected upgrade effect' } } : {}) }));
    });
  });
  let closing;
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close() {
      return closing ??= (async () => {
        for (const socket of server.clients) socket.terminate();
        await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
        assert.deepEqual(unexpected, [], 'Upgrade verification must never dispatch a native effect');
      })();
    },
  };
}
