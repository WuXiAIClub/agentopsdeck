import type { SdkDispatchAdapter, SdkSettlement } from '../connector/sdk-dispatch.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import type { SdkInputAttachment } from '../connector/sdk-attachment-input.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import type { SdkExecution, SdkExecutionRef, SdkTerminalOutcome } from '../connector/sdk-execution-journal.js';

export const CLAUDE_SDK_VERSION = '0.3.280';
export const CLAUDE_CLI_VERSION = '2.1.280';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = () => new Error('Claude execution could not be confirmed');

/** Implemented inside a private SDK worker, never with Hub HOME/configuration.
 * Exactly one query per execution. The worker owns process/descendant proof;
 * SDK result, session_state_changed(idle), or parent exit alone is NOT proof.
 * History rows must come from this exact native session in its explicit dir.
 * No raw provider errors, prompts, tool bodies or credentials cross this API. */
export interface ClaudeNativeTurn extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  historyIdentities(): Promise<readonly { type: string; uuid: string; session_id: string; parent_tool_use_id: string | null }[]>;
  inspectQuiescence(): Promise<boolean>;
  close(): void;
}
type Slot = {
  execution: SdkExecution; turn: ClaudeNativeTurn; initialized: boolean; admitted: boolean;
  ended: boolean; failed: boolean; released: boolean; stopRequested: boolean;
  result?: SdkTerminalOutcome; resultId?: string;
  assistants: Set<string>; tasks: Map<string, boolean>;
  accept: (value: { nativeRequestId: string }) => void; reject: (error: Error) => void;
};

/** Native Claude lifecycle bridge. It deliberately does not load the SDK,
 * discover user sessions, authorize tools, or retry an uncertain send.
 * Public runtime discovery/routes remain disabled until the private worker,
 * configuration, history projection and permission policy are integrated. */
