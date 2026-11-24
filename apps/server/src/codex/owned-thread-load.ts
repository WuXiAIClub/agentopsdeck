import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CodexExecution } from './executions.js';
import type { CodexAdmissionProof } from './dispatch-admission.js';
import { validNativeResumeReceipt, type NativeResumeReceipt } from './native-resume.js';
import { observedTransaction } from '../storage/observed-transaction.js';

export type OwnedThreadLoadInput = {
  sessionKey: string; commandId: string; connectionId: string; revision: number;
  proof: CodexAdmissionProof; fingerprint: string;
};
type Intent = OwnedThreadLoadInput & NativeResumeReceipt & {
  kind: 'owned-thread-load'; state: 'dispatch_may_have_started' | 'acknowledged';
};
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim()
  && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(JSON.stringify(v)) <= limit;
export function validOwnedThreadLoadInput(v: unknown): v is OwnedThreadLoadInput {
  return fields(v, ['sessionKey', 'commandId', 'connectionId', 'revision', 'proof', 'fingerprint'])
    && id(v.sessionKey, 4096) && v.sessionKey.startsWith('codex:') && v.sessionKey.length > 6
    && id(v.commandId, 512) && id(v.connectionId, 128) && Number.isSafeInteger(v.revision) && v.revision > 0
    && fields(v.proof, ['count', 'digest']) && Number.isSafeInteger(v.proof.count) && v.proof.count >= 1 && v.proof.count <= 16
    && typeof v.proof.digest === 'string' && /^[a-f0-9]{64}$/.test(v.proof.digest)
    && typeof v.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.fingerprint);
}

/** A distinct unbound STARTING contract; never relaxes bound-run recovery.
 * Reuses the existing pending-resume table so admission, maintenance and old
 * compatible releases fail closed. There is NO retry/TTL/recovery of these
 * records. A lost begin/native/ACK reply retains both the claim and intent.
 */
export class CodexOwnedThreadLoads {
  constructor(private readonly db: DatabaseSync,
    private readonly execution: (key: string) => (CodexExecution & { pending: readonly unknown[]; fenced?: boolean }) | undefined,
    private readonly deleted: (key: string) => boolean, private readonly protectWriter: () => void) {}

  private current(input: OwnedThreadLoadInput) {
    const fact = this.execution(input.sessionKey);
    return !!fact && !this.deleted(input.sessionKey) && !fact.fenced && !fact.preparation && !fact.nativeHistory
      && !fact.runId && !fact.reason && fact.phase === 'starting' && fact.sync === 'current'
      && fact.commandId === input.commandId && fact.connectionId === input.connectionId && fact.revision === input.revision
      && fact.pending.length === 0 && !fact.pendingCommandTools?.length;
  }
  private read(receipt: NativeResumeReceipt): Intent | undefined {
    if (!validNativeResumeReceipt(receipt)) throw Error('Invalid original owned-load receipt');
    const row = this.db.prepare('SELECT record FROM connector_codex_native_resume WHERE session_key=?').get(receipt.sessionKey);
    if (!row) return;
    const intent = JSON.parse(String(row.record));
    if (!fields(intent, ['kind', 'state', 'sessionKey', 'commandId', 'connectionId', 'revision', 'proof', 'fingerprint',
      'intentId', 'nativeConnectionId']) || intent.kind !== 'owned-thread-load'
      || !['dispatch_may_have_started', 'acknowledged'].includes(intent.state)
      || !validOwnedThreadLoadInput({ sessionKey: intent.sessionKey, commandId: intent.commandId,
        connectionId: intent.connectionId, revision: intent.revision, proof: intent.proof, fingerprint: intent.fingerprint })
      || !validNativeResumeReceipt({ sessionKey: intent.sessionKey, intentId: intent.intentId,
        nativeConnectionId: intent.nativeConnectionId })
      || intent.nativeConnectionId !== intent.connectionId) throw Error('Invalid persisted owned-load intent');
    if (intent.sessionKey !== receipt.sessionKey || intent.intentId !== receipt.intentId
      || intent.nativeConnectionId !== receipt.nativeConnectionId) return;
    return intent as Intent;
  }
  begin(input: OwnedThreadLoadInput, authorized: (input: OwnedThreadLoadInput) => boolean): NativeResumeReceipt | null {
    if (!validOwnedThreadLoadInput(input)) throw Error('Invalid owned-load intent');
    return observedTransaction(this.db, 'codex-native-resume', (_commit, inspect) => {
      if (!this.current(input) || this.db.prepare('SELECT 1 FROM connector_codex_native_resume WHERE session_key=?').get(input.sessionKey)) return null;
      const allowed = authorized(input); inspect(allowed);
      if (allowed !== true) return null;
      this.protectWriter();
      const receipt = { sessionKey: input.sessionKey, nativeConnectionId: input.connectionId, intentId: randomUUID() };
      this.db.prepare('INSERT INTO connector_codex_native_resume VALUES (?,?)').run(input.sessionKey,
        JSON.stringify({ ...input, ...receipt, kind: 'owned-thread-load', state: 'dispatch_may_have_started' } satisfies Intent));
      return receipt;
    });
  }
  /** Exact original native ACK, not current permission. Persist even when
   * revocation/shutdown changed authority while the physical RPC was in flight. */
  acknowledge(receipt: NativeResumeReceipt): boolean {
    return observedTransaction(this.db, 'codex-native-resume', () => {
      const intent = this.read(receipt);
      if (!intent || intent.state !== 'dispatch_may_have_started') return false;
      intent.state = 'acknowledged';
      this.db.prepare('UPDATE connector_codex_native_resume SET record=? WHERE session_key=?')
        .run(JSON.stringify(intent), receipt.sessionKey);
      return true;
    });
  }
  /** Only the original task after fresh unchanged terminal/Goal proof may
   * consume its ACK. The STARTING execution remains the crash/replay fence. */
  finish(receipt: NativeResumeReceipt, authorized: (input: OwnedThreadLoadInput) => boolean): boolean {
    return observedTransaction(this.db, 'codex-native-resume', (_commit, inspect) => {
      const intent = this.read(receipt);
      if (!intent || intent.state !== 'acknowledged' || !this.current(intent)) return false;
      const allowed = authorized(intent); inspect(allowed);
      if (allowed !== true) return false;
      return this.db.prepare('DELETE FROM connector_codex_native_resume WHERE session_key=? AND record=?')
        .run(receipt.sessionKey, JSON.stringify(intent)).changes === 1;
    });
  }
}
