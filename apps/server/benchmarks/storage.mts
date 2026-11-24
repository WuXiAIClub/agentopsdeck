/** Opt-in, real populated SQLite capacity fixture. Never accepts a database
 * path: the only database opened is in a newly allocated temporary directory.
 * Run: node --import tsx benchmarks/storage.mts --mib=1536
 * Uses production schemas/readers and formal SDK appends for write probes;
 * bulk seed is synthetic transcript data, not native model execution. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn, setTimeout as pause } from 'node:timers/promises';
import { createServer } from 'node:http';
import { ClaudeTranscriptStore } from '../src/claude/transcript-store.js';
import { CopilotTranscriptStore } from '../src/copilot/transcript-store.js';
import { projectClaudeMessage } from '../src/claude/message-projection.js';
import { projectCopilotMessage } from '../src/copilot/message-projection.js';
import { TurnQueue } from '../src/commands/turn-queue.js';
import { SdkExecutionJournal } from '../src/connector/sdk-execution-journal.js';

const MiB = 1024 ** 2, reserve = 4096 * MiB;
const args = process.argv.slice(2);
assert.ok(args.length <= 3 && args.every(a => /^--(mib|mixed-seconds|viewers)=\d+$/.test(a))
  && new Set(args.map(a => a.split('=')[0])).size === args.length, 'Only --mib=N, --mixed-seconds=N and --viewers=N are accepted');
const targetMiB = Number(args.find(a => a.startsWith('--mib='))?.split('=')[1] ?? 128);
const mixedSeconds = Number(args.find(a => a.startsWith('--mixed-seconds='))?.split('=')[1] ?? 0);
const viewerCount = Number(args.find(a => a.startsWith('--viewers='))?.split('=')[1] ?? 16);
assert.ok(Number.isSafeInteger(targetMiB) && targetMiB >= 16 && targetMiB <= 10240);
assert.ok(Number.isSafeInteger(mixedSeconds) && mixedSeconds >= 0 && mixedSeconds <= 60);
assert.ok(Number.isSafeInteger(viewerCount) && viewerCount >= 1 && viewerCount <= 64);
const free = (dir: string) => { const s = statfsSync(dir); return s.bavail * s.bsize; };
assert.ok(free(tmpdir()) > reserve + targetMiB * MiB * 1.2 + 128 * MiB, 'Insufficient headroom; no fixture created');
const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-storage-capacity-'));
const file = join(dir, 'synthetic.sqlite');
let db: DatabaseSync | undefined;
const text = 'Unicode 测试 🐟 '.repeat(28);
const results: unknown[] = [];
const round = (n: number) => Math.round(n * 1000) / 1000;
const pages = () => Number(db!.prepare('PRAGMA page_count').get()!.page_count);
const allocated = () => pages() * Number(db!.prepare('PRAGMA page_size').get()!.page_size);
const timed = <T>(fn: () => T) => { const t = performance.now(); const value = fn(); return { value, ms: performance.now() - t }; };
function distribution(fn: () => unknown, count = 30) {
  const samples = Array.from({ length: count }, () => timed(fn).ms).sort((a, b) => a - b);
  return { p50: round(samples[Math.floor(count * .5)]!), p95: round(samples[Math.floor(count * .95)]!), max: round(samples.at(-1)!) };
}
function stores() {
  const turns = new TurnQueue(db!);
  const refs = Object.fromEntries((['claude-code', 'ghcp'] as const).map(runtime => {
    const journal = new SdkExecutionJournal(db!, runtime), key = `${runtime}:capacity`;
    const ref = { key, id: 'capacity-execution', epoch: 'epoch' };
    if (!journal.session(key)) {
      journal.create({ key, nativeSessionId: 'native', title: 'Synthetic capacity', createdAt: 0 });
      turns.enqueue(runtime, { id: 'admission', sessionKey: key, payload: { text: 'Synthetic' }, createdAt: 0 });
      journal.begin(ref, ['admission'], turns);
    }
    return [runtime, ref];
  }));
  const cc = new ClaudeTranscriptStore(db!), ghcp = new CopilotTranscriptStore(db!);
  const append = (id: string) => {
    cc.append(refs['claude-code']!, projectClaudeMessage({ type: 'assistant', uuid: id, session_id: 'native',
      parent_tool_use_id: null, message: { role: 'assistant', content: text } }, 'native'));
    ghcp.append(refs.ghcp!, projectCopilotMessage({ id, type: 'assistant.message', timestamp: new Date(1).toISOString(),
      data: { messageId: id, content: text } })!);
  };
  return { cc, ghcp, append };
}
async function httpProbe(s: ReturnType<typeof stores>, expected: number) {
  const server = createServer((req, res) => {
    try {
      const page = req.url === '/cc' ? s.cc.pageBlocks('claude-code:capacity')! : s.ghcp.page('ghcp:capacity')!;
      assert.equal(page.totalCount, expected);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(page));
    } catch { res.statusCode = 500; res.end('synthetic probe failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const samples = [];
  try {
    for (const viewers of [...new Set([1, 6, viewerCount])]) {
      const latencies: number[] = []; let bytes = 0;
      const start = performance.now();
      for (let wave = 0; wave < 5; wave++) await Promise.all(Array.from({ length: viewers }, async (_, i) => {
        const started = performance.now();
        const res = await fetch(`http://127.0.0.1:${address.port}/${i % 2 ? 'ghcp' : 'cc'}`);
        assert.equal(res.status, 200); const body = await res.text();
        assert.equal(JSON.parse(body).totalCount, expected); bytes += Buffer.byteLength(body);
        latencies.push(performance.now() - started);
      }));
      latencies.sort((a, b) => a - b);
      samples.push({ viewers, requests: latencies.length, bytes, wallMs: round(performance.now() - start),
        p50Ms: round(latencies[Math.floor(latencies.length * .5)]!), p95Ms: round(latencies[Math.floor(latencies.length * .95)]!) });
    }
    return samples;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}
/** Closed-loop concurrency (not an unlimited offered-rate test). The single
 * owner serializes each synchronous read/append, while HTTP bodies are in
 * flight. No extra SQLite connection or production endpoint is involved. */
