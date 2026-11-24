/** Isolated coordinator cost, not an end-to-end UI benchmark. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeAdmission } from '../src/storage/volume-admission.js';

for (const disk of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-admission-bench-'));
  const db = new DatabaseSync(disk ? join(root, 'ledger.sqlite') : ':memory:');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
  let ddl = 0;
  const exec = db.exec.bind(db);
  db.exec = sql => { if (sql.includes('CREATE TABLE')) ddl++; return exec(sql); };
  const times: number[] = [];
  try {
    for (let i = 0; i < 500; i++) {
      const started = performance.now();
      new VolumeAdmission(db, root, Date.now, () => 4n * 1024n ** 3n).runSync('durable', 1024, () => {});
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ disk, operations: times.length, ddl,
      totalMs: times.reduce((a, b) => a + b, 0), p50Ms: times[250], p95Ms: times[475] }));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
