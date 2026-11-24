import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { HTTPException } from 'hono/http-exception';
import { validSocketProtocol, validWebsiteSocketFrame, WEBSITE_SOCKET_FRAME_BYTES, type WebsiteSocketFrame } from '../connector/website-sockets.js';
import type { WebsiteGateway } from './website-gateway.js';
import { HubRequestWork } from './async-request-work.js';

export type WebsiteSocketPeer = {
  protocol: string;
  read(signal: AbortSignal): Promise<{ frames: WebsiteSocketFrame[] }>;
  send(frame: WebsiteSocketFrame, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
};

/** Installed only on the isolated website listener, never the Hub/API listener. */
export function attachWebsiteSocketUpgrade(server: Server, gateway: WebsiteGateway) {
  const pending = new Set<AbortController>();
  const work = new HubRequestWork(128);
  let closing: Promise<void> | undefined;
  const selected = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: WEBSITE_SOCKET_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: (_protocols, request) => selected.get(request) || false });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void work.run(async () => {
    const controller = new AbortController(), stop = () => controller.abort();
    // A peer that ignores cancellation must not keep a browser's handshake
    // alive after gateway shutdown; transport ownership stays with this listener.
    const destroy = () => socket.destroy();
    controller.signal.addEventListener('abort', destroy, { once: true });
    pending.add(controller);
    socket.once('close', stop); socket.once('error', stop);
    let lease: Awaited<ReturnType<WebsiteGateway['openSocket']>> | undefined;
    let ws: WebSocket | undefined;
    let writes = Promise.resolve(), revokeFlight: Promise<void> | undefined;
    const timeout = setTimeout(() => { stop(); socket.destroy(); }, 8_000);
    try {
      if (request.method !== 'GET' || request.headers.origin !== 'null' || !request.url || request.url.length > 4096) throw new HTTPException(403);
      const raw = request.headers['sec-websocket-protocol'];
      const protocols = raw === undefined ? [] : typeof raw === 'string' ? raw.split(',').map(v => v.trim()) : [''];
      if (protocols.length > 4 || !protocols.every(validSocketProtocol) || new Set(protocols).size !== protocols.length) throw new HTTPException(400);
      lease = await gateway.openSocket(request.headers.host ?? '', request.url, protocols, controller.signal);
      controller.signal.throwIfAborted();
      selected.set(request, lease.peer.protocol);
      wss.handleUpgrade(request, socket, head, connected => { ws = connected; });
      if (!ws) throw new HTTPException(400);
      clearTimeout(timeout);
      let queued = 0, sentBytes = 0, receivedBytes = 0, frames = 0;
      const current = lease;
      const close = () => { stop(); ws?.terminate(); current.close(); };
      current.signal.addEventListener('abort', close, { once: true });
      const revoke = setInterval(() => {
        if (revokeFlight || controller.signal.aborted) return;
        revokeFlight = current.check().catch(close).finally(() => { revokeFlight = undefined; });
      }, 250);
      revoke.unref();
      controller.signal.addEventListener('abort', () => { clearInterval(revoke); ws?.terminate(); current.close(); }, { once: true });
      ws.on('error', close); ws.on('close', close);
      ws.on('message', (data, binary) => {
        if (controller.signal.aborted) return;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        sentBytes += bytes.length; frames++;
        if (queued >= 16 || sentBytes + receivedBytes > 8 * 1024 * 1024 || frames > 4096) return close();
        queued++;
        const frame = { bodyBase64: bytes.toString('base64'), binary };
        writes = writes.then(async () => { await current.check(); await current.peer.send(frame, current.signal); await current.check(); })
          .catch(close).finally(() => { queued--; });
      });
      try {
        while (!controller.signal.aborted && ws.readyState === WebSocket.OPEN) {
          await current.check();
          const readStarted = performance.now();
          const output = await current.peer.read(current.signal);
          await current.check();
          if (!output || !Array.isArray(output.frames) || output.frames.length > 64 || !output.frames.every(validWebsiteSocketFrame)) throw new HTTPException(502);
          // A faulty peer must not turn an empty long read into a hot request loop.
          if (!output.frames.length && performance.now() - readStarted < 1000) throw new HTTPException(502);
          for (const frame of output.frames) {
            await current.check();
            const bytes = Buffer.from(frame.bodyBase64, 'base64');
            receivedBytes += bytes.length; frames++;
            if (sentBytes + receivedBytes > 8 * 1024 * 1024 || frames > 4096 || ws.bufferedAmount > 256 * 1024) throw new HTTPException(429);
            await new Promise<void>((resolve, reject) => ws!.send(bytes, { binary: frame.binary }, error => error ? reject(error) : resolve()));
          }
        }
      } finally { current.signal.removeEventListener('abort', close); close(); }
    } catch {
      // No upstream status/body/path, credential or capability in errors/logs.
      if (!ws && !socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      ws?.terminate();
    } finally {
      clearTimeout(timeout); stop(); lease?.close();
      await Promise.allSettled([writes, ...(revokeFlight ? [revokeFlight] : []), ...(lease ? [lease.peer.close()] : [])]);
      pending.delete(controller);
      controller.signal.removeEventListener('abort', destroy);
      socket.removeListener('close', stop); socket.removeListener('error', stop);
    }
    }).catch(() => { socket.destroy(); });
  };
  server.on('upgrade', upgrade);
  return { close: () => {
    if (closing) return closing;
    let finish!: () => void, fail!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    // Stop accepting and destroy transports before waiting for original work.
    server.off('upgrade', upgrade);
    for (const controller of pending) controller.abort();
    for (const client of wss.clients) client.terminate();
    const socketsClosed = new Promise<void>(resolve => wss.close(() => resolve()));
    void Promise.all([work.close(), socketsClosed]).then(() => finish(), fail);
    return closing;
  } };
}
