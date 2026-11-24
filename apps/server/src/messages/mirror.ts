import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CommandMirrorSink, CompletedCommand } from '../commands/receipts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeckStore } from '../projection/deck-store.js';
import type { ExecutionGrantAuthority, ExecutionGrantTarget } from '../connector/execution-grants.js';
import type { OpenClawExecution, OpenClawRunObservation } from '../openclaw/executions.js';
import type { GatewayReply } from '../openclaw/gateway-reply.js';
import type { ExplicitChannelRoute } from './channel-route.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { ConnectorEventLog } from '../connector/event-log.js';
export { resolveExplicitChannelRoute, type ExplicitChannelRoute } from './channel-route.js';

const execFileAsync = promisify(execFile);

export type MirrorParams = {
  actorId?: string;
  executionGrant?: ExecutionGrantAuthority;
  sessionKey: string;
  after: number;
  inputText: string;
  explicitRoute: ExplicitChannelRoute;
  idempotencyKey: string;
};

type MirrorDeps = {
  store: DeckStore;
  normalizeError: (error: unknown) => string;
  authorizeTarget?: (params: MirrorParams) => boolean;
  localOpenClawCli?: boolean;
  sendOutbound?: typeof sendOutboundChannelMessage;
  signal?: AbortSignal;
  waitForReply?: boolean;
};

type MirrorJob = MirrorParams & {
  replyDeadlineAt?: number;
  nativeReply?: { source: 'cli'; commandId: string; text: string }
    | { source: 'gateway'; commandId: string; text: string; runId: string; connectionId: string; sequence: number };
  gatewayRun?: { runId: string; connectionId: string; state: 'pending' | 'completed' | 'blocked' };
  legacy?: true;
  createdAt: number;
  attempts: number;
  lastError?: string;
  mirroredMessageIds?: string[];
  lastMirroredAt?: number;
  deliveryState?: 'pending' | 'outcome_unknown' | 'sent' | 'no_output' | 'blocked';
  selectedMessageId?: string;
  outputSha256?: string;
  attemptedAt?: number;
};

export type MirrorDeliveryRef = { key: string; id: string; messageId: string; digest: string; attemptedAt: number };
export type MirrorDeliveryClaim = { state: 'idle' | 'blocked' | 'no_output' }
  | { state: 'send'; ref: MirrorDeliveryRef; route: ExplicitChannelRoute; text: string };

export class MirrorDeliveryUnknown extends Error {
  constructor() { super('Mirror delivery outcome unknown; original record retained, not retried'); }
}

export class MirrorDispatcherClosed extends Error {
  constructor(message = 'Mirror dispatcher closed; pending intent retained') { super(message); }
}

class MirrorDeliverySettled extends Error {
  constructor(readonly state: 'no_output' | 'blocked', message: string) { super(message); }
}

const recoverableMirror = `json_extract(job, '$.legacy') IS NULL AND json_extract(job, '$.deliveryState') = 'pending'
  AND (json_extract(job, '$.gatewayRun.state') = 'blocked'
    OR json_extract(job, '$.replyDeadlineAt') IS NOT NULL
    OR (json_extract(job, '$.nativeReply') IS NOT NULL
      AND (json_extract(job, '$.gatewayRun') IS NULL OR json_extract(job, '$.gatewayRun.state') = 'completed')))`;

const mirrorReplyWaitMs = 480_000;
const mirrorReplyTimeout = 'Original Gateway execution completed without final reply before its persisted deadline; not forwarded';

function replyWaitExpired(job: MirrorJob) {
  return !job.nativeReply && job.replyDeadlineAt !== undefined && Date.now() >= job.replyDeadlineAt;
}

export function createMirrorDispatcher(outbox: MirrorOutbox, deps: MirrorDeps) {
  const active = new Map<string, Promise<void>>();
  let controller = new AbortController();
  let stopped = false, closing: Promise<void> | undefined;
  let pause: { drained: Promise<void>; resume: () => boolean } | undefined;

  function start(job: MirrorJob, waitForReply = true) {
    if (stopped || pause) return Promise.reject(new MirrorDispatcherClosed());
    const existing = active.get(job.idempotencyKey);
    if (existing) return existing;
    if (job.legacy) return Promise.reject(new MirrorDeliveryUnknown());
    if (job.deliveryState === 'sent' || job.deliveryState === 'no_output') return Promise.resolve();
    if (job.deliveryState === 'blocked') return Promise.reject(new MirrorDeliverySettled('blocked', job.lastError ?? 'Mirror delivery blocked'));
    if (job.deliveryState !== 'pending') return Promise.reject(new MirrorDeliveryUnknown());
    // Register ownership before callbacks can re-enter this dispatcher.
    const signal = controller.signal;
    const task = Promise.resolve().then(() => deliverPersistentJob(job, outbox, { ...deps, waitForReply, signal }))
      .finally(() => active.delete(job.idempotencyKey));
    active.set(job.idempotencyKey, task);
    return task;
  }

  async function reconcileSession(sessionKey: string) {
    if (stopped || pause) throw new MirrorDispatcherClosed();
    const job = outbox.recoveryJob(sessionKey);
    if (job) await start(job, false);
  }

  async function resume() {
    if (stopped || pause) return;
    for (const sessionKey of outbox.recoveryPage('', 16)) {
      if (stopped || pause) return;
      await reconcileSession(sessionKey).catch(() => undefined);
    }
  }

  function mirrorAssistantReplyToChannel(params: MirrorParams) {
    if (stopped || pause) return Promise.reject(new MirrorDispatcherClosed());
    const job = outbox.get(params.idempotencyKey);
    if (!job) throw new Error('Mirror outbox job missing; admission required before dispatch');
    if (job.legacy || !sameMirrorRequest(job, params)) throw new Error('Mirror outbox request conflict');
    return start(job);
  }

  const stopAdmissions = () => { stopped = true; controller.abort(new MirrorDispatcherClosed()); };
  const close = () => {
    stopAdmissions();
    return closing ??= Promise.allSettled([...active.values()]).then(() => {});
  };
  const pauseAdmissions = () => {
    if (pause) return pause;
    let settled = false;
    const lease = {
      drained: Promise.allSettled([...active.values()]).then(() => { settled = true; }),
      resume: () => {
        if (pause !== lease || !settled || stopped) return false;
        controller = new AbortController();
        pause = undefined;
        return true;
      },
    };
    pause = lease;
    controller.abort(new MirrorDispatcherClosed('Mirror dispatcher paused; pending intent retained'));
    return lease;
  };
  return { mirrorAssistantReplyToChannel, reconcileSession, resume, stopAdmissions, close, pauseAdmissions };
}

