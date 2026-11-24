export type ConnectorEventFrame = { id?: string; event?: string; data: string };

// An interrupted frame is never a committed event. Callers resume from the last
// fully consumed frame, not from a partial ID seen before a disconnect.
export async function* parseConnectorEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, maxFrameBytes = 256 * 1024): AsyncGenerator<ConnectorEventFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  // A second cancel() can resolve after the stream is marked closed while the
  // FIRST underlying cancel is still pending. Retain and await that original
  // flight before releasing its reader or reporting that the feed exited.
  let cancellation: Promise<void> | undefined;
  const cancel = (reason?: unknown) => cancellation ??= Promise.resolve()
    .then(() => reader.cancel(reason)).catch(() => undefined);
  const abort = () => { void cancel(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        if (Buffer.byteLength(raw) > maxFrameBytes) throw new Error('Connector event exceeds size limit');
        buffer = buffer.slice(match.index + match[0].length);
        const frame: ConnectorEventFrame = { data: '' };
        const data: string[] = [];
        for (const line of raw.split(/\r\n|\r|\n/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const text = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id' && !text.includes('\0')) frame.id = text;
          else if (field === 'event') frame.event = text;
          else if (field === 'data') data.push(text);
        }
        if (data.length) { frame.data = data.join('\n'); yield frame; }
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) throw new Error('Connector event exceeds size limit');
      if (done) break;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await cancel(signal.aborted ? signal.reason : undefined);
    reader.releaseLock();
  }
}
