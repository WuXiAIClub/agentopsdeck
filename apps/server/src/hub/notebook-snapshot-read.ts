import type { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';
import { NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS } from '@agentopsdeck/shared';
import type { SessionNotebook } from './session-notebooks.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

export const NOTEBOOK_LAYOUT_PREFIX = '["hub-notebook-layout",1,';
export const DEFAULT_NOTEBOOK_LAYOUT_RESOURCE = JSON.stringify(['hub-notebook-layout', 1, 'default']);
export const NOTEBOOK_SNAPSHOT_RESULT_BYTES = 8 * 1024 * 1024;
const RESULT_BYTES = NOTEBOOK_SNAPSHOT_RESULT_BYTES;
export type NotebookSnapshotRead = { owner: string; mode: 'hot' | 'cold' | 'layouts' | 'search';
  resourceId: string | null; after: string | null; query: string | null; includeArchive: boolean };
export type NotebookVersion = { resourceId: string; area: 'hot' | 'cold'; revision: number; updatedAt: number | null };
export type NotebookSearch = { hotRevision: number; coldRevision: number | null;
  results: { area: 'hot' | 'cold'; revision: number; start: number; end: number; text: string }[] };
export type NotebookSnapshot = { documents: SessionNotebook[]; defaultDocument: SessionNotebook | null;
  search: NotebookSearch | null; versions: NotebookVersion[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const resource = (r: unknown): r is string => typeof r === 'string' && r.length <= 8192;
const version = (v: unknown): v is NotebookVersion => object(v) && fields(v, ['resourceId', 'area', 'revision', 'updatedAt'])
  && resource(v.resourceId) && (v.area === 'hot' || v.area === 'cold') && integer(v.revision) && v.revision < Number.MAX_SAFE_INTEGER
  && (v.updatedAt === null ? v.revision === 0 : integer(v.updatedAt) && v.revision > 0);
export function validNotebookSnapshotRead(v: unknown): v is NotebookSnapshotRead {
  if (!object(v) || !fields(v, ['owner', 'mode', 'resourceId', 'after', 'query', 'includeArchive'])
    || typeof v.owner !== 'string' || !v.owner || v.owner.length > 4096 || typeof v.includeArchive !== 'boolean') return false;
  if (v.mode === 'layouts') return v.resourceId === null && v.query === null && !v.includeArchive && typeof v.after === 'string'
    && v.after.length <= 200 && (!v.after || v.after.startsWith(NOTEBOOK_LAYOUT_PREFIX));
  if (!resource(v.resourceId) || v.after !== null) return false;
  return v.mode === 'search' ? typeof v.query === 'string' && !!v.query.trim() && v.query.length <= 200
    : (v.mode === 'hot' || v.mode === 'cold') && v.query === null && !v.includeArchive;
}
function document(v: unknown, area: 'hot' | 'cold'): v is SessionNotebook {
  return object(v) && fields(v, ['resourceId', 'text', 'revision', 'updatedAt'])
    && version({ resourceId: v.resourceId, area, revision: v.revision, updatedAt: v.updatedAt })
    && typeof v.text === 'string' && v.text.length <= (area === 'cold' ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)
    && (v.revision !== 0 || v.text === '');
}
const metadata = (d: SessionNotebook, area: 'hot' | 'cold'): NotebookVersion => ({ resourceId: d.resourceId, area, revision: d.revision, updatedAt: d.updatedAt });
export function validNotebookSnapshot(v: unknown, read: NotebookSnapshotRead): v is NotebookSnapshot {
  if (!validNotebookSnapshotRead(read) || !object(v) || !fields(v, ['documents', 'defaultDocument', 'search', 'versions'])
    || !Array.isArray(v.documents) || !Array.isArray(v.versions) || v.versions.length > 101 || !v.versions.every(version)) return false;
  const versions = v.versions as NotebookVersion[];
  if (read.mode === 'search') {
    if (v.documents.length || v.defaultDocument !== null || versions.length !== (read.includeArchive ? 2 : 1)
      || versions.some((row, i) => row.resourceId !== read.resourceId || row.area !== (i ? 'cold' : 'hot'))
      || !object(v.search) || !fields(v.search, ['hotRevision', 'coldRevision', 'results'])
      || v.search.hotRevision !== versions[0]!.revision || v.search.coldRevision !== (versions[1]?.revision ?? null)
      || !Array.isArray(v.search.results) || v.search.results.length > 20) return false;
    let hotEnd = 0, coldEnd = 0, coldSeen = false, hotCount = 0, coldCount = 0, hotBytes = 0, coldBytes = 0;
    for (const r of v.search.results) {
      if (!object(r) || !fields(r, ['area', 'revision', 'start', 'end', 'text']) || (r.area !== 'hot' && r.area !== 'cold')
        || r.area === 'cold' && !read.includeArchive || !integer(r.start) || !integer(r.end) || r.end !== r.start + read.query!.length
        || r.end > (r.area === 'hot' ? NOTEBOOK_MAX_CHARS : NOTEBOOK_ARCHIVE_MAX_CHARS)
        || r.revision !== versions[r.area === 'hot' ? 0 : 1]!.revision || typeof r.text !== 'string' || r.text.length > read.query!.length + 64) return false;
      if (r.area === 'hot') { if (coldSeen || r.start < hotEnd) return false; hotEnd = r.end; hotCount++; hotBytes += Buffer.byteLength(JSON.stringify(r)) + 1; }
      else { if (r.start < coldEnd) return false; coldSeen = true; coldEnd = r.end; coldCount++; coldBytes += Buffer.byteLength(JSON.stringify(r)) + 1; }
    }
    return hotCount <= (read.includeArchive ? 10 : 20) && coldCount <= 10 && hotBytes <= (read.includeArchive ? 3750 : 7500) && coldBytes <= 3750;
  }
  const area = read.mode === 'cold' ? 'cold' : 'hot';
  if (v.search !== null || !v.documents.every(d => document(d, area))) return false;
  const docs = v.documents as SessionNotebook[];
  if (read.mode === 'layouts') {
    if (docs.length > 100 || docs.some((d, i) => !d.resourceId.startsWith(NOTEBOOK_LAYOUT_PREFIX) || Buffer.compare(Buffer.from(d.resourceId), Buffer.from(read.after!)) <= 0
      || i > 0 && Buffer.compare(Buffer.from(d.resourceId), Buffer.from(docs[i - 1]!.resourceId)) <= 0)) return false;
    if (read.after ? v.defaultDocument !== null : !document(v.defaultDocument, 'hot') || v.defaultDocument.resourceId !== DEFAULT_NOTEBOOK_LAYOUT_RESOURCE) return false;
  } else if (docs.length !== 1 || docs[0]!.resourceId !== read.resourceId || v.defaultDocument !== null) return false;
  const expected = docs.map(d => metadata(d, area));
  if (v.defaultDocument !== null) expected.push(metadata(v.defaultDocument as SessionNotebook, 'hot'));
  return JSON.stringify(expected) === JSON.stringify(versions) && Buffer.byteLength(JSON.stringify(v)) <= RESULT_BYTES;
}
const table = (area: 'hot' | 'cold') => area === 'hot' ? 'hub_session_notebooks' : 'hub_notebook_archives';
const metadataSql = `CASE WHEN typeof(resource_id)='text' AND length(CAST(resource_id AS BLOB))<=32768 THEN resource_id ELSE NULL END AS resourceId,
  CASE WHEN typeof(revision)='integer' THEN revision ELSE NULL END AS revision,
  CASE WHEN typeof(updated_at)='integer' THEN updated_at ELSE NULL END AS updatedAt`;
function scopes(read: NotebookSnapshotRead): { area: 'hot' | 'cold'; resourceId: string }[] {
  return [{ area: read.mode === 'cold' ? 'cold' : 'hot', resourceId: read.resourceId! },
    ...(read.mode === 'search' && read.includeArchive ? [{ area: 'cold' as const, resourceId: read.resourceId! }] : [])];
}
/** Original writer's bounded metadata fence. Never allocates stored note text,
 * including corrupt BLOB/TEXT revision values. No new permission authority. */
export function notebookSnapshotVersions(db: DatabaseSync, read: NotebookSnapshotRead): NotebookVersion[] {
  if (!validNotebookSnapshotRead(read)) throw new DeliverySnapshotReadRejected();
  const get = (area: 'hot' | 'cold', resourceId: string): NotebookVersion => {
    const row = db.prepare(`SELECT ${metadataSql} FROM ${table(area)} WHERE user_id=? AND resource_id=?`).get(read.owner, resourceId);
    const v = row ? { resourceId: row.resourceId, area, revision: row.revision, updatedAt: row.updatedAt }
      : { resourceId, area, revision: 0, updatedAt: null };
    if (!version(v)) throw new DeliverySnapshotReadRejected(); return v;
  };
  if (read.mode !== 'layouts') return scopes(read).map(s => get(s.area, s.resourceId));
  const rows = db.prepare(`SELECT ${metadataSql} FROM hub_session_notebooks WHERE user_id=? AND substr(resource_id,1,?)=?
    AND resource_id>? ORDER BY resource_id LIMIT 100`).all(read.owner, NOTEBOOK_LAYOUT_PREFIX.length, NOTEBOOK_LAYOUT_PREFIX, read.after!);
  const versions: NotebookVersion[] = rows.map((row): NotebookVersion => {
    const value = { resourceId: row.resourceId, area: 'hot' as const, revision: row.revision, updatedAt: row.updatedAt };
    if (!version(value)) throw new DeliverySnapshotReadRejected();
    return value;
  });
  if (!read.after) versions.push(get('hot', DEFAULT_NOTEBOOK_LAYOUT_RESOURCE));
  return versions;
}
/** All hot/cold revisions, text and search snippets belong to ONE readonly
 * snapshot. The original stores remain sole writers of CAS and move receipts. */
export function readNotebookSnapshot(db: DatabaseSync, read: NotebookSnapshotRead): NotebookSnapshot {
  return notebookSnapshot(db, read, false);
}
/** The identity owner already holds the original SAVEPOINT. Never commit or
 * roll back that caller's transaction, and never silently begin a new one. */
export function readNotebookSnapshotInTransaction(db: DatabaseSync, read: NotebookSnapshotRead): NotebookSnapshot {
  return notebookSnapshot(db, read, true);
}
function notebookSnapshot(db: DatabaseSync, read: NotebookSnapshotRead, existingTransaction: boolean): NotebookSnapshot {
  let begun = false;
  try {
    if (!validNotebookSnapshotRead(read) || db.isTransaction !== existingTransaction) throw new DeliverySnapshotReadRejected();
    if (!existingTransaction) { db.exec('BEGIN'); begun = true; }
    const versions = notebookSnapshotVersions(db, read);
    const get = (v: NotebookVersion): SessionNotebook => {
      if (!v.revision) return { resourceId: v.resourceId, text: '', revision: 0, updatedAt: null };
      const max = v.area === 'cold' ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS;
      const row = db.prepare(`SELECT CASE WHEN typeof(text)='text' AND length(CAST(text AS BLOB))<=? THEN CAST(text AS BLOB) ELSE NULL END AS bytes
        FROM ${table(v.area)} WHERE user_id=? AND resource_id=?`).get(max * 4, read.owner, v.resourceId);
      if (!(row?.bytes instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.bytes); }
      catch { throw new DeliverySnapshotReadRejected(); }
      const d = { resourceId: v.resourceId, text, revision: v.revision, updatedAt: v.updatedAt };
      if (!document(d, v.area)) throw new DeliverySnapshotReadRejected(); return d;
    };
    const value: NotebookSnapshot = { documents: [], defaultDocument: null, search: null, versions };
    if (read.mode === 'search') {
      const hot = get(versions[0]!), cold = read.includeArchive ? get(versions[1]!) : undefined;
      const results: NotebookSearch['results'] = [];
      for (const [area, doc] of [['hot', hot], ['cold', cold]] as const) {
        if (!doc) continue;
        let start = 0, bytes = 0, count = 0;
        while (count++ < (cold ? 10 : 20) && (start = doc.text.indexOf(read.query!, start)) !== -1) {
          const row = { area, revision: doc.revision, start, end: start + read.query!.length,
            text: doc.text.slice(Math.max(0, start - 32), start + read.query!.length + 32) };
          bytes += Buffer.byteLength(JSON.stringify(row)) + 1; if (bytes > (cold ? 3750 : 7500)) break;
          results.push(row); start += read.query!.length;
        }
      }
      value.search = { hotRevision: hot.revision, coldRevision: cold?.revision ?? null, results };
    } else {
      // Stream bounded rows; never aggregate an unbounded stored page first.
      let bytes = 0;
      for (let i = 0; i < versions.length; i++) {
        const d = get(versions[i]!); bytes += Buffer.byteLength(JSON.stringify(d));
        if (bytes > RESULT_BYTES - 128 * 1024) throw new DeliverySnapshotReadRejected();
        if (read.mode === 'layouts' && !read.after && i === versions.length - 1) value.defaultDocument = d;
        else value.documents.push(d);
      }
    }
    if (!validNotebookSnapshot(value, read)) throw new DeliverySnapshotReadRejected();
    if (begun) { db.exec('COMMIT'); begun = false; }
    return value;
  } catch (error) {
    if (begun && db.isTransaction) { try { db.exec('ROLLBACK'); } catch (cleanup) { reportHubReadFailure('hub-notebook-snapshot-read', cleanup); throw cleanup; } }
    reportHubReadFailure('hub-notebook-snapshot-read', error); throw error;
  }
}