async function deliverPersistentJob(job: MirrorJob, outbox: MirrorOutbox, deps: MirrorDeps) {
  try {
    deps.signal?.throwIfAborted();
    deps.store.append('queued_message.created', { sessionKey: job.sessionKey, idempotencyKey: job.idempotencyKey,
      deliveryMode: 'mirror', mirror: 'started', outboundTarget: job.explicitRoute.outboundTarget }, { sessionKey: job.sessionKey });
    await deliverMirror(job, outbox, deps, {
      onAttemptError: (error) => {
        job.attempts += 1;
        job.lastError = deps.normalizeError(error);
        outbox.saveJob(job);
      },
      onDispatch: (messageId, text) => {
        const next: MirrorJob = { ...job, deliveryState: 'outcome_unknown', selectedMessageId: messageId,
          outputSha256: createHash('sha256').update(text).digest('hex'), attemptedAt: Date.now() };
        outbox.saveJob(next); // Failure here must not invoke the external channel.
        Object.assign(job, next);
      },
      onSent: (messageId) => {
        const next: MirrorJob = { ...job, deliveryState: 'sent', mirroredMessageIds: [messageId], lastMirroredAt: Date.now() };
        outbox.saveJob(next);
        Object.assign(job, next);
      },
    });
  } catch (error) {
    // A presentation failure cannot erase the saved channel result.
    if (job.deliveryState === 'sent') return;
    if (job.deliveryState === 'outcome_unknown') throw new MirrorDeliveryUnknown();
    if (deps.signal?.aborted) throw deps.signal.reason;
    // Another dispatcher may have selected the original job while we polled;
    // even a save that threw may have selected its snapshot before failing.
    let saved: MirrorJob | undefined;
    try { saved = outbox.get(job.idempotencyKey); }
    catch { throw new MirrorDeliveryUnknown(); }
    if (saved && sameMirrorRequest(saved, job) && saved.deliveryState === 'sent') return;
    if (!saved || !sameMirrorRequest(saved, job) || saved.deliveryState !== 'pending') throw new MirrorDeliveryUnknown();
    if (error instanceof MirrorDeliverySettled) {
      outbox.saveJob({ ...saved, deliveryState: error.state, lastError: error.message });
    }
    const message = deps.normalizeError(error);
    console.warn(`[mirror] failed id=${job.idempotencyKey} session=${job.sessionKey}: ${message}`);
    deps.store.append('queued_message.failed', {
      sessionKey: job.sessionKey,
      idempotencyKey: job.idempotencyKey,
      deliveryMode: 'mirror',
      mirror: 'failed',
      error: message,
    }, { sessionKey: job.sessionKey });
    throw error;
  }
}

async function deliverMirror(params: MirrorJob, outbox: MirrorOutbox, deps: MirrorDeps, hooks: { onAttemptError?: (error: unknown) => void;
  onDispatch?: (messageId: string, text: string) => void; onSent?: (messageId: string) => void } = {}) {
  if (deps.localOpenClawCli === false) throw new MirrorDeliverySettled('blocked', 'mirror via local openclaw CLI is disabled for remote deployment');
  const deadline = Date.now() + 480_000;
  let lastError: unknown;
  let selecting = false;
  while (Date.now() < deadline) {
    if (deps.waitForReply !== false) await delay(3_000, deps.signal);
    try {
      deps.signal?.throwIfAborted();
      const current = outbox.get(params.idempotencyKey);
      if (!current || current.legacy || !sameMirrorRequest(current, params)) throw new Error('Mirror admission changed');
      if (current.deliveryState !== 'pending') throw new MirrorDeliveryUnknown();
      if (current.gatewayRun?.state === 'blocked') throw new MirrorDeliverySettled('blocked', 'Mirror original Gateway run is not settled');
      if (replyWaitExpired(current)) throw new MirrorDeliverySettled('blocked', mirrorReplyTimeout);
      if (!current.nativeReply || (current.nativeReply.source === 'gateway' && current.gatewayRun?.state === 'pending')) {
        if (deps.waitForReply === false) return;
        continue;
      }
      params.nativeReply = current.nativeReply;
      if (current.gatewayRun) params.gatewayRun = current.gatewayRun;
      if (current.replyDeadlineAt !== undefined) params.replyDeadlineAt = current.replyDeadlineAt;
      selecting = true;
      if (current.nativeReply.source === 'gateway' && current.gatewayRun?.state !== 'completed') throw new Error('Mirror original Gateway run is not settled');
      const output = normalizeExternalMirrorText(current.nativeReply.text);
      if (!output) throw new MirrorDeliverySettled('no_output', 'Original native completion has no forwardable text; intent retained');
      const messageId = current.nativeReply.source === 'cli' ? `cli:${current.nativeReply.commandId}:assistant`
        : `gateway:${current.nativeReply.connectionId}:${current.nativeReply.runId}:${current.nativeReply.sequence}`;
      const text = formatMirrorOutput(params.inputText, output);
      let authorized: boolean | undefined;
      try { authorized = deps.authorizeTarget?.(structuredClone(params)); }
      catch { throw new MirrorDeliverySettled('blocked', 'Mirror original target authorization unavailable; intent retained, not retried'); }
      if (authorized !== true) throw new MirrorDeliverySettled('blocked', 'Mirror original target is not authorized');
      deps.signal?.throwIfAborted();
      hooks.onDispatch?.(messageId, text);
      await (deps.sendOutbound ?? sendOutboundChannelMessage)(params.explicitRoute, text, true);
      console.log(`[mirror] sent id=${params.idempotencyKey} session=${params.sessionKey} message=${messageId} target=${params.explicitRoute.outboundTarget}`);
      hooks.onSent?.(messageId);
      deps.store.append('queued_message.sent', {
        sessionKey: params.sessionKey,
        idempotencyKey: params.idempotencyKey,
        deliveryMode: 'mirror',
        outboundTarget: params.explicitRoute.outboundTarget,
        mirroredMessageId: messageId,
      }, { sessionKey: params.sessionKey });
      return;
    } catch (error) {
      if (selecting || deps.signal?.aborted || error instanceof MirrorDeliverySettled || deps.waitForReply === false) throw error;
      lastError = error;
      hooks.onAttemptError?.(error);
    }
  }
  throw new Error(`mirror delivery timed out waiting for original native reply${lastError ? `: ${deps.normalizeError(lastError)}` : ''}`);
}