async function mixedProbe(s: ReturnType<typeof stores>, initial: number) {
  let expected = initial, requests = 0, bytes = 0, stopped = false;
  const latencies: number[] = [], writes: number[] = [];
  const server = createServer((req, res) => {
    try {
      const page = req.url === '/cc' ? s.cc.pageBlocks('claude-code:capacity')! : s.ghcp.page('ghcp:capacity')!;
      assert.equal(page.totalCount, expected); assert.equal(page.messages.length, 200);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(page));
    } catch { res.statusCode = 500; res.end('synthetic mixed probe failed'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const start = performance.now(), until = start + mixedSeconds * 1000;
  const active = () => !stopped && performance.now() < until;
  const workers = Array.from({ length: viewerCount }, async (_, i) => {
    let last = initial;
    while (active()) {
      const t = performance.now();
      const res = await fetch(`http://127.0.0.1:${address.port}/${i % 2 ? 'ghcp' : 'cc'}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(res.status, 200); const body = await res.text(), page = JSON.parse(body);
      assert.ok(page.totalCount >= last && page.totalCount <= expected);
      last = page.totalCount; requests++; bytes += Buffer.byteLength(body); latencies.push(performance.now() - t);
    }
  });
  workers.push((async () => {
    while (active()) {
      await pause(50);
      if (!active()) break;
      assert.ok(free(dir) > reserve + 32 * MiB, 'Operational reserve reached during mixed load');
      const t = performance.now(); s.append(`mixed-${writes.length}`); writes.push(performance.now() - t); expected++;
    }
  })());
  try {
    await Promise.all(workers);
    assert.ok(requests >= viewerCount && writes.length >= 2);
    for (const table of ['claude_transcript_messages', 'copilot_transcript_messages']) {
      assert.equal(db!.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, expected);
    }
    assert.equal(s.cc.pageBlocks('claude-code:capacity')!.totalCount, expected);
    assert.equal(s.ghcp.page('ghcp:capacity')!.totalCount, expected);
    latencies.sort((a, b) => a - b); writes.sort((a, b) => a - b);
    return { viewers: viewerCount, requests, bytes, appendPairs: writes.length, expected,
      wallMs: round(performance.now() - start), p50Ms: round(latencies[Math.floor(latencies.length * .5)]!),
      p95Ms: round(latencies[Math.floor(latencies.length * .95)]!), appendPairP95Ms: round(writes[Math.floor(writes.length * .95)]!) };
  } finally {
    stopped = true; server.closeAllConnections();
    await Promise.allSettled(workers);
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}
try {
  db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384;
    PRAGMA max_page_count=${Math.ceil((targetMiB + 128) * MiB / 4096)}`);
  let s = stores(); s.append('template');
  const ccTemplate = JSON.parse(String(db.prepare('SELECT data FROM claude_transcript_messages LIMIT 1').get()!.data));
  const ghcpTemplate = JSON.parse(String(db.prepare('SELECT data FROM copilot_transcript_messages LIMIT 1').get()!.data));
  const ccInsert = db.prepare(`INSERT INTO claude_transcript_messages
    (session_key,execution_id,native_session_id,message_id,parent_id,data,created_at) VALUES ('claude-code:capacity','capacity-execution','native',?,'',?,1)`);
  const ghcpInsert = db.prepare(`INSERT INTO copilot_transcript_messages
    (session_key,public_id,native_session_id,execution_id,event_id,data) VALUES ('ghcp:capacity',?,'native','capacity-execution',?,?)`);
  const checkpoints = [...new Set([Math.min(128, targetMiB), Math.min(768, targetMiB), targetMiB])];
  let n = 0;
  for (const mib of checkpoints) {
    const start = performance.now();
    while (allocated() < mib * MiB) {
      assert.ok(free(dir) > reserve + 32 * MiB, 'Headroom reached; stopping before operational reserve');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let i = 0; i < 256; i++) {
          const id = `synthetic-${n++}`;
          const ccData = ccTemplate.map((r: Record<string, unknown>) => ({ ...r, nativeMessageId: id }));
          ccInsert.run(id, JSON.stringify(ccData));
          ghcpInsert.run(id, id, JSON.stringify({ ...ghcpTemplate, id }));
        }
        db.exec('COMMIT');
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
      await yieldTurn();
    }
    const checkpoint = timed(() => db!.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    assert.equal(checkpoint.value!.busy, 0);
    let expected = n + 1;
    const readCC = () => { const p = s.cc.pageBlocks('claude-code:capacity')!; assert.equal(p.totalCount, expected); assert.equal(p.messages.length, 200); return p; };
    const readGHCP = () => { const p = s.ghcp.page('ghcp:capacity')!; assert.equal(p.totalCount, expected); assert.equal(p.messages.length, 200); return p; };
    const ccCount = db.prepare(`SELECT sum(json_array_length(data)) FROM claude_transcript_messages
      INDEXED BY claude_transcript_block_counts WHERE session_key=? AND sequence<?`);
    const ghcpCount = db.prepare('SELECT count(*) FROM copilot_transcript_messages WHERE session_key=? AND sequence<?');
    const firstCC = timed(readCC), firstGHCP = timed(readGHCP);
    const newest = { cc: distribution(readCC), ghcp: distribution(readGHCP) };
    const countScan = { cc: distribution(() => ccCount.get('claude-code:capacity', Number.MAX_SAFE_INTEGER)),
      ghcp: distribution(() => ghcpCount.get('ghcp:capacity', Number.MAX_SAFE_INTEGER)) };
    // First older page: same public cursor and hidden-count invariants as HTTP.
    const ccAnchor = { nativeMessageId: firstCC.value.messages[0]!.nativeMessageId, parentToolUseId: null, blockIndex: 0 };
    const ghcpAnchor = firstGHCP.value.messages[0]!.id;
    assert.equal(s.cc.pageBlocks('claude-code:capacity', 200, ccAnchor)!.hiddenCount, expected - 400);
    assert.equal(s.ghcp.page('ghcp:capacity', 200, ghcpAnchor)!.hiddenCount, expected - 400);
    const older = { cc: distribution(() => s.cc.pageBlocks('claude-code:capacity', 200, ccAnchor), 10),
      ghcp: distribution(() => s.ghcp.page('ghcp:capacity', 200, ghcpAnchor), 10) };
    let writes = 0;
    const appendPair = distribution(() => { s.append(`probe-${mib}-${writes++}`); expected++; }, 10);
    // Match later stages' template + synthetic + formal write count.
    n += writes;
    const report = { mib, populatedBytes: allocated(), rowsPerAgent: expected, seedMs: round(performance.now() - start),
      firstReadMs: { cc: round(firstCC.ms), ghcp: round(firstGHCP.ms) }, newest, older, countScan, appendPair,
      responseBytes: { cc: Buffer.byteLength(JSON.stringify(firstCC.value)), ghcp: Buffer.byteLength(JSON.stringify(firstGHCP.value)) },
      checkpointMs: round(checkpoint.ms), walBytes: statSync(file + '-wal').size, freeBytes: free(dir) };
    results.push(report); console.log(JSON.stringify({ stage: report }));
  }
  const http = await httpProbe(s, n + 1);
  const mixed = mixedSeconds ? await mixedProbe(s, n + 1) : undefined;
  const readTimings = { cc: s.cc.readStats(), ghcp: s.ghcp.readStats() };
  if (mixed) n = mixed.expected - 1;
  // Measure the first-install path on this populated synthetic DB, not merely
  // new-empty DB startup. No production DB path can reach this harness.
  for (const table of ['claude_transcript_messages', 'copilot_transcript_messages']) {
    for (const type of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER IF EXISTS ${table}_count_${type}`);
  }
  db.exec('DROP TABLE IF EXISTS sdk_transcript_counts; DROP TABLE IF EXISTS sdk_transcript_counts_bootstrap');
  const migration = timed(stores); s = migration.value;
  assert.equal(s.cc.pageBlocks('claude-code:capacity')!.totalCount, n + 1);
  assert.equal(s.ghcp.page('ghcp:capacity')!.totalCount, n + 1);
  const integrity = timed(() => db!.prepare('PRAGMA quick_check').get());
  assert.equal(integrity.value!.quick_check, 'ok');
  db.close(); db = new DatabaseSync(file);
  const reopen = timed(stores); s = reopen.value;
  assert.equal(s.cc.pageBlocks('claude-code:capacity')!.totalCount, n + 1);
  assert.equal(s.ghcp.page('ghcp:capacity')!.totalCount, n + 1);
  console.log(JSON.stringify({ passed: true, node: process.version, synthetic: true, reopenMs: round(reopen.ms),
    migrationMs: round(migration.ms), integrityMs: round(integrity.ms), http, mixed, results, readTimings,
    scope: 'Isolated Linux SQLite, two SDK projection stores, single owner. Not live HTTP/models, Windows, physical ENOSPC or long soak.' }));
} finally {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
}
