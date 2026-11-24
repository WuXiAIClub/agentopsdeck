import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeckEvent } from '@agentopsdeck/shared';
import { ChangeSignal } from '../utils/change-signal.js';
import { observedTransaction } from '../storage/observed-transaction.js';

type Head = { epoch: string; seq: number; rows: number; bytes: number };

// A bounded projection journal, not the execution queue or runtime truth.
// A rebuilt in-memory projection starts a new epoch; opening a read handle does
// not. Snapshot capture and event append are synchronous in the owning process.
export class ConnectorEventLog {
  readonly changes = new ChangeSignal();
  private epoch: string;
  private failed: 'projection' | 'transaction' | undefined;
  constructor(private readonly db: DatabaseSync, private readonly maxRows = 4096,
    private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEventBytes = 128 * 1024) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(maxEventBytes) || maxEventBytes < 512 || maxEventBytes > Math.min(maxBytes, 128 * 1024)) throw new Error('Invalid event log limits');
    db.exec(`CREATE TABLE IF NOT EXISTS connector_event_head (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch TEXT NOT NULL,
      seq INTEGER NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS connector_event_insert AFTER INSERT ON connector_events BEGIN
      UPDATE connector_event_head SET rows = rows + 1, bytes = bytes + new.bytes WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_event_delete AFTER DELETE ON connector_events BEGIN
      UPDATE connector_event_head SET rows = rows - 1, bytes = bytes - old.bytes WHERE singleton = 1;
    END;`);
    db.prepare('INSERT OR IGNORE INTO connector_event_head VALUES (1, ?, 0, 0, 0)').run(randomUUID());
    this.epoch = (db.prepare('SELECT epoch FROM connector_event_head WHERE singleton = 1').get() as Head).epoch;
    this.checkCounters(this.head());
  }

  private checkCounters(head: Head) {
    // Bounded startup/recovery scan, never an O(retention) scan per token.
    const actual = this.db.prepare('SELECT count(*) AS rows, coalesce(sum(bytes), 0) AS bytes, min(seq) AS first, max(seq) AS last FROM connector_events')
      .get() as { rows: number; bytes: number; first: number | null; last: number | null };
    if (actual.rows !== head.rows || actual.bytes !== head.bytes
      || (actual.rows > 0 && (actual.last !== head.seq || actual.first !== head.seq - actual.rows + 1))) {
      throw new Error('Connector event journal counters invalid');
    }
  }

  beginEpoch() {
    this.head();
    const epoch = randomUUID();
    try {
      observedTransaction(this.db, 'connector-event-change', () => {
        this.head();
        this.db.exec('DELETE FROM connector_events');
        this.db.prepare('UPDATE connector_event_head SET epoch = ?, seq = 0 WHERE singleton = 1').run(epoch);
      });
      this.epoch = epoch;
    } catch (error) {
      this.failed = 'transaction'; this.changes.notify(); throw error;
    }
  }

  // Only the live projection owner calls this at a snapshot/replay boundary.
  // Its synchronous in-memory updates continued during an optional log outage.
  // Reset the stream, never replay a command or claim transactional facts healed.
  recoverProjection() {
    if (this.failed !== 'projection') return false;
    const epoch = randomUUID();
    try {
      if (this.db.isTransaction) return false;
      observedTransaction(this.db, 'connector-event-change', () => {
        this.checkCounters(this.head(true)); // Still this owner, with an intact log.
        // Exercise the real append path before retiring the gap-containing epoch.
        // The probe and old history disappear together; no partial reset escapes.
        this.persist({ id: '', type: 'stream.reset', ts: Date.now(), payload: { reason: 'projection_recovered' } }, true);
        this.db.exec('DELETE FROM connector_events');
        this.checkCounters(this.head(true));
        this.db.prepare('UPDATE connector_event_head SET epoch = ?, seq = 0 WHERE singleton = 1').run(epoch);
      });
      this.epoch = epoch;
      this.failed = undefined;
    } catch {
      return false;
    }
    this.changes.notify();
    return true;
  }

  append(event: DeckEvent): DeckEvent {
    return this.appendBatch([event]) ?? event;
  }

  // Execution facts own this transaction. Unlike optional projection writes,
  // failure must abort the fact/queue commit; callers wake readers only AFTER
  // COMMIT. Never start a nested transaction or silently accept a missing row.
  appendInTransaction(db: DatabaseSync, event: DeckEvent) {
    try {
      if (db !== this.db || !db.isTransaction) throw new Error('Event append requires its owning transaction');
      return this.persist(event);
    } catch (error) {
      this.failed = 'transaction';
      this.changes.notify(); // Wake to an unavailable journal, not a new cursor.
      throw error;
    }
  }

  /** One synchronous projection change, one transaction. No partial replay
   * prefix if a later row fails; retention remains bounded during the batch. */
  appendBatch(events: readonly DeckEvent[]): DeckEvent | undefined {
    // A journal outage cannot turn already-executing work into a rejected
    // command. Fail delivery/snapshots closed, not the runtime event callback.
    if (this.failed || !events.length) return;
    try {
      if (this.db.isTransaction) { this.failed = 'transaction'; return; }
      return observedTransaction(this.db, 'connector-event-change', () => {
        let saved: DeckEvent | undefined;
        for (const event of events) saved = this.persist(event);
        return saved;
      });
    } catch {
      this.failed = 'projection';
      return;
    }
  }

  private persist(event: DeckEvent, recovering = false): DeckEvent {
    const head = this.head(recovering), seq = head.seq + 1;
    if (!Number.isSafeInteger(seq)) throw new Error('Event sequence exhausted');
    let saved: DeckEvent = { ...event, id: this.cursor(seq) };
    if (event.type === 'message.created' || event.type === 'message.updated') {
      // The UI already refreshes the authorized message snapshot. Persisting
      // its growing full text on every token causes quadratic copying and IO.
      const value = event.payload as Record<string, unknown> | null;
      saved.payload = { invalidation: true, revision: saved.id,
        ...(typeof value?.id === 'string' ? { id: value.id.slice(0, 4096) } : {}),
        ...(value?.deleted === true ? { deleted: true } : {}) };
    }
    let body = JSON.stringify(saved);
    if (Buffer.byteLength(body) > this.maxEventBytes) {
      saved = { id: saved.id, type: 'stream.reset', ts: event.ts, payload: { reason: 'event_too_large' } };
      body = JSON.stringify(saved);
    }
    this.db.prepare('INSERT INTO connector_events VALUES (?, ?, ?)').run(seq, body, Buffer.byteLength(body));
    this.db.prepare('UPDATE connector_event_head SET seq = ? WHERE singleton = 1').run(seq);
    // Bounded table; each row is pruned at most once. Counters avoid scanning
    // and reserializing the retained log on every streamed token.
    let usage = this.head(recovering);
    while (usage.rows > this.maxRows || usage.bytes > this.maxBytes) {
      const removed = this.db.prepare('DELETE FROM connector_events WHERE seq = (SELECT min(seq) FROM connector_events)').run();
      if (removed.changes !== 1) throw new Error('Connector event retention counters invalid');
      usage = this.head(recovering);
    }
    return saved;
  }

  latestEventId() { return this.cursor(this.head().seq); }

  hasEvent(id: string) {
    const head = this.head(), seq = this.sequence(id);
    if (seq === undefined || seq > head.seq) return false;
    const floor = (this.db.prepare('SELECT min(seq) AS seq FROM connector_events').get() as { seq: number | null }).seq;
    return seq >= (floor === null ? head.seq : floor - 1);
  }

  getEventsSince(id?: string): DeckEvent[] {
    const cursor = id ?? this.latestEventId();
    if (!this.hasEvent(cursor)) return []; // Caller sends an explicit reset.
    const rows = this.db.prepare('SELECT body, bytes FROM connector_events WHERE seq > ? ORDER BY seq LIMIT 64')
      .iterate(this.sequence(cursor)!);
    const events: DeckEvent[] = [];
    let bytes = 0;
    for (const value of rows) {
      const row = value as { body: string; bytes: number };
      if (events.length && bytes + row.bytes > 512 * 1024) break;
      bytes += row.bytes; events.push(JSON.parse(row.body) as DeckEvent);
    }
    return events;
  }

  private cursor(seq: number) { return `ce1_${this.epoch}:${seq}`; }
  private sequence(cursor: string) {
    const prefix = `ce1_${this.epoch}:`;
    if (!cursor.startsWith(prefix)) return undefined;
    const raw = cursor.slice(prefix.length), seq = Number(raw);
    return /^(0|[1-9]\d{0,15})$/.test(raw) && Number.isSafeInteger(seq) ? seq : undefined;
  }
  private head(recovering = false) {
    if (this.failed && !(recovering && this.failed === 'projection')) throw new Error('Connector event journal unavailable');
    const head = this.db.prepare('SELECT * FROM connector_event_head WHERE singleton = 1').get() as Head;
    if (!head || head.epoch !== this.epoch || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(head.epoch)
      || ![head.seq, head.rows, head.bytes].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('Connector event epoch changed or invalid');
    return head;
  }
}
