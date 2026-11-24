import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubCreationDiscoveryCommand, validHubCreationDiscoveryReply } from './member-creation-discovery-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { copyOriginalRequest } from './original-request-scope.js';
/** Original grant/issuer discovery, not execution admission or session creation.
 * A read deadline never cancels/releases the worker's original command. */
export class AsyncHubCreationDiscovery {
  private readonly work = new HubRequestWork(32);
  private readonly drain: () => Promise<void>;
  private readonly requests:AsyncHubMemberRequests;
  private readonly persistence:AuthRoutePersistence;
  private readonly reads:AuthRouteReadWait;
  constructor(private readonly owner:Pick<AsyncHubMemberOwner,'command'>,
    diagnostics:PerformanceDiagnostics=performanceDiagnostics,warningMs=30000,timeoutMs=30000){
    this.requests=new AsyncHubMemberRequests(owner,diagnostics,warningMs,timeoutMs);
    this.persistence=new AuthRoutePersistence(diagnostics,warningMs);this.reads=new AuthRouteReadWait(this.persistence,diagnostics,timeoutMs);
    this.drain=createIndependentDrain([()=>this.work.close(),()=>this.requests.close(),()=>this.persistence.close()],'hub-route-drain',diagnostics);
  }
  get pending(){return this.persistence.pending+this.requests.pendingReads;}
  close(){void this.work.close();return this.drain();}
  environments(request:Request,after:string){
    const original=copyOriginalRequest(request);
    return this.work.run(()=>this.environmentsOriginal(original,after));
  }
  private async environmentsOriginal(original:Request,after:string){
    const evidence=Object.freeze(hubMemberEvidence(original)),authority=await this.requests.begin(original);
    const expected=original.headers.get('x-agentopsdeck-recovery-scope');
    if(expected!==null&&expected!==authority.recoveryScope)throw new HubMemberRequestError(409);
    const command=Object.freeze({userId:authority.principal.userId,after});
    if(!validHubCreationDiscoveryCommand(command))throw new HubMemberRequestError(400);
    await authority.check();let value;
    try{value=(await this.reads.run(original,43,()=>this.owner.command('creationEnvironments',{evidence,expectedScope:authority.recoveryScope,command}))).value;}
    catch(error){await authority.check();throw new HubMemberRequestError(error instanceof AuthReadCancelledError?499:503);}
    if(value===null)throw new HubMemberRequestError(401);await authority.check();
    if(!validHubCreationDiscoveryReply(command,value))throw new HubMemberRequestError(503);
    this.work.check();return value.page;
  }
}
