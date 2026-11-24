import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createCommandKey } from '@agentopsdeck/shared';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
export class GuidanceConflict extends Error {}
export type GuidanceAuthority = () => boolean;
type Config = { revision: number; text: string; hash: string; enabled: boolean };
export type GuidanceSubmission = { requestId: string; revision: number; hash: string; text: string; inputHash: string;
  commandKey?: string; createdAt?: number; expiresAt?: number;
  state: 'prepared' | 'unknown' | 'submitted' | 'rejected' | 'cancelled'; queueReceipt: string | null; contextEpoch: string | null };
type Evidence = { epoch: string; hash: string; checkId: string; state: 'confirmed_present' | 'confirmed_absent'; observedAt: number; expiresAt: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** G1: saving never sends. Claims are committed before queue I/O; an unknown
 * claim is only reconciled using the original request. All evidence must come
 * from a trusted exact-hash/context adapter, never from message text searches. */
export class SessionGuidanceStore {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  private scope(owner: string, target: string) { if (!identity(owner) || !identity(target)) throw new GuidanceConflict('scope'); }
  private exists() { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_guidance'").get(); }
  private transaction<T>(fn: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T,
    authorized?: GuidanceAuthority, authorityFailure: 'authority' | 'preflight' = 'authority'): T {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new GuidanceConflict('outer-transaction');
    if (authorized && (types.isProxy(authorized) || types.isAsyncFunction(authorized))) {
      try { const trace = this.diagnostics.start('session-guidance-change'); trace.add('step', 2); trace.add('deferred', 1); trace.finish(true); }
      catch { /* Diagnostics cannot execute or authorize the refused hook. */ }
      throw new GuidanceConflict('authority-contract');
    }
    return observedTransaction(this.db, 'session-guidance-change', (_commit, checkParticipant) => {
      const check = () => {
        checkParticipant(undefined);
        if (!authorized) return;
        const allowed = authorized(); checkParticipant(allowed);
        if (allowed !== true) throw new GuidanceConflict(authorityFailure);
      };
      // Durable authority must be read on this original root connection, not
      // cached outside a worker call. Recheck even an idempotent no-op result.
      check();
      this.db.exec(`CREATE TABLE IF NOT EXISTS session_guidance(owner TEXT,target TEXT,revision INTEGER,text TEXT,hash TEXT,enabled INTEGER,
        epoch TEXT,evidence TEXT,invalidated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,target));
        CREATE TABLE IF NOT EXISTS guidance_submissions(owner TEXT,target TEXT,request_id TEXT,payload TEXT,PRIMARY KEY(owner,request_id));
        CREATE TABLE IF NOT EXISTS guidance_cancellations(owner TEXT,target TEXT,request_id TEXT,PRIMARY KEY(owner,request_id));`);
      const result = fn(checkParticipant); check(); return result;
    }, this.diagnostics);
  }
  config(owner: string, target: string): Config | undefined {
    this.scope(owner, target); if (!this.exists()) return;
    const row = this.db.prepare('SELECT * FROM session_guidance WHERE owner=? AND target=?').get(owner, target);
    return row ? { revision: Number(row.revision), text: String(row.text), hash: String(row.hash), enabled: !!row.enabled } : undefined;
  }
  save(owner: string, target: string, expected: number, text: string, enabled: boolean, authorized?: GuidanceAuthority): Config {
    this.scope(owner, target);
    if (!integer(expected) || !integer(expected + 1) || typeof text !== 'string' || text.length > 8000 || text.includes('\0') || typeof enabled !== 'boolean') throw new GuidanceConflict('config');
    return this.transaction(() => {
      const current = this.config(owner, target);
      if ((current?.revision ?? 0) !== expected) throw new GuidanceConflict('revision');
      if (!current && Number(this.db.prepare('SELECT count(*) n FROM session_guidance WHERE owner=?').get(owner)!.n) >= 1024) throw new GuidanceConflict('config-capacity');
      const value = { revision: expected + 1, text, hash: hash(text), enabled };
      this.db.prepare(`INSERT INTO session_guidance VALUES(?,?,?,?,?,?,NULL,NULL,0) ON CONFLICT(owner,target) DO UPDATE SET
        revision=excluded.revision,text=excluded.text,hash=excluded.hash,enabled=excluded.enabled,evidence=NULL,invalidated=1`).run(owner, target, value.revision, text, value.hash, Number(enabled));
      return value;
    }, authorized);
  }
  context(owner: string, target: string, epoch: string | null, authorized?: GuidanceAuthority) {
    this.scope(owner, target); if (epoch !== null && !identity(epoch)) throw new GuidanceConflict('epoch');
    this.transaction(() => {
      if (!this.config(owner, target)) throw new GuidanceConflict('missing');
      this.db.prepare('UPDATE session_guidance SET invalidated=CASE WHEN epoch IS NOT NULL AND epoch IS NOT ? THEN 1 ELSE invalidated END,evidence=CASE WHEN epoch IS ? THEN evidence ELSE NULL END,epoch=? WHERE owner=? AND target=?').run(epoch, epoch, epoch, owner, target);
    }, authorized);
  }
  receipt(owner: string, target: string, requestId: string): GuidanceSubmission | undefined {
    this.scope(owner, target); if (!identity(requestId)) throw new GuidanceConflict('request');
    if (!this.exists()) return;
    const row = this.db.prepare('SELECT target,payload FROM guidance_submissions WHERE owner=? AND request_id=?').get(owner, requestId);
    if (row && row.target !== target) throw new GuidanceConflict('request-target');
    return row ? JSON.parse(String(row.payload)) as GuidanceSubmission : undefined;
  }
  prepare(owner: string, target: string, requestId: string, revision: number, input: string, authorized?: GuidanceAuthority) {
    this.scope(owner, target);
    if (!identity(requestId) || !integer(revision) || typeof input !== 'string' || input.length > 8000 || input.includes('\0')) throw new GuidanceConflict('submission');
    return this.transaction(() => {
      if(this.cancelled(owner,target,requestId))throw new GuidanceConflict('cancelled');
      const old = this.receipt(owner, target, requestId);
      if (old) {
        if (old.revision !== revision || old.inputHash !== hash(input)) throw new GuidanceConflict('request-reused');
        return old;
      }
      const config = this.config(owner, target);
      if (!config || !config.enabled || !config.text.trim() || config.revision !== revision) throw new GuidanceConflict('config-changed');
      if (Number(this.db.prepare('SELECT count(*) n FROM guidance_submissions WHERE owner=?').get(owner)!.n) >= 1024) throw new GuidanceConflict('receipt-capacity');
      // Freeze the exact combined message before any queue admission. Input is
      // optional and never dispatched separately or appended on a later retry.
      // One immutable clock sample keeps the committed preview within the
      // worker's five-minute budget even when preparation crosses a millisecond.
      const createdAt = this.now();
      const payload: GuidanceSubmission = { requestId, revision, hash: config.hash, text: input ? `${config.text}\n\n${input}` : config.text, inputHash: hash(input), state: 'prepared', queueReceipt: null, contextEpoch: null,
        commandKey:createCommandKey(randomUUID(),createdAt),createdAt,expiresAt:createdAt+300000 };
      this.db.prepare('INSERT INTO guidance_submissions VALUES(?,?,?,?)').run(owner, target, requestId, JSON.stringify(payload));
      return payload;
    }, authorized);
  }
  cancelled(owner:string,target:string,id:string) {
    this.scope(owner,target);if(!identity(id))throw new GuidanceConflict('request');
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='guidance_cancellations'").get())return false;
    const row=this.db.prepare('SELECT target FROM guidance_cancellations WHERE owner=? AND request_id=?').get(owner,id);
    if(row&&row.target!==target)throw new GuidanceConflict('request-target');return !!row;
  }
  cancel(owner:string,target:string,id:string,authorized?:GuidanceAuthority) {
    this.scope(owner,target);if(!identity(id))throw new GuidanceConflict('request');
    return this.transaction(()=>{
      if(this.cancelled(owner,target,id))return;
      const r=this.receipt(owner,target,id);if(r&&r.state!=='prepared')throw new GuidanceConflict('already-dispatched');
      if(Number(this.db.prepare('SELECT count(*) n FROM guidance_cancellations WHERE owner=?').get(owner)!.n)>=1024)throw new GuidanceConflict('receipt-capacity');
      if(r){r.state='cancelled';this.write(owner,r);}
      this.db.prepare('INSERT INTO guidance_cancellations VALUES(?,?,?)').run(owner,target,id);
    }, authorized);
  }
  claim(owner: string, target: string, requestId: string, authorized: () => boolean) {
    return this.transaction(() => {
      const receipt = this.receipt(owner, target, requestId); if (!receipt) throw new GuidanceConflict('missing');
      if (receipt.state !== 'prepared') return { claimed: false, receipt };
      if(receipt.expiresAt!==undefined&&(this.now()>=receipt.expiresAt||this.now()<receipt.createdAt!))throw new GuidanceConflict('preview-expired');
      const config = this.config(owner, target);
      if (!config?.enabled || config.revision !== receipt.revision || config.hash !== receipt.hash) throw new GuidanceConflict('preflight');
      receipt.contextEpoch = this.db.prepare('SELECT epoch FROM session_guidance WHERE owner=? AND target=?').get(owner, target)!.epoch as string | null;
      receipt.state = 'unknown'; this.write(owner, receipt); return { claimed: true, receipt };
    }, authorized, 'preflight');
  }
  private write(owner: string, receipt: GuidanceSubmission) {
    this.db.prepare('UPDATE guidance_submissions SET payload=? WHERE owner=? AND request_id=?').run(JSON.stringify(receipt), owner, receipt.requestId);
  }
  reconcile(owner: string, target: string, requestId: string, result: { state: 'submitted'; queueReceipt: string } | { state: 'rejected'; queueReceipt: null }, authorized?: GuidanceAuthority) {
    return this.transaction(() => {
      const receipt = this.receipt(owner, target, requestId);
      if (!receipt || !['submitted', 'rejected'].includes(result.state)
        || (result.state === 'submitted' ? !identity(result.queueReceipt) : result.queueReceipt !== null)) throw new GuidanceConflict('result');
      if (receipt.state === result.state && receipt.queueReceipt === result.queueReceipt) return receipt;
      if (receipt.state !== 'unknown') throw new GuidanceConflict('transition');
      Object.assign(receipt, result); this.write(owner, receipt); return receipt;
    }, authorized);
  }
  evidence(owner: string, target: string, value: Evidence, authorized?: GuidanceAuthority) {
    this.scope(owner, target);
    if (!identity(value.epoch) || !identity(value.checkId) || !/^[a-f0-9]{64}$/.test(value.hash)
      || !['confirmed_present', 'confirmed_absent'].includes(value.state) || !integer(value.observedAt) || !integer(value.expiresAt)
      || value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > 300_000) throw new GuidanceConflict('evidence');
    return this.transaction(() => {
      const config = this.config(owner, target), now = this.now();
      const row = this.db.prepare('SELECT epoch,evidence FROM session_guidance WHERE owner=? AND target=?').get(owner, target);
      if (!config || !config.enabled || row?.epoch !== value.epoch || config.hash !== value.hash || !integer(now)
        || now < value.observedAt || now >= value.expiresAt) throw new GuidanceConflict('stale-evidence');
      const old = row.evidence ? JSON.parse(String(row.evidence)) as Evidence : undefined;
      const clean: Evidence = { epoch: value.epoch, hash: value.hash, checkId: value.checkId, state: value.state, observedAt: value.observedAt, expiresAt: value.expiresAt };
      if (old && (old.observedAt >= value.observedAt || old.checkId === value.checkId) && JSON.stringify(old) !== JSON.stringify(clean)) throw new GuidanceConflict('evidence-order');
      this.db.prepare('UPDATE session_guidance SET evidence=? WHERE owner=? AND target=?').run(JSON.stringify(clean), owner, target);
    }, authorized);
  }
  inspect(owner: string, target: string) {
    const config = this.config(owner, target); if (!config) return undefined;
    const row = this.db.prepare('SELECT epoch,evidence,invalidated FROM session_guidance WHERE owner=? AND target=?').get(owner, target)!;
    const evidence = row.evidence ? JSON.parse(String(row.evidence)) as Evidence : undefined, now = this.now();
    if (evidence && evidence.hash === config.hash && evidence.epoch === row.epoch && integer(now) && now >= evidence.observedAt && now < evidence.expiresAt) return { config, state: evidence.state };
    const receipts = this.db.prepare('SELECT payload FROM guidance_submissions WHERE owner=? AND target=?').all(owner, target).map(r => JSON.parse(String(r.payload)) as GuidanceSubmission);
    const current = receipts.filter(r => r.revision === config.revision);
    // Context change/absence of proof cannot be interpreted as confirmed absence.
    const state = row.invalidated || evidence || current.some(r => r.state === 'unknown') || receipts.length && !current.length || current.some(r => r.state === 'submitted' && (row.epoch === null || r.contextEpoch !== row.epoch))
      ? 'unknown' : current.some(r => r.state === 'submitted') ? 'submitted' : 'not_submitted';
    return { config, state };
  }
}
