import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertWindowsPrivatePath, canonicalPrivatePath } from '../connector/windows-private-worker.js';
import type { CopilotHistoryIdentity } from './dispatch-adapter.js';
import { copilotHistoryIdentities, copilotLifecycleFrame } from './worker-protocol.js';
import { copilotManualCompactId } from './compact-evidence.js';

export const COPILOT_HISTORY_SCAN_BYTES = 16 * 1024 * 1024;
export const COPILOT_HISTORY_LINE_BYTES = 1024 * 1024;
const chunkBytes = 64 * 1024;
const invalid = () => new Error('Copilot persisted history could not be verified');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Pinned CLI 1.0.85 local persistence adapter, NOT an SDK remote-file API.
 * Called only after the owned native process has exited. Scan a bounded tail
 * instead of getEvents(), which allocates the entire raw native history.
 * Missing current-run identities never prove persistence; the dispatch
 * adapter must still match every observed user/assistant identity. This is
 * settlement evidence, not a claim to return the complete chat history.
 */
export async function readCopilotHistoryTail(home: string, sessionId: string): Promise<{
  entries: CopilotHistoryIdentity[]; compactIds: string[]; truncated: boolean; bytesRead: number;
}> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!['linux', 'win32'].includes(process.platform) || process.platform === 'linux' && !process.getuid || !isAbsolute(home) || !uuid.test(sessionId)) throw invalid();
    const directory = join(home, 'copilot', 'session-state', sessionId);
    for (const path of [home, join(home, 'copilot'), join(home, 'copilot', 'session-state'), directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !canonicalPrivatePath(path)) throw invalid();
      if (process.platform === 'win32') assertWindowsPrivatePath(path);
      else if (stat.uid !== process.getuid!() || (stat.mode & 0o022) || path === home && (stat.mode & 0o077)) throw invalid();
    }
    const path = join(directory, 'events.jsonl');
    file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const before = await file.stat(), initial = await lstat(path);
    if (!before.isFile() || initial.isSymbolicLink() || before.dev !== initial.dev || before.ino !== initial.ino
      || before.nlink !== 1 || !Number.isSafeInteger(before.size)) throw invalid();
    if (process.platform === 'win32') assertWindowsPrivatePath(path);
    else if (before.uid !== process.getuid!() || (before.mode & 0o022)) throw invalid();
    // A tail starts at an arbitrary byte; conservatively discard its first
    // line. Settlement requires the current turn's complete identities.
    let position = Math.max(0, before.size - COPILOT_HISTORY_SCAN_BYTES);
    const truncated = position > 0;
    let dropping = truncated, pending = Buffer.alloc(0), bytesRead = 0;
    const entries: CopilotHistoryIdentity[] = [], ids = new Set<string>();
    const compactIds: string[] = [];
    const chunk = Buffer.alloc(chunkBytes), decoder = new TextDecoder('utf-8', { fatal: true });
    while (position < before.size) {
      const count = Math.min(chunk.length, before.size - position);
      const read = await file.read(chunk, 0, count, position);
      if (read.bytesRead !== count) throw invalid();
      position += count; bytesRead += count;
      let offset = 0;
      while (offset < count) {
        const end = chunk.indexOf(10, offset), newline = end >= 0 && end < count;
        const until = newline ? end : count;
        if (!dropping) {
          if (pending.length + until - offset > COPILOT_HISTORY_LINE_BYTES) throw invalid();
          pending = Buffer.concat([pending, chunk.subarray(offset, until)]);
        }
        if (newline) {
          if (!dropping) {
            if (!pending.length) throw invalid();
            const event: unknown = JSON.parse(decoder.decode(pending));
            copilotLifecycleFrame(event);
            const compactId = copilotManualCompactId(event);
            if (compactId) {
              if (compactIds.length >= 10_000 || compactIds.includes(compactId)) throw invalid();
              compactIds.push(compactId);
            }
            for (const entry of copilotHistoryIdentities([event])) {
              if (ids.has(entry.id) || entries.length >= 10_000) throw invalid();
              ids.add(entry.id); entries.push(entry);
            }
          }
          pending = Buffer.alloc(0); dropping = false;
        }
        offset = until + (newline ? 1 : 0);
      }
    }
    if (pending.length || dropping) throw invalid();
    const after = await file.stat(), current = await lstat(path);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !canonicalPrivatePath(path)) throw invalid();
    return { entries, compactIds, truncated, bytesRead };
  } catch { throw invalid(); }
  finally { await file?.close(); }
}