export async function sendOutboundChannelMessage(route: ExplicitChannelRoute, text: string, localOpenClawCli = true) {
  if (!localOpenClawCli) throw new Error('mirror via local openclaw CLI is disabled for remote deployment');
  const args = [
    'message', 'send',
    '--channel', route.originatingChannel,
    '--target', route.outboundTarget,
    '--message', text,
    '--json',
  ];
  if (route.originatingAccountId) args.splice(4, 0, '--account', route.originatingAccountId);
  await execFileAsync('openclaw', args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
}

export function formatMirrorOutput(inputText: string, outputText: string) {
  const input = inputText.trim();
  if (!input) return outputText;
  return [`Input:\n${input}`, `Output:\n${outputText.trim()}`].join('\n\n');
}

export function normalizeExternalMirrorText(text: string) {
  let trimmed = text.trim();
  while (trimmed.startsWith('{"type":"thinking"')) {
    const newline = trimmed.indexOf('\n');
    if (newline < 0) return undefined;
    const firstLine = trimmed.slice(0, newline).trim();
    try {
      const parsed = JSON.parse(firstLine);
      if (parsed?.type !== 'thinking') break;
      trimmed = trimmed.slice(newline + 1).trim();
    } catch {
      break;
    }
  }
  if (!trimmed || trimmed.toUpperCase() === 'NO_REPLY' || isToolOnlyMirrorText(trimmed)) return undefined;
  return trimmed;
}

function isToolOnlyMirrorText(text: string) {
  const normalizedLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== '```text' && line !== '```json' && line !== '```');
  if (normalizedLines.length === 0) return false;
  if (normalizedLines.every((line) => /^\[tool output\]$/i.test(line))) return true;
  return /^\[tool\s+[^\]\n]+\]/i.test(text.trim());
}

export class MirrorOutbox {
  constructor(private readonly db: DatabaseSync, private readonly maxRows = 10_000, private readonly maxBytes = 32 * 1024 * 1024,
    private readonly commandEvidence?: CommandMirrorSink,
    private readonly deliveryEvents?: Pick<ConnectorEventLog, 'appendInTransaction'>) {
    db.exec(`CREATE TABLE IF NOT EXISTS connector_mirror_outbox (
      id TEXT PRIMARY KEY, session_key TEXT NOT NULL, job TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS connector_mirror_session ON connector_mirror_outbox(session_key, id);
    CREATE INDEX IF NOT EXISTS connector_mirror_recovery_v2 ON connector_mirror_outbox(session_key, id) WHERE ${recoverableMirror};
    CREATE INDEX IF NOT EXISTS connector_mirror_grant ON connector_mirror_outbox
      (json_extract(job, '$.executionGrant.id'), session_key)
      WHERE json_extract(job, '$.legacy') IS NULL AND json_extract(job, '$.deliveryState') = 'pending';
    CREATE UNIQUE INDEX IF NOT EXISTS connector_mirror_gateway_run ON connector_mirror_outbox
      (session_key, json_extract(job, '$.gatewayRun.connectionId'), json_extract(job, '$.gatewayRun.runId'))
      WHERE json_extract(job, '$.gatewayRun') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS connector_mirror_import (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), source TEXT NOT NULL, digest TEXT);
    CREATE TABLE IF NOT EXISTS connector_mirror_usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
    -- Measure legacy data only when bootstrapping its counter. Keep the gate
    -- and aggregates in one statement so writers cannot race initialization.
    INSERT OR IGNORE INTO connector_mirror_usage SELECT 1,
      (SELECT count(*) FROM connector_mirror_outbox),
      (SELECT coalesce(sum(length(cast(job AS BLOB)) + 512), 0) FROM connector_mirror_outbox)
      WHERE NOT EXISTS (SELECT 1 FROM connector_mirror_usage WHERE singleton = 1);
    CREATE TRIGGER IF NOT EXISTS connector_mirror_insert AFTER INSERT ON connector_mirror_outbox BEGIN
      UPDATE connector_mirror_usage SET rows = rows + 1, bytes = bytes + length(cast(new.job AS BLOB)) + 512 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_mirror_delete AFTER DELETE ON connector_mirror_outbox BEGIN
      UPDATE connector_mirror_usage SET rows = rows - 1, bytes = bytes - length(cast(old.job AS BLOB)) - 512 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_mirror_update AFTER UPDATE OF job ON connector_mirror_outbox BEGIN
      UPDATE connector_mirror_usage SET bytes = bytes + length(cast(new.job AS BLOB)) - length(cast(old.job AS BLOB)) WHERE singleton = 1;
    END;`);
  }

