import {randomUUID} from 'node:crypto';
import {validBoardUuid} from '@agentopsdeck/shared';
import type {HubStore, HubConnection} from './hub-store.js';
import type {FileBoardBinding, FileBoardApplyResult} from './workspace-board-files.js';
import type {WorkspaceFileSnapshot} from '../connector/workspace-file-codec.js';
import type {BoardContent, WorkspaceFileCard} from '@agentopsdeck/shared';
import {decodeHubSessionId} from './session-id.js';
import {validHubNativeFileCommand, validNativeFileSnapshot, type NativeFileScope} from './member-native-file-domain.js';
import {validHubConnectorAccessResult} from './member-connector-access-domain.js';

type Snapshot = WorkspaceFileSnapshot<BoardContent | WorkspaceFileCard>;
/** Separate private service capability: no HTTP identity, principal, executable
 * command or arbitrary resource can be supplied by the subscription runner. */
type ReferenceAction = 'current' | 'access' | 'closed' | 'release';
export type NativeFileBackgroundCommand = {action: 'scan'; after: string}
  | {[Action in ReferenceAction]: {action: Action; reference: string}}[ReferenceAction]
  | {action: 'apply'; reference: string; scope: NativeFileScope; snapshot: Snapshot};
export type NativeFileBackgroundWork = NativeFileScope & {reference: string; bindingId: string; group: string};
export type NativeFileBackgroundResult = {action: 'scan'; cursor: string; work: NativeFileBackgroundWork[]}
  | {action: 'current'; reference: string; current: boolean}
  | {action: 'access'; reference: string; domain: NativeFileScope['domain']; connection: HubConnection; epoch: number; token: string | null}
  | {action: 'apply'; reference: string; applied: FileBoardApplyResult}
  | {action: 'closed' | 'release'; reference: string};
export type NativeFileBackgroundOwner = {command(input: NativeFileBackgroundCommand): Promise<NativeFileBackgroundResult>};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const cursor = (v: unknown): v is string => v === '' || typeof v === 'string' && /^(board|card):[0-9a-f-]{36}$/i.test(v) && validBoardUuid(v.slice(v.indexOf(':') + 1));
const scope = (v: unknown): v is NativeFileScope => object(v) && keys(v, ['domain', 'resourceId']) && validHubNativeFileCommand({...v, action: 'current'});
export function validNativeFileBackgroundCommand(v: unknown): v is NativeFileBackgroundCommand {
  if (!object(v)) return false;
  if (v.action === 'scan') return keys(v, ['action', 'after']) && cursor(v.after);
  if (!validBoardUuid(v.reference)) return false;
  if (v.action === 'apply') return keys(v, ['action', 'reference', 'scope', 'snapshot']) && scope(v.scope) && validNativeFileSnapshot(v.scope, v.snapshot);
  return ['current', 'access', 'closed', 'release'].includes(String(v.action)) && keys(v, ['action', 'reference']);
}
export function validNativeFileBackgroundResult(v: unknown): v is NativeFileBackgroundResult {
  if (!object(v)) return false;
  if (v.action === 'scan') return keys(v, ['action', 'cursor', 'work']) && cursor(v.cursor) && Array.isArray(v.work) && v.work.length <= 4
    && v.work.every(w => object(w) && keys(w, ['domain', 'resourceId', 'reference', 'bindingId', 'group']) && scope({domain: w.domain, resourceId: w.resourceId})
      && validBoardUuid(w.reference) && validBoardUuid(w.bindingId) && validBoardUuid(w.group))
    && new Set(v.work.map(w => w.reference)).size === v.work.length;
  if (!validBoardUuid(v.reference)) return false;
  if (v.action === 'current') return keys(v, ['action', 'reference', 'current']) && typeof v.current === 'boolean';
  if (v.action === 'apply') return keys(v, ['action', 'reference', 'applied']) && ['updated', 'unchanged', 'retained', 'denied', 'invalid', 'limit'].includes(String(v.applied));
  if (v.action === 'closed' || v.action === 'release') return keys(v, ['action', 'reference']);
  if (v.action !== 'access' || !keys(v, ['action', 'reference', 'domain', 'connection', 'epoch', 'token']) || !['board', 'card'].includes(String(v.domain))) return false;
  return validHubConnectorAccessResult({connection: v.connection, epoch: v.epoch, token: v.token}) && object(v.connection)
    && v.connection.status !== 'disabled' && !!v.connection.nodeId && (v.connection.kind !== 'local' || v.token === null);
}
export function matchesNativeFileBackgroundReply(command: NativeFileBackgroundCommand, value: NativeFileBackgroundResult) {
  return command.action === value.action && (command.action === 'scan' || 'reference' in value && command.reference === value.reference);
}
type Reference = NativeFileBackgroundWork & {user: string; incarnation: number; nodeId: string; connectionId: string; authority: number};
const references = new WeakMap<HubStore, Map<string, Reference>>();
/** The in-memory capabilities follow the same rollback boundary as the SQL.
 * They are not durable receipts and must not survive a failed RELEASE. */
