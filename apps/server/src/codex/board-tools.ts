import { validBoardUuid } from '@agentopsdeck/shared';
import { BOARD_READ_TOOL, boardToolNames, boardToolDescriptions, boardReadSchema, boardUpdateSchema,
  loadWorkerBoardTools, validBoardToolInput } from '../tools/workspace-board-worker.js';

/** Fixed tool definitions only, no endpoint, capability or filesystem path is
 * ever sent to the native model. Enrolled at thread/start, never thread/resume. */
export const codexBoardToolSpecs = boardToolNames.map(name => ({ type: 'function', name,
  description: boardToolDescriptions[name], inputSchema: name === BOARD_READ_TOOL ? boardReadSchema : boardUpdateSchema }));

type ToolCall = { threadId: string; turnId: string; callId: string; namespace: null; tool: string; arguments: unknown };
type Turn = { active: (turnId: string) => boolean | Promise<boolean>; abort: AbortController; seen: Set<string>; busy: boolean;
  pending: Set<Promise<unknown>> };
const bounded = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
function validCall(v: unknown): v is ToolCall {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as ToolCall;
  return validBoardUuid(c.threadId) && bounded(c.turnId) && bounded(c.callId) && c.namespace === null
    && boardToolNames.some(name => name === c.tool) && validBoardToolInput(c.tool, c.arguments);
}
const result = (value: Record<string, unknown>) => ({ contentItems: [{ type: 'inputText', text: JSON.stringify(value) }], success: !value.error });

/** A per-admitted-turn host bridge. A native request is NOT an authorization:
 * the exact current command, execution lease and private binding are rechecked.
 * Stop/connection loss abort HTTP; a started write is never silently replayed. */
export class CodexBoardTools {
  private turns = new Map<string, Turn>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly directory: string | undefined, private readonly fetcher: typeof fetch = fetch) {}
  begin(threadId: string, active: (turnId: string) => boolean | Promise<boolean>) {
    this.stop(threadId);
    const turn: Turn = { active, abort: new AbortController(), seen: new Set(), busy: false, pending: new Set() };
    if (this.directory && !this.closed && validBoardUuid(threadId)) this.turns.set(threadId, turn);
    // Only revoke this original binding. Late cleanup cannot stop its successor.
    return () => {
      turn.abort.abort();
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId);
      return Promise.allSettled([...turn.pending]).then(() => {});
    };
  }
  stop(threadId: string) { const turn = this.turns.get(threadId); turn?.abort.abort(); this.turns.delete(threadId); }
  reset() { for (const id of this.turns.keys()) this.stop(id); }
  get inFlight() { return this.pending.size; }
  close(): Promise<void> {
    this.closed = true; this.reset();
    return this.closing ??= Promise.allSettled([...this.pending]).then(() => {});
  }
  invoke(value: unknown) {
    if (this.closed || this.pending.size >= 16) return Promise.resolve(result({ error: 'Task tool unavailable or request budget exceeded' }));
    let snapshot: unknown;
    try { snapshot = structuredClone(value); } catch { return Promise.resolve(result({ error: 'Task tool unavailable or invalid input' })); }
    const turn = validCall(snapshot) ? this.turns.get(snapshot.threadId) : undefined;
    // Register the physical drain before calling authority or exposing a promise.
    // Neither reentrant close nor replacing the returned promise's then may
    // hide outstanding worker permission checks or an uncertain HTTP mutation.
    const task = Promise.resolve().then(() => this.run(snapshot, turn));
    const release = () => { this.pending.delete(drain); turn?.pending.delete(drain); };
    const drain = task.then(release, release); this.pending.add(drain); turn?.pending.add(drain);
    return task;
  }
  private async run(value: unknown, turn: Turn | undefined) {
    if (this.closed || !this.directory || !validCall(value)) return result({ error: 'Task tool unavailable or invalid input' });
    const call = value;
    const local = () => !this.closed && !!turn && this.turns.get(call.threadId) === turn && !turn.abort.signal.aborted;
    const current = async () => {
      try { return local() && await turn!.active(call.turnId) === true && local(); }
      catch { return false; }
    };
    if (!turn || !local()) return result({ error: 'Task tool is not authorized for this active turn' });
    if (turn.seen.has(call.callId)) return result({ error: 'Task call already received; inspect the board before retrying' });
    if (turn.seen.size >= 512) return result({ error: 'Task tool request budget exceeded' });
    // Reserve before any await. Duplicate native requests cannot repeat writes.
    turn.seen.add(call.callId);
    if (turn.busy) return result({ error: 'Another task operation is in progress', status: 429 });
    turn.busy = true;
    let worker;
    try {
      if (!await current()) return result({ error: 'Task tool is not authorized for this active turn' });
      worker = await loadWorkerBoardTools(this.directory, 'codex', call.threadId, current, this.fetcher);
      if (!worker || !await current()) return result({ error: 'Private task grant unavailable or expired' });
      return result(await worker.invoke(call.tool, call.arguments, turn.abort.signal));
    } catch { return result({ error: 'Private task grant unavailable or expired' }); }
    finally { worker?.close(); turn.busy = false; }
  }
}
