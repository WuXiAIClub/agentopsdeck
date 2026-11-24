import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sessionRuntimeId, tokenSnapshotRequestId, validateNativeTokenSnapshot } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { readHubConnectionDirectory } from './member-connection-directory-domain.js';
import { CONNECTION_DISPLAY_VERSION_SQL } from './connection-display-version.js';
import { encodeHubSessionId } from './session-id.js';
import { usageSelection, type UsageSelection, type UsageManifest, type UsageManifests } from './usage-manifests.js';
import type { DelegationMember } from './workspace-delegation-preview.js';

// Fixed commands, not callback/raw SQL RPC. Credentials and full workspace
// documents never leave the original owner. Remote directory data is evidence
// of membership only; local ownership, epochs, tags and layout are derived here.
export const HUB_USAGE_MANIFEST_BYTES = 17 * 1024 * 1024;
export const HUB_USAGE_MANIFEST_NODES = 1_500_000;
type Entry = { connectionId: string; sessionKey: string; runtime: string };
type Catalog = { pin: string; connections: { id: string; nodeId: string; epoch: number }[] };
type SelectionProof = { selection: UsageSelection; pin: string; entries: Entry[] };
export type HubUsageManifestCommand = { action: 'catalog'; selection: UsageSelection }
  | { action: 'check'; selection: UsageSelection; pin: string }
  | ({ action: 'prepare' } & SelectionProof)
  | ({ action: 'confirm'; id: string } & SelectionProof)
  | { action: 'read' | 'view' | 'cancel'; id: string }
  | { action: 'claim'; id: string; childId: string }
  | { action: 'record'; id: string; childId: string; snapshot: unknown };
export type HubUsageManifestResult = null | { error: 403 | 404 | 409 }
  | { action: 'catalog'; catalog: Catalog }
  | { action: 'check'; ok: true }
  | { action: 'read' | 'prepare' | 'confirm'; receipt: UsageManifest | null; cancelled: boolean; claimed: boolean }
  | { action: 'view'; view: ReturnType<UsageManifests['view']> | null; cancelled: boolean }
  | { action: 'claim'; claimed: boolean }
  | { action: 'record' | 'cancel'; ok: true };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 2048 && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const pin = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) => { try { return typeof v === 'string' && tokenSnapshotRequestId(v) === v; } catch { return false; } };
const selectionValid = (v: unknown) => { try { usageSelection(v); return true; } catch { return false; } };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validHubUsageManifestCommand(v: unknown): v is HubUsageManifestCommand {
  if (!object(v)) return false;
  if (v.action === 'catalog') return fields(v, ['action','selection']) && selectionValid(v.selection);
  if (v.action === 'check') return fields(v, ['action','selection','pin']) && selectionValid(v.selection) && pin(v.pin);
  if (v.action === 'prepare' || v.action === 'confirm') return fields(v, ['action','selection','pin','entries', ...(v.action === 'confirm' ? ['id'] : [])])
    && (v.action !== 'confirm' || uuid(v.id)) && selectionValid(v.selection) && pin(v.pin) && Array.isArray(v.entries) && v.entries.length <= 10000
    && v.entries.every(e => object(e) && fields(e, ['connectionId','sessionKey','runtime']) && [e.connectionId,e.sessionKey,e.runtime].every(text)
      && sessionRuntimeId(e.sessionKey as string) === e.runtime);
  if (!uuid(v.id)) return false;
  if (['read','view','cancel'].includes(String(v.action))) return fields(v, ['action','id']);
  if (v.action === 'claim') return fields(v, ['action','id','childId']) && uuid(v.childId);
  if (v.action === 'record' && fields(v, ['action','id','childId','snapshot']) && uuid(v.childId)) {
    try { validateNativeTokenSnapshot(v.snapshot); return true; } catch { return false; }
  }
  return false;
}
function validReceipt(v: unknown): v is UsageManifest {
  if (!object(v) || !fields(v, ['owner','requestId','inputDigest','directoryRevision','selection','createdAt','expiresAt','state','members'])
    || !text(v.owner) || !uuid(v.requestId) || !pin(v.inputDigest) || !pin(v.directoryRevision) || !selectionValid(v.selection)
    || (v.selection as UsageSelection).requestId !== v.requestId || !Number.isSafeInteger(v.createdAt) || !Number.isSafeInteger(v.expiresAt)
    || !['prepared','collecting','complete','cancelled'].includes(String(v.state)) || !Array.isArray(v.members) || v.members.length > 128) return false;
  return v.members.every(c => object(c) && fields(c, ['member','requestId','state']) && uuid(c.requestId)
    && ['prepared','unknown','complete'].includes(String(c.state)) && object(c.member)
    && fields(c.member, ['owner','nodeId','connectionId','runtime','sessionId','authorityEpoch','groupId','tags','taskBinding'])
    && c.member.owner === v.owner && [c.member.nodeId,c.member.connectionId,c.member.runtime,c.member.sessionId].every(text)
    && Number.isSafeInteger(c.member.authorityEpoch) && Number(c.member.authorityEpoch) > 0
    && (c.member.groupId === null || text(c.member.groupId)) && Array.isArray(c.member.tags) && c.member.tags.length <= 8
    && c.member.tags.every(t => text(t) && t.length <= 32) && c.member.taskBinding === 'unknown');
}
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uniqueText = (v: unknown, limit: number): v is string[] => Array.isArray(v) && v.length <= limit
  && v.every(text) && new Set(v).size === v.length;