  list() {
    return (this.db.prepare('SELECT id, session_key, job FROM connector_mirror_outbox ORDER BY id').all() as MirrorRow[]).map(decodeMirrorRow);
  }

  get(id: string) {
    const row = this.db.prepare('SELECT id, session_key, job FROM connector_mirror_outbox WHERE id = ?').get(id) as MirrorRow | undefined;
    return row ? decodeMirrorRow(row) : undefined;
  }

  recoveryPage(after: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid mirror recovery page size');
    return (this.db.prepare(`SELECT DISTINCT session_key FROM connector_mirror_outbox
      WHERE ${recoverableMirror} AND session_key > ? ORDER BY session_key LIMIT ?`).all(after, Math.min(limit, 64)) as { session_key: string }[])
      .map(row => row.session_key);
  }

  recoveryJob(sessionKey: string) {
    const row = this.db.prepare(`SELECT id, session_key, job FROM connector_mirror_outbox
      WHERE ${recoverableMirror} AND session_key = ?
        AND (json_extract(job, '$.gatewayRun.state') = 'blocked' OR json_extract(job, '$.nativeReply') IS NOT NULL
          OR json_extract(job, '$.replyDeadlineAt') <= ?) ORDER BY id LIMIT 1`).get(sessionKey, Date.now()) as MirrorRow | undefined;
    return row ? decodeMirrorRow(row) : undefined;
  }

  /** Worker-internal business operation, not a generic job mutation. Select
   * original evidence and check CURRENT authority in the owning transaction.
   * Persist uncertainty before returning anything capable of an external send. */
  claimDelivery(sessionKey: string, localOpenClawCli: boolean,
    authorize: (params: MirrorParams) => boolean): MirrorDeliveryClaim {
    return this.transaction(() => {
      const job = this.recoveryJob(sessionKey);
      if (!job) return { state: 'idle' };
      const settle = (state: 'blocked' | 'no_output', lastError: string): MirrorDeliveryClaim => {
        this.saveJob({ ...job, deliveryState: state, lastError });
        this.deliveryEvent(job, 'queued_message.failed', { mirror: 'failed', error: lastError });
        return { state };
      };
      if (!localOpenClawCli) return settle('blocked', 'Mirror local OpenClaw CLI is disabled');
      if (job.gatewayRun?.state === 'blocked') return settle('blocked', 'Mirror original Gateway run is not settled');
      if (replyWaitExpired(job)) return settle('blocked', mirrorReplyTimeout);
      if (!job.nativeReply || job.nativeReply.source === 'gateway' && job.gatewayRun?.state !== 'completed') return { state: 'idle' };
      const output = normalizeExternalMirrorText(job.nativeReply.text);
      if (!output) return settle('no_output', 'Original native completion has no forwardable text; intent retained');
      // No async participant may silently become truthy authority.
      if (authorize(structuredClone(job)) !== true) return settle('blocked', 'Mirror original target is not authorized');
      const messageId = job.nativeReply.source === 'cli' ? `cli:${job.nativeReply.commandId}:assistant`
        : `gateway:${job.nativeReply.connectionId}:${job.nativeReply.runId}:${job.nativeReply.sequence}`;
      const text = formatMirrorOutput(job.inputText, output), attemptedAt = Date.now();
      const digest = createHash('sha256').update(text).digest('hex');
      this.saveJob({ ...job, deliveryState: 'outcome_unknown', selectedMessageId: messageId, outputSha256: digest, attemptedAt });
      this.deliveryEvent(job, 'queued_message.created', { mirror: 'started', outboundTarget: job.explicitRoute.outboundTarget });
      return { state: 'send', ref: { key: sessionKey, id: job.idempotencyKey, messageId, digest, attemptedAt },
        route: structuredClone(job.explicitRoute), text };
    });
  }

  /** Exact original effect acknowledgement, not authority for another effect.
   * Revocation after dispatch must not erase an actual successful send. */
  acknowledgeDelivery(ref: MirrorDeliveryRef): boolean {
    return this.transaction(() => {
      const job = this.get(ref.id);
      if (!job || job.legacy || job.sessionKey !== ref.key || job.selectedMessageId !== ref.messageId
        || job.outputSha256 !== ref.digest || job.attemptedAt !== ref.attemptedAt) return false;
      if (job.deliveryState === 'sent') return true;
      if (job.deliveryState !== 'outcome_unknown') return false;
      this.saveJob({ ...job, deliveryState: 'sent', mirroredMessageIds: [ref.messageId], lastMirroredAt: Date.now() });
      this.deliveryEvent(job, 'queued_message.sent', { outboundTarget: job.explicitRoute.outboundTarget, mirroredMessageId: ref.messageId });
      return true;
    });
  }

  private deliveryEvent(job: MirrorJob, type: 'queued_message.created' | 'queued_message.sent' | 'queued_message.failed',
    details: Record<string, string>) {
    this.deliveryEvents?.appendInTransaction(this.db, { id: '', type, ts: Date.now(), sessionKey: job.sessionKey,
      payload: { sessionKey: job.sessionKey, idempotencyKey: job.idempotencyKey, deliveryMode: 'mirror', ...details } });
  }

