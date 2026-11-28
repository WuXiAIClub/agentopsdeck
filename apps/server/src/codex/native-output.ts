import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const codexOutputFrameLimit = 32 * 1024 * 1024;

export function consumeCodexOutput(input: Readable, options: {
  receive(line: string): void;
  holdIngress(): () => void;
  pressure(): Promise<void> | undefined;
}): Promise<void> {
  let buffer = Buffer.alloc(0);
  let length = 0;
  let destroyed = false;
  let active: Promise<void> = Promise.resolve();
  const consume = (chunk: Buffer, final: boolean, done: (error?: Error | null) => void) => {
    let settled!: () => void;
    active = new Promise<void>(resolve => { settled = resolve; });
    const release = options.holdIngress();
    let offset = 0;
    const finish = (error?: unknown) => {
      if (error !== undefined || destroyed) { buffer = Buffer.alloc(0); length = 0; }
      release();
      settled();
      done(error === undefined ? undefined : error instanceof Error ? error : new Error('Codex output unavailable'));
    };
    const advance = () => {
      try {
        if (destroyed) { finish(); return; }
        for (;;) {
          const end = chunk.indexOf(10, offset);
          const size = (end < 0 ? chunk.length : end) - offset;
          if (size > codexOutputFrameLimit - length) throw new Error('Codex output frame exceeded its byte budget');
          if (end < 0 && offset === chunk.length && !length) { finish(); return; }
          if (end >= 0 || final) {
            const pressure = options.pressure();
            if (pressure) { void pressure.then(advance, finish); return; }
          }
          if (length + size > buffer.length) {
            const grown = Buffer.allocUnsafe(Math.min(codexOutputFrameLimit, Math.max(length + size, buffer.length * 2, 4096)));
            buffer.copy(grown, 0, 0, length);
            buffer = grown;
          }
          chunk.copy(buffer, length, offset, offset + size);
          length += size;
          if (end < 0 && !final) { finish(); return; }
          const line = buffer.toString('utf8', 0, length);
          length = 0;
          options.receive(line.endsWith('\r') ? line.slice(0, -1) : line);
          offset = end < 0 ? chunk.length : end + 1;
        }
      } catch (error) { finish(error); }
    };
    advance();
  };
  return pipeline(input, new Writable({
    write(chunk: Buffer, _encoding, done) { consume(chunk, false, done); },
    final(done) { consume(Buffer.alloc(0), true, done); },
    destroy(error, done) {
      destroyed = true;
      buffer = Buffer.alloc(0); length = 0;
      void active.then(() => done(error));
    },
  }));
}
