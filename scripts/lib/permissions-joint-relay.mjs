// Test-only, loopback HTTP relay. It forwards original bytes and headers, never
// fabricates a Connector response or records credentials/payloads. A one-use
// response barrier lets the joint fixture revoke authority during actual I/O.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';

export async function startJointReadRelay(origin) {
  const upstreamOrigin = new URL(origin);
  assert.equal(upstreamOrigin.protocol, 'http:'); assert.equal(upstreamOrigin.hostname, '127.0.0.1');
  const pending = new Set(), sockets = new Set(), gates = new Set();
  let armed, issuerFault;
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, upstreamOrigin);
    if (url.origin !== upstreamOrigin.origin) { outgoing.writeHead(400); outgoing.end(); return; }
    const originalIssuer = issuerFault && incoming.headers.authorization === `Bearer ${issuerFault.token}`;
    if (originalIssuer && issuerFault.blocked) {
      issuerFault.attempts++; incoming.socket.destroy(); return;
    }
    const gate = incoming.method === 'GET' && armed?.matches(url) ? armed : undefined;
    if (gate) armed = undefined;
    const controller = new AbortController();
    const upstream = request(url, { method: incoming.method, headers: { ...incoming.headers, host: upstreamOrigin.host },
      signal: controller.signal }, response => {
      if (originalIssuer && incoming.method === 'POST' && url.pathname === '/api/connector/v1/execution-grants/revoke'
        && response.statusCode === 200) issuerFault.acknowledgments++;
      const task = (async () => {
        let remaining = gate?.prefixBytes ?? 0;
        const hold = async () => {
          gate.reached(response.statusCode);
          await gate.wait(controller.signal);
        };
        const write = async bytes => { if (bytes.length && !outgoing.write(bytes)) await once(outgoing, 'drain', { signal: controller.signal }); };
        try {
          outgoing.writeHead(response.statusCode, response.headers); outgoing.flushHeaders();
          if (gate && remaining === 0) await hold();
          for await (const chunk of response) {
            if (gate && remaining > 0) {
              const count = Math.min(remaining, chunk.length);
              await write(chunk.subarray(0, count)); remaining -= count;
              if (!remaining) await hold();
              await write(chunk.subarray(count));
            } else await write(chunk);
          }
          if (gate && remaining > 0) throw new Error('Barrier prefix exceeds actual body');
          outgoing.end();
        } catch {
          // A revoked downstream reader may cancel while the original response
          // is held. Do not dump transport errors, headers or private bodies.
          response.destroy(); outgoing.destroy();
        }
      })();
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) { outgoing.writeHead(502); outgoing.end(); } else outgoing.destroy();
    });
    incoming.on('aborted', () => controller.abort());
    outgoing.on('close', () => controller.abort());
    incoming.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    isolateIssuer(token) {
      assert.ok(!issuerFault && typeof token === 'string' && token.length > 0 && token.length <= 4096,
        'Use one private isolated issuer credential');
      issuerFault = { token, blocked: true, attempts: 0, acknowledgments: 0 };
      return { get attempts() { return issuerFault.attempts; }, get acknowledgments() { return issuerFault.acknowledgments; },
        restore() { issuerFault.blocked = false; } };
    },
    arm({ pathname, query = {}, prefixBytes = 0 }) {
      assert.equal(armed, undefined, 'Only one unclaimed read barrier at a time');
      assert.ok(pathname.startsWith('/api/connector/v1/sessions/'));
      assert.ok(Number.isInteger(prefixBytes) && prefixBytes >= 0 && prefixBytes <= 32);
      let held, release;
      const reached = new Promise(resolve => { held = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      const gate = { prefixBytes, matches: url => url.pathname === pathname
          && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value),
        reached: status => held({ status, prefixBytes }),
        async wait(signal) {
          signal.throwIfAborted();
          let abort;
          try {
            await Promise.race([released, new Promise((_, reject) => {
              abort = () => reject(new Error('Read barrier cancelled')); signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            })]);
            signal.throwIfAborted();
          } finally { signal.removeEventListener('abort', abort); gates.delete(gate); }
        }, release };
      gates.add(gate); armed = gate;
      return { held: reached, release };
    },
    async close() {
      for (const gate of gates) gate.release();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
    },
  };
}