  usesExecutionGrant(target: ExecutionGrantTarget, grant: ExecutionGrantAuthority) {
    if (target.runtime !== 'openclaw') return false;
    return !!this.db.prepare(`SELECT 1 FROM connector_mirror_outbox
      WHERE json_extract(job, '$.legacy') IS NULL AND json_extract(job, '$.deliveryState') = 'pending'
        AND json_extract(job, '$.executionGrant.id') = ? AND session_key = ? AND json_extract(job, '$.actorId') = ?
        AND json_extract(job, '$.executionGrant.actorId') = ? AND json_extract(job, '$.executionGrant.issuerTokenId') = ?
        AND json_extract(job, '$.gatewayRun.state') IS NOT 'blocked' LIMIT 1`)
      .get(grant.id, target.sessionKey, grant.actorId, grant.actorId, grant.issuerTokenId);
  }

  hasUnresolved(sessionKey: string) {
    return !!this.db.prepare(`SELECT 1 FROM connector_mirror_outbox WHERE session_key = ?
      AND (json_extract(job, '$.legacy') = 1 OR json_extract(job, '$.deliveryState') IS NULL
        OR json_extract(job, '$.deliveryState') NOT IN ('sent', 'no_output', 'blocked')) LIMIT 1`).get(sessionKey);
  }

  maintenancePending(): number {
    return (this.db.prepare(`SELECT count(*) AS count FROM connector_mirror_outbox
      WHERE json_extract(job, '$.legacy') = 1 OR json_extract(job, '$.deliveryState') IS NULL
        OR json_extract(job, '$.deliveryState') NOT IN ('sent', 'no_output', 'blocked')`).get() as { count: number }).count;
  }

  admitInTransaction(db: DatabaseSync, params: MirrorParams) {
    this.assertTransaction(db);
    return this.upsert(params);
  }

  upsert(params: MirrorParams) {
    const job: MirrorJob = { ...structuredClone(params), createdAt: Date.now(), attempts: 0, deliveryState: 'pending' };
    validateMirrorJobs([job]);
    if (!job.actorId || job.legacy || job.nativeReply !== undefined || job.gatewayRun !== undefined || job.replyDeadlineAt !== undefined) throw new Error('Mirror outbox requires original actor and separate native evidence');
    return this.transaction(() => {
      const existing = this.get(params.idempotencyKey);
      if (existing) {
        if (existing.legacy || !sameMirrorRequest(existing, job)) throw new Error('Mirror outbox request conflict');
        return existing;
      }
      this.insert(job);
      return job;
    });
  }

  saveJob(next: MirrorJob) {
    validateMirrorJobs([next]);
    this.transaction(() => {
      const existing = this.get(next.idempotencyKey);
      if (!existing) throw new Error('Mirror outbox job missing');
      if (!sameMirrorRequest(existing, next) || existing.createdAt !== next.createdAt) throw new Error('Mirror outbox request conflict');
      if (JSON.stringify(existing.nativeReply) !== JSON.stringify(next.nativeReply)) throw new Error('Mirror native reply conflict');
      if (JSON.stringify(existing.gatewayRun) !== JSON.stringify(next.gatewayRun)) throw new Error('Mirror Gateway run conflict');
      if (existing.replyDeadlineAt !== next.replyDeadlineAt) throw new Error('Mirror reply deadline conflict');
      if (existing.legacy || next.legacy || !validDeliveryTransition(existing, next)) throw new Error('Mirror outbox delivery conflict');
      this.update(existing, next);
    });
  }

  recordCliReplyInTransaction(db: DatabaseSync, params: MirrorParams, text: string | undefined) {
    this.assertTransaction(db);
    const existing = this.get(params.idempotencyKey);
    if (!existing || existing.legacy || existing.gatewayRun || !sameMirrorRequest(existing, params)) throw new Error('Mirror native reply admission conflict');
    if (text === undefined) {
      if (existing.nativeReply || existing.deliveryState !== 'pending') throw new Error('Mirror native reply delivery conflict');
      this.update(existing, { ...existing, deliveryState: 'blocked', lastError: 'Original CLI completion has no structured reply evidence' });
      return;
    }
    const nativeReply = { source: 'cli' as const, commandId: params.idempotencyKey, text };
    if (existing.nativeReply) {
      if (JSON.stringify(existing.nativeReply) !== JSON.stringify(nativeReply)) throw new Error('Mirror native reply conflict');
      return;
    }
    if (existing.deliveryState !== 'pending') throw new Error('Mirror native reply delivery conflict');
    this.update(existing, { ...existing, nativeReply });
  }

  syncExecutionInTransaction(db: DatabaseSync, execution: OpenClawExecution, reply?: GatewayReply) {
    this.assertTransaction(db);
    const existing = this.get(execution.commandId);
    if (!existing || existing.legacy) return;
    if (existing.sessionKey !== execution.sessionKey) throw new Error('Mirror native execution admission conflict');
    if (existing.deliveryState === 'blocked' || existing.deliveryState === 'no_output') return;
    if (existing.deliveryState === 'pending' && !existing.gatewayRun && (execution.phase === 'failed' || execution.reason)
      && (execution.origin === 'cli' || !execution.runId || !execution.gatewayConnectionId)) {
      this.update(existing, { ...existing, deliveryState: 'blocked', lastError: 'Original native execution failed or became uncertain' });
      return;
    }
    if (execution.origin !== 'gateway' || !execution.runId || !execution.gatewayConnectionId) return;
    if (existing.nativeReply?.source === 'cli') throw new Error('Mirror Gateway admission conflict');
    const state = existing.gatewayRun?.state === 'blocked' || execution.reason || execution.phase === 'failed' ? 'blocked'
      : execution.phase === 'completed' ? 'completed' : 'pending';
    const gatewayRun = { runId: execution.runId, connectionId: execution.gatewayConnectionId, state } as const;
    if (existing.gatewayRun && (existing.gatewayRun.runId !== gatewayRun.runId || existing.gatewayRun.connectionId !== gatewayRun.connectionId)) {
      this.update(existing, { ...existing, gatewayRun: { ...existing.gatewayRun, state: 'blocked' } });
      return;
    }
    const replyDeadlineAt = existing.replyDeadlineAt ?? (state === 'completed' && !existing.nativeReply && !reply
      ? (execution.completedAt ?? execution.updatedAt) + mirrorReplyWaitMs : undefined);
    if (JSON.stringify(existing.gatewayRun) !== JSON.stringify(gatewayRun) || existing.replyDeadlineAt !== replyDeadlineAt) {
      this.update(existing, { ...existing, gatewayRun, ...(replyDeadlineAt === undefined ? {} : { replyDeadlineAt }) });
    }
    if (reply) this.observeFinalInTransaction(db, execution.sessionKey, { runId: execution.runId, gatewayConnectionId: execution.gatewayConnectionId,
      phase: 'completed', reply });
  }

