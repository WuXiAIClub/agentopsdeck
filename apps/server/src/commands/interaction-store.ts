import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { synchronousParticipantInspector } from '../storage/synchronous-participant.js';
import { isDeepStrictEqual } from 'node:util';
import { readInteractionRequest, type InteractionMode, type InteractionScope } from '@agentopsdeck/shared';
import { answerInteraction, closeInteraction, createInteraction, InteractionConflict,
  type InteractionClosure, type InteractionState } from './agent-interaction.js';
import { continuationFingerprint, InteractionDeliveryConflict, type InteractionContinuation } from './interaction-continuation.js';

type Delivery = 'none' | 'queued' | 'claimed' | 'confirmed' | 'unknown' | 'cancelled';
export type StoredInteraction = {
  revision: number; state: InteractionState; delivery: Delivery;
  continuationHash: string; claimId?: string; updatedAt: number;
  retiredAt?: number;
};
type Row = { fact: string };
type AnswerInput = Parameters<typeof answerInteraction>[1] & { expectedRevision: number; continuation: InteractionContinuation };
const sessionKey = (scope: Omit<InteractionScope, 'runId'>) => createHash('sha256')
  .update(JSON.stringify([scope.ownerId, scope.nodeId, scope.sessionKey])).digest('hex');
const scopeKey = (scope: InteractionScope) => createHash('sha256')
  .update(JSON.stringify([scope.ownerId, scope.nodeId, scope.sessionKey, scope.runId])).digest('hex');
const requestKey = (scope: InteractionScope, requestId: string) => createHash('sha256')
  .update(JSON.stringify([scopeKey(scope), requestId])).digest('hex');
const open = (fact: StoredInteraction) => fact.retiredAt === undefined && (fact.state.status === 'pending'
  || ['queued', 'claimed', 'unknown'].includes(fact.delivery));
const retentionMs = 7 * 24 * 60 * 60_000;

/** Durable acceptance and at-most-once CLAIM, not exactly-once native execution.
 * A crash after claim is UNKNOWN: never retry native delivery automatically.
 * Calls are synchronous top-level transactions; no network/native call is made
 * inside the transaction. One owning runtime must fence its old connection.
 * No polling, prompt/answer audit payload or goal mutation. Only terminal records
 * older than seven days may be pruned, atomically with their redacted audit.
 */
