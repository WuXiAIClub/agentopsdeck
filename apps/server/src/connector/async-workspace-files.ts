import { createHash } from 'node:crypto';
import type { ChangeSignal } from '../utils/change-signal.js';
import type { ConnectorOwnerCommands, ConnectorOwnerKind } from './connector-owner-domain.js';
import { WorkspaceFileEffects, FileBoardError, type WorkspaceFileMetadataPort, type ConnectorFileBoardIntent, type FileBoardWrite } from './workspace-board-files.js';
import { validConnectorWorkspaceFileOutput, type WorkspaceFileActor, type ConnectorWorkspaceFileCommands, type WorkspaceFileKind } from './connector-workspace-file-domain.js';
import type { WorkspaceFileCodec } from './workspace-file-codec.js';
import type { WorkspaceFileBinding } from './workspace-file-metadata.js';

export type WorkspaceFileOwner = {
  command<K extends ConnectorOwnerKind>(kind: K,input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']>;
  readonly authorityChanges: ChangeSignal;
};
type CommandValue<K extends WorkspaceFileKind> = Extract<ConnectorWorkspaceFileCommands[K]['output'],{ok:true}>['value'];
/** Main-thread physical effects, sole-worker metadata. Original evidence is
 * copied per operation, never reconstructed from an owner ID or cached grant. */
export class AsyncWorkspaceFiles<T> {
  private readonly effects: WorkspaceFileEffects<T,WorkspaceFileActor>;
  private readonly originalAuthorization = new WeakMap<Request,string>();
  readonly changes: ChangeSignal;
  constructor(private readonly owner: WorkspaceFileOwner, root: string, readonly codec: WorkspaceFileCodec<T>) {
    const file = codec.name === 'tasks.json' ? 'board' : 'card';
    let closed = false;
    const leases = new Map<string,string>();
    const call = async <K extends WorkspaceFileKind>(kind: K,input: ConnectorWorkspaceFileCommands[K]['input'],settlement = false): Promise<CommandValue<K>> => {
      if (closed && !settlement) throw new FileBoardError(503);
      const result = await owner.command(kind,input);
      if (!validConnectorWorkspaceFileOutput(kind,result)) throw new FileBoardError(503);
      if (!result.ok) throw new FileBoardError(result.status === 401 ? 403 : result.status);
      return result.value as CommandValue<K>;
    };
    const bound = async (actor: WorkspaceFileActor,id: string) => {
      const result = await call('workspaceFileBinding',{file,actor,id});
      if (result.row.id !== id || result.row.owner !== actor.tokenId || file === 'board' && result.kind !== null
        || file === 'card' && result.kind === null && !(result.row.state === 'revoked' && result.row.fingerprint === '')) throw new FileBoardError(503);
      return result;
    };
    const checkRows = (actor: WorkspaceFileActor,key: string,rows: WorkspaceFileBinding[]) => {
      if (rows.some(r => r.owner !== actor.tokenId || r.sessionKey !== key || r.state !== 'installed')
        || new Set(rows.map(r => r.id)).size !== rows.length) throw new FileBoardError(503);
      return rows;
    };
    const leaseKey = (id: string,hash: string,mutation = '') => JSON.stringify([id,hash,mutation]);
    const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    const port: WorkspaceFileMetadataPort<T,WorkspaceFileActor> = {
      guard: async (actor,sessionKey) => { await call('workspaceFileGuard',{file,actor,sessionKey}); },
      owned: async (actor,id) => (await bound(actor,id)).row,
      boundCodec: async (actor,id) => { const b = await bound(actor,id); return b.kind === null ? codec : codec.bound!(b.kind); },
      installation: async (actor,intent,reserve = false) => {
        const result = await call('workspaceFileInstall',{file,actor,intent,reserve});
        const text = codec.serialize(intent.content), hash = fingerprint([actor.tokenId,intent.sessionKey,text]);
        if (result.existing) {
          if (result.row.id !== intent.id || result.row.owner !== actor.tokenId || result.row.sessionKey !== intent.sessionKey
            || result.row.fingerprint !== hash && !(result.row.state === 'revoked' && result.row.fingerprint === '')) throw new FileBoardError(503);
        } else {
          if (result.text !== text || result.fingerprint !== hash || reserve !== !!result.effectId) throw new FileBoardError(503);
          if (result.effectId) leases.set(leaseKey(intent.id,hash),result.effectId);
        }
        return result;
      },
      installed: async (_actor,id,fingerprint) => {
        const key = leaseKey(id,fingerprint), effectId = leases.get(key);
        if (!effectId) throw new FileBoardError(503);
        await call('workspaceFileInstalled',{effectId,id,fingerprint},true); leases.delete(key);
      },
      receipt: async (actor,id,mutationId) => {
        const result = await call('workspaceFileReceipt',{file,actor,id,mutationId});
        if (result.mutationId !== mutationId) throw new FileBoardError(503);
        return result;
      },
      writeIntent: async (actor,id,intent,retainedBytes) => {
        const result = await call('workspaceFileWrite',{file,actor,id,intent,...(retainedBytes === undefined ? {} : {retainedBytes})});
        if (result.existing) {
          if (result.receipt.mutationId !== intent.mutationId) throw new FileBoardError(503);
        } else {
          const text = codec.serialize(intent.content), hash = fingerprint([intent.expectedHash,text]);
          if (result.text !== text || result.fingerprint !== hash || (retainedBytes !== undefined) !== !!result.effectId
            || result.reservedBytes !== codec.maxBytes + Buffer.byteLength(text)) throw new FileBoardError(503);
          if (result.effectId) leases.set(leaseKey(id,hash,intent.mutationId),result.effectId);
        }
        return result;
      },
      settleWrite: async (_actor,id,mutationId,fingerprint,state) => {
        const key = leaseKey(id,fingerprint,mutationId), effectId = leases.get(key);
        if (!effectId) throw new FileBoardError(503);
        await call('workspaceFileSettled',{effectId,id,mutationId,fingerprint,state},true); leases.delete(key);
      },
      revoke: async (actor,id,sessionKey) => {
        const result = await call('workspaceFileRevoke',{file,actor,id,...(sessionKey === undefined ? {} : {sessionKey})});
        if (result.id !== id || result.owner !== actor.tokenId || sessionKey !== undefined && result.sessionKey !== sessionKey) throw new FileBoardError(503);
        return result;
      },
      reconcile: () => call('workspaceFileReconcile',{file}),
      filesForSession: async (actor,sessionKey) => checkRows(actor,sessionKey,await call('workspaceFileSessionFiles',{file,actor,sessionKey})),
      close: () => { closed = true; },
    };
    this.effects = new WorkspaceFileEffects(port,root,codec); this.changes = this.effects.changes;
  }
  async authenticate(request: Request): Promise<WorkspaceFileActor | null> {
    // Preserve the original request evidence across every await/recheck, but
    // never preserve the resulting principal or grant across a revocation.
    if (!this.originalAuthorization.has(request)) this.originalAuthorization.set(request,request.headers.get('authorization') ?? '');
    const authorization = this.originalAuthorization.get(request)!;
    const principal = await this.owner.command('tokenAuthenticate',{authorization});
    if (!principal) return null;
    if (!principal.scopes.includes('boards:files')) throw new FileBoardError(403);
    return {authorization,tokenId:principal.tokenId};
  }
  get(actor: WorkspaceFileActor,id: string) { return this.effects.get({...actor},id); }
  snapshot(actor: WorkspaceFileActor,id: string) { return this.effects.snapshot({...actor},id); }
  receipt(actor: WorkspaceFileActor,id: string,mutation: string) { return this.effects.receipt({...actor},id,mutation); }
  install(actor: WorkspaceFileActor,input: ConnectorFileBoardIntent<T>) { return this.effects.install({...actor},structuredClone(input)); }
  write(actor: WorkspaceFileActor,id: string,input: FileBoardWrite<T>) { return this.effects.write({...actor},id,structuredClone(input)); }
  revoke(actor: WorkspaceFileActor,id: string,key?: string) { return this.effects.revoke({...actor},id,key); }
  filesForSession(actor: WorkspaceFileActor,key: string) { return this.effects.filesForSession({...actor},key); }
  contextForSession(actor: WorkspaceFileActor,key: string) { return this.effects.contextForSession({...actor},key); }
  reconcile() { return this.effects.reconcile(); }
  async subscribe(actor: WorkspaceFileActor,id: string,dirty: () => void) {
    const subscription = await this.effects.subscribe({...actor},id,dirty);
    return {current:subscription.current,release:subscription.release};
  }
  close() { return this.effects.close(); }
}