  observeFinalInTransaction(db: DatabaseSync, sessionKey: string, event: OpenClawRunObservation) {
    this.assertTransaction(db);
    if (event.phase !== 'completed' || !event.reply || !event.gatewayConnectionId) return;
    const row = this.db.prepare(`SELECT id, session_key, job FROM connector_mirror_outbox
      WHERE session_key = ? AND json_extract(job, '$.gatewayRun.connectionId') = ? AND json_extract(job, '$.gatewayRun.runId') = ?
        AND json_extract(job, '$.gatewayRun') IS NOT NULL`).get(sessionKey, event.gatewayConnectionId, event.runId) as MirrorRow | undefined;
    if (!row) return;
    const existing = decodeMirrorRow(row);
    if (existing.legacy || !existing.gatewayRun || existing.gatewayRun.state === 'blocked'
      || existing.deliveryState === 'blocked' || existing.deliveryState === 'no_output') return;
    const nativeReply = { source: 'gateway' as const, commandId: existing.idempotencyKey, text: event.reply.text,
      runId: event.runId, connectionId: event.gatewayConnectionId, sequence: event.reply.sequence };
    if (existing.nativeReply) {
      if (JSON.stringify(existing.nativeReply) !== JSON.stringify(nativeReply)) {
        this.update(existing, { ...existing, gatewayRun: { ...existing.gatewayRun, state: 'blocked' } });
      }
      return;
    }
    if (existing.deliveryState !== 'pending') throw new Error('Mirror Gateway reply delivery conflict');
    this.update(existing, { ...existing, nativeReply, ...(replyWaitExpired(existing)
      ? { deliveryState: 'blocked' as const, lastError: mirrorReplyTimeout } : {}) });
  }

  recoverGatewayInTransaction(db: DatabaseSync) {
    this.assertTransaction(db);
    db.prepare(`UPDATE connector_mirror_outbox SET job = json_set(job, '$.gatewayRun.state', 'blocked')
      WHERE json_extract(job, '$.gatewayRun') IS NOT NULL
        AND (json_extract(job, '$.nativeReply') IS NULL OR json_extract(job, '$.gatewayRun.state') IS NOT 'completed')
        AND json_extract(job, '$.gatewayRun.state') IS NOT 'blocked'`).run();
  }

  remove(idempotencyKey: string) {
    this.transaction(() => {
      const job = this.get(idempotencyKey);
      if (job && (job.legacy || job.nativeReply || job.gatewayRun || job.deliveryState !== 'pending')) throw new Error('Mirror outbox delivery evidence cannot be removed');
      this.db.prepare('DELETE FROM connector_mirror_outbox WHERE id = ?').run(idempotencyKey);
    });
  }

  reclaimCompletedInTransaction(db: DatabaseSync, target: CompletedCommand) {
    this.assertTransaction(db);
    const job = this.get(target.id);
    if (!target.mirror) return !job;
    if (target.runtime !== 'openclaw' || !job || job.legacy || !job.nativeReply || job.actorId !== target.actorId
      || job.sessionKey !== target.sessionKey || !['sent', 'no_output'].includes(job.deliveryState ?? '')
      || (job.gatewayRun && job.gatewayRun.state !== 'completed')) return false;
    db.prepare('DELETE FROM connector_mirror_outbox WHERE id = ?').run(target.id);
    return true;
  }

  editInputInTransaction(db: DatabaseSync, sessionKey: string, id: string, inputText: string) {
    this.assertTransaction(db);
    const job = this.get(id);
    if (!job) throw new Error('Mirror outbox job missing');
    if (job.sessionKey !== sessionKey || job.legacy || job.nativeReply || job.gatewayRun || job.deliveryState !== 'pending') throw new Error('Mirror outbox edit conflict');
    this.update(job, { ...job, inputText });
  }

  cancelInTransaction(db: DatabaseSync, sessionKey: string, id: string) {
    this.assertTransaction(db);
    const job = this.get(id);
    if (!job) throw new Error('Mirror outbox job missing');
    if (job.sessionKey !== sessionKey) throw new Error('Mirror outbox cancel conflict');
    this.remove(id);
  }

  // The original file is evidence only. Every imported row is fenced from
  // automatic sending: old snapshots cannot prove actor/run provenance.
  importLegacy(file: string) {
    const bytes = readLegacyMirrorFile(file, this.maxBytes);
    const source = resolve(file), digest = bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex');
    this.transaction(() => {
      const imported = this.db.prepare('SELECT source, digest FROM connector_mirror_import WHERE singleton = 1').get() as { source: string; digest: string | null } | undefined;
      if (imported) {
        if (imported.source !== source || imported.digest !== digest) throw new Error('Legacy mirror outbox changed after import; preserved for inspection');
        return;
      }
      if (bytes !== undefined) {
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid mirror outbox JSON; preserved for inspection'); }
        if (!recordWithKeys(parsed, ['jobs'])) throw new Error('Invalid mirror outbox schema; preserved for inspection');
        validateMirrorJobs(parsed.jobs);
        for (const job of parsed.jobs) {
          if (job.actorId !== undefined || job.executionGrant !== undefined || job.legacy !== undefined || job.nativeReply !== undefined || job.gatewayRun !== undefined || job.replyDeadlineAt !== undefined) throw new Error('Invalid legacy mirror outbox provenance');
          this.insert({ ...job, legacy: true });
        }
      }
      this.db.prepare('INSERT INTO connector_mirror_import VALUES(1, ?, ?)').run(source, digest);
    });
  }

