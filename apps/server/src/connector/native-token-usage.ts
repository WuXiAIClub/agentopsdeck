import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { NATIVE_TOKEN_EXPORT_LIMIT, validateNativeTokenUsageExport } from '@agentopsdeck/shared';
import type { NativeCumulativeCoverage, NativeTokenCounts, NativeTokenUsage } from '@agentopsdeck/shared';
import { nativeModelId, tokenUsageRange, validateNativeCumulativeCoverage, validateNativeTokenUsage } from '@agentopsdeck/shared';
import { NativeTokenSnapshotStore } from './native-token-snapshots.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';

type Runtime = NativeTokenUsage['runtime'];
export class NativeTokenExportTooLarge extends Error { constructor() { super('Shorten the token export period'); } }
const cacheFields = ['cacheReadTokens', 'cacheWriteTokens'] as const;
type CacheHighWater = Partial<Pick<NativeTokenCounts, typeof cacheFields[number]>>;
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
export function nativeTokenCounts(value: unknown): NativeTokenCounts | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (!integer(row.inputTokens) || !integer(row.outputTokens)
    || ['cacheReadTokens', 'cacheWriteTokens'].some(key => row[key] !== undefined && !integer(row[key]))) return;
  return { inputTokens: row.inputTokens, outputTokens: row.outputTokens,
    ...(row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens as number } : {}),
    ...(row.cacheWriteTokens !== undefined ? { cacheWriteTokens: row.cacheWriteTokens as number } : {}) };
}

/** Uses the existing sole SQLite owner. Small numeric rows, session/time index;
 * never reads transcripts on GET, opens a second DB, or updates execution. */
