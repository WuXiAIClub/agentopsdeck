import { execFile } from 'node:child_process';
import { Agent } from 'node:http';
import { createConnection } from 'node:net';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { TransportError, type AhpTransport, type JsonRpcMessage, type TransportFrame } from '@microsoft/agent-host-protocol/client';
import WebSocket, { createWebSocketStream } from 'ws';

const pipePrefix = '\\\\.\\pipe\\vscode-agent-host-';
const discoveryFailed = () => new Error('VS Code Agent Host discovery failed');
const opaque = /^[a-zA-Z0-9_-]{16,256}$/;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function selectVsCodeEndpoint(discovery: unknown, instanceId: string) {
  if (!opaque.test(instanceId) || !record(discovery) || !Array.isArray(discovery.endpoints)) throw discoveryFailed();
  const matches = discovery.endpoints.filter((value: unknown) => record(value)
    && value.type === 'editor' && value.schemaVersion === 2 && value.instanceId === instanceId);
  const entry: unknown = matches.length === 1 ? matches[0] : undefined;
  if (!record(entry) || !record(entry.endpoint) || entry.endpoint.type !== 'socket') throw discoveryFailed();
  const { path } = entry.endpoint;
  const { connectionToken } = entry;
  if (typeof path !== 'string' || !path.startsWith(pipePrefix) || !opaque.test(path.slice(pipePrefix.length))
    || typeof connectionToken !== 'string' || !opaque.test(connectionToken)) throw discoveryFailed();
  return { path, connectionToken };
}

export async function openVsCodeTransport(cli: string, instanceId: string): Promise<AhpTransport> {
  if (process.platform !== 'win32' || !/^[a-z]:\\/i.test(cli) || win32.basename(cli).toLowerCase() !== 'code-tunnel.exe') {
    throw discoveryFailed();
  }
  let endpoint: ReturnType<typeof selectVsCodeEndpoint>;
  try {
    const { stdout } = await promisify(execFile)(cli, ['agent', 'endpoints'], {
      windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024, encoding: 'utf8',
    });
    endpoint = selectVsCodeEndpoint(JSON.parse(stdout), instanceId);
  } catch {
    throw discoveryFailed();
  }
  const agent = new Agent();
  agent.createConnection = () => createConnection(endpoint.path);
  const socket = new WebSocket(`ws://localhost/?tkn=${endpoint.connectionToken}`, {
    agent, handshakeTimeout: 5_000, followRedirects: false, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024,
  });
  socket.once('close', () => agent.destroy());
  const stream = createWebSocketStream(socket, { readableObjectMode: true, highWaterMark: 4 });
  const inbox = stream[Symbol.asyncIterator]();
  const failure = () => new TransportError('io', 'VS Code Agent Host pipe unavailable');
  return {
    send(message: JsonRpcMessage | string) {
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      return new Promise<void>((resolve, reject) => {
        stream.write(text, error => error ? reject(failure()) : resolve());
      });
    },
    async recv(): Promise<TransportFrame | null> {
      try {
        const frame = await inbox.next();
        if (frame.done) return null;
        if (typeof frame.value !== 'string') throw failure();
        // The SDK includes JSON parse failures in its logs; do not pass through invalid wire text.
        if (!record(JSON.parse(frame.value))) throw failure();
        return { kind: 'text', text: frame.value };
      } catch {
        throw failure();
      }
    },
    close() {
      stream.destroy();
    },
  };
}
