import { randomUUID } from 'node:crypto';
import { validBoardUuid, WORKSPACE_FILE_CARD_KINDS } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { fileBoardRuntime, fileBoardWritable, LOCAL_FILE_BOARD_OWNER, type FileBoardPolicy } from './workspace-board-file-policy.js';
import { boardFileCodec } from './workspace-board-file-format.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { FileBoardError, type WorkspaceFileBinding, type WorkspaceFileMetadata } from './workspace-file-metadata.js';
import type { FileWriteOutcome } from './workspace-file-write.js';

export type WorkspaceFileActor = { authorization: string; tokenId: string };
export type WorkspaceFileToolPolicies = { claude?: { toolPolicy?: string }; copilot?: { toolPolicy?: string } };
type Base = { file: 'board' | 'card'; actor: WorkspaceFileActor };
type Result<T> = { ok: true; value: T } | { ok: false; status: 401 | 403 | 404 | 409 | 429 | 503 };
type Installation = ReturnType<WorkspaceFileMetadata<unknown>['installation']> & { effectId?: string };
type Write = ReturnType<WorkspaceFileMetadata<unknown>['writeIntent']> & { effectId?: string };
export type ConnectorWorkspaceFileCommands = {
  workspaceFileGuard: { input: Base & { sessionKey: string }; output: Result<null> };
  workspaceFileBinding: { input: Base & { id: string }; output: Result<{ row: WorkspaceFileBinding; kind: string | null }> };
  workspaceFileInstall: { input: Base & { intent: { id: string; sessionKey: string; content: unknown }; reserve: boolean }; output: Result<Installation> };
  workspaceFileInstalled: { input: { effectId: string; id: string; fingerprint: string }; output: Result<null> };
  workspaceFileReceipt: { input: Base & { id: string; mutationId: string }; output: Result<{ mutationId: string; state: FileWriteOutcome }> };
  workspaceFileWrite: { input: Base & { id: string; intent: { mutationId: string; expectedHash: string; content: unknown }; retainedBytes?: number }; output: Result<Write> };
  workspaceFileSettled: { input: { effectId: string; id: string; mutationId: string; fingerprint: string; state: FileWriteOutcome }; output: Result<null> };
  workspaceFileRevoke: { input: Base & { id: string; sessionKey?: string }; output: Result<WorkspaceFileBinding> };
  workspaceFileReconcile: { input: { file: 'board' | 'card' }; output: Result<string[]> };
  workspaceFileSessionFiles: { input: Base & { sessionKey: string }; output: Result<WorkspaceFileBinding[]> };
};
export type WorkspaceFileKind = keyof ConnectorWorkspaceFileCommands;
export const connectorWorkspaceFileSteps = Object.freeze({ workspaceFileGuard: 311, workspaceFileBinding: 312,
  workspaceFileInstall: 313, workspaceFileInstalled: 314, workspaceFileReceipt: 315, workspaceFileWrite: 316,
  workspaceFileSettled: 317, workspaceFileRevoke: 318, workspaceFileReconcile: 319, workspaceFileSessionFiles: 320 });
export const isConnectorWorkspaceFileKind = (kind: string): kind is WorkspaceFileKind => Object.hasOwn(connectorWorkspaceFileSteps, kind);
const record = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v,k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^(codex|claude-code|ghcp):[^\s\u0000-\u001f]{1,512}$/.test(v);
const actor = (v: unknown) => record(v,['authorization','tokenId']) && typeof v.authorization === 'string'
  && Buffer.byteLength(v.authorization) <= 4096 && !/[\r\n]/.test(v.authorization)
  && typeof v.tokenId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v.tokenId);
const outcome = (v: unknown) => v === 'saved' || v === 'conflict' || v === 'uncertain';
const binding = (v: unknown): v is WorkspaceFileBinding => record(v,['id','owner','sessionKey','fingerprint','state'])
  && validBoardUuid(v.id) && typeof v.owner === 'string' && key(v.sessionKey)
  && (hash(v.fingerprint) || v.fingerprint === '' && v.state === 'revoked')
  && ['prepared','installed','revoked'].includes(String(v.state));
