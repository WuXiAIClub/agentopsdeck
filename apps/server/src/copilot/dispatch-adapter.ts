import type { SdkDispatchAdapter, SdkSettlement } from '../connector/sdk-dispatch.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import type { SdkInputAttachment } from '../connector/sdk-attachment-input.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import type { SdkExecution, SdkExecutionRef, SdkTerminalOutcome } from '../connector/sdk-execution-journal.js';

export const COPILOT_SDK_VERSION = '1.0.14';
export const COPILOT_CLI_VERSION = '1.0.85';
export const COPILOT_PROTOCOL_VERSION = 3;
const failure = () => new Error('Copilot execution could not be confirmed');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export type CopilotHistoryIdentity = { id: string; type: 'user.message' | 'assistant.message'; messageId: string; originatingMessageId?: string };
/** One private, exclusively owned session/worker per invocation. The worker
 * verifies the CLI handshake before sending and supplies ONLY lifecycle
 * frames here. Neither session.idle nor send ACK proves process cleanup.
 * Unknown delivery must never be retried by the implementation. */
export interface CopilotNativeTurn extends AsyncIterable<unknown> {
  verified: Promise<{ sessionId: string; version: string; protocolVersion: number }>;
  admitted: Promise<{ messageId: string }>;
  interrupt(): Promise<void>;
  historyIdentities(): Promise<{ sessionId: string; entries: readonly CopilotHistoryIdentity[] }>;
  inspectQuiescence(): Promise<boolean>;
  close(): void;
}
type Slot = {
  execution: SdkExecution; turn: CopilotNativeTurn; failed: boolean; ended: boolean; released: boolean;
  stopRequested: boolean; idle: boolean; aborted: boolean; sawError: boolean; toolFailed: boolean;
  ack?: string; user?: { id: string; messageId: string }; outcome?: SdkTerminalOutcome;
  terminal?: Promise<void>;
  assistants: Map<string, string>; tools: Map<string, boolean>;
};

/** Copilot lifecycle deliberately does NOT use Claude result semantics.
 * A model iteration's assistant.turn_end/assistant.idle is not session.idle.
 * Root user echo + exact native ACK precede a terminal, and durable identity
 * plus confirmed native cleanup precede dispatching the next queue batch. */
