import { createHash } from "node:crypto";
import { copyBoardTask, validBoardContent, validBoardId, type BoardTask } from "@agentopsdeck/shared";

/** Internal preview only. The caller supplies an authenticated, complete catalog;
 * neither tags nor this fingerprint issue a capability. Never accept a catalog
 * from a browser as authority. No session creation, file install or message send. */
export type DelegationMember = {
  owner: string; nodeId: string; connectionId: string; runtime: string; sessionId: string;
  authorityEpoch: number; groupId: string | null; tags: string[];
  taskBinding: "supported" | "unsupported" | "unknown";
};
export type DelegationCatalog = {
  owner: string; generation: number; preferencesRevision: number; complete: boolean; members: DelegationMember[];
};
export type DelegationSelection = { groupId?: string; tags: string[]; tagMode: "all" | "any" };
export type DelegationBoard = { resourceId: string; revision: number; title: string; tasks: BoardTask[] };
export type DelegationPreviewInput = {
  owner: string; catalog: DelegationCatalog; selection: DelegationSelection; board: DelegationBoard;
  taskIds: string[]; fields: ("status" | "detail")[];
};
export const DELEGATION_PREVIEW_LIMITS = { members: 32, catalogMembers: 10_000, ttlMs: 5 * 60_000 } as const;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const identity = (s: string) => typeof s === "string" && s.length > 0 && s.length <= 2048 && s === s.trim() && !/[\u0000-\u001f\u007f]/.test(s);
const tagsValid = (tags: string[]) => Array.isArray(tags) && tags.length <= 8 && new Set(tags).size === tags.length
  && tags.every(tag => identity(tag) && tag.length <= 32);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (m: DelegationMember) => JSON.stringify([m.owner, m.nodeId, m.connectionId, m.runtime, m.sessionId]);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}

function snapshot(input: DelegationPreviewInput) {
  const { owner, catalog: c, selection: s, board: b } = input;
  if (!identity(owner) || c.owner !== owner || c.complete !== true || !integer(c.generation) || !integer(c.preferencesRevision)
    || !Array.isArray(c.members) || c.members.length > DELEGATION_PREVIEW_LIMITS.catalogMembers) throw Error("Catalog unavailable or outside owner scope");
  if (!s || !["all", "any"].includes(s.tagMode) || !tagsValid(s.tags) || (s.groupId !== undefined && !identity(s.groupId))) throw Error("Invalid selection");
  // Explicitly selected group/tags only: an empty selector must not mean all.
  if (s.groupId === undefined && s.tags.length === 0) throw Error("Explicit group or tag selection required");
  if (!validBoardId(b.resourceId) || !integer(b.revision) || !validBoardContent({ title: b.title, tasks: b.tasks })) throw Error("Invalid board snapshot");
  if (!Array.isArray(input.taskIds) || !input.taskIds.length || input.taskIds.length > 200 || new Set(input.taskIds).size !== input.taskIds.length
    || !Array.isArray(input.fields) || !input.fields.length || new Set(input.fields).size !== input.fields.length
    || input.fields.some(f => f !== "status" && f !== "detail")) throw Error("Invalid task grant selection");
  const tasks = input.taskIds.map(id => {
    const task = b.tasks.find(t => t.id === id); if (!task) throw Error("Selected task no longer exists");
    const copy = copyBoardTask(task); if (copy.tags) copy.tags.sort(); return copy;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const seen = new Map<string, DelegationMember>();
  for (const m of c.members) {
    if (m.owner !== owner || ![m.nodeId, m.connectionId, m.runtime, m.sessionId].every(identity) || !integer(m.authorityEpoch)
      || (m.groupId !== null && !identity(m.groupId)) || !tagsValid(m.tags)
      || !["supported", "unsupported", "unknown"].includes(m.taskBinding)) throw Error("Invalid authoritative member");
    // Whitelist fields: no credentials, URLs, message history or cold archive.
    const member: DelegationMember = { owner, nodeId: m.nodeId, connectionId: m.connectionId, runtime: m.runtime,
      sessionId: m.sessionId, authorityEpoch: m.authorityEpoch, groupId: m.groupId, tags: [...m.tags].sort(), taskBinding: m.taskBinding };
    const existing = seen.get(key(member));
    if (existing && digest(existing) !== digest(member)) throw Error("Conflicting duplicate member");
    seen.set(key(member), member);
  }
  const members = [...seen.values()].filter(m => (s.groupId === undefined || s.groupId === m.groupId)
    && (!s.tags.length || (s.tagMode === "all" ? s.tags.every(tag => m.tags.includes(tag)) : s.tags.some(tag => m.tags.includes(tag)))))
    .sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  if (members.length > DELEGATION_PREVIEW_LIMITS.members) throw Error("Too many members; narrow selection");
  return { owner, generation: c.generation, preferencesRevision: c.preferencesRevision,
    selection: { ...(s.groupId !== undefined ? { groupId: s.groupId } : {}), tags: [...s.tags].sort(), tagMode: s.tagMode },
    resource: { resourceId: b.resourceId, revision: b.revision, tasks, fields: [...input.fields].sort() }, members,
    confirmable: members.length > 0 && members.every(m => m.taskBinding === "supported") };
}
export type DelegationPreview = ReturnType<typeof createDelegationPreview>;
export function createDelegationPreview(input: DelegationPreviewInput, now: number) {
  if (!integer(now) || !integer(now + DELEGATION_PREVIEW_LIMITS.ttlMs)) throw Error("Invalid preview time");
  const value = snapshot(input);
  return freeze({ ...value, createdAt: now, expiresAt: now + DELEGATION_PREVIEW_LIMITS.ttlMs, fingerprint: digest(value) });
}
/** Receives the ORIGINAL SERVER-RETAINED preview, never a client-supplied grant.
 * Confirmation must persist it and reauthorize each member at execution time.
 * A true result only means the preview has not changed; it sends nothing. */
export function delegationPreviewCurrent(previous: DelegationPreview, current: DelegationPreviewInput, now: number): boolean {
  if (!integer(now) || now < previous.createdAt || now >= previous.expiresAt || !previous.confirmable) return false;
  try { return digest(snapshot(current)) === previous.fingerprint; } catch { return false; }
}