const codec = (file: unknown) => file === 'board' ? boardFileCodec : cardFileCodec();
export function validConnectorWorkspaceFileInput(kind: WorkspaceFileKind, v: unknown): boolean {
  if (kind === 'workspaceFileInstalled' || kind === 'workspaceFileSettled') return record(v,
    kind === 'workspaceFileInstalled' ? ['effectId','id','fingerprint'] : ['effectId','id','mutationId','fingerprint','state'])
    && validBoardUuid(v.effectId) && validBoardUuid(v.id) && hash(v.fingerprint)
    && (kind !== 'workspaceFileSettled' || validBoardUuid(v.mutationId) && outcome(v.state));
  if (kind === 'workspaceFileReconcile') return record(v,['file']) && (v.file === 'board' || v.file === 'card');
  const fields = kind === 'workspaceFileGuard' || kind === 'workspaceFileSessionFiles' ? ['sessionKey']
    : kind === 'workspaceFileInstall' ? ['intent','reserve'] : kind === 'workspaceFileWrite' ? ['id','intent']
    : kind === 'workspaceFileReceipt' ? ['id','mutationId'] : ['id'];
  if (!record(v,['file','actor',...fields],kind === 'workspaceFileWrite' ? ['retainedBytes'] : kind === 'workspaceFileRevoke' ? ['sessionKey'] : [])
    || !actor(v.actor) || v.file !== 'board' && v.file !== 'card' || Object.hasOwn(v,'id') && !validBoardUuid(v.id)) return false;
  switch (kind) {
    case 'workspaceFileGuard': case 'workspaceFileSessionFiles': return key(v.sessionKey);
    case 'workspaceFileBinding': return true;
    case 'workspaceFileReceipt': return validBoardUuid(v.mutationId);
    case 'workspaceFileRevoke': return !Object.hasOwn(v,'sessionKey') || key(v.sessionKey);
    case 'workspaceFileInstall': return typeof v.reserve === 'boolean' && record(v.intent,['id','sessionKey','content'])
      && validBoardUuid(v.intent.id) && key(v.intent.sessionKey) && codec(v.file).valid(v.intent.content);
    case 'workspaceFileWrite': return record(v.intent,['mutationId','expectedHash','content'])
      && validBoardUuid(v.intent.mutationId) && hash(v.intent.expectedHash) && codec(v.file).valid(v.intent.content)
      && (!Object.hasOwn(v,'retainedBytes') || Number.isSafeInteger(v.retainedBytes) && Number(v.retainedBytes) >= 0 && Number(v.retainedBytes) <= 64 * 1024 * 1024);
  }
}
export function validConnectorWorkspaceFileOutput(kind: WorkspaceFileKind, v: unknown): boolean {
  if (record(v,['ok','status']) && v.ok === false) return typeof v.status === 'number' && [401,403,404,409,429,503].includes(v.status);
  if (!record(v,['ok','value']) || v.ok !== true) return false;
  const r = v.value;
  switch (kind) {
    case 'workspaceFileGuard': case 'workspaceFileInstalled': case 'workspaceFileSettled': return r === null;
    case 'workspaceFileBinding': return record(r,['row','kind']) && binding(r.row)
      && (r.kind === null || (WORKSPACE_FILE_CARD_KINDS as readonly unknown[]).includes(r.kind));
    case 'workspaceFileReceipt': return record(r,['mutationId','state']) && validBoardUuid(r.mutationId) && outcome(r.state);
    case 'workspaceFileRevoke': return binding(r) && r.state === 'revoked';
    case 'workspaceFileReconcile': return Array.isArray(r) && r.length <= 64 && r.every(validBoardUuid) && new Set(r).size === r.length;
    case 'workspaceFileSessionFiles': return Array.isArray(r) && r.length <= 64 && r.every(binding);
    case 'workspaceFileInstall': return record(r,['existing','row']) && r.existing === true && binding(r.row)
      || record(r,['existing','text','fingerprint'],['effectId']) && r.existing === false && typeof r.text === 'string'
      && hash(r.fingerprint) && (!Object.hasOwn(r,'effectId') || validBoardUuid(r.effectId));
    case 'workspaceFileWrite': return record(r,['existing','receipt']) && r.existing === true
      && validConnectorWorkspaceFileOutput('workspaceFileReceipt',{ok:true,value:r.receipt})
      || record(r,['existing','text','fingerprint','reservedBytes'],['effectId']) && r.existing === false
      && typeof r.text === 'string' && hash(r.fingerprint) && Number.isSafeInteger(r.reservedBytes) && Number(r.reservedBytes) > 0
      && (!Object.hasOwn(r,'effectId') || validBoardUuid(r.effectId));
  }
}

/** Fixed commands on the original connection. No FS effects, app callbacks or
 * actor-id authority. A completion lease settles exactly one admitted effect,
 * including after key revocation; it cannot grant another physical write. */
