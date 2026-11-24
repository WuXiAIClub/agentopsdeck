import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Display-only bounded tail, never an authoritative execution/completion proof.
 * Refuse changing/non-regular files and discard a partial leading JSONL record. */
export async function readTranscriptTail(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) return '';
    const start = Math.max(0, before.size - 1024 * 1024);
    const position = start > 0 ? start - 1 : 0;
    const buffer = Buffer.allocUnsafe(before.size - position);
    let length = 0, reads = 0;
    while (length < buffer.length) {
      if (++reads > 64) return '';
      const { bytesRead } = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), position + length);
      if (!bytesRead) return '';
      length += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return '';
    if (!start) return buffer.toString('utf8');
    const newline = buffer.indexOf(10);
    return newline < 0 ? '' : buffer.toString('utf8', newline + 1);
  } finally { await handle.close(); }
}
