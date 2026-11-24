export type SessionRevocation = { state: 'pending' | 'confirmed'; pending: number; confirmed: number };
export type RevocationReference = { scope: string; sessionKey: string; grantId: string; version: number; userId: string };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A local DELETE ACK is not a remote execution ACK. Missing/invalid fields
 * remain unknown; elapsed time and a missing grant never imply confirmation. */
export function parseSessionRevocation(value: unknown, deletion = false): SessionRevocation {
  if (!object(value) || Object.keys(value).sort().join() !== (deletion ? 'ok,revocation' : 'revocation')
    || deletion && value.ok !== true || !object(value.revocation)) throw new Error('Revocation unconfirmed');
  const r = value.revocation;
  if (Object.keys(r).sort().join() !== 'confirmed,pending,state'
    || !Number.isSafeInteger(r.pending) || Number(r.pending) < 0
    || !Number.isSafeInteger(r.confirmed) || Number(r.confirmed) < 0
    || Number(r.pending) + Number(r.confirmed) > 10000
    || r.state !== (r.pending === 0 ? 'confirmed' : 'pending')) throw new Error('Revocation unconfirmed');
  return { state: r.pending === 0 ? 'confirmed' : 'pending', pending: Number(r.pending), confirmed: Number(r.confirmed) };
}

const KEY = 'agentopsdeck.session-revocation.v1';
const MAX_RECORDS = 32;
const validText = (value: unknown): value is string => typeof value === 'string' && !!value
  && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
function validReference(value: unknown): value is RevocationReference {
  return object(value) && Object.keys(value).sort().join() === 'grantId,scope,sessionKey,userId,version'
    && typeof value.scope === 'string' && /^[a-f0-9]{64}$/.test(value.scope)
    && validText(value.sessionKey) && validText(value.grantId) && validText(value.userId)
    && Number.isSafeInteger(value.version) && Number(value.version) > 0 && Number(value.version) < Number.MAX_SAFE_INTEGER;
}
const identity = (r: RevocationReference) => JSON.stringify([r.scope, r.sessionKey, r.grantId, r.version]);

/** Per-tab, bounded references only: no keys, names, message bodies or receipts.
 * Persist BEFORE DELETE. Recovery only queries this exact original version. */
export class SessionRevocationJournal {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {}
  private read(): RevocationReference[] {
    const raw = this.storage.getItem(KEY);
    if (raw === null) return [];
    if (raw.length > 65536) throw new Error('Revocation records unavailable');
    const value: unknown = JSON.parse(raw);
    if (!object(value) || Object.keys(value).sort().join() !== 'items,version' || value.version !== 1
      || !Array.isArray(value.items) || value.items.length > MAX_RECORDS || !value.items.every(validReference)
      || new Set(value.items.map(identity)).size !== value.items.length) throw new Error('Revocation records unavailable');
    return value.items;
  }
  private write(items: RevocationReference[]) {
    const raw = JSON.stringify({ version: 1, items });
    if (raw.length > 65536) throw new Error('Revocation records unavailable');
    this.storage.setItem(KEY, raw);
  }
  list(scope: string, sessionKey: string) { return this.read().filter(r => r.scope === scope && r.sessionKey === sessionKey); }
  remember(reference: RevocationReference) {
    if (!validReference(reference)) throw new Error('Revocation records unavailable');
    const items = this.read();
    if (items.some(r => identity(r) === identity(reference))) throw new Error('Query original revocation first');
    if (items.length >= MAX_RECORDS) throw new Error('Revocation records full');
    this.write([...items, reference]);
  }
  forget(reference: RevocationReference) { this.write(this.read().filter(r => identity(r) !== identity(reference))); }
}
