import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ArtifactRecord, ArtifactRegistryAccess } from './artifact-receiver.js';

/** One configured owner of the original JSON index, not a second SQL root.
 * Publish only after atomic persistence; an uncertain failed write is never
 * silently retried or converted into a new empty index. */
export class AsyncArtifactRegistry implements ArtifactRegistryAccess {
  private records = new Map<string, ArtifactRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failed = false;
  private closing?: Promise<void>;
  private constructor(private readonly file: string) {}
  static async open(file: string) {
    const registry = new AsyncArtifactRegistry(file);
    await registry.reload();
    return registry;
  }
  get(id: string) { const record = this.records.get(id); return record ? { ...record } : undefined; }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.failed) return Promise.reject(new Error('Artifact index unavailable'));
    const next = this.tail.then(async () => {
      if (this.failed) throw new Error('Artifact index unavailable');
      try { return await work(); }
      catch { this.failed = true; throw new Error('Artifact index unavailable'); }
    });
    // Always observe an unawaited rejection while retaining its failed state.
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
  reload(): Promise<void> {
    return this.enqueue(async () => {
      let text: string;
      try { text = await readFile(this.file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid artifact index');
      const rows = (parsed as { artifacts?: unknown }).artifacts;
      if (rows !== undefined && !Array.isArray(rows)) throw new Error('Invalid artifact index');
      const records = new Map(this.records);
      for (const row of rows ?? []) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.path !== 'string'
          || typeof row.name !== 'string' || !row.id || !row.path || !row.name) continue;
        records.set(row.id, row as ArtifactRecord);
      }
      this.records = records;
    });
  }
  upsert(record: ArtifactRecord): Promise<ArtifactRecord> {
    // Caller mutation cannot change the queued/persisted original record.
    const original = { ...record };
    return this.enqueue(async () => {
      const next = new Map(this.records); next.set(original.id, original);
      const artifacts = [...next.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2_000);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(`${JSON.stringify({ artifacts }, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      this.records = next;
      return { ...original };
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.tail.then(() => { if (this.failed) throw new Error('Artifact index unavailable'); });
  }
}
