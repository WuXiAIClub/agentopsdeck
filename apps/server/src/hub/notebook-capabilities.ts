import { observedTransaction } from '../storage/observed-transaction.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionNotebooks } from './session-notebooks.js';

export const NOTEBOOK_CAPABILITY_PREFIX = 'aod_note_';
export type NotebookFacet = 'hot:read' | 'cold:read' | 'move';
export type NotebookAuthority = { connectionId: string; version: number } | null;
export type NotebookCapability = { id: string; resourceId: string; facets: NotebookFacet[]; expiresAt: number; createdAt: number; revokedAt: number | null };
type Stored = NotebookCapability & { owner: string; binding: string | null; authority: NotebookAuthority };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function validNotebookCapability(v: unknown): v is { facets: NotebookFacet[]; expiresAt: number } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return Object.keys(x).length === 2 && Number.isSafeInteger(x.expiresAt) && Array.isArray(x.facets)
    && x.facets.length > 0 && x.facets.length <= 3 && new Set(x.facets).size === x.facets.length
    && x.facets.every(f => ['hot:read', 'cold:read', 'move'].includes(f))
    && (!x.facets.includes('move') || x.facets.includes('hot:read') && x.facets.includes('cold:read'));
}
/** Explicit, resource-scoped machine facets. Tokens are never human identities;
 * only their digest is persisted. Rebinding or connection authority changes
 * invalidate the grant. A hot-only grant cannot search/read/move cold data. */
export class NotebookCapabilities {
  constructor(private readonly db: DatabaseSync, private readonly notes: SessionNotebooks,
    private readonly authorityCurrent: (owner: string, proof: NotebookAuthority) => boolean, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_notebook_capabilities (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, resource TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_notebook_capabilities_owner ON hub_notebook_capabilities(owner,resource);`);
    // A temporary detach must not resurrect a grant issued before attachment.
    // Triggers share the native coordinator's transaction, including rollback.
    for (const event of ['INSERT', 'DELETE', 'UPDATE'] as const) {
      const records = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW'];
      db.exec(`CREATE TRIGGER IF NOT EXISTS notebook_capability_binding_${event.toLowerCase()}
        AFTER ${event} ON hub_workspace_native_file_locks BEGIN
        ${records.map(row => `UPDATE hub_notebook_capabilities SET payload=json_set(payload,'$.revokedAt',CAST(strftime('%s','now') AS INTEGER)*1000)
          WHERE ${row}.kind='notebook' AND owner=${row}.user_id AND resource=${row}.resource_id AND json_extract(payload,'$.revokedAt') IS NULL;`).join('\n')}
        END;`);
    }
  }
  private public(c: Stored): NotebookCapability {
    const { id, resourceId, facets, expiresAt, createdAt, revokedAt } = c;
    return { id, resourceId, facets, expiresAt, createdAt, revokedAt };
  }
  issue(owner: string, resourceId: string, input: { facets: NotebookFacet[]; expiresAt: number }, authority: NotebookAuthority) {
    // An identity command already owns the transaction. Release only the
    // nested savepoint; the caller alone decides whether the grant commits.
    // Standalone machine/fixture callers retain the original immediate commit.
    return observedTransaction(this.db, 'notebook-capability-change', () => {
      return this.issueLocked(owner, resourceId, input, authority);
    }, undefined, true);
  }
  private issueLocked(owner: string, resourceId: string, input: { facets: NotebookFacet[]; expiresAt: number }, authority: NotebookAuthority) {
    const at = this.now();
    if (!validNotebookCapability(input) || input.expiresAt <= at || input.expiresAt > at + 86_400_000
      || !this.authorityCurrent(owner, authority) || !this.notes.get(owner, resourceId).revision) return;
    // Expired/revoked credentials need no tombstone: their random token can
    // never be issued again, and move receipts have independent retention.
    this.db.prepare(`DELETE FROM hub_notebook_capabilities WHERE owner=? AND
      (json_extract(payload,'$.expiresAt')<=? OR json_extract(payload,'$.revokedAt') IS NOT NULL)`).run(owner, at);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM hub_notebook_capabilities WHERE owner=?').get(owner) as { n: number };
    if (count.n >= 64) return;
    const cap: Stored = { id: randomUUID(), owner, resourceId, facets: [...input.facets], expiresAt: input.expiresAt,
      createdAt: at, revokedAt: null, binding: this.notes.fileBinding(owner, resourceId) ?? null, authority };
    const token = NOTEBOOK_CAPABILITY_PREFIX + randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO hub_notebook_capabilities VALUES (?,?,?,?,?)').run(cap.id, hash(token), owner, resourceId, JSON.stringify(cap));
    return { capability: this.public(cap), token };
  }
  list(owner: string, resource: string) {
    return (this.db.prepare('SELECT payload FROM hub_notebook_capabilities WHERE owner=? AND resource=? ORDER BY id').all(owner, resource) as { payload: string }[])
      .map(row => this.public(JSON.parse(row.payload) as Stored));
  }
  revoke(owner: string, resource: string, id: string) {
    const row = this.db.prepare('SELECT payload FROM hub_notebook_capabilities WHERE owner=? AND resource=? AND id=?').get(owner, resource, id) as { payload: string } | undefined;
    if (!row) return false;
    const cap = JSON.parse(row.payload) as Stored; cap.revokedAt = this.now();
    this.db.prepare('UPDATE hub_notebook_capabilities SET payload=? WHERE id=?').run(JSON.stringify(cap), id); return true;
  }
  authorized(token: string, facets: NotebookFacet[] = []): Stored | undefined {
    if (!/^aod_note_[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = this.db.prepare('SELECT payload FROM hub_notebook_capabilities WHERE token_hash=?').get(hash(token)) as { payload: string } | undefined;
    if (!row) return;
    const c = JSON.parse(row.payload) as Stored, at = this.now();
    if (c.revokedAt !== null || at < c.createdAt || at >= c.expiresAt || !facets.every(f => c.facets.includes(f))
      || !this.authorityCurrent(c.owner, c.authority) || (this.notes.fileBinding(c.owner, c.resourceId) ?? null) !== c.binding) return;
    return c;
  }
}
