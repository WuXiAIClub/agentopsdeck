import type { InteractionAnswer, InteractionScope } from '@agentopsdeck/shared';
import type { InteractionRuntime, InteractionQuestion } from '../commands/interaction-runtime.js';
import type { NativeInteractionRuntime } from '../commands/interaction-port.js';
import type { InteractionContinuation } from '../commands/interaction-continuation.js';
import { codexQuestions } from '../commands/native-questions.js';
import { interactionToolPrompt } from '../commands/interaction-tool-prompt.js';
import { interactionCapabilitiesFor } from '../connector/sdk-interaction.js';
import { interactionGoalEvidence } from './interaction-goal.js';

type Identity = { ownerId: string; commandId: string; connectionId: string; turnId?: string; running: boolean;
  goal: Promise<InteractionContinuation['goal']>; seen: Set<string>; runtime: NativeInteractionRuntime; permitted?: () => Promise<boolean> };
type Pending = { scope: InteractionScope; runtime: NativeInteractionRuntime; publicId?: string; acknowledged?: boolean; responded?: boolean; resolve?: (value: 'confirmed' | 'unknown') => void; closed: boolean };
type Options = {
  runtime?: InteractionRuntime; nodeId: string;
  connection(): string | undefined;
  execution(key: string): { commandId: string; connectionId: string; runId?: string; phase: string } | undefined;
  permitted(key: string, actor: string): boolean;
  request(method: string, params: unknown): Promise<any>;
  write(message: unknown): void;
};
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const nativeId = (v: unknown): v is string | number => typeof v === 'string' && !!v && v.length <= 512 || typeof v === 'number' && Number.isSafeInteger(v);

/** In-memory original-child authority only. Durable records never reconstruct
 * a callback after restart. Goal successors retain the original actor, not a
 * guessed actor from the next browser or queued command. */
