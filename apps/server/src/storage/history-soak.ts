import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export type HistorySoakOptions = {
  durationMs: number; intervalMs?: number; concurrency?: number; rowsPerAppend?: number;
  payloadBytes?: number; checkpoint?: 'none' | 'passive';
};
type Timings = { sqlMs: number; jsonMs: number; projectionMs: number };
const maxDiskBytes = 64 * 1024 ** 2, headroom = 512 * 1024 ** 2;
const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
/** Controlled HTTP/append/WAL experiment on a freshly-created synthetic DB.
 * Never opens a user path or native history. Reopen != an OS cold-cache flush.
 * Retains only bounded aggregates; no message text/paths in returned evidence.
 * All writes are bounded before dispatch; OS ENOSPC still terminates the run.
 */
export async function runHistorySoak(input: HistorySoakOptions,
  observe: (sample: Readonly<Record<string, number>>) => void = () => {}, signal?: AbortSignal) {
  const { durationMs, intervalMs = 1000, concurrency = 4, rowsPerAppend = 16, payloadBytes = 512, checkpoint = 'passive' } = input;
  if (Object.keys(input).some(k => !['durationMs', 'intervalMs', 'concurrency', 'rowsPerAppend', 'payloadBytes', 'checkpoint'].includes(k))
    || !integer(durationMs, 100, 8 * 3600_000) || !integer(intervalMs, 25, 60_000) || !integer(concurrency, 1, 8)
    || !integer(rowsPerAppend, 1, 64) || !integer(payloadBytes, 1, 4096) || !['none', 'passive'].includes(checkpoint)) throw Error('soak-budget');
  const free = () => { const s = statfsSync(tmpdir()); return s.bavail * s.bsize; };
  if (free() < headroom) throw Error('soak-headroom');
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-soak-')), path = join(directory, 'fixture.sqlite');
  let db: DatabaseSync | undefined, reader: DatabaseSync | undefined;
  const connect = () => {
    db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=250');
    db.exec('CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    reader = new DatabaseSync(path); reader.exec('PRAGMA busy_timeout=250');
  };
  const sizes = () => Object.fromEntries(['', '-wal', '-shm'].map((suffix, i) => {
    try { return [['dbBytes', 'walBytes', 'shmBytes'][i]!, statSync(path + suffix).size]; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return [['dbBytes', 'walBytes', 'shmBytes'][i]!, 0]; }
  }));
  let httpRequests = 0, active = 0, peakConcurrent = 0;
  const timings: Timings = { sqlMs: 0, jsonMs: 0, projectionMs: 0 };
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/synthetic-history') { res.writeHead(404).end(); return; }
    active++; peakConcurrent = Math.max(peakConcurrent, active);
    try {
      // Intentional bounded overlap before synchronous DB stage. This is not
      // evidence of SQLite parallel execution or production queue behaviour.
      await delay(2);
      let at = performance.now();
      const rows = reader!.prepare('SELECT id,payload FROM samples ORDER BY id DESC LIMIT 256').all();
      timings.sqlMs += performance.now() - at; at = performance.now();
      const parsed = rows.map(r => ({ id: r.id, value: JSON.parse(String(r.payload)) as { iteration: number; text: string } }));
      timings.jsonMs += performance.now() - at; at = performance.now();
      const body = JSON.stringify({ count: parsed.length, rows: parsed.map(r => ({ id: r.id, iteration: r.value.iteration, characters: r.value.text.length })) });
      timings.projectionMs += performance.now() - at; httpRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
    } catch { res.writeHead(503).end(); }
    finally { active--; }
  });
  let rounds = 0, appended = 0, warmReads = 0, reopened = 0, retainedReaderRounds = 0, checkpointLagRounds = 0;
  let sqlWriteMs = 0, httpMs = 0, checkpointMs = 0, maxRssBytes = process.memoryUsage().rss, maxFootprint = 0;
  let stopped = 'duration-budget';
  const started = performance.now(), cpu = process.cpuUsage();
  try {
    connect();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('soak-listener');
    const url = `http://127.0.0.1:${address.port}/synthetic-history`;
    while (performance.now() - started < durationMs) {
      if (signal?.aborted) { stopped = 'aborted'; break; }
      if (free() < headroom) { stopped = 'low-space'; break; }
      const footprint = Object.values(sizes()).reduce((a, b) => a + b, 0);
      if (footprint + rowsPerAppend * (payloadBytes + 8192) + 1024 * 1024 > maxDiskBytes) { stopped = 'disk-budget'; break; }
      if (rounds % 8 === 0) { reader!.exec('BEGIN'); reader!.prepare('SELECT count(*) FROM samples').get(); }
      if (reader!.isTransaction) retainedReaderRounds++;
      const payload = JSON.stringify({ iteration: rounds, text: 'x'.repeat(payloadBytes) });
      let at = performance.now(); db!.exec('BEGIN IMMEDIATE');
      try {
        const write = db!.prepare('INSERT INTO samples VALUES(?,?)');
        for (let i = 0; i < rowsPerAppend; i++) write.run(++appended, payload);
        db!.prepare('DELETE FROM samples WHERE id <= ?').run(appended - 4096);
        db!.exec('COMMIT');
      } catch (e) { if (db!.isTransaction) db!.exec('ROLLBACK'); throw e; }
      sqlWriteMs += performance.now() - at; at = performance.now();
      // Two batches over the same snapshot provide a warm-read control.
      for (let warm = 0; warm < 2; warm++) {
        await Promise.all(Array.from({ length: concurrency }, async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (response.status !== 200) throw Error('synthetic-http-failed');
          const body = await response.json() as { count: number };
          if (!integer(body.count, 0, 256)) throw Error('synthetic-response-invalid');
        }));
        if (warm) warmReads += concurrency;
      }
      httpMs += performance.now() - at;
      at = performance.now();
      if (checkpoint === 'passive') {
        const row = db!.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!;
        if (Number(row.log) > Number(row.checkpointed)) checkpointLagRounds++;
      }
      checkpointMs += performance.now() - at;
      if (rounds % 8 === 4 && reader!.isTransaction) reader!.exec('ROLLBACK');
      if (rounds % 32 === 31) { reader!.close(); db!.close(); connect(); reopened++; }
      rounds++;
      maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss);
      maxFootprint = Math.max(maxFootprint, ...[Object.values(sizes()).reduce((a, b) => a + b, 0)]);
      if (rounds === 1 || rounds % 60 === 0) observe({ rounds, elapsedMs: performance.now() - started, httpRequests, ...sizes(), maxRssBytes });
      const remaining = durationMs - (performance.now() - started);
      if (remaining > 0) try { await delay(Math.min(intervalMs, remaining), undefined, signal ? { signal } : {}); }
      catch (e) { if (!signal?.aborted) throw e; }
    }
    const elapsedMs = performance.now() - started;
    return { version: 1, scope: 'synthetic-loopback-only', causal503Evidence: false, osColdCache: false,
      longSoak: stopped === 'duration-budget' && elapsedMs >= 2 * 3600_000, stopped, elapsedMs,
      requested: { durationMs, intervalMs, concurrency, rowsPerAppend, payloadBytes, checkpoint },
      budgets: { maxDiskBytes, minimumFreeBytes: headroom, maxRows: 4096, maxReadRows: 256 },
      rounds, appended, httpRequests, warmReads, reopened, retainedReaderRounds, checkpointLagRounds, peakConcurrent,
      sqlWriteMs, httpMs, checkpointMs, ...timings, maxRssBytes, maxFootprint, cpuMicros: process.cpuUsage(cpu), finalFootprint: sizes() };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    try { reader?.close(); } finally { try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } }
  }
}