  private assertTransaction(db: DatabaseSync) {
    if (db !== this.db || !db.isTransaction) throw new Error('Mirror outbox requires its owning transaction');
  }

  private transaction<T>(run: () => T): T {
    if (this.db.isTransaction) return run();
    return observedTransaction(this.db, 'mirror-outbox-change', () => run() as T extends PromiseLike<unknown> ? never : T);
  }

  private capacity(addedRows: number, addedBytes: number, excludedNativeId: string, checkParticipant: (value: unknown) => void) {
    let usage = this.db.prepare('SELECT rows, bytes FROM connector_mirror_usage WHERE singleton = 1').get() as { rows: number; bytes: number };
    if (usage.rows + addedRows > this.maxRows || usage.bytes + addedBytes > this.maxBytes) {
      checkParticipant(this.commandEvidence?.reclaimCompletedInTransaction?.(this.db, excludedNativeId));
      usage = this.db.prepare('SELECT rows, bytes FROM connector_mirror_usage WHERE singleton = 1').get() as { rows: number; bytes: number };
    }
    if (usage.rows + addedRows > this.maxRows || usage.bytes + addedBytes > this.maxBytes) throw new Error('Mirror outbox capacity reached');
  }

  private insert(job: MirrorJob) {
    // Direct InTransaction callers also need a rollback boundary: an inner
    // callback may otherwise escape before the outer owner sees its result.
    observedSavepoint(this.db, 'mirror-outbox-change', checkParticipant => {
      const bytes = JSON.stringify(job);
      this.capacity(1, Buffer.byteLength(bytes) + 512, job.idempotencyKey, checkParticipant);
      this.db.prepare('INSERT INTO connector_mirror_outbox VALUES(?, ?, ?)').run(job.idempotencyKey, job.sessionKey, bytes);
    });
  }

  private update(before: MirrorJob, next: MirrorJob) {
    observedSavepoint(this.db, 'mirror-outbox-change', checkParticipant => {
      validateMirrorJobs([next]);
      const bytes = JSON.stringify(next);
      this.capacity(0, Buffer.byteLength(bytes) - Buffer.byteLength(JSON.stringify(before)), next.idempotencyKey, checkParticipant);
      this.db.prepare('UPDATE connector_mirror_outbox SET job = ? WHERE id = ?').run(bytes, next.idempotencyKey);
      checkParticipant(this.commandEvidence?.recordMirrorInTransaction(this.db, next));
    });
  }
}

type MirrorRow = { id: string; session_key: string; job: string };
function decodeMirrorRow(row: MirrorRow): MirrorJob {
  const job: unknown = JSON.parse(row.job);
  const jobs: unknown = [job]; validateMirrorJobs(jobs);
  const decoded = jobs[0];
  if (!decoded || decoded.idempotencyKey !== row.id || decoded.sessionKey !== row.session_key) throw new Error('Invalid mirror outbox identity');
  return decoded;
}

function readLegacyMirrorFile(file: string, maxBytes: number) {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { lstatSync(file); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return; throw missing; }
    throw new Error('Unreadable mirror outbox; preserved for inspection');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid or oversized legacy mirror outbox');
    const chunks: Buffer[] = []; let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - size + 1));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (!read) return Buffer.concat(chunks, size);
      size += read;
      if (size > maxBytes) throw new Error('Legacy mirror outbox exceeds import limit');
      chunks.push(chunk.subarray(0, read));
    }
  } finally { closeSync(fd); }
}

function sameMirrorRequest(left: MirrorParams, right: MirrorParams) {
  return left.idempotencyKey === right.idempotencyKey && left.sessionKey === right.sessionKey
    && left.actorId === right.actorId && left.executionGrant?.id === right.executionGrant?.id
    && left.executionGrant?.actorId === right.executionGrant?.actorId && left.executionGrant?.issuerTokenId === right.executionGrant?.issuerTokenId
    && left.after === right.after && left.inputText === right.inputText
    && left.explicitRoute.originatingChannel === right.explicitRoute.originatingChannel
    && left.explicitRoute.originatingTo === right.explicitRoute.originatingTo
    && left.explicitRoute.originatingAccountId === right.explicitRoute.originatingAccountId
    && left.explicitRoute.outboundTarget === right.explicitRoute.outboundTarget;
}

function recordWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function validDeliveryTransition(before: MirrorJob, after: MirrorJob) {
  if (after.attempts < before.attempts) return false;
  if (before.deliveryState === 'pending') return ['pending', 'outcome_unknown', 'no_output', 'blocked'].includes(String(after.deliveryState));
  if (before.deliveryState === 'no_output' || before.deliveryState === 'blocked') return false;
  if (!before.deliveryState || after.deliveryState !== 'sent') return false;
  return (before.deliveryState !== 'sent' || (after.deliveryState === 'sent' && before.lastMirroredAt === after.lastMirroredAt))
    && before.selectedMessageId === after.selectedMessageId && before.outputSha256 === after.outputSha256 && before.attemptedAt === after.attemptedAt;
}

