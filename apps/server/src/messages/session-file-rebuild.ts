import { randomUUID } from 'node:crypto';
import { normalizeSourceFiles, type ChatMessage, type SessionFileEntry, type SessionFileRebuild } from '@agentopsdeck/shared';
import { FILE_INDEX_BYTES, FILE_INDEX_ROWS, FileIndexCursorError, type SessionFileIndex } from './session-file-index.js';

export type FileEvidenceBatch = { messages: readonly ChatMessage[]; scanned: number; bytes: number; before?: string | undefined; limited?: boolean };
type Job = { key: string; actor: string; native: string; fence: string; expires: number; nextAt: number;
  before?: string; entries: Map<string, SessionFileEntry>; size: number; progress: SessionFileRebuild };
export class FileRebuildError extends Error {
  constructor(readonly status: 404 | 409 | 429, message: string) { super(message); }
}

/** Request-driven, bounded derived-cache work. No background timer, native
 * RPC, tool-detail reads or queued Agent commands. All callbacks are synchronous
 * so authority/binding checks and the final SQLite commit cannot interleave. */
export class SessionFileRebuilds {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly index: SessionFileIndex,
    private readonly native: (key: string) => string | undefined,
    private readonly read: (key: string, before?: string) => FileEvidenceBatch,
    private readonly now = Date.now,
    private readonly source: (key: string) => 'durable-events' | 'verified-projection' = () => 'durable-events') {}

  private expire() {
    for (const [id, job] of this.jobs) if (job.expires <= this.now()) this.jobs.delete(id);
  }
  start(key: string, actor: string): SessionFileRebuild {
    this.expire();
    for (const [id, job] of this.jobs) {
      if (job.key === key && job.progress.state === 'scanning') {
        if (job.actor !== actor) throw new FileRebuildError(409, 'File index rebuild already active');
        // An explicit start can recover a lost receipt or a closed panel. Never
        // reset the cursor, budgets, cooldown or expiry, and never scan here.
        // Check ownership before invalidating work belonging to another actor.
        if (this.native(key) !== job.native || this.index.fence(key) !== job.fence) return this.finish(job, 'conflict');
        return { ...job.progress };
      }
      if (job.progress.state !== 'scanning') this.jobs.delete(id);
    }
    if (this.jobs.size >= 4) throw new FileRebuildError(429, 'File index rebuild capacity reached');
    const native = this.native(key);
    if (!native) throw new FileRebuildError(404, 'Session not available');
    const progress: SessionFileRebuild = { id: randomUUID(), step: 0, state: 'scanning', scanned: 0, bytes: 0, found: 0, limited: false };
    this.jobs.set(progress.id, { key, actor, native, fence: this.index.fence(key), expires: this.now() + 300_000,
      nextAt: 0, entries: new Map(), size: 2, progress });
    return { ...progress };
  }
  private job(key: string, actor: string, id: string) {
    this.expire();
    const job = this.jobs.get(id);
    if (!job || job.key !== key || job.actor !== actor) throw new FileRebuildError(404, 'File index rebuild not available');
    return job;
  }
  private finish(job: Job, state: SessionFileRebuild['state']) {
    job.progress.state = state; job.entries.clear();
    return { ...job.progress };
  }
  cancel(key: string, actor: string, id: string) {
    const job = this.job(key, actor, id);
    // A final commit may win the race with cancellation; never label it cancelled.
    return job.progress.state === 'scanning' ? this.finish(job, 'cancelled') : { ...job.progress };
  }
  step(key: string, actor: string, id: string, expectedStep: number): SessionFileRebuild {
    const job = this.job(key, actor, id), progress = job.progress;
    if (!Number.isSafeInteger(expectedStep) || expectedStep < 0 || expectedStep > progress.step)
      throw new FileRebuildError(409, 'Invalid file rebuild step');
    if (progress.state !== 'scanning' || expectedStep < progress.step || this.now() < job.nextAt) return { ...progress };
    try {
      if (this.native(key) !== job.native || this.index.fence(key) !== job.fence) return this.finish(job, 'conflict');
      const page = this.read(key, job.before);
      if (!Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.scanned > 20
        || !Number.isSafeInteger(page.bytes) || page.bytes < 0 || page.bytes > 1024 * 1024
        || page.before !== undefined && (page.scanned === 0 || page.before === job.before)) throw new Error('Invalid summary batch');
      progress.scanned += page.scanned; progress.bytes += page.bytes; progress.step++;
      // The transcript adapters return ascending messages; retain newest first
      // while walking pages backwards. Never inspect message text/tool details.
      outer: for (let i = page.messages.length - 1; i >= 0; i--) {
        const message = page.messages[i]!;
        if (message.sessionKey !== key || message.role !== 'tool' || message.toolPhase !== 'result' || message.status !== 'sent'
          || !message.id || message.id.length > 4096 || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0) continue;
        for (const file of normalizeSourceFiles(message.sourceFiles)) {
          const entry = { ...file, messageId: message.id, createdAt: message.createdAt };
          const identity = JSON.stringify([entry.messageId, entry.path]), data = JSON.stringify(entry), previous = job.entries.get(identity);
          if (previous) { if (JSON.stringify(previous) !== data) throw new Error('Conflicting evidence'); continue; }
          const size = Buffer.byteLength(data) + 1;
          if (job.entries.size >= FILE_INDEX_ROWS || job.size + size > FILE_INDEX_BYTES) { progress.limited = true; break outer; }
          job.entries.set(identity, entry); job.size += size;
        }
      }
      progress.found = job.entries.size;
      if (page.limited) progress.limited = true;
      if (page.before && (progress.scanned >= 10_000 || progress.bytes >= 64 * 1024 * 1024)) progress.limited = true;
      if (!page.before || progress.limited) {
        if (this.native(key) !== job.native) return this.finish(job, 'conflict');
        this.index.replaceDurable(key, job.native, job.fence, [...job.entries.values()].reverse(), progress.limited, this.source(key));
        return this.finish(job, 'completed');
      }
      job.before = page.before; job.nextAt = this.now() + 250;
      return { ...progress };
    } catch (error) { return this.finish(job, error instanceof FileIndexCursorError ? 'conflict' : 'failed'); }
  }
  close() { this.jobs.clear(); }
}