export class InteractionStore {
  constructor(private readonly db: DatabaseSync, private readonly maxRows = 2048,
    private readonly beforeCreate: () => void = () => {},
    private readonly beforeRetire: () => void = beforeCreate) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 2048) throw new InteractionDeliveryConflict('capacity');
    db.exec(`CREATE TABLE IF NOT EXISTS agent_interactions (
      key TEXT PRIMARY KEY, scope_key TEXT NOT NULL, session_scope TEXT NOT NULL, revision INTEGER NOT NULL,
      unresolved INTEGER NOT NULL CHECK(unresolved IN (0, 1)),
      fact TEXT NOT NULL CHECK(length(CAST(fact AS BLOB)) <= 131072)
    );
    CREATE INDEX IF NOT EXISTS agent_interactions_scope ON agent_interactions(scope_key);
    CREATE INDEX IF NOT EXISTS agent_interactions_session ON agent_interactions(session_scope);
    CREATE INDEX IF NOT EXISTS agent_interactions_pending_session ON agent_interactions(session_scope) WHERE unresolved = 1;
    CREATE INDEX IF NOT EXISTS agent_interactions_pending_run ON agent_interactions(scope_key) WHERE unresolved = 1;
    CREATE INDEX IF NOT EXISTS agent_interactions_pending_key ON agent_interactions(json_extract(fact, '$.state.request.sessionKey')) WHERE unresolved = 1;
    CREATE TABLE IF NOT EXISTS agent_interaction_audit (
      key TEXT NOT NULL, revision INTEGER NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(key, revision)
    );
    CREATE TABLE IF NOT EXISTS agent_interaction_modes (
      key TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('automatic', 'interactive'))
    );`);
  }

  mode(scope: Omit<InteractionScope, 'runId'>): InteractionMode {
    return (this.db.prepare('SELECT mode FROM agent_interaction_modes WHERE key = ?').get(sessionKey(scope)) as { mode: InteractionMode } | undefined)?.mode ?? 'automatic';
  }

  setMode(scope: Omit<InteractionScope, 'runId'>, mode: InteractionMode) {
    if (!['automatic', 'interactive'].includes(mode) || !readInteractionRequest({ ...scope, version: 1, runId: 'mode', requestId: 'mode',
      kind: 'text', prompt: 'mode', createdAt: 0, expiresAt: 1 })) throw new InteractionConflict('invalid');
    this.transaction(checkParticipant => {
      checkParticipant(this.beforeCreate());
      if (mode === 'automatic') { this.db.prepare('DELETE FROM agent_interaction_modes WHERE key = ?').run(sessionKey(scope)); return; }
      if (this.mode(scope) === mode) return;
      const { count } = this.db.prepare('SELECT count(*) AS count FROM agent_interaction_modes').get() as { count: number };
      if (count >= 10_000) throw new InteractionDeliveryConflict('capacity');
      this.db.prepare('INSERT INTO agent_interaction_modes(key, mode) VALUES(?, ?)').run(sessionKey(scope), mode);
    });
  }

  get(scope: InteractionScope, requestId: string): StoredInteraction | undefined {
    const row = this.db.prepare('SELECT fact FROM agent_interactions WHERE key = ?').get(requestKey(scope, requestId)) as Row | undefined;
    return row ? JSON.parse(row.fact) as StoredInteraction : undefined;
  }

  /** Per-run indicator. Admission of NEW work must use hasUnresolvedSession,
   * otherwise changing runId would accidentally bypass an older live request. */
  hasUnresolved(scope: InteractionScope): boolean {
    return !!this.db.prepare('SELECT 1 FROM agent_interactions WHERE scope_key = ? AND unresolved = 1 LIMIT 1').get(scopeKey(scope));
  }

  /** Additional admission guard, never a replacement for goal/history checks. */
  hasUnresolvedSession(scope: Omit<InteractionScope, 'runId'>): boolean {
    const result = this.db.prepare('SELECT 1 FROM agent_interactions WHERE session_scope = ? AND unresolved = 1 LIMIT 1').get(sessionKey(scope));
    return !!result;
  }

  /** Runtime admission is session-wide, including requests from a former owner.
   * Expression index avoids reading question bodies on every dispatch. */
  hasUnresolvedKey(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM agent_interactions WHERE unresolved = 1 AND json_extract(fact, '$.state.request.sessionKey') = ? LIMIT 1").get(key);
  }

  unresolved(): StoredInteraction[] {
    return (this.db.prepare('SELECT fact FROM agent_interactions WHERE unresolved = 1').all() as Row[])
      .map(row => JSON.parse(row.fact) as StoredInteraction);
  }

  /** Bounded identity-only projection for native settlement reconciliation.
   * Do not deserialize prompts or answers on the history refresh path. */
  unresolvedScopes(key?: string): InteractionScope[] {
    return this.db.prepare(`SELECT DISTINCT
      json_extract(fact, '$.state.request.ownerId') AS ownerId,
      json_extract(fact, '$.state.request.nodeId') AS nodeId,
      json_extract(fact, '$.state.request.sessionKey') AS sessionKey,
      json_extract(fact, '$.state.request.runId') AS runId
      FROM agent_interactions WHERE unresolved = 1${key === undefined ? '' : " AND json_extract(fact, '$.state.request.sessionKey') = ?"}`)
      .all(...(key === undefined ? [] : [key])) as InteractionScope[];
  }

  unresolvedCount(): number {
    return (this.db.prepare('SELECT count(*) AS count FROM agent_interactions WHERE unresolved = 1').get() as { count: number }).count;
  }

  list(scope: Omit<InteractionScope, 'runId'>): StoredInteraction[] {
    return (this.db.prepare('SELECT fact FROM agent_interactions WHERE session_scope = ? ORDER BY unresolved DESC, rowid DESC LIMIT 64')
      .all(sessionKey(scope)) as Row[]).map(row => JSON.parse(row.fact) as StoredInteraction);
  }

  /** Only exclusive runtime composition calls this, never a management reader.
   * Old live handles cannot survive process replacement. Claimed answers remain
   * unknown; opening/recovering never redelivers an answer or starts a goal. */
  recover(now: number): number {
    const scopes = new Map<string, InteractionScope>();
    for (const fact of this.unresolved()) scopes.set(scopeKey(fact.state.request), fact.state.request);
    let changed = 0;
    for (const scope of scopes.values()) changed += this.closeRun(scope, 'restarted', now);
    return changed;
  }

  create(value: unknown, capabilities: unknown, scope: InteractionScope, continuation: InteractionContinuation, now: number) {
    const state = createInteraction(value, capabilities, scope, now);
    const continuationHash = continuationFingerprint(continuation);
    return this.transaction(checkParticipant => {
      const prior = this.get(scope, state.request.requestId);
      if (prior) {
        if (!isDeepStrictEqual(prior.state.request, state.request) || prior.continuationHash !== continuationHash) {
          throw new InteractionDeliveryConflict('continuation');
        }
        return prior;
      }
      checkParticipant(this.beforeCreate());
      // Never evict a live or uncertain record on capacity pressure. Expired
      // terminal receipts cannot be replayed as their request TTL is over.
      this.db.prepare(`DELETE FROM agent_interaction_audit WHERE key IN
        (SELECT key FROM agent_interactions WHERE unresolved = 0 AND
        json_extract(fact, '$.updatedAt') < ? AND json_extract(fact, '$.state.request.expiresAt') < ?)`)
        .run(now - retentionMs, now);
      this.db.prepare(`DELETE FROM agent_interactions WHERE unresolved = 0 AND
        json_extract(fact, '$.updatedAt') < ? AND json_extract(fact, '$.state.request.expiresAt') < ?`)
        .run(now - retentionMs, now);
      const count = this.db.prepare('SELECT count(*) AS n FROM agent_interactions').get()!.n as number;
      const runCount = this.db.prepare('SELECT count(*) AS n FROM agent_interactions WHERE scope_key = ? AND unresolved = 1').get(scopeKey(scope))!.n as number;
      if (count >= this.maxRows || runCount >= 32) throw new InteractionDeliveryConflict('capacity');
      const fact: StoredInteraction = { revision: 1, state, delivery: 'none', continuationHash, updatedAt: now };
      const key = requestKey(scope, state.request.requestId);
      this.db.prepare('INSERT INTO agent_interactions(key, scope_key, session_scope, revision, unresolved, fact) VALUES(?, ?, ?, ?, 1, ?)')
        .run(key, scopeKey(scope), sessionKey(scope), 1, JSON.stringify(fact));
      this.audit(key, fact, 'created');
      return fact;
    });
  }

  answer(input: AnswerInput): StoredInteraction {
    return this.transaction(() => {
      const prior = this.require(input.scope, input.requestId);
      this.time(prior, input.now);
      // Recheck permission even for idempotent client retries. Native evidence
      // must be acquired/revalidated by the service, not decoded from HTTP JSON.
      const result = answerInteraction(prior.state, input);
      if (!result.changed) return prior; // receipt read only, never delivery retry
      this.expected(prior, input.expectedRevision);
      if (result.state.status === 'answered') this.continuation(prior, input.continuation);
      return this.save(prior, { ...prior, state: result.state,
        delivery: result.state.status === 'answered' ? 'queued' : 'cancelled', updatedAt: input.now },
      result.state.status === 'answered' ? 'answer-accepted' : 'expired');
    });
  }

  /** Must be invoked only by the owner of a proven live native continuation.
   * A duplicate claim returns no payload; accepted answers are not a tool queue. */
  claim(input: { scope: InteractionScope; requestId: string; expectedRevision: number;
    continuation: InteractionContinuation; permissionAllowed: boolean; now: number }): StoredInteraction | undefined {
    return this.transaction(() => {
      const prior = this.require(input.scope, input.requestId);
      this.time(prior, input.now);
      if (!input.permissionAllowed) throw new InteractionConflict('permission');
      if (prior.delivery !== 'queued' || prior.state.status !== 'answered') return undefined;
      this.expected(prior, input.expectedRevision);
      if (input.now >= prior.state.request.expiresAt) {
        this.save(prior, { ...prior, delivery: 'cancelled', updatedAt: input.now }, 'expired');
        return undefined;
      }
      this.continuation(prior, input.continuation);
      return this.save(prior, { ...prior, delivery: 'claimed', claimId: randomUUID(), updatedAt: input.now }, 'delivery-claimed');
    });
  }

  /** Native response acknowledgement, not proof of tool completion. Late ACKs
   * cannot resurrect unknown/restarted records. Neither outcome permits retry. */
  settle(scope: InteractionScope, requestId: string, claimId: string, outcome: 'confirmed' | 'unknown', now: number) {
    return this.transaction(() => {
      const prior = this.require(scope, requestId);
      this.time(prior, now);
      if (!['confirmed', 'unknown'].includes(outcome) || prior.claimId !== claimId || !claimId) throw new InteractionDeliveryConflict('delivery');
      if (prior.delivery === outcome) return prior;
      if (prior.delivery !== 'claimed') throw new InteractionDeliveryConflict('delivery');
      return this.save(prior, { ...prior, delivery: outcome, updatedAt: now }, `delivery-${outcome}`);
    });
  }

  /** Explicit stop/disconnect/revoke/restart of one identified run. Never infer
   * goal completion or erase answers. Claim uncertainty survives recovery. */
  closeRun(scope: InteractionScope, reason: InteractionClosure, now: number): number {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT fact FROM agent_interactions WHERE scope_key = ?').all(scopeKey(scope)) as Row[];
      let changed = 0;
      for (const row of rows) {
        const prior = JSON.parse(row.fact) as StoredInteraction;
        this.time(prior, now);
        if (reason === 'expired' && now < prior.state.request.expiresAt) continue;
        const state = closeInteraction(prior.state, reason, now);
        const delivery = prior.delivery === 'claimed' ? 'unknown'
          : prior.delivery === 'queued' || (prior.state.status === 'pending' && state.status === 'closed') ? 'cancelled' : prior.delivery;
        if (state === prior.state && delivery === prior.delivery) continue;
        this.save(prior, { ...prior, state, delivery, updatedAt: now }, reason); changed++;
      }
      return changed;
    });
  }

  closeRequest(scope: InteractionScope, requestId: string, reason: InteractionClosure, now: number) {
    return this.transaction(() => {
      const prior = this.require(scope, requestId);
      this.time(prior, now);
      const state = closeInteraction(prior.state, reason, now);
      const delivery = prior.delivery === 'claimed' ? 'unknown'
        : prior.delivery === 'queued' || state.status === 'closed' && prior.state.status === 'pending' ? 'cancelled' : prior.delivery;
      return state === prior.state && delivery === prior.delivery ? prior
        : this.save(prior, { ...prior, state, delivery, updatedAt: now }, reason);
    });
  }

  auditTrail(scope: InteractionScope, requestId: string) {
    return this.db.prepare('SELECT revision, event, at FROM agent_interaction_audit WHERE key = ? ORDER BY revision')
      .all(requestKey(scope, requestId));
  }

  /** Trusted native turn-completed / original worker EXIT evidence only.
   * A disconnect, timeout, stop request or restart is NOT such evidence.
   * Preserve UNKNOWN, answers and audit; release only this run's admission gate.
   */
  retireRun(scope: InteractionScope, now: number) {
    // Settling original native work must remain possible while new admission
    // is paused, otherwise maintenance can never drain its own pending count.
    return this.transaction(checkParticipant => {
      checkParticipant(this.beforeRetire());
      const rows = this.db.prepare('SELECT fact FROM agent_interactions WHERE scope_key = ? AND unresolved = 1').all(scopeKey(scope)) as Row[];
      for (const row of rows) {
        const prior = JSON.parse(row.fact) as StoredInteraction;
        this.time(prior, now);
        const state = closeInteraction(prior.state, 'stopped', now);
        const delivery = prior.delivery === 'claimed' ? 'unknown'
          : prior.delivery === 'queued' || prior.state.status === 'pending' ? 'cancelled' : prior.delivery;
        this.save(prior, { ...prior, state, delivery, retiredAt: now, updatedAt: now }, 'native-run-ended');
      }
      return rows.length;
    }, true);
  }

  private require(scope: InteractionScope, requestId: string) {
    const result = this.get(scope, requestId);
    if (!result) throw new InteractionDeliveryConflict('missing');
    return result;
  }
  private expected(fact: StoredInteraction, revision: number) {
    if (!Number.isSafeInteger(revision) || fact.revision !== revision) throw new InteractionDeliveryConflict('revision');
  }
  private continuation(fact: StoredInteraction, current: InteractionContinuation) {
    if (continuationFingerprint(current) !== fact.continuationHash) throw new InteractionDeliveryConflict('continuation');
  }
  private time(fact: StoredInteraction, now: number) {
    if (!Number.isSafeInteger(now) || now < fact.updatedAt) throw new InteractionConflict('invalid');
  }
  private save(prior: StoredInteraction, next: StoredInteraction, event: string): StoredInteraction {
    next.revision = prior.revision + 1;
    const key = requestKey(prior.state.request, prior.state.request.requestId);
    const result = this.db.prepare('UPDATE agent_interactions SET revision = ?, unresolved = ?, fact = ? WHERE key = ? AND revision = ?')
      .run(next.revision, open(next) ? 1 : 0, JSON.stringify(next), key, prior.revision);
    if (result.changes !== 1) throw new InteractionDeliveryConflict('revision');
    this.audit(key, next, event);
    return next;
  }
  private audit(key: string, fact: StoredInteraction, event: string) {
    this.db.prepare('INSERT INTO agent_interaction_audit(key, revision, event, at) VALUES(?, ?, ?, ?)')
      .run(key, fact.revision, event, fact.updatedAt);
  }
  private transaction<T>(fn: (checkParticipant: (value: unknown) => void) => T, retirement = false): T {
    // Retirement may be part of the original owner's authorized maintenance
    // transaction. A savepoint cannot commit that owner; a raw external BEGIN
    // is not an owning boundary and remains rejected.
    return observedTransaction(this.db, 'interaction-store-change', (_commit, checkParticipant) => fn(checkParticipant) as T extends PromiseLike<unknown> ? never : T,
      undefined, retirement && synchronousParticipantInspector(this.db) !== undefined);
  }
}