function validDeliveryFields(job: Record<string, unknown>) {
  if (job.deliveryState === undefined) return job.selectedMessageId === undefined && job.outputSha256 === undefined && job.attemptedAt === undefined;
  if (job.deliveryState === 'no_output' || job.deliveryState === 'blocked') {
    if (typeof job.lastError !== 'string' || !job.lastError) return false;
    if (job.deliveryState === 'no_output' && (!recordWithKeys(job.nativeReply, ['source', 'commandId', 'text', 'runId', 'connectionId', 'sequence'])
      || typeof job.nativeReply.text !== 'string' || normalizeExternalMirrorText(job.nativeReply.text)
      || (job.nativeReply.source === 'gateway' && (!recordWithKeys(job.gatewayRun, ['runId', 'connectionId', 'state'])
        || job.gatewayRun.state !== 'completed')))) return false;
  }
  if (['pending', 'no_output', 'blocked'].includes(String(job.deliveryState))) return job.selectedMessageId === undefined && job.outputSha256 === undefined && job.attemptedAt === undefined
    && job.mirroredMessageIds === undefined && job.lastMirroredAt === undefined;
  if (!['outcome_unknown', 'sent'].includes(String(job.deliveryState)) || typeof job.selectedMessageId !== 'string' || !job.selectedMessageId.trim()
    || typeof job.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(job.outputSha256)
    || typeof job.attemptedAt !== 'number' || !Number.isSafeInteger(job.attemptedAt) || job.attemptedAt < 0) return false;
  return job.deliveryState === 'outcome_unknown' ? job.mirroredMessageIds === undefined && job.lastMirroredAt === undefined
    : typeof job.lastMirroredAt === 'number' && job.lastMirroredAt >= job.attemptedAt
      && Array.isArray(job.mirroredMessageIds) && job.mirroredMessageIds.length === 1 && job.mirroredMessageIds[0] === job.selectedMessageId;
}

function validateMirrorJobs(value: unknown): asserts value is MirrorJob[] {
  const nonempty = (input: unknown) => typeof input === 'string' && input.trim().length > 0;
  const time = (input: unknown) => typeof input === 'number' && Number.isFinite(input) && input >= 0;
  const keys = new Set<string>();
  if (!Array.isArray(value) || value.some(job => {
    if (!recordWithKeys(job, ['actorId', 'executionGrant', 'legacy', 'nativeReply', 'gatewayRun', 'replyDeadlineAt', 'sessionKey', 'after', 'inputText', 'explicitRoute', 'idempotencyKey', 'createdAt', 'attempts', 'lastError', 'mirroredMessageIds', 'lastMirroredAt',
      'deliveryState', 'selectedMessageId', 'outputSha256', 'attemptedAt']) || !validDeliveryFields(job)
      || (job.legacy !== undefined && job.legacy !== true)
      || !validNativeEvidence(job)
      || (job.actorId !== undefined && !nonempty(job.actorId))
      || (job.executionGrant !== undefined && (!recordWithKeys(job.executionGrant, ['id', 'actorId', 'issuerTokenId'])
        || !nonempty(job.executionGrant.id) || !nonempty(job.executionGrant.issuerTokenId) || job.executionGrant.actorId !== job.actorId))
      || !nonempty(job.sessionKey) || !nonempty(job.idempotencyKey) || typeof job.inputText !== 'string'
      || !time(job.after) || !time(job.createdAt) || !Number.isSafeInteger(job.attempts) || Number(job.attempts) < 0
      || (job.lastError !== undefined && typeof job.lastError !== 'string')
      || (job.lastMirroredAt !== undefined && !time(job.lastMirroredAt))
      || (job.mirroredMessageIds !== undefined && (!Array.isArray(job.mirroredMessageIds) || !job.mirroredMessageIds.every(nonempty)))
      || !recordWithKeys(job.explicitRoute, ['originatingChannel', 'originatingTo', 'originatingAccountId', 'outboundTarget'])
      || !nonempty(job.explicitRoute.originatingChannel) || !nonempty(job.explicitRoute.originatingTo)
      || !nonempty(job.explicitRoute.outboundTarget)
      || (job.explicitRoute.originatingAccountId !== undefined && !nonempty(job.explicitRoute.originatingAccountId))) return true;
    const id = job.idempotencyKey as string;
    if (keys.has(id)) return true;
    keys.add(id); return false;
  })) throw new Error('Invalid mirror outbox jobs; preserved for inspection');
}

function validNativeEvidence(job: Record<string, unknown>) {
  const identity = (value: unknown) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512;
  const run = job.gatewayRun;
  if (job.replyDeadlineAt !== undefined && (!Number.isSafeInteger(job.replyDeadlineAt) || Number(job.replyDeadlineAt) < 0
    || !recordWithKeys(run, ['runId', 'connectionId', 'state']) || !['completed', 'blocked'].includes(String(run.state)))) return false;
  if (run !== undefined && (job.legacy || !recordWithKeys(run, ['runId', 'connectionId', 'state'])
    || !identity(run.runId) || !identity(run.connectionId) || !['pending', 'completed', 'blocked'].includes(String(run.state)))) return false;
  const reply = job.nativeReply;
  if (reply === undefined) return true;
  if (job.legacy || !recordWithKeys(reply, ['source', 'commandId', 'text', 'runId', 'connectionId', 'sequence'])
    || reply.commandId !== job.idempotencyKey || typeof reply.text !== 'string' || Buffer.byteLength(reply.text) > 1024 * 1024) return false;
  if (reply.source === 'cli') return run === undefined && recordWithKeys(reply, ['source', 'commandId', 'text']);
  return reply.source === 'gateway' && recordWithKeys(run, ['runId', 'connectionId', 'state'])
    && run.runId === reply.runId && run.connectionId === reply.connectionId
    && Number.isSafeInteger(reply.sequence) && Number(reply.sequence) >= 0;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
