import { randomUUID } from 'node:crypto';
import { validBoardUuid, validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { HubStore, HubConnection } from './hub-store.js';
import { ContentProposalConflict, type ContentBinding } from './content-proposal-store.js';
import { currentContentBinding, validContentBinding } from './member-content-replica-domain.js';
import { executeContentSync, matchesContentSyncReply, validContentSyncCommand, validContentSyncResult,
  type ContentSyncCommand, type ContentSyncResult } from './member-content-sync-domain.js';
import { validHubConnectorAccessResult } from './member-connector-access-domain.js';

/** Private service capability. No owner, HTTP proof, SQL or execution callback
 * crosses this port. References are created only from the original binding page. */
export type ContentBackgroundCommand = { action: 'scan'; after: number }
  | { action: 'current'; reference: string }
  | { action: 'access'; reference: string }
  | { action: 'release'; reference: string }
  | { action: 'ack'; reference: string; proof: { epoch: string; revision: number; hash: string } }
  | { action: 'sync'; reference: string; command: ContentSyncCommand };
export type ContentBackgroundWork = { reference: string; id: string; generation: string; resource: string };
export type ContentBackgroundResult = { action: 'scan'; cursor: number; work: ContentBackgroundWork[] }
  | { action: 'current' | 'ack'; reference: string; binding: ContentBinding }
  | { action: 'access'; reference: string; connection: HubConnection; epoch: number; token: string | null }
  | { action: 'release'; reference: string }
  | { action: 'sync'; reference: string; resource: string; result: ContentSyncResult };
export type ContentBackgroundOwner = { command(command: ContentBackgroundCommand): Promise<ContentBackgroundResult> };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validContentBackgroundCommand(v: unknown): v is ContentBackgroundCommand {
  if (!object(v)) return false;
  if (v.action === 'scan') return keys(v,['action','after']) && revision(v.after);
  if (!validBoardUuid(v.reference)) return false;
  if (v.action === 'current' || v.action === 'access' || v.action === 'release') return keys(v,['action','reference']);
  if (v.action === 'ack') return keys(v,['action','reference','proof']) && object(v.proof)
    && keys(v.proof,['epoch','revision','hash']) && validBoardUuid(v.proof.epoch) && revision(v.proof.revision) && hash(v.proof.hash);
  return v.action === 'sync' && keys(v,['action','reference','command']) && object(v.command) && !Object.hasOwn(v.command,'resourceId')
    && !['sync-conflict-proof','sync-resolution-claim','sync-resolution-ack'].includes(String(v.command.action))
    && validContentSyncCommand({ ...v.command, resourceId: 'INTERNAL' });
}
export function validContentBackgroundResult(v: unknown): v is ContentBackgroundResult {
  if (!object(v)) return false;
  if (v.action === 'scan') return keys(v,['action','cursor','work']) && revision(v.cursor) && Array.isArray(v.work) && v.work.length <= 4
    && v.work.every(w => object(w) && keys(w,['reference','id','generation','resource']) && [w.reference,w.id,w.generation].every(validBoardUuid)
      && validWorkspaceFileCardResource(w.resource)) && new Set(v.work.map(w => w.reference)).size === v.work.length;
  if (!validBoardUuid(v.reference)) return false;
  if (v.action === 'release') return keys(v,['action','reference']);
  if (v.action === 'current' || v.action === 'ack') return keys(v,['action','reference','binding']) && validContentBinding(v.binding) && !v.binding.revoked;
  if (v.action === 'access') {
    const { action: _action, reference: _reference, ...access } = v;
    return keys(v,['action','reference','connection','epoch','token']) && validHubConnectorAccessResult(access)
      && object(v.connection) && v.connection.status !== 'disabled' && !!v.connection.nodeId
      && (v.connection.kind !== 'local' || v.token === null);
  }
  return v.action === 'sync' && keys(v,['action','reference','resource','result']) && validWorkspaceFileCardResource(v.resource)
    && object(v.result) && validContentSyncResult({ ...v.result, resourceId: v.resource });
}
export function matchesContentBackgroundReply(command: ContentBackgroundCommand, value: ContentBackgroundResult) {
  if (command.action !== value.action) return false;
  if (command.action === 'scan') return value.action === 'scan';
  if (!('reference' in value) || value.reference !== command.reference) return false;
  if (command.action === 'sync') return value.action === 'sync' && matchesContentSyncReply(command.command,value.result,value.resource);
  if (command.action === 'ack') return value.action === 'ack' && value.binding.initial?.epoch === command.proof.epoch
    && value.binding.acknowledgedRevision === command.proof.revision && value.binding.acknowledgedHash === command.proof.hash;
  return true;
}
type Work = ContentBackgroundWork & { owner: string; createdAt: number; nodeId: string };
const references = new WeakMap<HubStore, Map<string, Work>>();
/** Runs on the existing single SQL owner, including permission checks repeated
 * inside original capacity/commit transactions. A process restart loses all refs. */
export async function executeContentBackground(owner: HubStore, command: ContentBackgroundCommand): Promise<ContentBackgroundResult> {
  let active = references.get(owner);
  if (!active) { active = new Map(); references.set(owner,active); }
  const store = owner.createContentDocumentStore();
  if (command.action === 'scan') {
    if (active.size) throw new ContentProposalConflict('background-busy');
    let rows = store.syncPage(command.after);
    if (!rows.length && command.after) rows = store.syncPage(0);
    const work: ContentBackgroundWork[] = [];
    // Scan invalid/orphaned rows without pinning the cursor on them forever.
    for (const row of rows) {
      try {
        const user = owner.getUser(row.owner);
        if (!user) continue;
        const binding = currentContentBinding(owner,row.owner,row.resource,row.id,undefined,() => {});
        const connection = owner.getConnection(binding.target!.connectionId,row.owner);
        if (!connection?.nodeId) continue;
        const item = { reference: randomUUID(), id: row.id, generation: binding.generation, resource: row.resource };
        active.set(item.reference,{ ...item,owner: row.owner,createdAt: user.createdAt,nodeId: connection.nodeId });
        work.push(item);
      } catch (error) { if (!(error instanceof ContentProposalConflict)) { for (const w of work) active.delete(w.reference); throw error; } }
    }
    return { action: 'scan',cursor: rows.at(-1)?.cursor ?? 0,work };
  }
  if (command.action === 'release') { active.delete(command.reference); return { action: 'release',reference: command.reference }; }
  const item = active.get(command.reference);
  if (!item) throw new ContentProposalConflict('background-reference');
  const current = () => currentContentBinding(owner,item.owner,item.resource,item.id,item.generation,() => {
    if (owner.getUser(item.owner)?.createdAt !== item.createdAt) throw new ContentProposalConflict('background-owner');
    const binding = store.bindingRecord(item.owner,item.resource,item.id);
    if (!binding?.target || owner.getConnection(binding.target.connectionId,item.owner)?.nodeId !== item.nodeId)
      throw new ContentProposalConflict('background-node');
  });
  const binding = current(), base = { reference: command.reference };
  if (command.action === 'current') return { ...base,action: command.action,binding };
  if (command.action === 'access') {
    const connection = owner.getConnection(binding.target!.connectionId,item.owner)!;
    return { ...base,action: 'access',connection,epoch: binding.target!.authority,
      token: connection.kind === 'local' ? null : owner.getCredentialToken(connection.id,item.owner) ?? null };
  }
  if (command.action === 'ack') return { ...base,action: 'ack',binding: store.acknowledgeInstallation(item.owner,item.resource,item.id,item.generation,command.proof) };
  if (command.command.id !== item.id || command.command.generation !== item.generation
    || ['sync-conflict-proof','sync-resolution-claim','sync-resolution-ack'].includes(command.command.action))
    throw new ContentProposalConflict('background-scope');
  return { ...base,action: 'sync',resource: item.resource,result: await executeContentSync(owner,item.owner,item.resource,command.command,() => { current(); }) };
}
