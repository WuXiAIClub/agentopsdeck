import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tokenUsageRange, validateNativeTokenUsageExport } from '@agentopsdeck/shared';
import type { NativeTokenUsage, NativeTokenUsageExport } from '@agentopsdeck/shared';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import type { OriginalTransactionWrite } from '../auth/application-transaction-gate.js';

type Runtime = NativeTokenUsage['runtime'];
type Selection = { runtime: Runtime; key: string; requestId: string; from: number; to: number; bucketMs: number };
type ModelSummary = { model: string | null; samples: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number | null; cacheWriteTokens: number | null };
export type NativeTokenSnapshot = {
  version: 1; kind: 'local-ledger-snapshot'; requestId: string; createdAt: number;
  /** A member-set digest, NOT an upstream cursor or proof that an epoch closed. */
  memberDigest: string; modelsByKnowledge: ModelSummary[]; data: NativeTokenUsageExport;
};
// Bounded additive evidence, never a transcript archive. No automatic cleanup.
export const TOKEN_SNAPSHOT_LIMITS = { perSession: 16, total: 256, payloadBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 } as const;
export class NativeTokenSnapshotConflict extends Error { constructor() { super('Token snapshot request already has another selection'); } }
export class NativeTokenSnapshotLimit extends Error { constructor() { super('Token snapshot evidence budget exceeded'); } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function identity(runtime: Runtime, key: string, requestId: string) {
  if (!['codex', 'claude-code', 'ghcp', 'antigravity'].includes(runtime) || typeof key !== 'string' || !key.startsWith(`${runtime}:`)
    || key.length <= runtime.length + 1 || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)
    || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw Error('Invalid token snapshot identity');
}
function summary(data: NativeTokenUsageExport) {
  const groups = new Map<string, ModelSummary>();
  for (const row of data.observations) {
    // Unknown and known cache samples are separate; unknown is never zero.
    const key = JSON.stringify([row.model, row.cacheReadTokens !== null, row.cacheWriteTokens !== null]);
    const group = groups.get(key) ?? { model: row.model, samples: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: row.cacheReadTokens === null ? null : 0, cacheWriteTokens: row.cacheWriteTokens === null ? null : 0 };
    group.samples++;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      if (group[field] !== null) {
        const sum = group[field]! + row[field]!;
        if (!integer(sum)) throw Error('Token snapshot precision exceeded');
        group[field] = sum;
      }
    }
    groups.set(key, group);
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}
function digest(data: NativeTokenUsageExport) { return hash(JSON.stringify(data.observations.map(row => row.identity).sort())); }
type Row = { runtime: string; session_key: string; request_id: string; selection: string; payload: string; checksum: string };

/** Receives the existing owner connection. It never opens another DB or sends
 * requests. Callers must authorize writes before exposing snapshot creation. */
export class NativeTokenSnapshotStore {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now,
    private readonly storageAdmission?: <T>(bytes: number, write: () => T extends PromiseLike<unknown> ? never : T) => T,
    private readonly asyncAdmission?: <T>(bytes: number, write: () => Promise<T>) => Promise<T>) {}
  private ensureSchema() {
    // DDL belongs to the same transaction as the receipt. Never cache schema
    // existence: an outer caller may roll back its first snapshot (and DDL).
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_token_snapshots (
      runtime TEXT NOT NULL, session_key TEXT NOT NULL, request_id TEXT NOT NULL,
      selection TEXT NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL,
      PRIMARY KEY(runtime,session_key,request_id));
      CREATE TRIGGER IF NOT EXISTS native_token_snapshots_no_update BEFORE UPDATE ON native_token_snapshots
        BEGIN SELECT RAISE(ABORT,'Token snapshots are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS native_token_snapshots_no_delete BEFORE DELETE ON native_token_snapshots
        BEGIN SELECT RAISE(ABORT,'Token snapshots are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS native_token_snapshots_no_replace BEFORE INSERT ON native_token_snapshots
        WHEN EXISTS(SELECT 1 FROM native_token_snapshots WHERE runtime=NEW.runtime AND session_key=NEW.session_key AND request_id=NEW.request_id)
        BEGIN SELECT RAISE(ABORT,'Token snapshots are immutable'); END;`);
  }
  private row(runtime: Runtime, key: string, requestId: string) {
    return this.db.prepare('SELECT * FROM native_token_snapshots WHERE runtime=? AND session_key=? AND request_id=?')
      .get(runtime, key, requestId) as Row | undefined;
  }
  private decode(row: Row): NativeTokenSnapshot {
    if (Buffer.byteLength(row.payload) > TOKEN_SNAPSHOT_LIMITS.payloadBytes || hash(row.payload) !== row.checksum) throw Error('Invalid token snapshot integrity');
    const raw = JSON.parse(row.payload) as NativeTokenSnapshot;
    if (raw?.version !== 1 || raw.kind !== 'local-ledger-snapshot' || raw.requestId !== row.request_id
      || !integer(raw.createdAt) || raw.createdAt > 8_640_000_000_000_000) throw Error('Invalid token snapshot');
    const data = validateNativeTokenUsageExport(raw.data);
    if (data.usage.runtime !== row.runtime || row.selection !== JSON.stringify([data.usage.from, data.usage.to, data.usage.bucketMs])
      || raw.memberDigest !== digest(data) || JSON.stringify(raw.modelsByKnowledge) !== JSON.stringify(summary(data))) throw Error('Invalid token snapshot reconciliation');
    return { version: 1, kind: 'local-ledger-snapshot', requestId: raw.requestId, createdAt: raw.createdAt,
      memberDigest: raw.memberDigest, modelsByKnowledge: raw.modelsByKnowledge, data };
  }
  read(runtime: Runtime, key: string, requestId: string): NativeTokenSnapshot | undefined {
    identity(runtime, key, requestId);
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_token_snapshots'").get()) return undefined;
    const row = this.row(runtime, key, requestId.toLowerCase());
    return row ? this.decode(row) : undefined;
  }
  create(selection: Selection, readSelected: () => NativeTokenUsageExport): NativeTokenSnapshot {
    identity(selection.runtime, selection.key, selection.requestId);
    tokenUsageRange(selection.from, selection.to, selection.bucketMs);
    const write = () => this.createAdmitted(selection, readSelected);
    // A retry verifies immutable selection inside the original transaction but
    // never needs new-work headroom or scans the ledger again.
    if (this.read(selection.runtime, selection.key, selection.requestId)) return write();
    // Async-only owners must never silently create new work through this
    // legacy port. Receipt recovery above remains local and immutable.
    if (!this.storageAdmission && this.asyncAdmission) throw Error('async-admission-required');
    if (!this.storageAdmission) return write();
    if (this.db.isTransaction) throw Error('Snapshot admission requires owning transaction');
    return this.storageAdmission(TOKEN_SNAPSHOT_LIMITS.payloadBytes + 65536, write);
  }
  async createAsync(selection: Selection, readSelected: () => NativeTokenUsageExport, check: () => void = () => {},
    commit?: OriginalTransactionWrite): Promise<NativeTokenSnapshot> {
    const input = { ...selection };
    identity(input.runtime, input.key, input.requestId);
    tokenUsageRange(input.from, input.to, input.bucketMs);
    const trace = performanceDiagnostics.start('native-token-snapshot-admission');
    let failed = true, settled = false, active = true, entered = false;
    let step = 1;
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step, unknown: Number(settled) }), 30_000);
    warning.unref();
    let original: NativeTokenSnapshot | undefined;
    const started = performance.now();
    try {
      check();
      const existing = this.read(input.runtime, input.key, input.requestId);
      const write = () => {
        if (!active) throw new Error('Snapshot admission ended');
        if (entered) throw new Error('Snapshot admission writer already attempted');
        entered = true;
        check();
        if (this.db.isTransaction) throw Error('Snapshot admission requires owning transaction');
        step = 2;
        trace.add('queueMs', performance.now() - started);
        const at = performance.now();
        try {
          const result = this.createAdmitted(input, readSelected);
          original = result;
          settled = true; trace.add('settled', 1); return result;
        } finally { step = 3; trace.add('bodyMs', performance.now() - at); }
      };
      if (this.db.isTransaction) throw Error('Snapshot admission requires owning transaction');
      const bytes = TOKEN_SNAPSHOT_LIMITS.payloadBytes + 65536;
      // Auth is checked after capacity admission, immediately around the whole
      // original synchronous SQL write. No Promise enters the savepoint and no
      // identity fence is held while waiting for the volume owner.
      if (existing) commit ? await commit(write) : write();
      else if (this.asyncAdmission) await this.asyncAdmission(bytes, async () => commit ? await commit(write) : write());
      else {
        const admitted = () => this.storageAdmission ? this.storageAdmission(bytes, write) : write();
        commit ? await commit(admitted) : admitted();
      }
      if (!original) throw new Error('Snapshot admission writer was not committed');
      check(); requireConnectionReady(this.db);
      if (!this.db.isOpen) throw Error('Storage connection closed');
      failed = false; return original;
    } catch (error) {
      // SQL uncertainty is diagnosed by observedSavepoint. A settled receipt
      // followed by admission/delivery failure is unknown to this caller.
      if (settled) trace.add('unknown', 1);
      if (error instanceof StorageAdmissionDeferred) trace.add('deferred', 1);
      throw error;
    } finally { active = false; clearTimeout(warning); trace.finish(failed); }
  }
  private createAdmitted(selection: Selection, readSelected: () => NativeTokenUsageExport): NativeTokenSnapshot {
    const { runtime, key, from, to, bucketMs } = selection;
    identity(runtime, key, selection.requestId); tokenUsageRange(from, to, bucketMs);
    const requestId = selection.requestId.toLowerCase();
    const fingerprint = JSON.stringify([from, to, bucketMs]);
    // Keep membership, cumulative coverage and insertion in one SQLite snapshot.
    // Nested callers may catch errors and commit other work: use a savepoint.
    return observedSavepoint(this.db, 'native-token-snapshot', () => {
      this.ensureSchema();
      const existing = this.row(runtime, key, requestId);
      let result: NativeTokenSnapshot;
      if (existing) {
        if (existing.selection !== fingerprint) throw new NativeTokenSnapshotConflict();
        result = this.decode(existing); // A retry never rescans a changed ledger.
      } else {
        const count = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM native_token_snapshots').get() as { count: number; bytes: number };
        const scoped = this.db.prepare('SELECT COUNT(*) AS count FROM native_token_snapshots WHERE runtime=? AND session_key=?').get(runtime, key) as { count: number };
        if (count.count >= TOKEN_SNAPSHOT_LIMITS.total || scoped.count >= TOKEN_SNAPSHOT_LIMITS.perSession) throw new NativeTokenSnapshotLimit();
        const createdAt = this.now();
        if (!integer(createdAt) || createdAt > 8_640_000_000_000_000) throw Error('Invalid token snapshot time');
        const data = validateNativeTokenUsageExport(readSelected());
        if (data.usage.runtime !== runtime || JSON.stringify([data.usage.from, data.usage.to, data.usage.bucketMs]) !== fingerprint) throw Error('Token snapshot selection mismatch');
        result = { version: 1, kind: 'local-ledger-snapshot', requestId, createdAt, memberDigest: digest(data), modelsByKnowledge: summary(data), data };
        const payload = JSON.stringify(result), bytes = Buffer.byteLength(payload);
        if (bytes > TOKEN_SNAPSHOT_LIMITS.payloadBytes || count.bytes + bytes > TOKEN_SNAPSHOT_LIMITS.totalBytes) throw new NativeTokenSnapshotLimit();
        this.db.prepare('INSERT INTO native_token_snapshots VALUES(?,?,?,?,?,?)').run(runtime, key, requestId, fingerprint, payload, hash(payload));
      }
      return result;
    });
  }
}
