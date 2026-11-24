import { isRecord } from '../commands/turn-queue.js';
import { backgroundTerminals } from './background-terminals.js';
import { isSelfRootSubAgentActivity, nativeGoalEvidence, nativeGoalProtection, nativeHistoryFingerprint } from './native-history.js';

type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const terminal = (v: unknown) => ['completed', 'failed', 'interrupted'].includes(String(v));
function fail(): never { throw new Error('Native child drain is unconfirmed'); }
const fingerprint = (thread: any): string => JSON.stringify([
  nativeHistoryFingerprint(thread), thread.parentThreadId ?? null, thread.forkedFromId ?? null,
]);

/** Identities from native structured items only, never messages or tool text. */
export function nativeChildIds(items: readonly unknown[], selfRootThreadId?: string): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) fail();
    let refs: unknown[];
    if (item.type === 'subAgentActivity') {
      if (!identity(item.agentThreadId)) fail();
      if (isSelfRootSubAgentActivity(item, selfRootThreadId)) continue;
      refs = [item.agentThreadId];
    } else if (['collabAgentToolCall', 'collabToolCall'].includes(String(item.type))) {
      if (!Array.isArray(item.receiverThreadIds) || !item.receiverThreadIds.length) fail();
      refs = item.receiverThreadIds;
      if (isRecord(item.agentsStates)) refs = [...refs, ...Object.keys(item.agentsStates)];
    } else continue;
    for (const id of refs) { if (!identity(id)) fail(); ids.add(id); }
    if (ids.size > 32) fail();
  }
  return [...ids];
}

/** Same-owner, read-only proof of the referenced child subtree. No discovery
 * of unrelated transcripts, projection, resume, cancellation, or persisted
 * child content. Caller invalidates check on native activity/connection changes.
 * Tool completion alone is deliberately NOT execution evidence. */
type ChildSnapshot = { id: string; path: unknown; fingerprint: string; goal: string; loaded: boolean };
type Options = {
  /** Full root turn IDs establish the inherited prefix of native forks. */
  parentTurnIds?: ReadonlySet<string> | undefined;
  cold?: ChildSnapshot[];
};

async function childProof(parentId: string, items: readonly unknown[], request: Request,
  check: () => void, deadline: number, options: Options): Promise<void> {
  const first = nativeChildIds(items, parentId);
  if (!first.length) return;
  const remaining = () => { check(); const ms = deadline - Date.now(); if (ms <= 0) fail(); return ms; };
  const read = async (method: string, params: unknown) => {
    const result = await request(method, params, remaining()); remaining(); return result;
  };
  const loaded = async () => {
    const ids = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const r = await read('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isRecord(r) || !Array.isArray(r.data) || r.data.length > 100) fail();
      for (const id of r.data) { if (!identity(id) || ids.has(id)) fail(); ids.add(id); }
      if (r.nextCursor == null) return ids;
      if (!identity(r.nextCursor) || cursors.has(r.nextCursor)) fail();
      cursor = r.nextCursor; cursors.add(cursor);
    }
    return fail();
  };
  const before = await loaded();
  const seen = new Map<string, { parent: string; depth: number; fingerprint: string; goal: string; loaded: boolean }>();
  const pending = first.map(id => ({ id, parent: parentId, depth: 1, parentTurns: options.parentTurnIds }));
  let itemCount = 0;
  const snapshot = async (id: string, parent: string, isLoaded: boolean, parentTurns?: ReadonlySet<string>) => {
    const r = await read('thread/read', { threadId: id, includeTurns: true });
    if (!isRecord(r) || !isRecord(r.thread)) fail();
    const t = r.thread;
    if (t.id !== id || t.parentThreadId !== parent || !isRecord(t.status)
      || t.status.type !== (isLoaded ? 'idle' : 'notLoaded')
      || !Array.isArray(t.turns) || !t.turns.length || t.turns.length > 2048) fail();
    const turnIds = new Set<string>(), itemIds = new Set<string>();
    const children: unknown[] = [];
    let ownTurns = false;
    if (t.forkedFromId != null && (t.forkedFromId !== parent || !parentTurns)) fail();
    for (const turn of t.turns) {
      if (!isRecord(turn) || !identity(turn.id) || turnIds.has(turn.id) || !terminal(turn.status)
        || turn.itemsView !== 'full' || !Array.isArray(turn.items)) fail();
      turnIds.add(turn.id);
      const inherited = t.forkedFromId === parent && parentTurns!.has(turn.id);
      if (inherited && ownTurns) fail();
      if (!inherited) ownTurns = true;
      // Interrupted execution wrappers can dispatch tools after their abort.
      // Without separate cleanup evidence this is NOT an automatic recovery.
      if (!inherited && turn.status === 'interrupted') fail();
      for (const item of turn.items) {
        if (++itemCount > 20000 || !isRecord(item) || !identity(item.id) || itemIds.has(item.id)
          || typeof item.type !== 'string' || (!inherited && ['inProgress', 'running'].includes(String(item.status)))) fail();
        itemIds.add(item.id);
        // A full-history fork contains the parent's old child references.
        // These are not descendants of this child. Never use timestamps/text
        // to infer the boundary: require native fork provenance and turn IDs.
        if (!inherited) children.push(item);
      }
    }
    if (!ownTurns) fail();
    const goal = nativeGoalEvidence(await read('thread/goal/get', { threadId: id }), id);
    if (nativeGoalProtection(goal.status)) fail();
    // Native cannot enumerate processes on a notLoaded thread. Only the
    // preparation pass may omit this query; that pass grants NO clearance.
    if ((isLoaded || !options.cold)
      && (await backgroundTerminals(request, id, () => { remaining(); }, deadline)).length) fail();
    remaining();
    return { id, path: t.path, loaded: isLoaded, fingerprint: fingerprint(t), goal: goal.version,
      children: nativeChildIds(children), turnIds };
  };
  const parents = new Map<string, ReadonlySet<string> | undefined>();
  const cold: ChildSnapshot[] = [];
  while (pending.length) {
    const next = pending.shift()!;
    if (next.id === parentId || next.depth > 8 || seen.has(next.id) || seen.size >= 32) fail();
    const proof = await snapshot(next.id, next.parent, before.has(next.id), next.parentTurns);
    parents.set(next.id, next.parentTurns);
    seen.set(next.id, { parent: next.parent, depth: next.depth, fingerprint: proof.fingerprint,
      goal: proof.goal, loaded: before.has(next.id) });
    if (!proof.loaded) cold.push(proof);
    for (const id of proof.children) pending.push({ id, parent: next.id, depth: next.depth + 1, parentTurns: proof.turnIds });
  }
  // Recheck each child, including same-ID late results and goal changes.
  for (const [id, previous] of seen) {
    const current = await snapshot(id, previous.parent, previous.loaded, parents.get(id));
    if (current.fingerprint !== previous.fingerprint || current.goal !== previous.goal) fail();
  }
  const after = await loaded();
  for (const [id, previous] of seen) if (after.has(id) !== previous.loaded) fail();
  remaining();
  options.cold?.push(...cold);
}