function validTotals(v: unknown): boolean {
  if (!object(v) || !natural(v.events) || !object(v.metrics)
    || !fields(v.metrics, ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'])) return false;
  return Object.values(v.metrics).every(m => object(m) && fields(m, ['knownSubtotal','knownSampleCount','unknownSampleCount'])
    && natural(m.knownSubtotal) && natural(m.knownSampleCount) && natural(m.unknownSampleCount)
    && m.knownSampleCount + m.unknownSampleCount === v.events);
}
function validView(v: unknown): boolean {
  if (!object(v) || !fields(v, ['requestId','selection','directoryRevision','createdAt','expiresAt','state','members','result'])
    || !uuid(v.requestId) || !selectionValid(v.selection) || (v.selection as UsageSelection).requestId !== v.requestId
    || !pin(v.directoryRevision) || !natural(v.createdAt) || !natural(v.expiresAt) || v.expiresAt < v.createdAt
    || !['prepared','collecting','complete','cancelled'].includes(String(v.state)) || !Array.isArray(v.members) || v.members.length > 128) return false;
  const members = v.members;
  if (!members.every(m => object(m) && fields(m, ['sessionId','connectionId','runtime','groupId','tags','requestId','state'])
    && [m.sessionId,m.connectionId,m.runtime].every(text) && (m.groupId === null || text(m.groupId))
    && uniqueText(m.tags,8) && m.tags.every(t => t.length <= 32) && uuid(m.requestId)
    && ['prepared','unknown','complete'].includes(String(m.state)))
    || new Set(members.map(m => m.sessionId)).size !== members.length
    || new Set(members.map(m => m.requestId)).size !== members.length) return false;
  if (v.state !== 'complete') return v.result === null;
  const r = v.result;
  if (!members.every(m => m.state === 'complete') || !object(r)
    || !fields(r, ['version','membership','directoryRevision','memberCount','manifest','manifestDigest','total','groups','overlappingGroups','coverageReasons','creditEstimate'])
    || r.version !== 1 || r.membership !== 'query-time' || r.directoryRevision !== v.directoryRevision || r.memberCount !== members.length
    || !pin(r.manifestDigest) || !Array.isArray(r.manifest) || r.manifest.length !== members.length
    || !object(r.total) || !fields(r.total, ['events','metrics']) || !validTotals(r.total)
    || !Array.isArray(r.groups) || r.groups.length > 128 * 16 || r.overlappingGroups !== true
    || JSON.stringify(r.coverageReasons) !== JSON.stringify(['partial-native-coverage','root-agent-only','observed-time-not-native-time'])
    || !object(r.creditEstimate) || !fields(r.creditEstimate, ['status','reason']) || r.creditEstimate.status !== 'unavailable'
    || r.creditEstimate.reason !== 'no-verified-versioned-billing-rule') return false;
  const targets = new Set<string>(), groups = new Set<string>();
  if (!r.manifest.every(m => {
    if (!object(m) || !fields(m, ['target','authorityEpoch','groups','requestId','memberDigest']) || !text(m.target)
      || targets.has(m.target) || !natural(m.authorityEpoch) || !uniqueText(m.groups,16) || !uuid(m.requestId) || !pin(m.memberDigest)
      || !members.some(c => c.sessionId === m.target && c.requestId === m.requestId)) return false;
    targets.add(m.target); return true;
  })) return false;
  return r.groups.every(g => {
    if (!object(g) || !fields(g, ['name','events','metrics']) || !text(g.name) || groups.has(g.name) || !validTotals(g)) return false;
    groups.add(g.name); return true;
  });
}
export function validHubUsageManifestResult(v: unknown): v is HubUsageManifestResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return typeof v.error === 'number' && [403,404,409].includes(v.error);
  if (v.action === 'catalog') return fields(v, ['action','catalog']) && object(v.catalog) && fields(v.catalog, ['pin','connections']) && pin(v.catalog.pin)
    && Array.isArray(v.catalog.connections) && v.catalog.connections.length <= 65536 && v.catalog.connections.every(c => object(c)
      && fields(c, ['id','nodeId','epoch']) && text(c.id) && text(c.nodeId) && Number.isSafeInteger(c.epoch) && Number(c.epoch) > 0);
  if (v.action === 'check' || v.action === 'record' || v.action === 'cancel') return fields(v, ['action','ok']) && v.ok === true;
  if (v.action === 'claim') return fields(v, ['action','claimed']) && typeof v.claimed === 'boolean';
  if (['read','prepare','confirm'].includes(String(v.action))) return fields(v, ['action','receipt','cancelled','claimed'])
    && (v.receipt === null || validReceipt(v.receipt)) && typeof v.cancelled === 'boolean' && typeof v.claimed === 'boolean';
  if (v.action === 'view') return fields(v, ['action','view','cancelled']) && typeof v.cancelled === 'boolean'
    && (v.view === null || validView(v.view));
  return false;
}

/** Called only under the identity savepoint, including when nested in the
 * ledger's own write transaction. Never use the public delivery fences here:
 * those intentionally refuse uncommitted reads. */
export function readHubUsageCatalog(owner: HubStore, db: DatabaseSync, actor: HubPrincipal, selection: UsageSelection) {
  const directory = readHubConnectionDirectory(db, actor, { action: 'read' });
  if (!directory || directory.action !== 'read') throw Error('catalog-unavailable');
  const connections = directory.snapshot.connections.flatMap((c, i) => {
    if (c.status === 'disabled') return [];
    if (!c.nodeId) throw Error('catalog-unpinned');
    return [{ id: c.id, nodeId: c.nodeId, epoch: directory.epochs[i]! }];
  }).sort((a,b) => a.id.localeCompare(b.id));
  const preferences = owner.workspace.get(actor.userId);
  let layout: unknown = null, layoutKeys: Set<string> | undefined;
  if (selection.layoutId) {
    const kind = selection.layoutId === 'current' ? 'current' : 'saved', document = owner.layouts.get(actor.userId, kind);
    const content: unknown = document.content ? JSON.parse(document.content) : null;
    const saved = kind === 'current' ? content : Array.isArray(content) ? content.find(v => object(v) && v.id === selection.layoutId) : undefined;
    if (!object(saved) || !object(saved.workspace) || !Array.isArray(saved.workspace.panes) || !Array.isArray(saved.workspace.floating)) throw Error('invalid-layout');
    const panes = saved.workspace.panes;
    if (saved.workspace.floating.some(f => !object(f) || !panes.some(p => object(p) && p.id === f.id))) throw Error('invalid-layout');
    layoutKeys = new Set<string>();
    for (const pane of panes) {
      if (!object(pane)) throw Error('invalid-layout');
      if (pane.kind === undefined || pane.kind === 'session') {
        if (!text(pane.sessionKey)) throw Error('invalid-layout');
        layoutKeys.add(pane.sessionKey);
      }
    }
    layout = [kind,document.revision,saved];
  }
  const generation = Number(db.prepare(CONNECTION_DISPLAY_VERSION_SQL).get(actor.userId)?.version ?? 0);
  return { catalog: { pin: hash([directory.version,preferences.revision,connections,layout]), connections }, generation, preferences, layout, layoutKeys };
}
type Facts = ReturnType<typeof readHubUsageCatalog>;
function select(actor: HubPrincipal, facts: Facts, s: UsageSelection, entries: Entry[]) {
  const byId = new Map(facts.catalog.connections.map(c => [c.id,c])), seen = new Set<string>();
  const members: DelegationMember[] = entries.map(e => {
    const c = byId.get(e.connectionId), sessionId = encodeHubSessionId(e.connectionId,e.sessionKey);
    if (!c || seen.has(sessionId) || sessionRuntimeId(e.sessionKey) !== e.runtime) throw Error('catalog-invalid-member');
    seen.add(sessionId);
    const preference = facts.preferences.sessions[sessionId];
    return { owner: actor.userId, nodeId: c.nodeId, connectionId: c.id, sessionId, runtime: e.runtime, authorityEpoch: c.epoch,
      groupId: preference?.groupId ?? null, tags: [...(preference?.tags ?? [])].sort(), taskBinding: 'unknown' };
  });
  members.sort((a,b) => {
    const key = (m: DelegationMember) => JSON.stringify([m.owner,m.nodeId,m.connectionId,m.runtime,m.sessionId]);
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });
  if (facts.layoutKeys && [...facts.layoutKeys].some(k => !seen.has(k))) throw Error('layout-member-unavailable');
  const selected = members.filter(m => (!s.groupId || m.groupId === s.groupId) && (!s.connectionId || m.connectionId === s.connectionId)
    && (!s.runtime || m.runtime === s.runtime) && (!facts.layoutKeys || facts.layoutKeys.has(m.sessionId))
    && (!s.tags.length || (s.tagMode === 'all' ? s.tags.every(t => m.tags.includes(t)) : s.tags.some(t => m.tags.includes(t)))));
  if (selected.length > 128) throw Error('narrow-scope');
  // Keep the original wire revision formula for existing previews. The local
  // catalog pin is an additional execution fence, not a new receipt format.
  return { members: selected, catalogMembers: members };
}

export async function executeHubUsageManifest(owner: HubStore, request: Request, expectedScope: string, command: HubUsageManifestCommand): Promise<HubUsageManifestResult> {
  let actor: HubPrincipal | undefined, facts: Facts | undefined;
  const selection = 'selection' in command ? usageSelection(command.selection) : undefined;
  const check = () => {
    const authority = owner.identities.memberUsageManifestAuthority(request, expectedScope, owner, selection);
    if (!authority || actor && actor.userId !== authority.actor.userId) throw Error('request-authority');
    actor = authority.actor; facts = authority.facts;
    if ('pin' in command && facts?.catalog.pin !== command.pin) throw Error('scope-changed');
  };
  const strip = (r: UsageManifest | undefined): UsageManifest | null => r ? { ...r, members: r.members.map(({snapshot: _snapshot,...m}) => m) } : null;
  try {
    check(); const user = actor!.userId, store = owner.usageManifests;
    if (command.action === 'catalog') return { action: 'catalog', catalog: facts!.catalog };
    if (command.action === 'check') return { action: 'check', ok: true };
    if (command.action === 'prepare' || command.action === 'confirm') {
      const selected = select(actor!,facts!,selection!,command.entries);
      // Include the original local fence and exact layout in the immutable
      // revision, alongside the sorted complete remote catalog.
      const revision = hash([facts!.generation,facts!.preferences.revision,selected.catalogMembers,facts!.layout]);
      if (command.action === 'prepare') {
        const receipt = await store.prepareAsync(user,selection!,revision,selected.members,check);
        check(); return { action: 'prepare', receipt: strip(receipt), cancelled: false, claimed: false };
      }
      if (command.id !== selection!.requestId) throw Error('selection');
      const confirmed = store.confirm(user,command.id,() => {
        check();
        const r = store.read(user,command.id);
        if (!r || hash(r.selection) !== hash(selection) || r.directoryRevision !== revision) throw Error('scope-changed');
      });
      check(); return { action: 'confirm', receipt: strip(confirmed.receipt), cancelled: false, claimed: confirmed.claimed };
    }
    if (command.action === 'claim') {
      const claimed = await store.claimAsync(user,command.id,command.childId,check); check(); return { action: 'claim', claimed };
    }
    if (command.action === 'record') { store.record(user,command.id,command.childId,command.snapshot,check); check(); return { action: 'record', ok: true }; }
    if (command.action === 'cancel') { store.cancel(user,command.id,check); check(); return { action: 'cancel', ok: true }; }
    const cancelled = store.cancelled(user,command.id), receipt = store.read(user,command.id);
    check();
    return command.action === 'view' ? { action: 'view', view: receipt ? store.view(receipt) : null, cancelled }
      : { action: 'read', receipt: strip(receipt), cancelled, claimed: false };
  } catch (error) {
    // Authority takes precedence over remote/ledger failure, never refresh the
    // principal or clear the durable UNKNOWN claim to make recovery succeed.
    const current = owner.identities.memberUsageManifestAuthority(request,expectedScope,owner);
    if (!current || actor && current.actor.userId !== actor.userId) return { error: 403 };
    if (error instanceof Error && error.message === 'request-authority') return { error: 403 };
    return { error: 409 };
  }
}
