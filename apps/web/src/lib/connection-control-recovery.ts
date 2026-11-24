import { newCommandKey } from './command-recovery.js';

export type ConnectionControlTarget = { connectionId: string; operation: 'reconcile' | 'updateCheck' };
export type ConnectionControlReceipt = { key: string; operation: ConnectionControlTarget['operation']; state: 'outcome_unknown' | 'accepted' | 'rejected'; status?: number };
export type PendingConnectionControl = ConnectionControlTarget & { scope: string; key: string; createdAt: number; state: ConnectionControlReceipt['state'] };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const journalKey = 'agentopsdeck.connection-control-recovery.v1';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const operation = (v: unknown) => v === 'reconcile' || v === 'updateCheck';
const state = (v: unknown) => v === 'outcome_unknown' || v === 'accepted' || v === 'rejected';
const identity = (row: PendingConnectionControl) => JSON.stringify([row.scope, row.connectionId, row.operation, row.key]);
export function connectionControlReceipt(value: unknown, row: PendingConnectionControl): ConnectionControlReceipt {
  if (!object(value) || Object.keys(value).some(k => !['key', 'operation', 'state', 'status'].includes(k))
    || value.key !== row.key || value.operation !== row.operation || !state(value.state)
    || value.state === 'outcome_unknown' && value.status !== undefined
    || value.state !== 'outcome_unknown' && (!Number.isInteger(value.status) || Number(value.status) < 200 || Number(value.status) >= 500
      || Number(value.status) >= 300 && Number(value.status) < 400 || (Number(value.status) < 300) !== (value.state === 'accepted'))) {
    throw new Error('Original control receipt unavailable; the request was not resent');
  }
  return value as ConnectionControlReceipt;
}

/** Tab-local intent only. The Hub's existing receipt ledger remains the sole
 * execution authority. No payloads, credentials, response bodies or timers. */
export class ConnectionControlJournal {
  constructor(private readonly storage: StoragePort) {}
  private read(): PendingConnectionControl[] {
    const raw = this.storage.getItem(journalKey);
    if (raw === null) return [];
    if (raw.length > 128 * 1024) throw new Error('Saved control records exceed the size limit');
    let rows: unknown;
    try { rows = JSON.parse(raw); } catch { throw new Error('Saved control records are damaged; submission was not attempted'); }
    if (!Array.isArray(rows) || rows.length > 128 || rows.some(row => !object(row)
      || Object.keys(row).length !== 6 || !id(row.scope) || !id(row.connectionId) || !operation(row.operation)
      || typeof row.key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(row.key)
      || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !state(row.state))) {
      throw new Error('Saved control records are invalid; submission was not attempted');
    }
    if (new Set(rows.map(identity)).size !== rows.length) throw new Error('Duplicate saved control records');
    return rows as PendingConnectionControl[];
  }
  private write(rows: PendingConnectionControl[]) {
    const raw = JSON.stringify(rows);
    if (rows.length > 128 || raw.length > 128 * 1024) throw new Error('Control recovery storage is full; query saved requests first');
    this.storage.setItem(journalKey, raw);
  }
  list(scope: string) { return this.read().filter(row => row.scope === scope); }
  begin(scope: string, target: ConnectionControlTarget): PendingConnectionControl {
    if (!id(scope) || !id(target.connectionId) || !operation(target.operation)) throw new Error('Invalid control target');
    const rows = this.read();
    if (rows.some(row => row.scope === scope && row.connectionId === target.connectionId && row.state === 'outcome_unknown')) {
      throw new Error('This Connector has an unresolved control; query its original receipt first');
    }
    const row: PendingConnectionControl = { scope, connectionId: target.connectionId, operation: target.operation,
      key: newCommandKey(), createdAt: Date.now(), state: 'outcome_unknown' };
    this.write([...rows, row]);
    return row;
  }
  settle(row: PendingConnectionControl, value: unknown) {
    const receipt = connectionControlReceipt(value, row), rows = this.read();
    const index = rows.findIndex(item => identity(item) === identity(row));
    if (index === -1) throw new Error('Original saved control is unavailable');
    const previous = rows[index]!;
    if (previous.state !== 'outcome_unknown' && previous.state !== receipt.state) throw new Error('Conflicting control receipt');
    rows[index] = { ...previous, state: receipt.state }; this.write(rows);
    return receipt;
  }
  dismiss(row: PendingConnectionControl) {
    const rows = this.read(), saved = rows.find(item => identity(item) === identity(row));
    if (saved?.state === 'outcome_unknown') throw new Error('Query the original receipt before dismissing');
    this.write(rows.filter(item => identity(item) !== identity(row)));
  }
}
