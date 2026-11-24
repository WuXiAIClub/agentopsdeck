import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CommandReceipt } from '@agentopsdeck/shared';
import { COMMAND_KEY_FUTURE_SKEW_MS, COMMAND_KEY_MAX_AGE_MS, commandKeyIssuedAt, createCommandKey } from '@agentopsdeck/shared';
import type { TurnAdmission } from './turn-queue.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import { validConnectionControlOperation } from '../hub/connection-control-contract.js';
import type { OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
export type { CommandReceipt } from '@agentopsdeck/shared';

export type CommandResult = { status: number; body: Record<string, unknown> };
export type CommandExecutionSink = {
  recordExecutionInTransaction(db: DatabaseSync, runtime: 'openclaw' | 'codex', execution: {
    sessionKey: string; commandId: string; phase: string; completedAt?: number; reason?: string;
  }): void;
};
export type CommandMirrorSink = {
  reclaimCompletedInTransaction?(db: DatabaseSync, excludedNativeId?: string): void;
  recordMirrorInTransaction(db: DatabaseSync, job: {
    sessionKey: string; idempotencyKey: string; actorId?: string; deliveryState?: string;
  }): void;
};
export type CompletedCommand = { runtime: 'openclaw' | 'codex'; id: string; actorId: string; sessionKey: string; mirror: boolean };
type Row = { id: string; command_key: string; fingerprint: string; state: CommandReceipt['state'];
  created_at: number; updated_at: number; result: string | null; authority_id: number | null };

export class CommandConflict extends Error {}
export class CommandKeyExpired extends CommandConflict {
  constructor() { super('Command key expired; original outcome is not established and must not be retried with a new key'); }
}
export class CommandCapacity extends Error {}
const RESULT_RESERVE_BYTES = 128;
export const MAX_COMMAND_RESULT_BYTES = 64 * 1024;
const MAX_BINDING_BYTES = 8 * 1024;
// Trusted internal metadata only; secrets belong in the existing encrypted
// vault. Called under the claim transaction, only for a newly admitted row.
export type CommandBinding = { metadata: Record<string, unknown>; retainedBytes?: number;
  /** Pure local result ONLY: no native/network/file effect may be certified by
   * a claim callback. Persist result and immutable report in one transaction. */
  complete?: CommandResult };
// Creation/settings/update return metadata of unknown size. Reserve the supported
// result ceiling before dispatch, then release unused capacity on settlement.
function resultReserve(scope: string) {
  try {
    const value = JSON.parse(scope);
    if (Array.isArray(value) && value.length === 2 && ['create', 'settings', 'update', 'maintenance'].includes(value[0])) return MAX_COMMAND_RESULT_BYTES;
  } catch { /* legacy scopes need not be JSON */ }
  return RESULT_RESERVE_BYTES;
}
// Connector control scopes already contain actor + native session identity.
// CASE (not boolean short-circuit assumptions) keeps legacy/non-JSON scopes
// safe while indexing the existing fact, without a second tombstone store.
const controlSession = (operation: 'delete' | 'settings') => `CASE WHEN json_valid(scope) THEN CASE
  WHEN json_type(scope) = 'array' AND json_array_length(scope) = 2
    AND json_extract(scope, '$[0]') = '${operation}' AND json_type(scope, '$[1]') = 'text'
  THEN CASE WHEN json_valid(json_extract(scope, '$[1]')) THEN CASE
    WHEN json_type(json_extract(scope, '$[1]')) = 'array'
      AND json_array_length(json_extract(scope, '$[1]')) = 2
      AND json_type(json_extract(scope, '$[1]'), '$[0]') = 'text'
      AND json_type(json_extract(scope, '$[1]'), '$[1]') = 'text'
    THEN json_extract(json_extract(scope, '$[1]'), '$[1]') END END END END`;

// A receipt is not an execution queue. Persist uncertainty BEFORE dispatch;
// crashes, lost replies and simultaneous duplicates can never authorize a
// second side effect. Runtime-owned queues continue to own accepted work.
export class CommandReceipts {
  private readonly deletionLookup: StatementSync;
  private readonly settingsLookup: StatementSync;
  private readonly evidenceLookup: StatementSync;
  private readonly executionCompletion: StatementSync;
  private readonly mirrorCompletion: StatementSync;
  private readonly receiptLookup: StatementSync;
  private readonly receiptExists: StatementSync;
  private readonly usageLookup: StatementSync;
  private readonly policyLookup: StatementSync;
  private readonly advancePolicy: StatementSync;
  private readonly insertReceipt: StatementSync;
  private readonly settleReceipt: StatementSync;
  constructor(private readonly db: DatabaseSync, private readonly maxRows = 20_000,
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly releaseCompleted?: (db: DatabaseSync, target: CompletedCommand) => boolean,
    private readonly storageAdmission?: <T>(bytes: number, write: () => T extends PromiseLike<unknown> ? never : T) => T,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly asyncStorageAdmission?: <T>(bytes: number, write: () => Promise<T>) => Promise<T>) {
    db.exec(`CREATE TABLE IF NOT EXISTS command_receipts (
      scope TEXT NOT NULL, command_key TEXT NOT NULL, id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result TEXT,
      PRIMARY KEY (scope, command_key)
    );
    CREATE TABLE IF NOT EXISTS command_receipt_usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
    INSERT OR IGNORE INTO command_receipt_usage VALUES(1, 0, 0);
    CREATE TABLE IF NOT EXISTS command_receipt_policy (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      reject_before INTEGER NOT NULL CHECK(typeof(reject_before) = 'integer' AND reject_before >= 0)
    );
    INSERT INTO command_receipt_policy SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM command_receipt_policy WHERE singleton = 1);
    CREATE TRIGGER IF NOT EXISTS command_receipt_expired_key BEFORE INSERT ON command_receipts
      WHEN substr(new.command_key, 1, 4) = 'cp1:' AND CAST(substr(new.command_key, 5) AS INTEGER)
        < (SELECT reject_before FROM command_receipt_policy WHERE singleton = 1)
      BEGIN SELECT RAISE(ABORT, 'Command key expired'); END;
    CREATE TRIGGER IF NOT EXISTS command_receipt_policy_update BEFORE UPDATE ON command_receipt_policy
      WHEN new.reject_before < old.reject_before
      BEGIN SELECT RAISE(ABORT, 'Command rejection boundary cannot decrease'); END;
    CREATE TRIGGER IF NOT EXISTS command_receipt_policy_insert BEFORE INSERT ON command_receipt_policy
      WHEN EXISTS (SELECT 1 FROM command_receipt_policy WHERE singleton = 1 AND reject_before > new.reject_before)
      BEGIN SELECT RAISE(ABORT, 'Command rejection boundary cannot decrease'); END;
    CREATE TRIGGER IF NOT EXISTS command_receipt_policy_delete BEFORE DELETE ON command_receipt_policy
      BEGIN SELECT RAISE(ABORT, 'Command rejection boundary cannot be removed'); END;`);
    this.reserveResults();
    const columns = db.prepare('PRAGMA table_info(command_receipts)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'settings_dispatch_phase')) db.exec(`ALTER TABLE command_receipts ADD COLUMN
      settings_dispatch_phase TEXT CHECK(settings_dispatch_phase IN ('prewrite', 'dispatch_may_have_started'))`);
    if (!columns.some((column) => column.name === 'delivery_key')) db.exec('ALTER TABLE command_receipts ADD COLUMN delivery_key TEXT');
    if (!columns.some((column) => column.name === 'authority_id')) db.exec('ALTER TABLE command_receipts ADD COLUMN authority_id INTEGER');
    if (!columns.some((column) => column.name === 'native_runtime')) db.exec('ALTER TABLE command_receipts ADD COLUMN native_runtime TEXT');
    if (!columns.some((column) => column.name === 'native_mirror')) db.exec('ALTER TABLE command_receipts ADD COLUMN native_mirror INTEGER');
    if (!columns.some((column) => column.name === 'native_completed_at')) db.exec('ALTER TABLE command_receipts ADD COLUMN native_completed_at INTEGER');
    if (!columns.some((column) => column.name === 'mirror_completed_at')) db.exec('ALTER TABLE command_receipts ADD COLUMN mirror_completed_at INTEGER');
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_native_target ON command_receipts
      (native_runtime, json_extract(result, '$.body.idempotencyKey'))
      WHERE native_runtime IS NOT NULL AND state = 'accepted' AND json_valid(result);
      CREATE TRIGGER IF NOT EXISTS command_receipt_native_binding BEFORE UPDATE OF native_runtime, native_mirror ON command_receipts
      WHEN old.native_runtime IS NOT NULL AND (new.native_runtime IS NOT old.native_runtime OR new.native_mirror IS NOT old.native_mirror)
      BEGIN SELECT RAISE(ABORT, 'Command native binding cannot change'); END;`);
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_queue_target ON command_receipts
      (scope, json_extract(result, '$.body.idempotencyKey')) WHERE state = 'accepted' AND json_valid(result)`);
    db.exec('CREATE INDEX IF NOT EXISTS command_receipt_delivery ON command_receipts(scope, delivery_key) WHERE delivery_key IS NOT NULL');
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_rejected_retention ON command_receipts(updated_at)
      WHERE state = 'rejected' AND delivery_key IS NULL AND authority_id IS NULL
        AND binding_json IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:'`);
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_connection_control_retention ON command_receipts(updated_at)
      WHERE state IN ('accepted', 'rejected') AND delivery_key IS NULL AND authority_id IS NULL
        AND native_runtime IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:'
        AND CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.domain') END = 'connection-control'`);
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_completed_retention ON command_receipts(native_completed_at)
      WHERE state = 'accepted' AND native_runtime IS NOT NULL AND delivery_key IS NULL AND authority_id IS NULL
        AND binding_json IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:';
      CREATE INDEX IF NOT EXISTS command_receipt_original_target ON command_receipts(json_extract(result, '$.body.idempotencyKey'))
        WHERE state = 'accepted' AND json_valid(result);`);
    const deletionSession = controlSession('delete'), settingsSession = controlSession('settings');
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_deletion_session ON command_receipts
      (${deletionSession}, state) WHERE state IN ('accepted', 'outcome_unknown')`);
    // Projection/admission hot path: reuse the indexed statement, not results.
    this.deletionLookup = db.prepare(`SELECT state FROM command_receipts WHERE ${deletionSession} = ?
      AND state IN ('accepted', 'outcome_unknown') ORDER BY state LIMIT 1`);
    db.exec(`CREATE INDEX IF NOT EXISTS command_receipt_pending_settings_session ON command_receipts
      (${settingsSession}) WHERE state = 'outcome_unknown'`);
    // Offline, explicitly authorized recovery may release the start fence without
    // inventing a native ACK. The original receipt remains unknown/idempotent.
    // No HTTP writer: the maintenance owner must prove the old process stopped,
    // save a backup and bind its audit to this exact receipt and observed state.
    db.exec(`CREATE TABLE IF NOT EXISTS settings_start_releases (
      scope TEXT NOT NULL, command_key TEXT NOT NULL, receipt_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, audit_json TEXT NOT NULL CHECK(json_valid(audit_json)
        AND length(cast(audit_json AS BLOB)) BETWEEN 2 AND 8192),
      PRIMARY KEY(scope, command_key),
      FOREIGN KEY(scope, command_key) REFERENCES command_receipts(scope, command_key)
    );
    CREATE TRIGGER IF NOT EXISTS settings_start_release_immutable_update
      BEFORE UPDATE ON settings_start_releases BEGIN SELECT RAISE(ABORT, 'Settings recovery audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS settings_start_release_immutable_delete
      BEFORE DELETE ON settings_start_releases BEGIN SELECT RAISE(ABORT, 'Settings recovery audit is immutable'); END;`);
    this.settingsLookup = db.prepare(`SELECT 1 FROM command_receipts WHERE ${settingsSession} = ? AND state = 'outcome_unknown'
      AND NOT EXISTS (SELECT 1 FROM settings_start_releases recovery WHERE recovery.scope = command_receipts.scope
        AND recovery.command_key = command_receipts.command_key AND recovery.receipt_id = command_receipts.id
        AND recovery.fingerprint = command_receipts.fingerprint) LIMIT 1`);
    this.evidenceLookup = db.prepare(`SELECT scope, command_key, native_mirror FROM command_receipts
      WHERE native_runtime IS NOT NULL AND native_runtime = ? AND state = 'accepted' AND json_valid(result)
        AND json_extract(result, '$.body.idempotencyKey') = ? LIMIT 2`);
    this.executionCompletion = db.prepare(`UPDATE command_receipts SET native_completed_at = ?
      WHERE scope = ? AND command_key = ? AND native_completed_at IS NOT ?`);
    this.mirrorCompletion = db.prepare(`UPDATE command_receipts SET mirror_completed_at = CASE WHEN ? IS NULL THEN NULL
      ELSE coalesce(mirror_completed_at, ?) END WHERE scope = ? AND command_key = ?
        AND ((? IS NULL AND mirror_completed_at IS NOT NULL) OR (? IS NOT NULL AND mirror_completed_at IS NULL))`);
    // Cache SQL only, on this owner connection. Do not materialize opaque
    // bindings for receipt reads, or a possibly large result for admission's
    // existence check. The locked lookup still rechecks content and authority.
    this.receiptLookup = db.prepare(`SELECT id, command_key, fingerprint, state, created_at, updated_at, result, authority_id
      FROM command_receipts WHERE scope = ? AND command_key = ?`);
    this.receiptExists = db.prepare('SELECT 1 FROM command_receipts WHERE scope = ? AND command_key = ?');
    this.usageLookup = db.prepare('SELECT rows, bytes FROM command_receipt_usage WHERE singleton = 1');
    this.policyLookup = db.prepare('SELECT reject_before FROM command_receipt_policy WHERE singleton = 1');
    this.advancePolicy = db.prepare('UPDATE command_receipt_policy SET reject_before = ? WHERE singleton = 1 AND reject_before < ?');
    this.insertReceipt = db.prepare(`INSERT INTO command_receipts
      (scope, command_key, id, fingerprint, state, created_at, updated_at, result, delivery_key, authority_id, binding_json, retained_bytes, settings_dispatch_phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`);
    this.settleReceipt = db.prepare("UPDATE command_receipts SET state = ?, result = ?, updated_at = ? WHERE scope = ? AND command_key = ? AND state = 'outcome_unknown' AND (? = 0 OR (SELECT bytes FROM command_receipt_usage WHERE singleton = 1) + ? <= ?)");
  }

  claim(scope: string, key: string, payload: unknown, isolatedDelivery = false, authorityId?: number,
    admit?: () => boolean, bind?: (receiptId: string) => CommandBinding,
    settingsPrewrite = false): { fresh: boolean; receipt: CommandReceipt } {
    const write = () => this.claimAdmitted(scope, key, payload, isolatedDelivery, authorityId, admit, bind, settingsPrewrite);
    // Originals and settlement remain readable/writable under storage pressure.
    // New admission reserves the bounded receipt store ceiling, including opaque
    // binding retention, before any admission/binding callback may mutate SQL.
    // The inner transaction still rechecks identity; this lookup grants no work.
    if (this.receiptExists.get(scope, key)) return write();
    if (!this.storageAdmission && this.asyncStorageAdmission) throw new Error('async-admission-required');
    if (!this.storageAdmission) return write();
    return this.storageAdmission(this.maxBytes + 64 * 1024, write);
  }

  /** Physical-space admission and the optional original Auth gate may await.
   * Capacity waits precede that gate. Receipt/queue/binding SQL
   * stays in the original owner's synchronous transaction. The hint never
   * grants work; duplicates and authorization are rechecked after waiting.
   * A lost release reply cannot grant dispatch or replay the committed claim. */
  async claimAsync(scope: string, key: string, payload: unknown, isolatedDelivery = false, authorityId?: number,
    admit?: () => boolean, bind?: (receiptId: string) => CommandBinding,
    settingsPrewrite = false, check: () => void = () => {}, transactionCheck?: () => void,
    transactionWrite?: OriginalTransactionWrite): Promise<{ fresh: boolean; receipt: CommandReceipt }> {
    return this.claimOriginalAsync(scope, key, payload, isolatedDelivery, authorityId, admit, bind, settingsPrewrite, check, transactionCheck, undefined, transactionWrite);
  }

  /** Private owning-domain transport optimization, NOT an authorization proof.
   * The effect caller pins its original JSON payload and uses the SAME digest
   * as claimAsync. Current identity is still checked under BEGIN, including
   * duplicates. No message/attachment bytes need to cross the SQL RPC channel.
   * Never expose this method as an HTTP client-supplied fingerprint API. */
  async claimDigestAsync(scope: string, key: string, digest: string, check: () => void, transactionCheck: () => void, authorityId?: number) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new CommandConflict('Invalid command content identity');
    return this.claimOriginalAsync(scope, key, undefined, true, authorityId, undefined, undefined, false, check, transactionCheck, digest);
  }

  /** Private duplicate preflight. Never inserts or refreshes authority. The
   * owning business domain must still check the original request identity. */
  matchDigest(scope: string, key: string, digest: string): CommandReceipt | undefined {
    this.validateClaim(scope, key, true, undefined, false);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new CommandConflict('Invalid command content identity');
    const row = this.row(scope, key);
    if (row && row.fingerprint !== digest) throw new CommandConflict('Command key already used for different content');
    return row ? fromRow(row) : undefined;
  }

  private async claimOriginalAsync(scope: string, key: string, payload: unknown, isolatedDelivery: boolean, authorityId: number | undefined,
    admit: (() => boolean) | undefined, bind: ((receiptId: string) => CommandBinding) | undefined,
    settingsPrewrite: boolean, check: () => void, transactionCheck?: () => void, preparedDigest?: string,
    transactionWrite?: OriginalTransactionWrite): Promise<{ fresh: boolean; receipt: CommandReceipt }> {
    const trace = this.diagnostics.start('command-receipt-admission');
    let failed = true, step = 1, active = true, entered = false;
    let result: { fresh: boolean; receipt: CommandReceipt } | undefined;
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step, unknown: Number(result?.fresh ?? false) }), 30_000);
    warning.unref();
    try {
      if (this.db.isTransaction) throw new Error('Transaction requires its owning database boundary');
      this.checkRequest(check);
      // Snapshot the canonical fingerprint before yielding. Caller object
      // mutation during admission must not change the request's identity.
      // Retain original key/scope/binding validation even when only the content
      // digest crosses the private worker boundary.
      this.validateClaim(scope, key, isolatedDelivery, authorityId, settingsPrewrite);
      const fingerprint = preparedDigest ?? commandPayloadFingerprint(payload);
      const write = () => {
        if (!active) throw new Error('Receipt admission ended');
        if (entered) throw new Error('Receipt admission writer already attempted');
        entered = true;
        this.checkRequest(check);
        step = 2;
        const at = performance.now();
        try {
          result = this.claimAdmitted(scope, key, payload, isolatedDelivery, authorityId, admit, bind, settingsPrewrite, fingerprint, transactionCheck);
          trace.add('changed', Number(result.fresh));
          return result;
        } finally { step = 3; trace.add('bodyMs', performance.now() - at); }
      };
      if (!this.asyncStorageAdmission) {
        // Preserve synchronous admission for legacy owners; this fallback is
        // not asynchronous SQLite and is deliberately not advertised as such.
        const original = () => !this.storageAdmission || this.receiptExists.get(scope, key) ? write()
          : this.storageAdmission(this.maxBytes + 64 * 1024, write);
        if (transactionWrite) await transactionWrite(original); else original();
      } else if (this.receiptExists.get(scope, key)) {
        if (transactionWrite) await transactionWrite(write); else write();
      }
      else {
        const queued = performance.now();
        let releaseAt: number | undefined;
        try {
          await this.asyncStorageAdmission(this.maxBytes + 64 * 1024, async () => {
            trace.add('queueMs', performance.now() - queued);
            // Space waits outside the authority fence. Once granted, the
            // original synchronous transaction rechecks its own token too.
            try { return transactionWrite ? await transactionWrite(write) : write(); } finally { releaseAt = performance.now(); }
          });
          if (!result) throw new Error('Receipt admission writer was not committed');
        } finally {
          active = false;
          if (!entered) trace.add('queueMs', performance.now() - queued);
          if (releaseAt !== undefined) trace.add('releaseMs', performance.now() - releaseAt);
        }
      }
      if (!result) throw new Error('Receipt admission writer was not committed');
      this.checkRequest(check); // Includes the wait for a quiescent ledger release acknowledgment.
      requireConnectionReady(this.db);
      if (!this.db.isOpen) throw new Error('Storage connection closed');
      // An original-only recovery may settle this exact command while release
      // is pending. Preserve its identity and current outcome, not a stale
      // permission to dispatch again. Missing/replaced originals fail closed.
      const current = this.get(scope, key);
      if (!current || current.id !== result.receipt.id) throw new CommandConflict('Original command receipt changed');
      result = { fresh: result.fresh && current.state === 'outcome_unknown', receipt: current };
      failed = false; return result;
    } catch (error) {
      // A committed unknown receipt remains a replay fence even if authority
      // changed or the coordinator failed before the caller received it.
      trace.add(result?.fresh ? 'unknown' : 'deferred', 1);
      throw error;
    } finally { active = false; clearTimeout(warning); trace.finish(failed); }
  }

  private claimFingerprint(scope: string, key: string, payload: unknown, isolatedDelivery: boolean,
    authorityId: number | undefined, settingsPrewrite: boolean): string {
    this.validateClaim(scope, key, isolatedDelivery, authorityId, settingsPrewrite);
    return commandPayloadFingerprint(payload);
  }

  private validateClaim(scope: string, key: string, isolatedDelivery: boolean,
    authorityId: number | undefined, settingsPrewrite: boolean): void {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict('Invalid command key');
    if (Buffer.byteLength(scope) > 4096) throw new CommandConflict('Invalid command scope');
    if (settingsPrewrite && !isSettingsScope(scope)) throw new CommandConflict('Invalid settings scope');
    if (authorityId !== undefined && (!isolatedDelivery || !Number.isSafeInteger(authorityId) || authorityId < 1)) {
      throw new CommandConflict('Invalid command authority');
    }
  }

  private checkRequest(check: () => void): void {
    if (synchronousSqliteValue(this.db, check) !== undefined) throw new CommandConflict('Invalid request authority');
  }

  private claimAdmitted(scope: string, key: string, payload: unknown, isolatedDelivery = false, authorityId?: number,
    admit?: () => boolean, bind?: (receiptId: string) => CommandBinding,
    settingsPrewrite = false, fingerprint = this.claimFingerprint(scope, key, payload, isolatedDelivery, authorityId, settingsPrewrite), transactionCheck?: () => void):
    { fresh: boolean; receipt: CommandReceipt } {
    return observedTransaction(this.db, 'command-receipt-claim', (commit, checkParticipant) => {
      // Fixed owning-domain guard. It runs after BEGIN for duplicates as well
      // as new rows; an admission wait cannot carry stale identity into SQL.
      if (transactionCheck) this.checkRequest(transactionCheck);
      const existing = this.row(scope, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CommandConflict('Command key already used for different content');
        if ((existing.authority_id ?? undefined) !== authorityId) throw new CommandConflict('Command authority cannot change');
        commit();
        return { fresh: false, receipt: fromRow(existing) };
      }
      const now = Date.now();
      let issuedAt: number | undefined;
      try { issuedAt = commandKeyIssuedAt(key); }
      catch { throw new CommandConflict('Invalid versioned command key'); }
      if (issuedAt !== undefined) {
        this.advancePolicy.run(Math.max(0, now - COMMAND_KEY_MAX_AGE_MS), Math.max(0, now - COMMAND_KEY_MAX_AGE_MS));
        const policy = this.policyLookup.get() as { reject_before: number };
        if (issuedAt < policy.reject_before) {
          commit();
          throw new CommandKeyExpired();
        }
        if (issuedAt > now + COMMAND_KEY_FUTURE_SKEW_MS) throw new CommandConflict('Command key is too far in the future');
      }
      let size = this.usageLookup.get() as { rows: number; bytes: number };
      if (size.rows >= this.maxRows || size.bytes + Buffer.byteLength(scope) + 512 + resultReserve(scope) > this.maxBytes) {
        this.reclaimRejectedInTransaction(now);
        this.reclaimConnectionControlsInTransaction(now);
        size = this.usageLookup.get() as { rows: number; bytes: number };
      }
      if (size.rows >= this.maxRows || size.bytes + Buffer.byteLength(scope) + 512 + resultReserve(scope) > this.maxBytes) {
        // This claim already owns the rollback boundary, including its policy
        // updates. Let it retire an escaped participant only AFTER rollback.
        if (this.releaseCompleted) this.reclaimCompleted(this.db, undefined, checkParticipant);
        size = this.usageLookup.get() as { rows: number; bytes: number };
      }
      if (size.rows >= this.maxRows || size.bytes + Buffer.byteLength(scope) + 512 + resultReserve(scope) > this.maxBytes) throw new CommandCapacity('Command receipt capacity reached');
      const id = randomUUID();
      // Evaluate before this command's unknown row exists, but under the same
      // write lock as queue/execution admission. Duplicates never re-evaluate.
      const admitted = admit?.() ?? true;
      checkParticipant(admitted);
      if (typeof admitted !== 'boolean') throw new CommandConflict('Invalid command admission');
      const binding = admitted ? bind?.(id) : undefined;
      checkParticipant(binding);
      const encoded = binding ? JSON.stringify(binding.metadata) : null;
      const retained = binding?.retainedBytes ?? 0;
      if ((binding && (!encoded || !binding.metadata || Array.isArray(binding.metadata) || typeof binding.metadata !== 'object'))
        || (encoded && Buffer.byteLength(encoded) > MAX_BINDING_BYTES)
        || !Number.isSafeInteger(retained) || retained < 0) throw new CommandConflict('Invalid command binding');
      if (size.bytes + Buffer.byteLength(scope) + 512 + resultReserve(scope)
        + (encoded ? Buffer.byteLength(encoded) : 0) + retained > this.maxBytes) throw new CommandCapacity('Command receipt capacity reached');
      this.insertReceipt.run(scope, key, id, fingerprint, 'outcome_unknown', now, now,
          isolatedDelivery ? issuedAt === undefined ? `cmd_${id}` : createCommandKey(id, issuedAt) : null,
          authorityId ?? null, encoded, retained, settingsPrewrite ? 'prewrite' : null);
      const receipt = admitted ? binding?.complete ? this.settle(scope, key, binding.complete) : this.get(scope, key)!
        : this.settle(scope, key, { status: 409, body: { error: 'Session lifecycle conflict' } });
      if (binding?.complete && receipt.state === 'outcome_unknown') throw new CommandCapacity('Local command result could not be committed');
      commit();
      return { fresh: admitted, receipt };
    }, this.diagnostics);
  }

  get(scope: string, key: string) { const row = this.row(scope, key); return row ? fromRow(row) : undefined; }

  settingsStartReleased(scope: string, key: string): boolean {
    if (!isSettingsScope(scope)) return false;
    return !!this.db.prepare(`SELECT 1 FROM command_receipts r JOIN settings_start_releases a
      ON a.scope = r.scope AND a.command_key = r.command_key AND a.receipt_id = r.id AND a.fingerprint = r.fingerprint
      WHERE r.scope = ? AND r.command_key = ? AND r.state = 'outcome_unknown'`).get(scope, key);
  }

  beginSettingsWrite(scope: string, key: string) {
    const changed = this.db.prepare(`UPDATE command_receipts SET settings_dispatch_phase = 'dispatch_may_have_started'
      WHERE scope = ? AND command_key = ? AND state = 'outcome_unknown' AND settings_dispatch_phase = 'prewrite'`).run(scope, key);
    if (changed.changes !== 1) throw new CommandConflict('Settings dispatch admission unavailable');
  }

  // Called ONLY during exclusive Connector store startup, before admitting any
  // handlers/workers. A live reader/GET must never reject another active writer.
  // Legacy NULL and dispatched rows remain unknown, regardless of their age.
  recoverSettingsPrewrites() {
    observedTransaction(this.db, 'command-receipt-recovery', () => {
      const rows = this.db.prepare(`SELECT scope, command_key FROM command_receipts
        WHERE settings_dispatch_phase = 'prewrite' AND state = 'outcome_unknown'`).all() as Array<{ scope: string; command_key: string }>;
      for (const row of rows) {
        if (!isSettingsScope(row.scope)) throw new CommandConflict('Invalid settings prewrite');
        const receipt = this.settle(row.scope, row.command_key, { status: 409,
          body: { error: 'Settings interrupted before dispatch; no settings write was sent' } });
        if (receipt.state !== 'rejected') throw new CommandCapacity('Settings prewrite recovery could not be persisted');
      }
    }, this.diagnostics);
  }

  reclaimCompletedInTransaction(db: DatabaseSync, excludedNativeId?: string) {
    if (db !== this.db || !db.isTransaction) throw new Error('Receipt reclamation requires its owning transaction');
    if (!this.releaseCompleted) return;
    return observedSavepoint(db, 'command-receipt-reclaim', checkParticipant =>
      this.reclaimCompleted(db, excludedNativeId, checkParticipant), this.diagnostics);
  }

  private reclaimCompleted(db: DatabaseSync, excludedNativeId: string | undefined, checkParticipant: (value: unknown) => void) {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid receipt retention clock');
    const cutoff = Math.max(0, now - COMMAND_KEY_MAX_AGE_MS);
    const candidates = db.prepare(`SELECT scope, command_key, native_runtime, native_mirror,
        json_extract(result, '$.body.idempotencyKey') AS native_id FROM command_receipts
      WHERE state = 'accepted' AND native_runtime IS NOT NULL AND delivery_key IS NULL AND authority_id IS NULL
        AND binding_json IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:'
        AND typeof(native_completed_at) = 'integer' AND native_completed_at >= 0 AND native_completed_at < ?
        AND ((native_mirror = 0 AND mirror_completed_at IS NULL) OR (native_mirror = 1
          AND typeof(mirror_completed_at) = 'integer' AND mirror_completed_at >= 0 AND mirror_completed_at < ?))
        AND (? IS NULL OR native_mirror = 1)
        AND json_valid(result) ORDER BY native_completed_at LIMIT 64`).all(cutoff, cutoff, excludedNativeId ?? null) as Array<{
          scope: string; command_key: string; native_runtime: string; native_mirror: number; native_id: unknown;
        }>;
    for (const candidate of candidates) {
      if (!['openclaw', 'codex'].includes(candidate.native_runtime)
        || typeof candidate.native_id !== 'string' || !candidate.native_id || Buffer.byteLength(candidate.native_id) > 512
        || candidate.native_id === excludedNativeId) continue;
      let issuedAt: number | undefined, address: unknown;
      try { issuedAt = commandKeyIssuedAt(candidate.command_key); address = JSON.parse(candidate.scope); } catch { continue; }
      if (issuedAt === undefined || issuedAt >= cutoff || !Array.isArray(address) || address.length !== 2
        || address.some(part => typeof part !== 'string' || !part) || JSON.stringify(address) !== candidate.scope) continue;
      const matches = db.prepare(`SELECT scope, command_key FROM command_receipts WHERE state = 'accepted' AND json_valid(result)
        AND json_extract(result, '$.body.idempotencyKey') = ? LIMIT 2`).all(candidate.native_id);
      if (matches.length !== 1) continue;
      const released = this.releaseCompleted!(db, { runtime: candidate.native_runtime as CompletedCommand['runtime'], id: candidate.native_id,
        actorId: address[0], sessionKey: address[1], mirror: candidate.native_mirror === 1 });
      checkParticipant(released);
      if (typeof released !== 'boolean') throw new Error('Receipt reclamation participant must return a boolean');
      if (!released) continue;
      this.advancePolicy.run(cutoff, cutoff);
      db.prepare('DELETE FROM command_receipts WHERE scope = ? AND command_key = ?').run(candidate.scope, candidate.command_key);
    }
  }

  private reclaimRejectedInTransaction(now: number) {
    const cutoff = Math.max(0, now - COMMAND_KEY_MAX_AGE_MS);
    this.advancePolicy.run(cutoff, cutoff);
    const policy = this.policyLookup.get() as { reject_before: number };
    const candidates = this.db.prepare(`SELECT scope, command_key FROM command_receipts
      WHERE state = 'rejected' AND delivery_key IS NULL AND authority_id IS NULL
        AND binding_json IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:'
        AND updated_at < ? ORDER BY updated_at LIMIT 64`).all(cutoff) as Array<{ scope: string; command_key: string }>;
    const remove = this.db.prepare('DELETE FROM command_receipts WHERE scope = ? AND command_key = ?');
    for (const candidate of candidates) {
      let issuedAt: number | undefined;
      try { issuedAt = commandKeyIssuedAt(candidate.command_key); } catch { continue; }
      if (issuedAt !== undefined && issuedAt < policy.reject_before) remove.run(candidate.scope, candidate.command_key);
    }
  }

  /** Only a fixed, confirmed original-effect domain may retire its binding.
   * Unknowns, arbitrary bindings, legacy keys and downstream owners survive.
   * The policy fence and removal share the claim transaction, so an expired
   * command cannot be replayed after reclaim, restart or clock rollback. */
  private reclaimConnectionControlsInTransaction(now: number) {
    const cutoff = Math.max(0, now - COMMAND_KEY_MAX_AGE_MS);
    this.advancePolicy.run(cutoff, cutoff);
    const policy = this.policyLookup.get() as { reject_before: number };
    const candidates = this.db.prepare(`SELECT scope, command_key, id, fingerprint, binding_json FROM command_receipts
      WHERE state IN ('accepted', 'rejected') AND delivery_key IS NULL AND authority_id IS NULL
        AND native_runtime IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:'
        AND CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.domain') END = 'connection-control'
        AND updated_at < ? ORDER BY updated_at LIMIT 64`).all(cutoff) as Array<{
          scope: string; command_key: string; id: string; fingerprint: string; binding_json: string;
        }>;
    const remove = this.db.prepare('DELETE FROM command_receipts WHERE scope = ? AND command_key = ?');
    for (const row of candidates) {
      try {
        const issuedAt = commandKeyIssuedAt(row.command_key), binding = JSON.parse(row.binding_json);
        if (issuedAt === undefined || issuedAt >= policy.reject_before || Buffer.byteLength(row.binding_json) > MAX_BINDING_BYTES
          || !binding || typeof binding !== 'object' || Array.isArray(binding)
          || Object.keys(binding).sort().join(',') !== 'connectionId,control,domain,epoch,key,ownerUserId,receiptId'
          || ![binding.ownerUserId, binding.connectionId].every(v => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\x00-\x1f\x7f]/.test(v))
          || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0
          || binding.receiptId !== row.id || binding.key !== row.command_key || !validConnectionControlOperation(binding.control)
          || row.scope !== JSON.stringify(['connection-control', JSON.stringify([binding.ownerUserId, binding.connectionId])])
          || row.fingerprint !== commandPayloadFingerprint({epoch: binding.epoch, control: binding.control})) continue;
      } catch { continue; /* malformed/legacy facts are never authority to release */ }
      // SQL failures belong to the original claim rollback boundary.
      remove.run(row.scope, row.command_key);
    }
  }

  // Never included in public receipts. A missing legacy binding is not a
  // license to attach today's target or authority to an old command.
  binding(scope: string, key: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT binding_json FROM command_receipts WHERE scope = ? AND command_key = ?')
      .get(scope, key) as { binding_json: string | null } | undefined;
    if (!row?.binding_json || Buffer.byteLength(row.binding_json) > MAX_BINDING_BYTES) return undefined;
    try {
      const value: unknown = JSON.parse(row.binding_json);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }

  // State only: callers must not learn another actor's command key/result.
  // Accepted sorts first if a legacy database contains several deletion facts.
  sessionDeletion(sessionKey: string): 'accepted' | 'outcome_unknown' | undefined {
    return (this.deletionLookup.get(sessionKey) as
      { state: 'accepted' | 'outcome_unknown' } | undefined)?.state;
  }

  // State only, across actors: loss of an ACK does not release a native
  // settings operation or authorize deletion. No age-based lock expiry.
  sessionSettingsPending(sessionKey: string) { return !!this.settingsLookup.get(sessionKey); }

  // Resolve one actor-owned metadata page, not the entire receipt history.
  // LIMIT 2 detects ambiguous legacy mappings without scanning duplicates or
  // guessing a command. No payload/result is returned to the caller.
  queueCommandKeys(scope: string, ids: readonly string[]): Array<string | null> {
    if (Buffer.byteLength(scope) > 4096 || ids.length > 64 || ids.some(id => typeof id !== 'string' || !id.length || id.length > 512)) {
      throw new CommandConflict('Invalid queue command page');
    }
    const lookup = this.db.prepare(`SELECT command_key FROM command_receipts
      WHERE scope = ? AND state = 'accepted' AND json_valid(result)
        AND json_extract(result, '$.body.idempotencyKey') = ? LIMIT 2`);
    return ids.map(id => {
      const rows = lookup.all(scope, id) as Array<{ command_key: string }>;
      return rows.length === 1 && /^[A-Za-z0-9._:-]{1,200}$/.test(rows[0]!.command_key) ? rows[0]!.command_key : null;
    });
  }

  deliveryCommands(scope: string, keys: readonly string[]) {
    if (Buffer.byteLength(scope) > 4096 || keys.length > 64 || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key))) {
      throw new CommandConflict('Invalid delivery command page');
    }
    const lookup = this.db.prepare(`SELECT command_key AS key, state, authority_id AS authorityId FROM command_receipts
      WHERE scope = ? AND delivery_key = ? LIMIT 2`);
    return keys.map(key => {
      const rows = lookup.all(scope, key) as Array<{ key: string; state: CommandReceipt['state']; authorityId: number | null }>;
      return rows.length === 1 ? { ...rows[0]! } : null;
    });
  }

  // Internal numeric provenance shares the initial claim transaction and its
  // fixed 512-byte allowance. Never graft authority onto an old unknown row;
  // NULL means legacy/unbound, not permission to dispatch using a fresh lease.
  authorityId(scope: string, key: string) {
    const row = this.db.prepare('SELECT authority_id FROM command_receipts WHERE scope = ? AND command_key = ?')
      .get(scope, key) as { authority_id: number | null } | undefined;
    return row?.authority_id ?? undefined;
  }

  // New Hub receipts have independent downstream keys even when users/Hubs
  // share a Connector token. Old rows retain their original key for recovery;
  // absence of a mapping must never cause an alternate dispatch or query.
  deliveryKey(scope: string, key: string) {
    const row = this.db.prepare('SELECT delivery_key FROM command_receipts WHERE scope = ? AND command_key = ?')
      .get(scope, key) as { delivery_key: string | null } | undefined;
    if (!row) throw new CommandConflict('Command not found');
    return row.delivery_key ?? key;
  }

  // Local SDK allocation has no external side effect. Do not acknowledge a
  // session unless its identity and receipt share the owning transaction.
  creationCommit(scope: string, key: string, result: CommandResult) {
    const commit = this.queueCommit(scope, key, result);
    return (db: DatabaseSync) => {
      if (db !== this.db || !db.isTransaction) throw new Error('Creation and receipt require their owning transaction');
      commit(db);
    };
  }

  // Used only inside a Connector TurnQueue admission/edit/cancel transaction. Returning
  // a closure keeps HTTP handlers out of SQLite while enforcing one database.
  queueCommit(scope: string, key: string, result: CommandResult) {
    return (db: DatabaseSync, admission?: TurnAdmission) => {
      if (db !== this.db) throw new Error('Queue and receipt must share a database');
      if (admission && !db.isTransaction) throw new Error('Native admission requires its owning transaction');
      const receipt = this.get(scope, key);
      if (!receipt || receipt.state !== 'outcome_unknown') throw new CommandConflict('Command is not open for admission');
      if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300) throw new CommandConflict('Queue admission requires an accepted result');
      if (this.settle(scope, key, result).state !== 'accepted') throw new CommandCapacity('Command receipt capacity reached');
      if (admission?.actorId && ['openclaw', 'codex'].includes(admission.runtime)
        && scope === JSON.stringify([admission.actorId, admission.sessionKey]) && result.body.idempotencyKey === admission.id) {
        db.prepare(`UPDATE command_receipts SET native_runtime = ?, native_mirror = ?
          WHERE scope = ? AND command_key = ? AND native_runtime IS NULL`)
          .run(admission.runtime, Number(admission.mirror), scope, key);
        const matches = db.prepare(`SELECT scope FROM command_receipts
          WHERE native_runtime IS NOT NULL AND native_runtime = ? AND state = 'accepted' AND json_valid(result)
            AND json_extract(result, '$.body.idempotencyKey') = ? LIMIT 2`).all(admission.runtime, admission.id);
        if (matches.length > 1) db.prepare(`UPDATE command_receipts SET native_completed_at = NULL, mirror_completed_at = NULL
          WHERE native_runtime IS NOT NULL AND native_runtime = ? AND state = 'accepted' AND json_valid(result)
            AND json_extract(result, '$.body.idempotencyKey') = ?`).run(admission.runtime, admission.id);
      }
    };
  }

  recordExecutionInTransaction(db: DatabaseSync, runtime: 'openclaw' | 'codex', execution: {
    sessionKey: string; commandId: string; phase: string; completedAt?: number; reason?: string;
  }) {
    if (db !== this.db || !db.isTransaction) throw new Error('Execution and receipt require their owning transaction');
    this.observeEvidence(() => {
      const rows = this.evidenceLookup.all(runtime, execution.commandId) as Array<{ scope: string; command_key: string }>;
      return { rows, update: () => {
        if (rows.length !== 1) return;
        const row = rows[0]!;
        let address: unknown;
        try { address = JSON.parse(row.scope); } catch { return; }
        if (!Array.isArray(address) || address.length !== 2 || typeof address[0] !== 'string' || address[1] !== execution.sessionKey) return;
        const completedAt = !execution.reason && ['completed', 'failed', ...(runtime === 'codex' ? ['interrupted'] : [])].includes(execution.phase)
          && Number.isSafeInteger(execution.completedAt) && execution.completedAt! >= 0 ? execution.completedAt! : null;
        return this.executionCompletion.run(completedAt, row.scope, row.command_key, completedAt).changes;
      } };
    });
  }

  recordMirrorInTransaction(db: DatabaseSync, job: {
    sessionKey: string; idempotencyKey: string; actorId?: string; deliveryState?: string;
  }) {
    if (db !== this.db || !db.isTransaction) throw new Error('Mirror and receipt require their owning transaction');
    this.observeEvidence(() => {
      const rows = this.evidenceLookup.all('openclaw', job.idempotencyKey) as Array<{ scope: string; command_key: string; native_mirror: number | null }>;
      return { rows, update: () => {
        if (rows.length !== 1) return;
        const row = rows[0]!;
        if (row.native_mirror !== 1 || !job.actorId || row.scope !== JSON.stringify([job.actorId, job.sessionKey])) return;
        const completedAt = ['sent', 'no_output'].includes(job.deliveryState ?? '') ? Date.now() : null;
        if (completedAt !== null && (!Number.isSafeInteger(completedAt) || completedAt < 0)) throw new Error('Invalid mirror completion clock');
        return this.mirrorCompletion.run(completedAt, completedAt, row.scope, row.command_key, completedAt, completedAt).changes;
      } };
    });
  }

  // Diagnostics describe this statement, not settlement of the caller's
  // transaction. Duplicate evidence is checked but does not dirty SQLite pages.
  private observeEvidence(work: () => { rows: unknown[]; update: () => number | bigint | undefined }) {
    const trace = this.diagnostics.start('command-receipt-evidence'), at = performance.now();
    let failed = true;
    try {
      const { rows, update } = work(); trace.add('records', rows.length);
      trace.add('changed', Number(update() ?? 0)); failed = false;
    } finally { trace.add('bodyMs', performance.now() - at); trace.finish(failed); }
  }

  settleFromReceipt(scope: string, key: string, upstream: CommandReceipt | undefined) {
    const result = upstream?.result;
    if (upstream?.key === this.deliveryKey(scope, key) && result && Number.isInteger(result.status)
      && result.body && typeof result.body === 'object' && !Array.isArray(result.body)
      && ((upstream.state === 'accepted' && result.status >= 200 && result.status < 300)
        || (upstream.state === 'rejected' && result.status >= 400 && result.status < 500))) {
      return this.settle(scope, key, result);
    }
    return this.get(scope, key)!;
  }

  settle(scope: string, key: string, result: CommandResult) {
    // This may run inside a queue/claim transaction. Log observed SQL changes,
    // never a durable settlement or ownership of the caller's rollback.
    const trace = this.diagnostics.start('command-receipt-settle'), at = performance.now();
    let failed = true;
    try {
      // 5xx never establishes whether the runtime accepted a side effect.
      if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 500
        || (result.status >= 300 && result.status < 400)) {
        trace.add('deferred', 1);
        const receipt = this.get(scope, key)!; failed = false; return receipt;
      }
      const state = result.status < 300 ? 'accepted' : 'rejected';
      const safe = state === 'accepted' ? result : { status: result.status, body: { error: 'Command rejected' } };
      const encoded = JSON.stringify(safe);
      if (Buffer.byteLength(encoded) > MAX_COMMAND_RESULT_BYTES) {
        trace.add('deferred', 1);
        const receipt = this.get(scope, key)!; failed = false; return receipt;
      }
      const growth = Math.max(0, Buffer.byteLength(encoded) - resultReserve(scope));
      const changed = this.settleReceipt.run(state, encoded, Date.now(), scope, key, growth, growth, this.maxBytes);
      trace.add('changed', Number(changed.changes));
      const receipt = this.get(scope, key)!; failed = false; return receipt;
    } finally { trace.add('bodyMs', performance.now() - at); trace.finish(failed); }
  }

  private row(scope: string, key: string) {
    return this.receiptLookup.get(scope, key) as Row | undefined;
  }

  // Reserve bounded final metadata in the existing usage budget, not a second
  // receipt/state store. Unknown rows still contain no result. Replace legacy
  // accounting once, transactionally; an over-budget upgrade preserves facts
  // and may settle without growth, but cannot admit more commands.
  private reserveResults() {
    const names = this.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN
      ('command_receipt_insert', 'command_receipt_update', 'command_receipt_delete',
       'command_receipt_insert_v2', 'command_receipt_update_v2', 'command_receipt_delete_v2',
       'command_receipt_insert_v3', 'command_receipt_update_v3', 'command_receipt_delete_v3',
       'command_receipt_insert_v4', 'command_receipt_update_v4', 'command_receipt_delete_v4',
       'command_receipt_insert_v5', 'command_receipt_update_v5', 'command_receipt_delete_v5',
       'command_receipt_insert_v6', 'command_receipt_update_v6', 'command_receipt_delete_v6')`).all() as { name: string; sql: string }[];
    if (names.length === 3 && names.every(row => row.name.endsWith('_v6') && row.sql.includes("'maintenance'"))) return;
    observedTransaction(this.db, 'command-receipt-migration', () => {
      const columns = this.db.prepare('PRAGMA table_info(command_receipts)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'binding_json')) this.db.exec('ALTER TABLE command_receipts ADD COLUMN binding_json TEXT');
      if (!columns.some(column => column.name === 'retained_bytes')) this.db.exec('ALTER TABLE command_receipts ADD COLUMN retained_bytes INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS command_receipt_binding_immutable
        BEFORE UPDATE OF binding_json, retained_bytes ON command_receipts
        WHEN new.binding_json IS NOT old.binding_json OR new.retained_bytes IS NOT old.retained_bytes
        BEGIN SELECT RAISE(ABORT, 'Command binding cannot change'); END`);
      for (const name of ['insert', 'update', 'delete']) {
        this.db.exec(`DROP TRIGGER IF EXISTS command_receipt_${name}; DROP TRIGGER IF EXISTS command_receipt_${name}_v2;
          DROP TRIGGER IF EXISTS command_receipt_${name}_v3; DROP TRIGGER IF EXISTS command_receipt_${name}_v4;
          DROP TRIGGER IF EXISTS command_receipt_${name}_v5; DROP TRIGGER IF EXISTS command_receipt_${name}_v6`);
      }
      const resultBytes = (row = '') => `CASE WHEN ${row}result IS NULL THEN
        CASE WHEN json_valid(${row}scope) THEN CASE
          WHEN json_type(${row}scope) = 'array' AND json_array_length(${row}scope) = 2
            AND json_extract(${row}scope, '$[0]') IN ('create', 'settings', 'update', 'maintenance') THEN ${MAX_COMMAND_RESULT_BYTES}
          ELSE ${RESULT_RESERVE_BYTES} END ELSE ${RESULT_RESERVE_BYTES} END
        ELSE max(length(cast(${row}result AS BLOB)), ${RESULT_RESERVE_BYTES}) END`;
      const bindingBytes = (row = '') => `(coalesce(length(cast(${row}binding_json AS BLOB)), 0) + ${row}retained_bytes)`;
      this.db.exec(`UPDATE command_receipt_usage SET
        rows = (SELECT count(*) FROM command_receipts),
        bytes = (SELECT coalesce(sum(length(cast(scope AS BLOB)) + ${resultBytes()} + ${bindingBytes()} + 512), 0) FROM command_receipts) WHERE singleton = 1;
        CREATE TRIGGER command_receipt_insert_v6 AFTER INSERT ON command_receipts BEGIN
          UPDATE command_receipt_usage SET rows = rows + 1, bytes = bytes + length(cast(new.scope AS BLOB)) + ${resultBytes('new.')} + ${bindingBytes('new.')} + 512 WHERE singleton = 1;
        END;
        CREATE TRIGGER command_receipt_update_v6 AFTER UPDATE OF result ON command_receipts BEGIN
          UPDATE command_receipt_usage SET bytes = bytes + ${resultBytes('new.')} - ${resultBytes('old.')} WHERE singleton = 1;
        END;
        CREATE TRIGGER command_receipt_delete_v6 AFTER DELETE ON command_receipts BEGIN
          UPDATE command_receipt_usage SET rows = rows - 1, bytes = bytes - length(cast(old.scope AS BLOB)) - ${resultBytes('old.')} - ${bindingBytes('old.')} - 512 WHERE singleton = 1;
        END;`);
    }, this.diagnostics);
  }
}

function isSettingsScope(scope: string) {
  try { const parts = JSON.parse(scope); return Array.isArray(parts) && parts.length === 2 && parts[0] === 'settings' && typeof parts[1] === 'string'; }
  catch { return false; }
}

function fromRow(row: Row): CommandReceipt {
  return { id: row.id, key: row.command_key, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.result ? { result: JSON.parse(row.result) as CommandResult } : {}) };
}

export function commandPayloadFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new CommandConflict('Command content is too deeply nested');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