export function createWorkspaceFileAuthorizer(owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  policy?: FileBoardPolicy, toolPolicies: WorkspaceFileToolPolicies = {}) {
  const authorize = createTurnAuthorizer(owner.executionGrants,(id,scope) => tokens?.hasScope(id,scope) === true);
  return (id: string,sessionKey: string) => {
    const runtime = fileBoardRuntime(sessionKey);
    return !!runtime && fileBoardWritable(runtime,toolPolicies) && !!policy?.policies.some(p => p.owner === id && p.runtime === runtime)
      && !owner.commands.sessionDeletion(sessionKey) && tokens?.hasScope(id,'boards:files') === true
      && authorize(id === LOCAL_FILE_BOARD_OWNER ? 'local:daily' : id,{runtime,sessionKey},'messages:send');
  };
}
export function createConnectorWorkspaceFileCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  policy?: FileBoardPolicy, toolPolicies: WorkspaceFileToolPolicies = {}) {
  const allowed = createWorkspaceFileAuthorizer(owner,tokens,policy,toolPolicies);
  // Only normalized operator configuration selects root and codec.
  const boards = policy ? owner.createWorkspaceFileMetadata(boardFileCodec,allowed) : undefined;
  const cards = policy ? owner.createWorkspaceFileMetadata(cardFileCodec(),allowed) : undefined;
  type Lease = { metadata: NonNullable<typeof boards | typeof cards>; owner: string; id: string; fingerprint: string; mutationId?: string };
  const leases = new Map<string,Lease>();
  const execute = <K extends WorkspaceFileKind>(kind: K,input: ConnectorWorkspaceFileCommands[K]['input']): ConnectorWorkspaceFileCommands[K]['output'] => {
    try {
      if (!validConnectorWorkspaceFileInput(kind,input)) throw new FileBoardError(503);
      let value: unknown;
      if (kind === 'workspaceFileInstalled' || kind === 'workspaceFileSettled') {
        const v = input as ConnectorWorkspaceFileCommands['workspaceFileSettled']['input'];
        const lease = leases.get(v.effectId);
        if (!lease || lease.id !== v.id || lease.fingerprint !== v.fingerprint
          || (kind === 'workspaceFileInstalled' ? lease.mutationId !== undefined : lease.mutationId !== v.mutationId)) throw new FileBoardError(409);
        if (kind === 'workspaceFileInstalled') lease.metadata.installed(lease.owner,v.id,v.fingerprint);
        else lease.metadata.settleWrite(lease.owner,v.id,v.mutationId,v.fingerprint,v.state);
        leases.delete(v.effectId); value = null;
      } else {
        const v = input as Base & { id: string; sessionKey?: string; intent: never; reserve: boolean; mutationId: string; retainedBytes?: number };
        const metadata = v.file === 'board' ? boards : cards;
        if (!metadata) throw new FileBoardError(503);
        let id = '';
        if (kind !== 'workspaceFileReconcile') {
          const principal = tokens?.authenticateAuthorization(v.actor.authorization);
          if (!principal) return {ok:false,status:401};
          if (principal.tokenId !== v.actor.tokenId || !principal.scopes.includes('boards:files')) throw new FileBoardError(403);
          id = principal.tokenId;
        }
        switch (kind) {
          case 'workspaceFileGuard': metadata.guard(id,v.sessionKey!); value = null; break;
          case 'workspaceFileBinding': {
            const row = metadata.owned(id,v.id);
            // The kind is durable metadata, not a transferable codec function.
            value = {row,kind:row.state === 'revoked' && row.fingerprint === '' ? null : metadata.boundKind(v.id)};
            break;
          }
          case 'workspaceFileReceipt': value = metadata.receipt(id,v.id,v.mutationId); break;
          case 'workspaceFileRevoke': value = metadata.revoke(id,v.id,v.sessionKey); break;
          case 'workspaceFileReconcile': value = metadata.reconcile(); break;
          case 'workspaceFileSessionFiles': value = metadata.filesForSession(id,v.sessionKey!); break;
          case 'workspaceFileInstall': case 'workspaceFileWrite': {
            const reserve = kind === 'workspaceFileInstall' ? v.reserve : v.retainedBytes !== undefined;
            if (reserve && leases.size >= 128) {
              // Backpressure must not make an original receipt inaccessible.
              // This inspection is on the same owner, without another effect.
              const prior = kind === 'workspaceFileInstall' ? metadata.installation(id,v.intent)
                : metadata.writeIntent(id,v.id,v.intent);
              if (!prior.existing) throw new FileBoardError(429);
              value = prior; break;
            }
            const result = kind === 'workspaceFileInstall' ? metadata.installation(id,v.intent,v.reserve)
              : metadata.writeIntent(id,v.id,v.intent,v.retainedBytes);
            value = result;
            if (reserve && !result.existing) {
              const effectId = randomUUID(), intent = v.intent as {id: string;mutationId: string};
              leases.set(effectId,{metadata,owner:id,id:kind === 'workspaceFileInstall' ? intent.id : v.id,
                fingerprint:result.fingerprint,...(kind === 'workspaceFileWrite' ? {mutationId:intent.mutationId} : {})});
              value = {...result,effectId};
            }
            break;
          }
        }
      }
      const result = {ok:true,value};
      if (!validConnectorWorkspaceFileOutput(kind,result)) throw new FileBoardError(503);
      return result as ConnectorWorkspaceFileCommands[K]['output'];
    } catch (e) { if (e instanceof FileBoardError) return {ok:false,status:e.status}; throw e; }
  };
  return Object.assign(execute,{dispose:() => {boards?.close(); cards?.close(); leases.clear();}});
}