export class ClaudeDispatchAdapter implements SdkDispatchAdapter {
  private available = true;
  private readonly slots = new Map<string, Slot>();
  readonly epoch: string;
  constructor(private readonly options: {
    epoch: string;
    start: (execution: SdkExecution, text: string, context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => ClaudeNativeTurn;
    terminal: (ref: SdkExecutionRef, outcome: SdkTerminalOutcome) => boolean | Promise<boolean>;
    unknown: (ref: SdkExecutionRef) => void;
    drained?: (ref: SdkExecutionRef) => void;
  }) {
    if (!identity(options.epoch)) throw new Error('Invalid Claude worker epoch');
    this.epoch = options.epoch;
  }
  get ready() { return this.available; }

  send(execution: SdkExecution, text: string, context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext): Promise<{ nativeRequestId: string }> {
    if (execution.kind === 'compact' || !this.ready || execution.epoch !== this.epoch || !execution.key.startsWith('claude-code:')
      || !uuid.test(execution.id) || !uuid.test(execution.nativeSessionId)
      || !['create', 'resume'].includes(execution.nativeMode)
      || !text.trim() || this.slots.has(execution.key) && !this.slots.get(execution.key)!.released) {
      return Promise.reject(failure());
    }
    // The journal has already committed intent. start is invoked once, with
    // an immutable snapshot so delayed caller mutations cannot rebind events.
    const snapshot = structuredClone(execution);
    let turn: ClaudeNativeTurn;
    try { turn = this.options.start(structuredClone(snapshot), text, context, attachments, interaction); }
    catch {
      try { this.options.unknown(snapshot); } catch { this.available = false; }
      return Promise.reject(failure());
    }
    let accept!: Slot['accept'], reject!: Slot['reject'];
    const ack = new Promise<{ nativeRequestId: string }>((resolve, fail) => { accept = resolve; reject = fail; });
    const slot: Slot = { execution: snapshot, turn, initialized: false, admitted: false,
      ended: false, failed: false, released: false, stopRequested: false,
      assistants: new Set(), tasks: new Map(), accept, reject };
    this.slots.set(snapshot.key, slot);
    void this.consume(slot);
    return ack;
  }

  async interrupt(execution: SdkExecution): Promise<void> {
    const slot = this.match(execution);
    if (!slot || !slot.admitted || slot.result || slot.failed || slot.stopRequested || !execution.stopRequested) throw failure();
    slot.stopRequested = true;
    // The durable stop intent must precede this call. SDK acknowledgment only
    // means the request was handled; it does not mark idle or settle history.
    await slot.turn.interrupt();
  }

  async inspectSettlement(execution: SdkExecution): Promise<SdkSettlement> {
    const proof: SdkSettlement = { key: execution.key, id: execution.id, epoch: execution.epoch,
      nativeSessionId: execution.nativeSessionId, historyPersisted: false, nativeQuiescent: false };
    const slot = this.match(execution);
    if (!slot || slot.failed || !slot.result || !slot.ended || [...slot.tasks.values()].some(active => active)) return proof;
    // Inspect native quiescence both before and after the history read. A
    // timeout is bounded by SdkDispatch and freezes intent, never replays it.
    if (!await slot.turn.inspectQuiescence()) return proof;
    const rows = await slot.turn.historyIdentities();
    if (!await slot.turn.inspectQuiescence() || !this.match(execution) || slot.failed) return proof;
    const rootRows = rows.filter(row => row.session_id === execution.nativeSessionId && row.parent_tool_use_id === null);
    const inputs = rootRows.filter(row => row.type === 'user' && row.uuid === execution.id);
    const outputs = new Set(rootRows.filter(row => row.type === 'assistant').map(row => row.uuid));
    // A success without any durable assistant is not a confirmed transcript.
    // A correlated error/interrupt can legitimately have no assistant output.
    proof.historyPersisted = inputs.length === 1 && (slot.result !== 'completed' || slot.assistants.size > 0)
      && [...slot.assistants].every(id => outputs.has(id));
    proof.nativeQuiescent = true;
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
    this.slots.clear();
    if (failed) throw failure();
  }

  private match(ref: SdkExecutionRef & { nativeSessionId?: string }): Slot | undefined {
    const slot = this.slots.get(ref.key);
    return this.ready && slot?.execution.id === ref.id && slot.execution.epoch === ref.epoch
      && (!ref.nativeSessionId || slot.execution.nativeSessionId === ref.nativeSessionId) ? slot : undefined;
  }
  private fail(slot: Slot) {
    if (slot.failed || slot.released) return;
    slot.failed = true; slot.reject(failure());
    // Callback failures must not turn a consumed native stream into an
    // unhandled promise rejection. Journal errors still leave it unresolved.
    try { this.options.unknown(slot.execution); } catch { this.available = false; }
  }
  private async consume(slot: Slot) {
    try {
      for await (const event of slot.turn) {
        if (!this.match(slot.execution) || slot.failed) break;
        // A malformed/foreign event is not the SDK's expected post-interrupt
        // exception, even if a correlated interrupt result already arrived.
        try { await this.observe(slot, event); } catch { this.fail(slot); break; }
      }
      if (!slot.result) this.fail(slot);
    } catch {
      // The pinned native SDK emits a correlated error result and then throws
      // after interrupt. Keep that evidence; history AND native quiescence are
      // still mandatory. An unrelated exception cannot become an interrupt.
      if (slot.result !== 'interrupted' || !slot.stopRequested) this.fail(slot);
    }
    finally {
      slot.ended = true;
      // Notify the owning scheduler AFTER consuming the iterator, not merely
      // on SDK result. The scheduler still needs native/history settlement.
      try { this.options.drained?.(slot.execution); } catch { this.fail(slot); }
    }
  }
  private async observe(slot: Slot, event: unknown) {
    if (!record(event) || typeof event.type !== 'string') throw failure();
    if (event.session_id !== slot.execution.nativeSessionId) throw failure();
    const child = event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null;
    if (event.type === 'system' && event.subtype === 'init') {
      if (child || event.claude_code_version !== CLAUDE_CLI_VERSION || slot.initialized) throw failure();
      slot.initialized = true; return;
    }
    // The pinned native CLI also emits additive frames (e.g.
    // command_lifecycle before init) absent from the SDK's public TS union.
    // Ignore them, without using them as version/admission/terminal evidence.
    const taskEvent = event.type === 'system' && ['task_started', 'task_notification'].includes(String(event.subtype));
    if (!taskEvent && !['user', 'assistant', 'stream_event', 'result'].includes(event.type)) return;
    if (!slot.initialized) throw failure();
    if (taskEvent) {
      if (!identity(event.task_id)) throw failure();
      // Closed tombstones prevent duplicate/out-of-order starts resurrecting
      // a task. Bound identity memory; overflow fails closed, not silently idle.
      if (!slot.tasks.has(event.task_id) && slot.tasks.size >= 10_000) throw failure();
      if (event.subtype === 'task_notification') {
        if (!['completed', 'failed', 'stopped'].includes(String(event.status))) throw failure();
        slot.tasks.set(event.task_id, false);
      } else if (!slot.tasks.has(event.task_id)) slot.tasks.set(event.task_id, true);
      return;
    }
    // Subagent output/result never acknowledges or completes a root send.
    if (child) return;
    const correlated = event.user_message_uuid === slot.execution.id
      || event.type === 'user' && event.uuid === slot.execution.id;
    if (event.user_message_uuid !== undefined && event.user_message_uuid !== slot.execution.id) throw failure();
    // We supply precisely one UUID to one query; native folding of additional
    // sends means exclusive ownership was lost. Do not settle that execution.
    if (event.user_message_uuids !== undefined && (!Array.isArray(event.user_message_uuids)
      || event.user_message_uuids.length !== 1 || event.user_message_uuids[0] !== slot.execution.id)) throw failure();
    if (event.type === 'result') {
      if (!correlated || !identity(event.uuid) || typeof event.is_error !== 'boolean'
        || event.queued_turn_count !== undefined && event.queued_turn_count !== 0) throw failure();
      const outcome = event.is_error ? slot.stopRequested ? 'interrupted' : 'failed' : 'completed';
      if (slot.result) { if (slot.resultId !== event.uuid || slot.result !== outcome) throw failure(); return; }
      // A worker command's Promise is not a durable terminal ACK. Keep the
      // stream ordered behind its original reply; close/failure during the
      // wait must never be undone by a late acknowledgement.
      if (await this.options.terminal(slot.execution, outcome) !== true
        || !this.available || slot.failed || this.match(slot.execution) !== slot) throw failure();
      slot.result = outcome; slot.resultId = event.uuid;
    } else if (slot.result && ['assistant', 'user', 'stream_event'].includes(event.type)) throw failure();
    if (event.type === 'assistant') {
      if (!identity(event.uuid) || !record(event.message) || event.message.role !== 'assistant') throw failure();
      if (slot.assistants.size >= 10_000 && !slot.assistants.has(event.uuid)) throw failure();
      slot.assistants.add(event.uuid);
    }
    if (correlated && ['user', 'assistant', 'stream_event', 'result'].includes(event.type) && !slot.admitted) {
      slot.admitted = true; slot.accept({ nativeRequestId: slot.execution.id });
    }
  }
}
