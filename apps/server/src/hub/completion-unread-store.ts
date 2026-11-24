import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubCompletionAction, HubCompletionAuthority, HubCompletionResult } from './member-completion-domain.js';

export class CompletionConflict extends Error {}
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const sequence = (n: number) => Number.isSafeInteger(n) && n >= 0;
type Target = { generation: string; latest: number; read_through: number; gap: number };
export const COMPLETION_LIMITS = { events: 10_000, targets: 1024, baselines: 4096, observations: 1024, acknowledgements: 10_000 };
export const completionTarget = (node: string, authority: number | string, remote: string) => createHash('sha256').update(JSON.stringify([node, authority, remote])).digest('hex');
export const connectionCompletionTarget = (node: string, connection: string, authority: number, remote: string) =>
  completionTarget(node, JSON.stringify([connection, authority]), remote);

/** U1 internal store. The caller must supply authenticated owner/target and a
 * trusted live completion adapter; this module never infers completion from UI,
 * history, animation, or a model response. No subscription is started here. */
export class CompletionUnreadStore {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  private check(...ids: string[]) { if (!ids.every(identity)) throw new CompletionConflict('identity'); }
  private schema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS completion_targets(owner TEXT, target TEXT, generation TEXT NOT NULL,
      latest INTEGER NOT NULL DEFAULT 0, read_through INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,target));
      CREATE TABLE IF NOT EXISTS completion_baselines(owner TEXT,target TEXT,epoch TEXT,cursor INTEGER NOT NULL,PRIMARY KEY(owner,target,epoch));
      CREATE TABLE IF NOT EXISTS completion_events(owner TEXT,target TEXT,epoch TEXT,turn_id TEXT,sequence INTEGER NOT NULL,
        PRIMARY KEY(owner,target,epoch,turn_id),UNIQUE(owner,sequence));
      CREATE TABLE IF NOT EXISTS completion_observations(owner TEXT,token TEXT,target TEXT,generation TEXT,ceiling INTEGER,expires INTEGER,PRIMARY KEY(owner,token));
      CREATE TABLE IF NOT EXISTS completion_acks(owner TEXT,request_id TEXT,target TEXT,token TEXT,through_sequence INTEGER,PRIMARY KEY(owner,request_id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS completion_runtime(owner TEXT,target TEXT,epoch TEXT,turn_id TEXT,stamp INTEGER,PRIMARY KEY(owner,target));`);
  }
  private transaction<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new CompletionConflict('outer-transaction');
    return observedTransaction(this.db, 'completion-unread-change', () => { this.schema(); return fn(); }, this.diagnostics);
  }
  private count(table: string, owner: string) { return Number(this.db.prepare(`SELECT count(*) n FROM ${table} WHERE owner=?`).get(owner)!.n); }
  private target(owner: string, target: string) { return this.db.prepare('SELECT * FROM completion_targets WHERE owner=? AND target=?').get(owner, target) as Target | undefined; }
  private exists() { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='completion_targets'").get(); }
  /** A disconnected feed (or Hub restart) has no complete-history proof.
   * Preserve observed unread/ACKs, invalidate witnesses, disclose the gap.
   * Owner-wide marking is deliberately conservative for partial node outages. */
  markGap(owner?: string) {
    if (!this.exists()) return;
    this.transaction(() => {
      if (owner !== undefined) {
        this.check(owner);
        this.db.prepare('UPDATE completion_targets SET gap=1 WHERE owner=?').run(owner);
        this.db.prepare('DELETE FROM completion_runtime WHERE owner=?').run(owner);
      } else {
        this.db.exec('UPDATE completion_targets SET gap=1; DELETE FROM completion_runtime;');
      }
    });
  }
  baseline(owner: string, target: string, epoch: string, cursor: number) {
    this.check(owner, target, epoch); if (!sequence(cursor)) throw new CompletionConflict('cursor');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT cursor FROM completion_baselines WHERE owner=? AND target=? AND epoch=?').get(owner, target, epoch);
      if (old) { if (old.cursor !== cursor) throw new CompletionConflict('baseline-reused'); return; }
      if (this.count('completion_baselines', owner) >= COMPLETION_LIMITS.baselines) throw new CompletionConflict('baseline-capacity');
      if (!this.target(owner, target)) {
        if (this.count('completion_targets', owner) >= COMPLETION_LIMITS.targets) throw new CompletionConflict('target-capacity');
        this.db.prepare('INSERT INTO completion_targets(owner,target,generation) VALUES(?,?,?)').run(owner, target, randomUUID());
      }
      this.db.prepare('INSERT INTO completion_baselines VALUES(?,?,?,?)').run(owner, target, epoch, cursor);
      // A new source baseline never clears existing unread or a known gap.
    });
  }
  record(input: { owner: string; target: string; epoch: string; turnId: string; sourceCursor: number; provenance: 'live-successful-message' }) {
    return this.transaction(() => this.recordWithin(input));
  }
  private recordWithin(input: { owner: string; target: string; epoch: string; turnId: string; sourceCursor: number; provenance: 'live-successful-message' }) {
    const { owner, target, epoch, turnId, sourceCursor } = input;
    this.check(owner, target, epoch, turnId);
    if (input.provenance !== 'live-successful-message' || !sequence(sourceCursor)) throw new CompletionConflict('untrusted-completion');
      const baseline = this.db.prepare('SELECT cursor FROM completion_baselines WHERE owner=? AND target=? AND epoch=?').get(owner, target, epoch);
      if (!baseline) throw new CompletionConflict('baseline-required');
      const old = this.db.prepare('SELECT sequence FROM completion_events WHERE owner=? AND target=? AND epoch=? AND turn_id=?').get(owner, target, epoch, turnId);
      if (old) return { sequence: Number(old.sequence), duplicate: true, gap: false };
      if (sourceCursor <= Number(baseline.cursor)) return { sequence: null, duplicate: false, gap: false };
      if (this.count('completion_events', owner) >= COMPLETION_LIMITS.events) {
        this.db.prepare('UPDATE completion_targets SET gap=1 WHERE owner=? AND target=?').run(owner, target);
        return { sequence: null, duplicate: false, gap: true };
      }
      const next = Number(this.db.prepare('SELECT coalesce(max(sequence),0)+1 n FROM completion_events WHERE owner=?').get(owner)!.n);
      if (!sequence(next)) throw new CompletionConflict('sequence-overflow');
      this.db.prepare('INSERT INTO completion_events VALUES(?,?,?,?,?)').run(owner, target, epoch, turnId, next);
      this.db.prepare('UPDATE completion_targets SET latest=? WHERE owner=? AND target=?').run(next, owner, target);
      return { sequence: next, duplicate: false, gap: false };
  }
  /** Trusted event-journal adapter only. The caller's journal/cursor transaction
   * also owns this write. Require a fresh live running witness, never infer an
   * unread from the first historical/terminal snapshot or a compact operation. */
  ingest(owner: string, target: string, epoch: string, payload: unknown, liveSince: number, eventTime: number) {
    if (!this.db.isTransaction) throw new CompletionConflict('journal-transaction-required');
    this.check(owner, target, epoch); this.schema();
    if (!sequence(liveSince) || !sequence(eventTime) || eventTime < liveSince) return;
    if (!payload || typeof payload !== 'object') return;
    const runtime = (payload as { runtime?: Record<string, unknown> }).runtime;
    if (!runtime || typeof runtime.turnId !== 'string' || !identity(runtime.turnId) || runtime.operation !== 'message'
      || runtime.connection !== 'connected' || runtime.sync !== 'current' || typeof runtime.lastEventAt !== 'number'
      || !sequence(runtime.lastEventAt) || runtime.lastEventAt < liveSince) return;
    if (!this.target(owner, target)) {
      if (this.count('completion_targets', owner) >= COMPLETION_LIMITS.targets) return;
      this.db.prepare('INSERT INTO completion_targets(owner,target,generation) VALUES(?,?,?)').run(owner, target, randomUUID());
    }
    // One baseline per authority domain. New transport connections use the
    // fresh liveSince witness without clearing prior dedup or unread state.
    if (!this.db.prepare('SELECT 1 FROM completion_baselines WHERE owner=? AND target=? AND epoch=?').get(owner, target, epoch)) {
      if (this.count('completion_baselines', owner) >= COMPLETION_LIMITS.baselines) {
        this.db.prepare('UPDATE completion_targets SET gap=1 WHERE owner=? AND target=?').run(owner, target); return;
      }
      this.db.prepare('INSERT INTO completion_baselines VALUES(?,?,?,?)').run(owner, target, epoch, Math.max(0, liveSince - 1));
    }
    if (['starting', 'running', 'waiting', 'finalizing'].includes(String(runtime.phase))) {
      this.db.prepare(`INSERT INTO completion_runtime VALUES(?,?,?,?,?) ON CONFLICT(owner,target) DO UPDATE SET epoch=excluded.epoch,turn_id=excluded.turn_id,stamp=excluded.stamp WHERE excluded.stamp >= completion_runtime.stamp`).run(owner, target, epoch, runtime.turnId, runtime.lastEventAt);
    } else {
      const seen = this.db.prepare('SELECT * FROM completion_runtime WHERE owner=? AND target=?').get(owner, target);
      if (runtime.phase === 'completed' && seen?.epoch === epoch && seen.turn_id === runtime.turnId && Number(seen.stamp) >= liveSince && Number(seen.stamp) <= runtime.lastEventAt) {
        this.recordWithin({ owner, target, epoch, turnId: runtime.turnId, sourceCursor: runtime.lastEventAt, provenance: 'live-successful-message' });
      }
      if (['completed', 'failed', 'interrupted'].includes(String(runtime.phase))) this.db.prepare('DELETE FROM completion_runtime WHERE owner=? AND target=? AND turn_id=?').run(owner, target, runtime.turnId);
    }
  }
  summary(owner: string, targets: string[]) {
    this.check(owner, ...targets); if (targets.length > 1024) throw new CompletionConflict('target-limit');
    if (!this.exists()) return [];
    return [...new Set(targets)].flatMap(target => {
      const row = this.target(owner, target);
      return row ? [{ target, generation: row.generation, latestSequence: row.latest, readThrough: row.read_through,
        unread: row.latest > row.read_through, coverage: row.gap ? 'gap' as const : 'observed' as const }] : [];
    });
  }
  observe(owner: string, target: string) {
    this.check(owner, target);
    return this.transaction(() => this.observeWithin(owner, target));
  }
  private observeWithin(owner: string, target: string) {
      this.check(owner, target);
      const row = this.target(owner, target); if (!row) throw new CompletionConflict('target-missing');
      const now = this.now(); if (!sequence(now) || !sequence(now + 300_000)) throw new CompletionConflict('clock');
      this.db.prepare('DELETE FROM completion_observations WHERE owner=? AND expires<=?').run(owner, now);
      if (this.count('completion_observations', owner) >= COMPLETION_LIMITS.observations) throw new CompletionConflict('observation-capacity');
      const token = randomUUID(), expiresAt = now + 300_000;
      this.db.prepare('INSERT INTO completion_observations VALUES(?,?,?,?,?,?)').run(owner, token, target, row.generation, row.latest, expiresAt);
      const event = this.db.prepare('SELECT turn_id FROM completion_events WHERE owner=? AND target=? AND sequence=?').get(owner, target, row.latest);
      return { token, generation: row.generation, throughSequence: row.latest, expiresAt, ...(event ? { turnId: String(event.turn_id) } : {}) };
  }
  markRead(owner: string, target: string, requestId: string, token: string, through: number) {
    this.check(owner, target, requestId, token); if (!sequence(through)) throw new CompletionConflict('sequence');
    return this.transaction(() => this.markReadWithin(owner, target, requestId, token, through));
  }
  private markReadWithin(owner: string, target: string, requestId: string, token: string, through: number) {
      this.check(owner, target, requestId, token); if (!sequence(through)) throw new CompletionConflict('sequence');
      const old = this.db.prepare('SELECT * FROM completion_acks WHERE owner=? AND request_id=?').get(owner, requestId);
      if (old) {
        if (old.target !== target || old.token !== token || old.through_sequence !== through) throw new CompletionConflict('request-reused');
        return through;
      }
      const proof = this.db.prepare('SELECT * FROM completion_observations WHERE owner=? AND token=?').get(owner, token);
      const row = this.target(owner, target), now = this.now();
      if (!sequence(now) || !proof || proof.target !== target || !row || row.generation !== proof.generation
        || now >= Number(proof.expires) || now < Number(proof.expires) - 300_000 || through > Number(proof.ceiling)) throw new CompletionConflict('observation-invalid');
      if (this.count('completion_acks', owner) >= COMPLETION_LIMITS.acknowledgements) throw new CompletionConflict('ack-capacity');
      this.db.prepare('INSERT INTO completion_acks VALUES(?,?,?,?,?)').run(owner, requestId, target, token, through);
      this.db.prepare('UPDATE completion_targets SET read_through=max(read_through,?) WHERE owner=? AND target=?').run(through, owner, target);
      return through;
  }
  /** Original COMPLETE owner only. The local resolver reads credentials/scope
   * and connection generation in this transaction. It is never an RPC callback
   * or a cached authorization flag. Existing public methods keep rejecting an
   * outer transaction; only these private effects participate in this one. */
  memberCommand(resolve: () => HubCompletionAuthority, command: HubCompletionAction): HubCompletionResult {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new CompletionConflict('outer-transaction');
    try {
      return observedTransaction(this.db, 'completion-unread-change', () => {
        const authority = resolve();
        if (!authority || 'error' in authority) return authority;
        const { owner, targets } = authority;
        if (command.action === 'summary') {
          const rows = this.summary(owner, targets.map(t => t.id));
          return { items: targets.flatMap(({ sessionKey, id, displayTarget }) => {
            const row = rows.find(r => r.target === id);
            if (!row) return [];
            const { target: _target, ...value } = row;
            return [{ ...value, sessionKey, displayTarget }];
          }) };
        }
        this.schema();
        const target = targets[0];
        if (!target || targets.length !== 1) throw new CompletionConflict('target-missing');
        if (command.action === 'observe') return { observation: this.observeWithin(owner, target.id) };
        return { throughSequence: this.markReadWithin(owner, target.id, command.requestId, command.token, command.throughSequence) };
      }, this.diagnostics);
    } catch (error) {
      // Convert predictable conflicts only AFTER the original rollback. SQL,
      // COMMIT, cleanup and unknown errors escape; never turn those into replay.
      if (error instanceof CompletionConflict) return { conflict: error.message };
      throw error;
    }
  }
}
