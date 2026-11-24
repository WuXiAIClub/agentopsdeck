import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, ChatMessageMedia } from '@agentopsdeck/shared';
import { mediaResourceId } from '../messages/media-resource.js';
import { validateSdkAttachments, SDK_ATTACHMENT_MAX_BYTES, SDK_ATTACHMENTS_MAX_BYTES, SDK_ATTACHMENT_MAX_ITEMS, type SdkInputAttachment } from './sdk-attachment-input.js';
import type { SdkExecution } from './sdk-execution-journal.js';

const fence = `CREATE TRIGGER connector_sdk_media_writer_compatibility
 BEFORE INSERT ON connector_users WHEN agentopsdeck_connector_sdk_media_writer_epoch() IS NOT 1
 BEGIN SELECT RAISE(ABORT, 'Incompatible SDK attachment writer'); END`;
type Row = { id: string; name: string; mime: string; size: number };
export const SDK_ATTACHMENT_CHUNK_BYTES = 64 * 1024;
export type SdkAttachmentManifestItem = { admissionId: string; id: string; name: string; mimeType: string; size: number; sha256: string };
const metadata = (row: Row): ChatMessageMedia => ({ type: row.mime.startsWith('image/') ? 'image' : 'file',
  url: `/api/sdk-attachments/${row.id}`, name: row.name, mimeType: row.mime, size: row.size });

/** Private Connector DB, separate bodies: never put base64 in queue, receipt,
 * history, event log or Hub projection. Same DB transaction as admission. */