export class NativeTokenUsageStore {
  // Opt-in internal operation: ordinary collection and GETs create no archive.
  private snapshotStore?: NativeTokenSnapshotStore;
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now,
    private readonly snapshotAdmission?: <T>(bytes: number, write: () => T extends PromiseLike<unknown> ? never : T) => T,
    private readonly asyncSnapshotAdmission?: <T>(bytes: number, write: () => Promise<T>) => Promise<T>) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_token_samples (
      runtime TEXT NOT NULL, session_key TEXT NOT NULL, event_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read INTEGER, cache_write INTEGER, PRIMARY KEY(runtime,session_key,event_id));
      CREATE INDEX IF NOT EXISTS native_token_samples_time ON native_token_samples(runtime,session_key,observed_at);
      CREATE TABLE IF NOT EXISTS native_token_baselines (
        runtime TEXT NOT NULL, session_key TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(runtime,session_key));`);
    if (!db.prepare('PRAGMA table_info(native_token_samples)').all().some(row => row.name === 'model')) {
      db.exec('ALTER TABLE native_token_samples ADD COLUMN model TEXT');
    }
  }
  record(runtime: Runtime, key: string, eventId: string, counts: NativeTokenCounts, model?: string, observedAt = this.now()) {
    if (!['codex', 'claude-code', 'ghcp', 'antigravity'].includes(runtime) || !key.startsWith(`${runtime}:`) || !eventId || eventId.length > 1024 || !nativeTokenCounts(counts)) throw Error('Invalid native token observation');
    if (!integer(observedAt)) throw Error('Invalid native observation time');
    if (model !== undefined && !nativeModelId(model)) throw Error('Invalid native model');
    this.db.prepare('INSERT OR IGNORE INTO native_token_samples(runtime,session_key,event_id,observed_at,input_tokens,output_tokens,cache_read,cache_write,model) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(runtime, key, eventId, observedAt, counts.inputTokens, counts.outputTokens, counts.cacheReadTokens ?? null, counts.cacheWriteTokens ?? null, model ?? null);
  }
  /** First cumulative counter is a baseline, NOT usage charged to this hour.
   * Replays/decreases retain a high-water mark, not a guessed reset boundary. */
  cumulative(key: string, turnId: string, counts: NativeTokenCounts) {
    if (!key.startsWith('codex:') || !turnId || turnId.length > 512 || !nativeTokenCounts(counts)) return;
    this.atomicCumulative(() => {
      const row = this.db.prepare('SELECT data FROM native_token_baselines WHERE runtime=? AND session_key=?').get('codex', key) as { data: string } | undefined;
      const stored = row ? JSON.parse(row.data) : undefined;
      const previous = row ? nativeTokenCounts(stored) : undefined;
      if (row && !previous) throw Error('Invalid native token baseline');
      const now = this.now();
      if (!integer(now) || now > 8_640_000_000_000_000) throw Error('Invalid native observation time');
      const coverage: NativeCumulativeCoverage = stored?.coverage !== undefined ? validateNativeCumulativeCoverage(stored.coverage)
        : validateNativeCumulativeCoverage({ trackedSince: now, initialBaseline: previous ? null : { ...counts, observedAt: now }, lastRegressionAt: null, lastCacheGapAt: null });
      // A wall-clock reversal must not produce an invalid or earlier diagnostic.
      // These timestamps are collection evidence, never reassigned usage time.
      const diagnosticAt = Math.max(now, coverage.trackedSince, coverage.lastRegressionAt ?? 0, coverage.lastCacheGapAt ?? 0);
      // Last observation and lifetime cache watermark are distinct: absent
      // telemetry breaks delta continuity, but cannot erase replay protection.
      // Older baseline rows have no cacheHighWater and remain readable.
      const highWater: CacheHighWater = {};
      if (stored?.cacheHighWater !== undefined) {
        const value = stored.cacheHighWater;
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.entries(value).some(([field, n]) => !cacheFields.includes(field as typeof cacheFields[number]) || !integer(n))) {
          throw Error('Invalid native token baseline cache watermark');
        }
        Object.assign(highWater, value);
      }
      for (const field of cacheFields) {
        if (previous?.[field] !== undefined) highWater[field] = Math.max(highWater[field] ?? 0, previous[field]!);
      }
      // Lower counters may be delayed samples or native resets. Retain the high
      // water mark: undercount explicitly rather than invent/double count usage.
      const regressed = previous && (counts.inputTokens < previous.inputTokens || counts.outputTokens < previous.outputTokens
        || cacheFields.some(field => counts[field] !== undefined && highWater[field] !== undefined && counts[field]! < highWater[field]!));
      // Missing cache fields on an otherwise accepted observation break delta
      // continuity. Never infer a zero cache delta after telemetry resumes.
      if (!regressed && previous && cacheFields.some(field => (previous[field] === undefined) !== (counts[field] === undefined))) coverage.lastCacheGapAt = diagnosticAt;
      if (regressed) {
        coverage.lastRegressionAt = diagnosticAt;
        const next = JSON.stringify({ ...stored, coverage });
        if (next !== row!.data) this.db.prepare('UPDATE native_token_baselines SET data=? WHERE runtime=? AND session_key=?').run(next, 'codex', key);
        return;
      }
      if (previous) {
        const delta: NativeTokenCounts = { inputTokens: counts.inputTokens - previous.inputTokens, outputTokens: counts.outputTokens - previous.outputTokens };
        for (const field of cacheFields) {
          if (counts[field] !== undefined && previous[field] !== undefined && counts[field]! >= previous[field]!) delta[field] = counts[field]! - previous[field]!;
        }
        if (Object.values(delta).some(value => value > 0)) this.record('codex', key, JSON.stringify([turnId, counts.inputTokens, counts.outputTokens, counts.cacheReadTokens ?? null, counts.cacheWriteTokens ?? null]), delta);
      }
      for (const field of cacheFields) if (counts[field] !== undefined) highWater[field] = counts[field];
      this.db.prepare('INSERT INTO native_token_baselines VALUES(?,?,?,?) ON CONFLICT(runtime,session_key) DO UPDATE SET data=excluded.data')
        .run('codex', key, now, JSON.stringify({ ...counts, cacheHighWater: highWater, coverage }));
    });
  }
  private atomicCumulative(update: () => void) {
    // A caller can catch an I/O/constraint error and still commit its own
    // transaction. The delta and baseline must remain atomic in that case too.
    observedSavepoint(this.db, 'native-token-cumulative', update);
  }
  readSnapshot(runtime: Runtime, key: string, requestId: string) {
    const snapshots = this.snapshotStore ??= new NativeTokenSnapshotStore(this.db, this.now, this.snapshotAdmission, this.asyncSnapshotAdmission);
    return snapshots.read(runtime, key, requestId);
  }
  snapshot(runtime: Runtime, key: string, requestId: string, from: number, to: number, bucketMs: number) {
    const snapshots = this.snapshotStore ??= new NativeTokenSnapshotStore(this.db, this.now, this.snapshotAdmission, this.asyncSnapshotAdmission);
    return snapshots.create({ runtime, key, requestId, from, to, bucketMs }, () => this.export(runtime, key, from, to, bucketMs));
  }
  snapshotAsync(runtime: Runtime, key: string, requestId: string, from: number, to: number, bucketMs: number, check?: () => void,
    commit?: import('../auth/application-transaction-gate.js').OriginalTransactionWrite) {
    const snapshots = this.snapshotStore ??= new NativeTokenSnapshotStore(this.db, this.now, this.snapshotAdmission, this.asyncSnapshotAdmission);
    return snapshots.createAsync({ runtime, key, requestId, from, to, bucketMs }, () => this.export(runtime, key, from, to, bucketMs), check, commit);
  }
  export(runtime: Runtime, key: string, from: number, to: number, bucketMs: number) {
    // Reuse the exact range validator before SQL. No raw event/session IDs leave
    // the sole DB owner. Synchronous reads cannot interleave with its writes;
    // row-vs-summary reconciliation also rejects an inconsistent snapshot.
    tokenUsageRange(from, to, bucketMs);
    if (!['codex', 'claude-code', 'ghcp', 'antigravity'].includes(runtime) || !key.startsWith(`${runtime}:`)) throw Error('Invalid native token runtime');
    const rows = this.db.prepare(`SELECT event_id, observed_at, model, input_tokens, output_tokens, cache_read, cache_write
      FROM native_token_samples WHERE runtime=? AND session_key=? AND observed_at>=? AND observed_at<?
      ORDER BY observed_at,event_id LIMIT ?`).all(runtime, key, from, to, NATIVE_TOKEN_EXPORT_LIMIT + 1);
    if (rows.length > NATIVE_TOKEN_EXPORT_LIMIT) throw new NativeTokenExportTooLarge();
    const usage = this.range(runtime, key, from, to, bucketMs);
    const observations = rows.map(row => ({
      identity: createHash('sha256').update(JSON.stringify([runtime, key, row.event_id])).digest('hex'),
      observedAt: row.observed_at, model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read, cacheWriteTokens: row.cache_write,
    }));
    return validateNativeTokenUsageExport({ version: 1, usage, observations });
  }
  range(runtime: Runtime, key: string, from: number, to: number, bucketMs: number): NativeTokenUsage {
    if (!['codex', 'claude-code', 'ghcp', 'antigravity'].includes(runtime) || !key.startsWith(`${runtime}:`)
      || !integer(from) || !integer(to) || to <= from || to - from > 31 * 86_400_000
      ) throw Error('Invalid token usage range');
    tokenUsageRange(from, to, bucketMs);
    const first = this.db.prepare('SELECT MIN(observed_at) AS at FROM native_token_samples WHERE runtime=? AND session_key=?').get(runtime, key) as { at: number | null };
    // One bounded grouping scan supplies both model rows and bucket totals.
    // Folding must preserve unknown cache counts and reject unsafe sums; a
    // second aggregate scan would double read work and can observe other writes.
    const byModel = this.db.prepare(`SELECT CAST(observed_at / ? AS INTEGER) * ? AS at, model, COUNT(*) AS samples,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
      CASE WHEN COUNT(cache_read)=COUNT(*) THEN SUM(cache_read) ELSE NULL END AS cacheReadTokens,
      CASE WHEN COUNT(cache_write)=COUNT(*) THEN SUM(cache_write) ELSE NULL END AS cacheWriteTokens
      FROM native_token_samples WHERE runtime=? AND session_key=? AND observed_at>=? AND observed_at<?
      GROUP BY at,model ORDER BY at,model LIMIT 8193`).all(bucketMs, bucketMs, runtime, key, from, to);
    if (byModel.length > 8192) throw Error('Native model bucket budget exceeded');
    const indexed = new Map<number, NativeTokenUsage['buckets'][number]>();
    for (const row of byModel) {
      const { at, ...model } = row;
      for (const [field, value] of Object.entries(row)) if (field !== 'model' && value !== null && !integer(value)) throw Error('Native token total exceeds numeric precision');
      let bucket = indexed.get(Number(at));
      if (!bucket) {
        bucket = { at: Number(at), samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [] };
        indexed.set(bucket.at, bucket);
      }
      for (const field of ['samples', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        const value = row[field];
        if (field === 'cacheReadTokens' || field === 'cacheWriteTokens') {
          if (bucket[field] === null || value === null) { bucket[field] = null; continue; }
        }
        const total = bucket[field]! + Number(value);
        if (!integer(total)) throw Error('Native token total exceeds numeric precision');
        bucket[field] = total;
      }
      bucket.models!.push(model as NonNullable<NativeTokenUsage['buckets'][number]['models']>[number]);
    }
    const buckets = [...indexed.values()];
    const baseline = runtime === 'codex' ? this.db.prepare('SELECT data FROM native_token_baselines WHERE runtime=? AND session_key=?').get(runtime, key) as { data: string } | undefined : undefined;
    const savedCoverage = baseline ? JSON.parse(baseline.data).coverage : undefined;
    const cumulativeCoverage = savedCoverage === undefined ? undefined : validateNativeCumulativeCoverage(savedCoverage);
    return validateNativeTokenUsage({ version: 1, runtime, attribution: 'root-agent', timeBasis: 'observed-at', coverage: 'partial',
      inputAccounting: runtime === 'codex' ? 'includes-cache' : runtime === 'claude-code' ? 'excludes-cache' : 'provider-defined',
      from, to, bucketMs, observedSince: first.at, buckets, ...(cumulativeCoverage ? { cumulativeCoverage } : {}) });
  }
}