export class CodexInteractionBridge {
  private readonly owners = new Map<string, Identity>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: Options) {}
  begin(key: string, ownerId: string | undefined, commandId: string, delegated: boolean) {
    this.stop(key);
    this.owners.delete(key);
    const connectionId = this.options.connection();
    if (!ownerId || delegated || !connectionId) return false;
    if (this.options.runtime?.store.mode({ ownerId, nodeId: this.options.nodeId, sessionKey: key }) !== 'interactive') return false;
    this.register(key, ownerId, commandId, connectionId, this.options.runtime);
    return true;
  }
  /** Only an already verified original worker binding can enter this path. */
  beginOwned(key: string, ownerId: string, commandId: string, connectionId: string, runtime: NativeInteractionRuntime,
    permitted: () => Promise<boolean>): () => void {
    if (!ownerId || connectionId !== this.options.connection()) throw new Error('Original Codex interaction connection unavailable');
    this.stop(key); this.owners.delete(key);
    const identity = this.register(key, ownerId, commandId, connectionId, runtime, permitted);
    return () => { if (this.owners.get(key) === identity) { this.stop(key); this.owners.delete(key); } };
  }
  private register(key: string, ownerId: string, commandId: string, connectionId: string, runtime: NativeInteractionRuntime,
    permitted?: () => Promise<boolean>) {
    // Retain goal owners only while the same native execution/connection still
    // exists. A completed owner may legitimately own the next goal turn.
    for (const [session, identity] of this.owners) {
      const execution = this.options.execution(session);
      if (identity.connectionId !== connectionId || !execution || execution.commandId !== identity.commandId
        || execution.connectionId !== identity.connectionId || ['stopping', 'interrupted', 'failed'].includes(execution.phase)) {
        this.stop(session); this.owners.delete(session);
      }
    }
    if (this.owners.size >= 2048) throw new Error('Codex interaction ownership capacity reached');
    const threadId = key.slice('codex:'.length);
    const goal = this.options.request('thread/goal/get', { threadId }).then(v => interactionGoalEvidence(v, threadId),
      () => ({ status: 'unknown' as const, version: '' }));
    const identity: Identity = { ownerId, commandId, connectionId, running: false, goal, seen: new Set(), runtime, ...(permitted ? { permitted } : {}) };
    this.owners.set(key, identity); return identity;
  }
  notification(method: string, params: unknown) {
    if (!record(params) || typeof params.threadId !== 'string') return;
    const key = `codex:${params.threadId}`, owner = this.owners.get(key);
    if (method === 'serverRequest/resolved' && nativeId(params.requestId)) {
      const id = this.rpcKey(params.threadId, params.requestId), entry = this.pending.get(id);
      if (!entry) return;
      if (entry.resolve) { this.pending.delete(id); entry.closed = true; entry.acknowledged = true; entry.resolve('confirmed'); }
      else this.cancel(id, entry, 'disconnected'); // native withdrew an unanswered question
    }
    if (!owner || owner.connectionId !== this.options.connection()) return;
    if (method === 'thread/goal/updated' && owner.running && params.turnId === owner.turnId
      && this.options.execution(key)?.runId === owner.turnId) {
      // Goal creation within the owned turn can precede the first question.
      owner.goal = Promise.resolve(interactionGoalEvidence(params, params.threadId));
    }
    if (method === 'turn/started' && typeof params.turn?.id === 'string') {
      if (owner.turnId === params.turn.id) return;
      this.stop(key); owner.turnId = params.turn.id; owner.running = true;
    } else if (method === 'turn/completed' && params.turn?.id === owner.turnId) {
      owner.running = false; this.stop(key);
      owner.runtime.nativeRunEnded({ ownerId: owner.ownerId, nodeId: this.options.nodeId, sessionKey: key, runId: owner.turnId! });
      owner.seen.clear();
      const turnId = owner.turnId;
      // Retain a continuing goal's actor, but do not accumulate completed
      // ordinary sessions forever. A late read must never erase a successor
      // or newly admitted owner. Unknown evidence remains fail-closed.
      void this.options.request('thread/goal/get', { threadId: params.threadId }).then(result => {
        if (this.owners.get(key) !== owner || owner.running || owner.turnId !== turnId
          || owner.connectionId !== this.options.connection()) return;
        const goal = interactionGoalEvidence(result, params.threadId);
        if (goal.status === 'absent' || goal.status === 'complete') this.owners.delete(key);
      }).catch(() => { /* An unavailable goal is not evidence of completion. */ });
    }
  }
  handle(method: string, id: string | number, params: unknown): boolean {
    if (!['item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return false;
    if (!nativeId(id) || !record(params) || typeof params.threadId !== 'string' || typeof params.turnId !== 'string'
      || !params.turnId.trim() || params.turnId.length > 256 || /[\x00-\x1f\x7f]/.test(params.turnId) || typeof params.itemId !== 'string') return false;
    const key = `codex:${params.threadId}`, owner = this.owners.get(key), execution = this.options.execution(key);
    if (!owner || !execution || owner.commandId !== execution.commandId || owner.connectionId !== this.options.connection()
      || execution.connectionId !== owner.connectionId || ['stopping', 'interrupted', 'failed'].includes(execution.phase)) return false;
    // turn/start response can precede its notification; native execution journal
    // is valid fallback only for the exact acknowledged running turn.
    if (!owner.turnId && execution.runId === params.turnId && execution.phase === 'running') { owner.turnId = params.turnId; owner.running = true; }
    if (!owner.running || owner.turnId !== params.turnId) return false;
    const rpc = this.rpcKey(params.threadId, id);
    if (owner.seen.has(rpc)) return true;
    if (this.pending.size >= 32 || owner.seen.size >= 2048) return false;
    owner.seen.add(rpc);
    const scope = { ownerId: owner.ownerId, nodeId: this.options.nodeId, sessionKey: key, runId: params.turnId };
    const entry: Pending = { scope, runtime: owner.runtime, closed: false };
    this.pending.set(rpc, entry);
    const alive = () => !entry.closed && this.pending.get(rpc) === entry && this.owners.get(key) === owner && owner.running
      && owner.turnId === params.turnId && owner.connectionId === this.options.connection()
      && this.options.execution(key)?.commandId === owner.commandId
      && this.options.execution(key)?.connectionId === owner.connectionId
      && !['stopping', 'interrupted', 'failed'].includes(this.options.execution(key)?.phase ?? 'failed');
    const continuation = async (): Promise<InteractionContinuation> => {
      if (!alive()) throw new Error('Original Codex request is unavailable');
      const goal = interactionGoalEvidence(await this.options.request('thread/goal/get', { threadId: params.threadId }), params.threadId);
      if (!alive()) throw new Error('Codex connection changed');
      // An unrelated external turn must not inherit the original actor. Native
      // goal successors are accepted only with affirmative continuing-goal evidence.
      if (this.options.execution(key)?.runId !== params.turnId) {
        const original = await owner.goal;
        if (!alive()) throw new Error('Codex execution changed');
        if (!['active', 'blocked'].includes(goal.status) || !['active', 'blocked'].includes(original.status)
          || goal.version !== original.version) throw new Error('Unowned Codex successor');
      } else if (['active', 'blocked'].includes(goal.status)) {
        // The admitted original turn may itself create a goal. Pin its identity
        // before accepting any later autonomous successor.
        owner.goal = Promise.resolve(goal);
      }
      return { connectionId: owner.connectionId, goal: goal as InteractionContinuation['goal'] };
    };
    const writeResult = (result: unknown) => new Promise<'confirmed' | 'unknown'>(resolve => {
      if (!alive() || entry.responded) { resolve('unknown'); return; }
      entry.responded = true;
      entry.resolve = resolve;
      try { this.options.write({ id, result }); } catch { this.cancel(rpc, entry, 'disconnected'); }
    });
    const cancelNative = () => {
      if (!alive() || entry.responded) return;
      entry.responded = true;
      try { this.options.write({ id, ...(method.endsWith('/requestApproval') ? { result: { decision: 'cancel' } }
        : { error: { code: -32000, message: 'Interaction closed; no answer was submitted' } }) }); } catch { /* lost connection */ }
    };
    const ask = async (question: InteractionQuestion, deliver: (answer: InteractionAnswer) => Promise<'confirmed' | 'unknown'>) => {
      const view = await owner.runtime.open(question, interactionCapabilitiesFor('codex'), { scope, active: alive, continuation,
        permitted: async () => alive() && (owner.permitted ? await owner.permitted() : this.options.permitted(key, owner.ownerId)) === true && alive(), deliver,
        cancel: () => { cancelNative(); this.cancel(rpc, entry, 'disconnected'); } });
      entry.publicId = view.request.requestId;
      if (!alive() && !entry.acknowledged) owner.runtime.closeRequest(scope, entry.publicId, 'disconnected');
    };
    void (async () => {
      if (method === 'item/tool/requestUserInput') {
        const questions = codexQuestions(params), answers: Record<string, { answers: string[] }> = {};
        const next = async (index: number): Promise<void> => {
          const q = questions[index]!;
          await ask(q.question, async answer => {
            answers[q.id] = { answers: q.decode(answer) };
            if (index === questions.length - 1) return writeResult({ answers });
            // Original adapter retains partial answers; no native tool has
            // resumed. Only final answer writes the original RPC response.
            queueMicrotask(() => { void next(index + 1).catch(() => { cancelNative(); this.cancel(rpc, entry, 'disconnected'); }); });
            return 'confirmed';
          });
        };
        await next(0);
      } else {
        // Session/root/network grants are not allow-once and are not exposed.
        if (params.additionalPermissions != null || params.networkApprovalContext != null || params.grantRoot != null) throw new Error('Additional permissions are not supported');
        let details: unknown;
        if (method === 'item/commandExecution/requestApproval') {
          if (typeof params.command !== 'string' || !params.command.trim()
            || params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes('accept'))) throw new Error('Command approval unavailable');
          details = { command: params.command, cwd: params.cwd, reason: params.reason };
        } else {
          // One latest turn only. Approval must never materialize the entire
          // transcript of a long-running session, nor search an older turn.
          const reply = await this.options.request('thread/turns/list', { threadId: params.threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
          const turn = reply?.data?.find((t: any) => t.id === params.turnId);
          const item = turn?.items?.find((i: any) => i.id === params.itemId && i.type === 'fileChange');
          if (!item || !Array.isArray(item.changes) || !item.changes.length) throw new Error('Exact file changes unavailable');
          details = { changes: item.changes, reason: params.reason };
        }
        if (!alive()) return;
        await ask({ kind: 'approval', prompt: interactionToolPrompt('Codex', details) }, async answer => {
          if (answer.kind !== 'approval') throw new Error('Invalid approval');
          return writeResult({ decision: answer.decision === 'allow-once' ? 'accept' : 'decline' });
        });
      }
    })().catch(() => { cancelNative(); this.cancel(rpc, entry, 'disconnected'); });
    return true;
  }
  stop(key: string) {
    for (const [id, entry] of this.pending) if (entry.scope.sessionKey === key) this.cancel(id, entry, 'stopped');
  }
  reset() {
    for (const [id, entry] of this.pending) this.cancel(id, entry, 'disconnected');
    this.owners.clear();
  }
  private cancel(id: string, entry: Pending, reason: 'stopped' | 'disconnected') {
    if (entry.closed) return;
    entry.closed = true; this.pending.delete(id); entry.resolve?.('unknown');
    if (entry.publicId) entry.runtime.closeRequest(entry.scope, entry.publicId, reason);
  }
  private rpcKey(thread: string, id: string | number) { return JSON.stringify([this.options.connection(), thread, id]); }
}
