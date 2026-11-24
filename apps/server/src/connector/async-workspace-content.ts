import type { WorkspaceFileCard } from '@agentopsdeck/shared';
import type { WorkspaceFileOwner } from './async-workspace-files.js';
import type { ConnectorOwnerCommands } from './connector-owner-domain.js';
import { WorkspaceContentEffects, type ContentReplicaFilePort } from './workspace-content-replica.js';
import { ContentReplicaConflict, type WorkspaceContentMetadataPort } from './workspace-content-metadata.js';
import { FileBoardError } from './workspace-file-metadata.js';
import type { WorkspaceFileActor } from './connector-workspace-file-domain.js';
import { validConnectorContentReplicaOutput, type ConnectorContentReplicaCommands, type ContentReplicaKind } from './connector-content-replica-domain.js';

type Value<K extends ContentReplicaKind> = Extract<ConnectorContentReplicaCommands[K]['output'],{ok:true}>['value'];
/** Original physical executor plus sole-worker journal. No SQL, replica cache
 * or replay permission is introduced by this adapter. */
export class AsyncWorkspaceContent extends WorkspaceContentEffects<WorkspaceFileCard,WorkspaceFileActor> {
  constructor(owner:WorkspaceFileOwner,files:ContentReplicaFilePort<WorkspaceFileCard,WorkspaceFileActor>) {
    const call=async <K extends ContentReplicaKind>(kind:K,actor:WorkspaceFileActor,args:ConnectorContentReplicaCommands[K]['input']['args']):Promise<Value<K>>=>{
      const input=structuredClone({actor,args});
      const result=await owner.command(kind,input as ConnectorOwnerCommands[K]['input']);
      if(!validConnectorContentReplicaOutput(kind,result))throw new FileBoardError(503);
      if(!result.ok){
        if(result.status===409)throw new ContentReplicaConflict('original-journal-conflict');
        throw new FileBoardError(result.status===401?403:result.status);
      }
      // Inspect only protocol evidence, never arbitrary user card fields.
      const checkReplica=(value:unknown):void=>{
        const row=value as {owner:string;id:string};
        if(row.owner!==input.actor.tokenId||row.id!==input.args[0])throw new FileBoardError(503);
      };
      const checkLocal=(value:unknown,mutation?:unknown):void=>{
        const row=value as {proposal:{bindingId:string;mutationId:string}};
        if(row.proposal.bindingId!==input.args[0]||mutation!==undefined&&row.proposal.mutationId!==mutation)throw new FileBoardError(503);
      };
      if(kind==='contentReplicaOwned')checkReplica(result.value);
      else if(kind==='contentReplicaProposals')for(const row of result.value as Value<'contentReplicaProposals'>)checkLocal(row);
      else if(kind==='contentReplicaClaim')checkLocal((result.value as Value<'contentReplicaClaim'>).local,input.args[1]);
      else if(kind==='contentReplicaSettle')checkLocal(result.value,input.args[1]);
      else if(kind==='contentReplicaObserve'&&result.value!==null)checkLocal(result.value);
      else if(kind==='contentReplicaResolve')checkLocal(result.value,(input as ConnectorContentReplicaCommands['contentReplicaResolve']['input']).args[1].mutationId);
      else if(kind==='contentReplicaResolution'){
        const plan=result.value as Value<'contentReplicaResolution'>;
        const resolution=(input as ConnectorContentReplicaCommands['contentReplicaResolution']['input']).args[1];
        checkReplica(plan.replica);checkLocal(plan.conflict,resolution.conflictId);
        if(plan.prior)checkLocal(plan.prior,resolution.mutationId);
      }else if(kind==='contentReplicaProjection')checkReplica((result.value as Value<'contentReplicaProjection'>).replica);
      else if(kind==='contentReplicaProjected'){
        const proof=result.value as Value<'contentReplicaProjected'>;
        const [,job,state]=(input as ConnectorContentReplicaCommands['contentReplicaProjected']['input']).args;
        if(proof.id!==job.id||proof.state!==state||proof.hash!==(state==='saved'?job.hash:null))throw new FileBoardError(503);
      }else if(kind==='contentReplicaInstalled'){
        if((result.value as Value<'contentReplicaInstalled'>).hash!==input.args[1])throw new FileBoardError(503);
      }else if(kind==='contentReplicaPrepareProjection'){
        const job=(input as ConnectorContentReplicaCommands['contentReplicaPrepareProjection']['input']).args[1];
        if(JSON.stringify((result.value as Value<'contentReplicaPrepareProjection'>).content)!==job.content)throw new FileBoardError(503);
      }else if(kind==='contentReplicaInstallation'){
        const plan=result.value as Value<'contentReplicaInstallation'>;
        const intent=(input as ConnectorContentReplicaCommands['contentReplicaInstallation']['input']).args[0];
        if(JSON.stringify(plan.content)!==intent.base.content)throw new FileBoardError(503);
        if(plan.prior&&(plan.prior.owner!==input.actor.tokenId||plan.prior.id!==intent.id||plan.prior.sessionKey!==intent.sessionKey
          ||plan.prior.generation!==intent.generation||plan.prior.resource!==intent.resource))throw new FileBoardError(503);
      }
      return result.value as Value<K>;
    };
    const port:WorkspaceContentMetadataPort<WorkspaceFileCard,WorkspaceFileActor>={
      owned:(actor,...args)=>call('contentReplicaOwned',actor,args),
      installation:(actor,...args)=>call('contentReplicaInstallation',actor,args),
      prepareInstallation:async(actor,...args)=>{await call('contentReplicaPrepareInstallation',actor,args);},
      installed:(actor,...args)=>call('contentReplicaInstalled',actor,args),
      proposals:(actor,...args)=>call('contentReplicaProposals',actor,args),
      claim:(actor,...args)=>call('contentReplicaClaim',actor,args),
      settle:(actor,...args)=>call('contentReplicaSettle',actor,args),
      resolution:(actor,...args)=>call('contentReplicaResolution',actor,args),
      resolve:(actor,...args)=>call('contentReplicaResolve',actor,args),
      observe:async(actor,...args)=>(await call('contentReplicaObserve',actor,args))??undefined,
      projection:(actor,...args)=>call('contentReplicaProjection',actor,args),
      prepareProjection:(actor,...args)=>call('contentReplicaPrepareProjection',actor,args),
      projected:(actor,...args)=>call('contentReplicaProjected',actor,args),
      revoke:async(actor,...args)=>{await call('contentReplicaRevoke',actor,args);},
    };
    super(port,files);
  }
}
