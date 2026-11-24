import type { Readable } from 'node:stream';

export function drainNativeDiagnostics(input: Readable, limit = 64 * 1024) {
  let bytes = 0;
  input.on('error', () => {});
  input.on('data', (chunk: Buffer | string) => {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    bytes = Math.min(limit + 1, bytes + size);
  });
  return { exceeded: () => bytes > limit, bytes: () => bytes };
}
