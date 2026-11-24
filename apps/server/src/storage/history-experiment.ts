import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type HistoryExperimentOptions = { rounds?: number; rows?: number; payloadBytes?: number; checkpoint?: 'none' | 'passive' };
const maxDiskBytes = 64 * 1024 ** 2, minimumFreeBytes = 512 * 1024 ** 2;
const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
/** Bounded synthetic experiment only: no caller-selected paths, native history,
 * HTTP requests or production DBs. Separate stage timings are not 503 evidence.
 * The short duration is NOT a 2h/8h stability test or a filesystem quota. */
export function runHistoryExperiment(options: HistoryExperimentOptions = {}) {
  const { rounds = 12, rows = 250, payloadBytes = 512, checkpoint = 'none' } = options;
  if (Object.keys(options).some(k => !['rounds', 'rows', 'payloadBytes', 'checkpoint'].includes(k))
    || !integer(rounds, 1, 32) || !integer(rows, 1, 2000) || !integer(payloadBytes, 1, 4096)
    || !['none', 'passive'].includes(checkpoint) || rows * payloadBytes > 4 * 1024 ** 2) throw Error('experiment-budget');
  const hasSpace = (path: string) => { const fs = statfsSync(path); return fs.bavail * fs.bsize >= minimumFreeBytes; };
  if (!hasSpace(tmpdir())) throw Error('experiment-headroom');
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-experiment-'));
  const path = join(directory, 'fixture.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE samples(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    const write = db.prepare('INSERT INTO samples VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    const read = db.prepare('SELECT payload FROM samples ORDER BY id');
    const footprint = () => Object.fromEntries(['', '-wal', '-shm'].map((suffix, i) => {
      let bytes = 0;
      try { bytes = statSync(path + suffix).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return [['database', 'wal', 'shm'][i]!, bytes];
    }));
    const measured = <T>(action: () => T): [T, number] => { const start = performance.now(); const value = action(); return [value, performance.now() - start]; };
    const samples = [];
    const baseline = footprint(), started = performance.now(), cpu = process.cpuUsage();
    let stopped: 'round-budget' | 'time-budget' | 'disk-budget' | 'low-space' = 'round-budget';
    for (let round = 0; round < rounds; round++) {
      if (performance.now() - started >= 10_000) { stopped = 'time-budget'; break; }
      if (!hasSpace(directory)) { stopped = 'low-space'; break; }
      // Conservative room for the next bounded transaction, including pages.
      if (Object.values(footprint()).reduce((a, b) => a + b, 0) + rows * (payloadBytes + 8192) > maxDiskBytes) { stopped = 'disk-budget'; break; }
      const payload = JSON.stringify({ iteration: round, text: 'x'.repeat(payloadBytes) });
      const [, sqlWriteMs] = measured(() => {
        db!.exec('BEGIN IMMEDIATE');
        try { for (let id = 0; id < rows; id++) write.run(id, payload); db!.exec('COMMIT'); }
        catch (error) { if (db!.isTransaction) db!.exec('ROLLBACK'); throw error; }
      });
      const [records, sqlReadMs] = measured(() => read.all());
      const [parsed, jsonMs] = measured(() => records.map(row => JSON.parse(String(row.payload)) as { iteration: number; text: string }));
      const [projection, projectionMs] = measured(() => JSON.stringify(parsed.map((r, i) => ({ id: i, round: r.iteration, characters: r.text.length }))));
      const beforeCheckpoint = footprint();
      const [checkpointResult, checkpointMs] = measured(() => checkpoint === 'passive' ? db!.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() : null);
      samples.push({ round, rows: records.length, sqlWriteMs, sqlReadMs, jsonMs, projectionMs, checkpointMs,
        projectionBytes: Buffer.byteLength(projection), projectionDigest: createHash('sha256').update(projection).digest('hex'),
        beforeCheckpoint, footprint: footprint(), checkpointResult, rssBytes: process.memoryUsage().rss });
    }
    return { version: 1, scope: 'synthetic-local-only', causal503Evidence: false, longSoak: false,
      options: { rounds, rows, payloadBytes, checkpoint }, budgets: { maxDiskBytes, minimumFreeBytes, maxDurationMs: 10_000 },
      durationMs: performance.now() - started, cpuMicros: process.cpuUsage(cpu), baseline, stopped, samples };
  } finally {
    // This exact fresh directory belongs solely to this experiment.
    try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