export function nativeFileBackgroundCheckpoint(owner: HubStore) {
  const before = new Map(references.get(owner));
  return () => {references.set(owner, before);};
}
/** Called only inside the original Hub savepoint. No new ledger or writer. */
export function executeNativeFileBackground(owner: HubStore, command: NativeFileBackgroundCommand): NativeFileBackgroundResult {
  let active = references.get(owner);
  if (!active) {active = new Map(); references.set(owner, active);}
  const files = (domain: NativeFileScope['domain']) => domain === 'board' ? owner.boardFiles : owner.cardFiles;
  const current = (ref: Reference): FileBoardBinding | undefined => {
    if (owner.getUser(ref.user)?.createdAt !== ref.incarnation) return;
    const binding = files(ref.domain).get(ref.user, ref.bindingId), connection = owner.getConnection(ref.connectionId, ref.user);
    const decoded = binding && decodeHubSessionId(binding.sessionId);
    if (!binding || binding.state !== 'active' || binding.resourceId !== ref.resourceId || binding.connectionId !== ref.connectionId
      || binding.authority !== ref.authority || decoded?.connectionId !== ref.connectionId || !/^(codex|claude-code|ghcp):/.test(decoded.remoteSessionKey)
      || !connection || connection.status === 'disabled' || connection.nodeId !== ref.nodeId
      || owner.connectionAuthority(ref.connectionId, ref.user) !== ref.authority) return;
    return binding;
  };
  if (command.action === 'scan') {
    for (const [id, ref] of active) if (!current(ref)) active.delete(id);
    const rows = (['board', 'card'] as const).flatMap(domain => files(domain).active().map(binding => ({domain, binding, key: domain + ':' + binding.bindingId})))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const page = rows.filter(r => r.key > command.after).slice(0, 4), work: NativeFileBackgroundWork[] = [];
    const created: string[] = [];
    try {
      for (const {domain, binding} of page) {
        const existing = [...active.values()].find(r => r.domain === domain && r.bindingId === binding.bindingId);
        // Re-deliver private capabilities after an unknown scan ACK. This is
        // not an installation/write replay and creates no second subscription.
        if (existing) {
          work.push({domain, resourceId: existing.resourceId, reference: existing.reference, bindingId: existing.bindingId, group: existing.group});
          continue;
        }
        if (active.size >= 128) break; // Original global quotas: 64 per domain.
        const user = owner.getUser(binding.userId), connection = owner.getConnection(binding.connectionId, binding.userId);
        if (!user || !connection?.nodeId) continue;
        const peer = [...active.values()].find(r => r.domain === domain && r.user === binding.userId && r.connectionId === binding.connectionId
          && r.authority === binding.authority && r.nodeId === connection.nodeId);
        const ref: Reference = {domain, resourceId: binding.resourceId, reference: randomUUID(), bindingId: binding.bindingId, group: peer?.group ?? randomUUID(),
          user: binding.userId, incarnation: user.createdAt, nodeId: connection.nodeId, connectionId: binding.connectionId, authority: binding.authority};
        if (!current(ref)) continue;
        active.set(ref.reference, ref); created.push(ref.reference);
        work.push({domain, resourceId: ref.resourceId, reference: ref.reference, bindingId: ref.bindingId, group: ref.group});
      }
    } catch (error) {for (const ref of created) active.delete(ref); throw error;}
    return {action: 'scan', cursor: page.length === 4 ? page.at(-1)!.key : '', work};
  }
  if (command.action === 'release') {active.delete(command.reference); return {...command};}
  const ref = active.get(command.reference), binding = ref && current(ref);
  if (command.action === 'current') return {...command, current: !!binding};
  if (!ref || !binding) throw Error('native_file_background_authority_unavailable');
  if (command.action === 'access') {
    const connection = owner.getConnection(ref.connectionId, ref.user)!;
    return {...command, domain: ref.domain, connection, epoch: ref.authority,
      token: connection.kind === 'local' ? null : owner.getCredentialToken(connection.id, ref.user) ?? null};
  }
  if (command.action === 'closed') {files(ref.domain).revoke(ref.user, ref.bindingId); return {...command};}
  if (command.scope.domain !== ref.domain || command.scope.resourceId !== ref.resourceId) throw Error('native_file_background_scope_unavailable');
  const applied = ref.domain === 'board' ? owner.boardFiles.apply(ref.user, ref.bindingId, command.snapshot as WorkspaceFileSnapshot<BoardContent>)
    : owner.cardFiles.apply(ref.user, ref.bindingId, command.snapshot as WorkspaceFileSnapshot<WorkspaceFileCard>);
  if (applied === 'invalid' || applied === 'limit') files(ref.domain).apply(ref.user, ref.bindingId, {state: 'unavailable'});
  return {action: 'apply', reference: ref.reference, applied};
}
