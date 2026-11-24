import { open } from 'node:fs/promises';
import type { ChatMessageMedia, SendDeliveryMode } from '@agentopsdeck/shared';
import type { DeckStore } from '../projection/deck-store.js';
import { TurnQueue, TurnAuthorizationError, isRecord, type QueuedTurn, type TurnQueueCommit } from '../commands/turn-queue.js';
import { TurnWorker } from '../commands/turn-worker.js';
import { readRecoveryPage } from '../commands/recovery-page.js';
import { MAX_MEDIA_BYTES, MAX_TOTAL_MEDIA_BYTES } from '../messages/send-message.js';
import { MirrorDeliveryUnknown, MirrorDispatcherClosed, type MirrorOutbox } from '../messages/mirror.js';
import type { AuthorizeTurn, ExecutionGrantAuthority } from '../connector/execution-grants.js';
import type { OpenClawExecutions } from './executions.js';
import { isNormalOpenClawCompletion, type OpenClawRecoverySource } from './recovery.js';
import { openClawMessageCommit } from './message-admission.js';
import { recoverOpenClawStartup } from './startup-recovery.js';

export type ExplicitRoute = { originatingChannel: string; originatingTo: string; originatingAccountId?: string; outboundTarget: string };
export type OpenClawQueuedPayload = {
  actorId?: string | undefined;
  executionGrant?: ExecutionGrantAuthority | undefined;
  message: string;
  deliveryMode: SendDeliveryMode;
  explicitRoute?: ExplicitRoute;
  // New admissions retain file references, not a second copy of base64 bytes.
  // Only one-time legacy imports can still contain an inline attachment.
  media: Array<{ media: ChatMessageMedia; filePath?: string; gatewayAttachment?: unknown }>;
};
export type OpenClawQueuedTurn = QueuedTurn<OpenClawQueuedPayload>;

export class OpenClawTurnQueue {
  private closed = false;
  private worker: TurnWorker;
  constructor(private readonly options: {
    turns: TurnQueue;
    executions: OpenClawExecutions;
    queueFile?: string;
    store: DeckStore;
    authorizeTurn: AuthorizeTurn;
    refreshSessions: () => Promise<void>;
    refreshMessages: (sessionKey: string, options?: { fresh: true }) => Promise<void>;
    send: (turn: OpenClawQueuedTurn, attachments: unknown[]) => Promise<unknown>;
    mirror: (turn: OpenClawQueuedTurn) => Promise<void>;
    reconcileMirror?: (sessionKey: string) => Promise<void>;
    mirrorOutbox?: MirrorOutbox;
    recovery?: OpenClawRecoverySource;
  }) {
    options.store.bindOpenClawExecutions(options.executions, options.recovery ? () => options.recovery!.connectionId() : undefined);
    recoverOpenClawStartup(options.turns, options.executions, options.queueFile);
    for (const turn of options.turns.list<OpenClawQueuedPayload>('openclaw')) this.project(turn);
    this.worker = new TurnWorker({ queue: options.turns, runtime: 'openclaw', reconcile: (key) => this.reconcile(key),
      additionalSessionPage: async (after, limit, isCurrent) => {
        const connectionId = options.recovery?.connectionId();
        return readRecoveryPage(after, limit, [
          (cursor, size) => options.executions.recoveryPage(connectionId, cursor, size),
          (cursor, size) => options.executions.historyPage(cursor, size),
          ...(options.reconcileMirror && options.mirrorOutbox
            ? [(cursor: string, size: number) => options.mirrorOutbox!.recoveryPage(cursor, size)] : []),
        ], () => isCurrent() && !this.closed && options.recovery?.connectionId() === connectionId);
      } });
  }