export class SdkAttachmentStore {
  constructor(private readonly db: DatabaseSync) {
    db.function('agentopsdeck_connector_sdk_media_writer_epoch', { deterministic: true }, () => 1);
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='connector_sdk_media_writer_compatibility'").get() as { sql: string } | undefined;
    if (existing && existing.sql.replace(/\s+/g, ' ').trim() !== fence.replace(/\s+/g, ' ').trim()) throw new Error('Invalid SDK attachment writer fence');
    db.exec(`CREATE TABLE IF NOT EXISTS sdk_attachments (
      session_key TEXT NOT NULL, admission_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL, body BLOB NOT NULL,
      PRIMARY KEY(session_key, admission_id, id));`);
  }
  prepare(items: SdkInputAttachment[]) {
    validateSdkAttachments(items);
    return items.map(item => ({ ...item, id: randomUUID() }));
  }
  metadata(items: Array<SdkInputAttachment & { id: string }>) {
    return items.map(item => metadata({ ...item, mime: item.mimeType, size: Buffer.byteLength(item.data, 'base64') }));
  }
  save(key: string, admission: string, items: Array<SdkInputAttachment & { id: string }>) {
    if (!items.length) return;
    if (!this.db.isTransaction) throw new Error('SDK attachments require atomic admission');
    // The prepare step supplied IDs; validate only the native allowlisted shape.
    validateSdkAttachments(items.map(({ name, mimeType, data }) => ({ name, mimeType, data })));
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='connector_sdk_media_writer_compatibility'").get()) this.db.exec(fence);
    const insert = this.db.prepare('INSERT INTO sdk_attachments VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const item of items) {
      const body = Buffer.from(item.data, 'base64');
      insert.run(key, admission, item.id, item.name, item.mimeType, body.length, body);
    }
  }
  media(key: string, admission: string): ChatMessageMedia[] {
    return (this.db.prepare('SELECT id, name, mime, size FROM sdk_attachments WHERE session_key=? AND admission_id=? ORDER BY rowid').all(key, admission) as Row[]).map(metadata);
  }
  project(message: ChatMessage): ChatMessage {
    const media = message.role === 'user' ? this.media(message.sessionKey, message.id) : [];
    return media.length ? { ...message, media } : message;
  }
  forExecution(execution: SdkExecution): SdkInputAttachment[] {
    const items = execution.members.flatMap(id => {
      const queued = this.db.prepare('SELECT payload FROM connector_turns WHERE runtime=? AND session_key=? AND id=?')
        .get(execution.key.split(':')[0]!, execution.key, id) as { payload: string } | undefined;
      if (!queued) throw new Error('SDK attachment admission unavailable');
      const count = JSON.parse(queued.payload).attachmentCount ?? 0;
      if (!Number.isSafeInteger(count) || count < 0 || count > 8) throw new Error('Invalid SDK attachment admission');
      const rows = this.db.prepare('SELECT name, mime, body FROM sdk_attachments WHERE session_key=? AND admission_id=? ORDER BY rowid LIMIT 9')
        .all(execution.key, id) as Array<{ name: string; mime: string; body: Uint8Array }>;
      if (rows.length !== count) throw new Error('SDK attachment admission incomplete');
      return rows.map(row => ({ name: row.name, mimeType: row.mime, data: Buffer.from(row.body).toString('base64') }));
    });
    validateSdkAttachments(items); return items;
  }
  /** Metadata is bounded before any BLOB allocation. Chunked SQL keeps even a
   * corrupt oversized body out of the owner/IPC result allocation. */
  executionManifest(execution: SdkExecution, counts: readonly number[]): SdkAttachmentManifestItem[] {
    if (execution.members.length !== counts.length || counts.length > 16) throw Error('SDK attachment admission incomplete');
    const result: SdkAttachmentManifestItem[] = [];
    let total = 0;
    for (const [index, admissionId] of execution.members.entries()) {
      const count = counts[index]!;
      if (!Number.isSafeInteger(count) || count < 0 || count > SDK_ATTACHMENT_MAX_ITEMS) throw Error('Invalid SDK attachment admission');
      const rows = this.db.prepare(`SELECT id, name, mime, size, typeof(body) AS bodyType, length(body) AS bodySize
        FROM sdk_attachments WHERE session_key=? AND admission_id=? ORDER BY rowid LIMIT 9`)
        .all(execution.key, admissionId) as Array<Row & { bodyType: string; bodySize: number }>;
      if (rows.length !== count || result.length + count > SDK_ATTACHMENT_MAX_ITEMS) throw Error('SDK attachment admission incomplete');
      for (const row of rows) {
        if (row.bodyType !== 'blob' || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > SDK_ATTACHMENT_MAX_BYTES
          || row.bodySize !== row.size || typeof row.id !== 'string' || !row.id || row.id.length > 512
          || typeof row.name !== 'string' || row.name.length > 255 || typeof row.mime !== 'string' || row.mime.length > 128
          || (total += row.size) > SDK_ATTACHMENTS_MAX_BYTES) throw Error('Invalid SDK attachment body');
        const hash = createHash('sha256');
        for (let offset = 0; offset < row.size; offset += SDK_ATTACHMENT_CHUNK_BYTES) {
          hash.update(this.executionChunk(execution.key, admissionId, row.id, offset, row.size));
        }
        result.push({ admissionId, id: row.id, name: row.name, mimeType: row.mime, size: row.size, sha256: hash.digest('hex') });
      }
    }
    return result;
  }
  executionChunk(key: string, admissionId: string, id: string, offset: number, size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 1 || size > SDK_ATTACHMENT_MAX_BYTES || !Number.isSafeInteger(offset)
      || offset < 0 || offset >= size || offset % SDK_ATTACHMENT_CHUNK_BYTES !== 0) throw Error('Invalid SDK attachment chunk');
    const row = this.db.prepare(`SELECT substr(body, ?, ?) AS body FROM sdk_attachments
      WHERE session_key=? AND admission_id=? AND id=? AND typeof(body)='blob' AND size=? AND length(body)=?`)
      .get(offset + 1, SDK_ATTACHMENT_CHUNK_BYTES, key, admissionId, id, size, size) as { body: Uint8Array } | undefined;
    if (!row || !(row.body instanceof Uint8Array) || row.body.length !== Math.min(SDK_ATTACHMENT_CHUNK_BYTES, size - offset)) {
      throw Error('SDK attachment admission incomplete');
    }
    return Buffer.from(row.body);
  }
  read(key: string, admission: string, resource: string) {
    const member = this.media(key, admission).find(item => mediaResourceId(item.url) === resource);
    if (!member) return;
    const id = member.url.slice('/api/sdk-attachments/'.length);
    const row = this.db.prepare('SELECT body FROM sdk_attachments WHERE session_key=? AND admission_id=? AND id=?').get(key, admission, id) as { body: Uint8Array } | undefined;
    return row ? { media: member, bytes: row.body } : undefined;
  }
  remove(key: string, admission?: string) {
    if (admission === undefined) this.db.prepare('DELETE FROM sdk_attachments WHERE session_key=?').run(key);
    else this.db.prepare('DELETE FROM sdk_attachments WHERE session_key=? AND admission_id=?').run(key, admission);
  }
}