export async function inspectNativeChildren(parentId: string, items: readonly unknown[], request: Request,
  check: () => void, deadline = Date.now() + 4000, parentTurnIds?: ReadonlySet<string>): Promise<void> {
  await childProof(parentId, items, request, check, deadline, { parentTurnIds });
}

/** Worker-only cold loading. NOT called by history reads and NOT a drain
 * certificate. The caller must reconcile all native evidence again afterward.
 * No turn start, child message, Goal write, cancellation or ownership adoption. */
export async function rehydrateNativeChildren(parentId: string, items: readonly unknown[], request: Request,
  guard: () => () => void, validatePath: (path: unknown) => Promise<void>,
  parentTurnIds: ReadonlySet<string>, deadline = Date.now() + 4000,
  resume?: (threadId: string, fingerprint: string, timeoutMs: number) => Promise<unknown>): Promise<boolean> {
  const cold: ChildSnapshot[] = [];
  const initial = guard();
  await childProof(parentId, items, request, initial, deadline, { parentTurnIds, cold });
  for (const child of cold) {
    const check = guard();
    const read = async (method: string, params: unknown) => {
      check(); if (Date.now() >= deadline) fail();
      const result = await request(method, params, deadline - Date.now()); check(); return result;
    };
    await validatePath(child.path); check();
    const current = await read('thread/read', { threadId: child.id, includeTurns: true });
    if (!isRecord(current) || !isRecord(current.thread) || !isRecord(current.thread.status) || current.thread.status.type !== 'notLoaded'
      || !Array.isArray(current.thread.turns) || fingerprint(current.thread) !== child.fingerprint) fail();
    const goal = nativeGoalEvidence(await read('thread/goal/get', { threadId: child.id }), child.id);
    if (goal.version !== child.goal || nativeGoalProtection(goal.status)) fail();
    check(); if (Date.now() >= deadline) fail();
    // Own resume changes the activity epoch. Do not reuse this guard afterward;
    // a fresh guard must still recheck owner authority/connection/revision.
    const result = resume ? await resume(child.id, nativeHistoryFingerprint(current.thread), deadline - Date.now())
      : await request('thread/resume', { threadId: child.id }, deadline - Date.now());
    guard()();
    if (Date.now() >= deadline) fail();
    if (!isRecord(result) || !isRecord(result.thread) || !isRecord(result.thread.status) || result.thread.status.type !== 'idle'
      || !Array.isArray(result.thread.turns) || fingerprint(result.thread) !== child.fingerprint) fail();
  }
  return cold.length > 0;
}