  start() { if (!this.closed) this.worker.start(); }
  pause() { return this.worker.pause(); }
  wake() { if (!this.closed) this.worker.wake(); }
  async close() { this.closed = true; await this.worker.close(); }
  hasPending(sessionKey: string) { return this.options.turns.hasPending('openclaw', sessionKey); }
  enqueue(turn: Omit<OpenClawQueuedTurn, 'state'>, commitReceipt?: Parameters<TurnQueue['enqueue']>[2]) {
    this.checkAdmission(turn);
    this.options.turns.enqueue('openclaw', turn, this.admissionCommit(turn, commitReceipt));
    this.project({ ...turn, state: 'queued' });
  }
  async enqueueAsync(turn: Omit<OpenClawQueuedTurn, 'state'>, commitReceipt?: TurnQueueCommit,
    check: () => void = () => {}) {
    // Freeze authority and mirror data used by the commit callback as well as
    // the row. Callers cannot mutate one while the coordinator is waiting.
    const snapshot = { ...turn, payload: JSON.parse(JSON.stringify(turn.payload)) as OpenClawQueuedPayload };
    const ready = () => { check(); this.checkAdmission(snapshot); };
    await this.options.turns.enqueueAsync('openclaw', snapshot, this.admissionCommit(snapshot, commitReceipt), ready);
    ready();
    this.project({ ...snapshot, state: 'queued' });
  }
  private checkAdmission(turn: Omit<OpenClawQueuedTurn, 'state'>) {
    if (this.closed) throw new Error('OpenClaw queue closed');
    if (!this.authorized(turn)) throw new TurnAuthorizationError();
  }
  private admissionCommit(turn: Omit<OpenClawQueuedTurn, 'state'>, commitReceipt?: TurnQueueCommit): TurnQueueCommit {
    return openClawMessageCommit(turn, this.options.mirrorOutbox, commitReceipt);
  }
  edit(sessionKey: string, id: string, message: string, expectedVersion?: string, commitReceipt?: TurnQueueCommit) {
    let mirror = false;
    const changed = this.options.turns.edit<OpenClawQueuedPayload>('openclaw', sessionKey, id, (payload) => {
      mirror = payload.deliveryMode === 'mirror';
      return { ...payload, message };
    }, expectedVersion, db => {
      if (mirror) {
        if (!this.options.mirrorOutbox) throw new Error('Mirror admission is not configured');
        this.options.mirrorOutbox.editInputInTransaction(db, sessionKey, id, message);
      }
      commitReceipt?.(db);
    });
    const existing = this.options.store.getMessages(sessionKey).find((item) => item.id === id);
    if (changed && existing) this.options.store.addMessage({ ...existing, text: message, queueVersion: this.options.turns.version('openclaw', sessionKey, id), updatedAt: Date.now() });
    return changed;
  }
  cancel(sessionKey: string, id: string, expectedVersion?: string, commitReceipt?: TurnQueueCommit) {
    const changed = this.options.turns.cancel<OpenClawQueuedPayload>('openclaw', sessionKey, id, expectedVersion, db => {
      commitReceipt?.(db);
    }, (db, payload) => {
      if (payload.deliveryMode === 'mirror') {
        if (!this.options.mirrorOutbox) throw new Error('Mirror admission is not configured');
        this.options.mirrorOutbox.cancelInTransaction(db, sessionKey, id);
      }
    });
    if (changed) this.options.store.removeMessage(sessionKey, id);
    return changed;
  }

  private async reconcile(sessionKey: string) {
    if (this.closed) return;
    await this.options.reconcileMirror?.(sessionKey);
    if (this.closed) return;
    await this.recoverExecution(sessionKey);
    if (this.closed) return;
    // An accepted execution survives removal of its last queued message.
    const synced = await this.syncHistory(sessionKey);
    if (this.closed) return;
    const head = this.options.turns.head<OpenClawQueuedPayload>('openclaw', sessionKey);
    if (!head) return;
    if (head?.state === 'blocked') return;
    if (head?.state === 'queued' && !this.authorized(head)) {
      this.options.turns.block('openclaw', head.id);
      this.project({ ...head, state: 'blocked' });
      return;
    }
    await this.options.refreshSessions();
    if (this.closed) return;
    if (!synced) await this.options.refreshMessages(sessionKey);
    if (this.closed) return;
    const { turns, store, executions } = this.options;
    // Transcript rows cannot acknowledge command acceptance or execution.
    // Unknown legacy admissions remain queued until explicit reconciliation.
    const session = store.getSessionExecution(sessionKey);
    // Execution admission must not call the display getter: legacy summaries
    // can infer idle from assistant/compaction text while a run is still active.
    if (!session || session.hasActiveRun || !['idle', 'failed'].includes(session.status)) return;
    const next = turns.head<OpenClawQueuedPayload>('openclaw', sessionKey);
    if (!next || next.state !== 'queued') return;
    if (!turns.start('openclaw', sessionKey, next.id)) return;
    let dispatched = false;
    let begun = false;
    let accepted = false;
    try {
      const attachments = await readOpenClawQueuedAttachments(next.payload);
      if (!this.authorized(next)) throw new TurnAuthorizationError();
      const current = store.getSessionExecution(sessionKey);
      if (this.closed || !current || current.hasActiveRun || !['idle', 'failed'].includes(current.status)) {
        turns.defer('openclaw', next.id);
        this.project({ ...next, state: 'queued' });
        return;
      }
      if (!executions.begin(sessionKey, next.id)) {
        turns.defer('openclaw', next.id);
        this.project({ ...next, state: 'queued' });
        return;
      }
      begun = true;
      store.projectOpenClawExecution(sessionKey);
      dispatched = true;
      const dispatchedAt = Date.now();
      const result = await this.options.send(next, attachments);
      const commit = () => turns.complete('openclaw', next.id);
      const acknowledged = executions.get(sessionKey)?.origin === 'cli'
        ? executions.acknowledgeCli(sessionKey, next.id, commit)
        : executions.acknowledge(sessionKey, next.id, isRecord(result) ? result.runId : undefined, commit);
      if (!acknowledged) throw new Error('OpenClaw dispatch identity changed before acknowledgement');
      accepted = true;
      if (store.projectOpenClawExecution(sessionKey)) this.wake();
      this.project(next, 'sent', dispatchedAt);
      store.append('queued_message.sent', { sessionKey, idempotencyKey: next.id, result, queued: true }, { sessionKey });
    } catch (error) {
      if (accepted) { store.invalidateOpenClawExecutionFacts(); return; }
      if (error instanceof TurnAuthorizationError) {
        if (begun) executions.rejectBeforeRun(sessionKey, next.id);
        turns.block('openclaw', next.id);
        this.project({ ...next, state: 'blocked' });
      } else if (dispatched) {
        executions.uncertain(sessionKey, next.id);
        turns.uncertain('openclaw', next.id);
        this.project({ ...next, state: 'outcome_unknown' });
      } else {
        if (begun) executions.rejectBeforeRun(sessionKey, next.id);
        turns.defer('openclaw', next.id);
        this.project({ ...next, state: 'queued' });
      }
      if (begun) store.projectOpenClawExecution(sessionKey);
      return;
    }
    // Mirroring is independent of runtime acceptance; its failure cannot
    // turn an accepted command into a second dispatch.
    if (next.payload.deliveryMode === 'mirror' && this.options.reconcileMirror) this.wake();
    else if (next.payload.deliveryMode === 'mirror') void this.options.mirror(next).catch(error => {
      if (error instanceof MirrorDeliveryUnknown || error instanceof MirrorDispatcherClosed) return;
      store.append('queued_message.failed', { sessionKey, idempotencyKey: next.id, mirrorError: 'Mirror delivery failed' }, { sessionKey });
    });
  }

