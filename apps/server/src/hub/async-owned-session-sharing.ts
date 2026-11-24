import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubOwnedSessionSharingCommand, validHubOwnedSessionSharingReply,
  type HubOwnedSessionSharingCommand, type HubOwnedSessionSharingResult } from './member-owned-session-sharing-domain.js';
import type { SessionShareOptions } from './node-grants.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export class HubOwnedSessionSharingError extends HubMemberRequestError {
  constructor(status: 400 | 404 | 409, readonly conflict: Exclude<HubOwnedSessionSharingResult,null>['conflict']) { super(status); }
}
/** Original owner only. Awaited identity/node checks cannot undo accepted
 * writes; disconnect and unknown ACK never imply permission to replay. */
export class AsyncHubOwnedSessionSharing {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests=new AsyncHubMemberRequests(owner,diagnostics,warningMs,timeoutMs);
    this.persistence=new AuthRoutePersistence(diagnostics,warningMs);
  }
  get pending(){return this.requests.pendingReads+this.persistence.pending;}
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async begin(request:Request,sessionId:string){
    const original=copyOriginalRequest(request);
    const evidence=Object.freeze(hubMemberEvidence(original)),authority=await this.requests.begin(original);
    const target=Object.freeze({userId:authority.principal.userId,sessionId});
    const access=async(input:HubOwnedSessionSharingCommand)=>{
      if(!validHubOwnedSessionSharingCommand(input))throw new HubMemberRequestError(400);
      const command:HubOwnedSessionSharingCommand=Object.freeze(input.action==='create'||input.action==='update'
        ?{...input,options:Object.freeze({...input.options})}:{...input});
      await authority.check();
      if(original.signal.aborted)throw new HubMemberRequestError(499);
      let value;
      try{value=(await this.persistence.run(46,async()=>{
        const result=await this.owner.command('ownedSessionSharing',{
          evidence,expectedScope:authority.recoveryScope,command,
        });
        // A delivered ACK is not settlement proof unless it matches the exact
        // original request. Log mismatches as unknown, not successful writes.
        if(!validHubOwnedSessionSharingReply(command,result))throw new HubMemberRequestError(503);
        return result;
      })).value;}
      catch{await authority.check();throw new HubMemberRequestError(503);}
      if(value===null)throw new HubMemberRequestError(401);
      await authority.check();
      if(!validHubOwnedSessionSharingReply(command,value))throw new HubMemberRequestError(503);
      if(value.status!==200&&value.status!==201)throw new HubOwnedSessionSharingError(value.status,value.conflict);
      if(original.signal.aborted)throw new HubMemberRequestError(499);
      return value;
    };
    const initial=await access({...target,action:'authorize'}),nodeVersion=initial.nodeVersion!;
    const check=()=>access({...target,nodeVersion,action:'check'});
    const run=async(input:HubOwnedSessionSharingCommand)=>{
      // Own options before the first permission await, not after caller IO.
      const command:HubOwnedSessionSharingCommand=input.action==='create'||input.action==='update'
        ?{...input,options:{...input.options}}:{...input};
      await check();const value=await access(command);await check();return value;
    };
    return{
      async check(){await check();},
      async list(){const value=await access({...target,action:'list'});await check();
        if(value.nodeVersion!==nodeVersion||!value.page)throw new HubMemberRequestError(503);return value.page;},
      async create(recipientId:string,role:'observer'|'collaborator',options:SessionShareOptions){
        const value=await run({...target,nodeVersion,action:'create',recipientId,role,options});
        if(!value.grant)throw new HubMemberRequestError(503);return{grant:value.grant};},
      async update(id:string,version:number,role:'observer'|'collaborator',options:SessionShareOptions){
        const value=await run({...target,nodeVersion,action:'update',id,version,role,options});
        if(!value.grant)throw new HubMemberRequestError(503);return{grant:value.grant};},
      async remove(id:string,version:number){const value=await run({...target,nodeVersion,action:'delete',id,version});
        if(typeof value.ok!=='boolean')throw new HubMemberRequestError(503);return{ok:value.ok};},
    };
  }
}