export class CopilotDispatchAdapter implements SdkDispatchAdapter {
  private available = true;
  private readonly slots = new Map<string, Slot>();
  readonly epoch: string;
  constructor(private readonly options: {
    epoch: string; start: (execution: SdkExecution, text: string, context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => CopilotNativeTurn;
    terminal: (ref: SdkExecutionRef, outcome: SdkTerminalOutcome) => boolean | Promise<boolean>;
    unknown: (ref: SdkExecutionRef) => void; drained?: (ref: SdkExecutionRef) => void;
  }) {
    if (!identity(options.epoch)) throw new Error('Invalid Copilot worker epoch');
    this.epoch = options.epoch;
  }
  get ready() { return this.available; }

  async send(execution: SdkExecution, text: string, context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext): Promise<{ nativeRequestId: string }> {
    if (execution.kind === 'compact' || !this.ready || execution.epoch !== this.epoch || !execution.key.startsWith('ghcp:')
      || !uuid.test(execution.id) || !uuid.test(execution.nativeSessionId) || !['create', 'resume'].includes(execution.nativeMode)
      || !text.trim() || (this.slots.has(execution.key) && !this.slots.get(execution.key)!.released)) throw failure();
    const snapshot = structuredClone(execution);
    let turn: CopilotNativeTurn;
    try { turn = this.options.start(structuredClone(snapshot), text, context, attachments, interaction); }
    catch { this.markUnknown(snapshot); throw failure(); }
    const slot: Slot = { execution: snapshot, turn, failed: false, ended: false, released: false, stopRequested: false,
      idle: false, aborted: false, sawError: false, toolFailed: false, assistants: new Map(), tools: new Map() };
    this.slots.set(snapshot.key, slot);
    // Attach both rejection handlers immediately: a native failure before the
    // version handshake must not become an unhandled rejection.
    const ack = turn.admitted.then(value => ({ value }), () => ({ value: undefined }));
    void this.consume(slot);
    try {
      const status = await turn.verified;
      if (status.sessionId !== snapshot.nativeSessionId || status.version !== COPILOT_CLI_VERSION
        || status.protocolVersion !== COPILOT_PROTOCOL_VERSION) throw failure();
      const { value } = await ack;
      if (slot.failed || !value || !identity(value.messageId)
        || slot.user && slot.user.messageId !== value.messageId) throw failure();
      slot.ack = value.messageId;
      await this.terminal(slot);
      return { nativeRequestId: value.messageId };
    } catch { this.fail(slot); throw failure(); }
  }

  async interrupt(execution: SdkExecution): Promise<void> {
    const slot = this.match(execution);
    if (!slot || !slot.ack || slot.idle || slot.failed || slot.stopRequested || !execution.stopRequested) throw failure();
    slot.stopRequested = true;
    await slot.turn.interrupt();
  }

  async inspectSettlement(execution: SdkExecution): Promise<SdkSettlement> {
    const proof: SdkSettlement = { key: execution.key, id: execution.id, epoch: execution.epoch,
      nativeSessionId: execution.nativeSessionId, nativeQuiescent: false, historyPersisted: false };
    const slot = this.match(execution);
    if (!slot || slot.failed || !slot.ended || !slot.outcome || !slot.user || !slot.ack) return proof;
    proof.nativeQuiescent = await slot.turn.inspectQuiescence();
    if (!proof.nativeQuiescent) return proof;
    const history = await slot.turn.historyIdentities();
    if (slot.failed || !this.ready || !this.match(execution) || history.sessionId !== execution.nativeSessionId
      || history.entries.length > 10_000) return { ...proof, nativeQuiescent: false };
    const users = history.entries.filter(row => row.type === 'user.message' && row.messageId === slot.ack);
    proof.historyPersisted = users.length === 1 && users[0]!.id === slot.user.id
      && [...slot.assistants].every(([id, messageId]) => history.entries.some(row => row.type === 'assistant.message'
        && row.id === id && row.messageId === messageId && (!row.originatingMessageId || row.originatingMessageId === slot.ack)));
    if (proof.historyPersisted) slot.released = true;
    return proof;
  }

  close() {
    this.available = false;
    let failed = false;
    for (const slot of this.slots.values()) {
      if (!slot.released) this.fail(slot);
      try { slot.turn.close(); } catch { failed = true; }
    }
    if (failed) throw failure();
  }
  private match(ref: SdkExecutionRef & { nativeSessionId?: string }) {
    const slot = this.slots.get(ref.key);
    return slot && slot.execution.id === ref.id && slot.execution.epoch === ref.epoch
      && (!ref.nativeSessionId || ref.nativeSessionId === slot.execution.nativeSessionId) ? slot : undefined;
  }
  private markUnknown(ref: SdkExecutionRef) {
    try { this.options.unknown(ref); } catch { this.available = false; }
  }
  private fail(slot: Slot) {
    if (slot.failed || slot.released) return;
    slot.failed = true; this.markUnknown(slot.execution);
    // Closing this private worker is cleanup, never a retry or proof of idle.
    try { slot.turn.close(); } catch { this.available = false; }
  }
  private async terminal(slot: Slot) {
    // Native ACK and stream consumption can converge here concurrently.
    // Both must observe the same original owner command, never submit twice.
    if (slot.terminal) return slot.terminal;
    if (slot.failed || slot.outcome || !slot.ack || !slot.user || !slot.idle) return;
    // Native abort can end an in-flight shell without tool.execution_complete.
    // Only an exact requested stop may take this path. It is not tool success:
    // durable history and independently verified worker cleanup still gate
    // settlement and admission of the next queued turn.
    if (slot.ack !== slot.user.messageId
      || [...slot.tools.values()].some(Boolean) && !(slot.aborted && slot.stopRequested)) throw failure();
    const outcome = slot.aborted ? 'interrupted' : slot.sawError || (!slot.assistants.size && slot.toolFailed) ? 'failed' : 'completed';
    if (outcome === 'completed' && !slot.assistants.size) throw failure();
    const task = Promise.resolve().then(async () => {
      if (!this.available || slot.failed || this.match(slot.execution) !== slot) throw failure();
      if (await this.options.terminal(slot.execution, outcome) !== true
        || !this.available || slot.failed || this.match(slot.execution) !== slot) throw failure();
      slot.outcome = outcome;
      // ACK may arrive after the stream ends. Wake settlement in both orders.
      if (slot.ended) this.options.drained?.(slot.execution);
    });
    slot.terminal = task;
    return task;
  }
  private async consume(slot: Slot) {
    try {
      const status = await slot.turn.verified;
      if (status.sessionId !== slot.execution.nativeSessionId || status.version !== COPILOT_CLI_VERSION
        || status.protocolVersion !== COPILOT_PROTOCOL_VERSION) throw failure();
      for await (const event of slot.turn) {
        if (slot.failed || !this.match(slot.execution)) break;
        await this.observe(slot, event);
      }
      if (!slot.failed && !slot.idle) throw failure();
    } catch { this.fail(slot); }
    finally {
      slot.ended = true;
      try { this.options.drained?.(slot.execution); } catch { this.fail(slot); }
    }
  }
  private async observe(slot: Slot, event: unknown) {
    if (!record(event) || typeof event.type !== 'string' || !identity(event.id) || !record(event.data)) throw failure();
    const data = event.data;
    if (event.agentId !== undefined || data.parentToolCallId !== undefined) return;
    if (event.type === 'user.message') {
      if (!identity(data.messageId) || slot.idle || slot.user && (slot.user.id !== event.id || slot.user.messageId !== data.messageId)
        || slot.ack && slot.ack !== data.messageId) throw failure();
      slot.user = { id: event.id, messageId: data.messageId };
    } else if (['assistant.message', 'tool.execution_start', 'tool.execution_complete', 'session.error'].includes(event.type)) {
      if (!slot.user || slot.idle) throw failure();
      if (data.originatingMessageId !== undefined && data.originatingMessageId !== slot.user.messageId) throw failure();
      if (event.type === 'assistant.message') {
        if (!identity(data.messageId) || slot.assistants.size >= 10_000
          || slot.assistants.has(event.id) && slot.assistants.get(event.id) !== data.messageId) throw failure();
        slot.assistants.set(event.id, data.messageId);
      } else if (event.type === 'session.error') slot.sawError = true;
      else {
        if (!identity(data.toolCallId) || slot.tools.size >= 10_000) throw failure();
        if (event.type === 'tool.execution_start') {
          if (!slot.tools.has(data.toolCallId)) slot.tools.set(data.toolCallId, true);
        } else {
          if (!slot.tools.has(data.toolCallId) || typeof data.success !== 'boolean') throw failure();
          slot.tools.set(data.toolCallId, false); slot.toolFailed ||= !data.success;
        }
      }
    } else if (event.type === 'session.idle') {
      // Ignore startup/resume idle, which precedes this invocation's user echo.
      if (!slot.user) return;
      if (data.aborted !== undefined && typeof data.aborted !== 'boolean') throw failure();
      if (slot.idle && slot.aborted !== (data.aborted === true)) throw failure();
      slot.idle = true; slot.aborted = data.aborted === true;
    }
    await this.terminal(slot);
  }
}