  private async recoverExecution(sessionKey: string) {
    const { recovery, executions, store } = this.options;
    if (!recovery || this.closed) return false;
    const candidate = executions.recoveryCandidate(sessionKey, recovery.connectionId());
    if (!candidate?.runId || !candidate.gatewayConnectionId) return false;
    let snapshot: unknown;
    try { snapshot = await recovery.query(candidate.runId, candidate.gatewayConnectionId); }
    catch { return false; } // Transport failure is never a completion/retry proof.
    if (this.closed || recovery.connectionId() !== candidate.gatewayConnectionId
      || !isNormalOpenClawCompletion(snapshot, candidate.runId)) return false;
    if (!executions.completeFromQuery(candidate)) return false;
    try { store.projectOpenClawExecution(sessionKey); }
    catch { store.invalidateOpenClawExecutionFacts(); }
    return true;
  }

  private async syncHistory(sessionKey: string) {
    const { executions } = this.options;
    const sync = executions.get(sessionKey)?.historySync;
    if (!sync || sync.state === 'current') return false;
    try {
      await this.options.refreshMessages(sessionKey, { fresh: true });
      if (!this.closed) executions.setHistorySync(sessionKey, sync.revision, 'current');
    } catch {
      if (!this.closed) executions.setHistorySync(sessionKey, sync.revision, 'error');
    }
    if (!this.closed) {
      try { this.options.store.projectOpenClawExecution(sessionKey); }
      catch { this.options.store.invalidateOpenClawExecutionFacts(); }
    }
    // Read failure neither changes execution nor prevents successor admission.
    // The original worker will retry the durable pending/error fact.
    return true;
  }

  private authorized(turn: Omit<OpenClawQueuedTurn, 'state'>) {
    const target = { runtime: 'openclaw' as const, sessionKey: turn.sessionKey };
    return this.options.authorizeTurn(turn.payload.actorId, target, 'messages:send', turn.payload.executionGrant)
      && (turn.payload.deliveryMode !== 'mirror'
        || this.options.authorizeTurn(turn.payload.actorId, target, 'messages:mirror', turn.payload.executionGrant));
  }

  private project(turn: OpenClawQueuedTurn, status?: 'sent', dispatchedAt?: number) {
    this.options.store.addMessage({ id: turn.id, sessionKey: turn.sessionKey, role: 'user', text: turn.payload.message,
      queueVersion: status ? undefined : this.options.turns.version('openclaw', turn.sessionKey, turn.id),
      media: turn.payload.media.map((item) => item.media), createdAt: dispatchedAt ?? turn.createdAt, updatedAt: Date.now(),
      status: status ?? (turn.state === 'blocked' ? 'failed' : turn.state === 'queued' ? 'queued' : 'outcome_unknown'),
      ...(turn.state === 'blocked' ? { failureReason: new TurnAuthorizationError().message } : {}) });
  }
}

export async function readOpenClawQueuedAttachments(payload: OpenClawQueuedPayload) {
  const attachments: unknown[] = [];
  let total = 0;
  for (const item of payload.media) {
    if (!item.filePath) { attachments.push(item.gatewayAttachment); continue; }
    const file = await open(item.filePath, 'r');
    try {
      const { size } = await file.stat();
      total += size;
      if (size > MAX_MEDIA_BYTES || total > MAX_TOTAL_MEDIA_BYTES || (item.media.size !== undefined && item.media.size !== size)) throw new Error('Queued attachment changed or exceeds limit');
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await file.read(bytes, offset, size - offset, offset);
        if (!result.bytesRead) throw new Error('Queued attachment truncated');
        offset += result.bytesRead;
      }
      attachments.push({ fileName: item.media.name, mimeType: item.media.mimeType, content: bytes.toString('base64') });
    } finally { await file.close(); }
  }
  return attachments;
}
