import type { ConnectorClient } from './connector-client.js';
import type { ContentReplicaTransport } from './workspace-content-coordinator.js';

/** One request per operation; unknown outcomes are left to the durable
 * coordinator. Never retries a PUT/claim/project after a transport failure. */
export function contentReplicaTransport(client:Pick<ConnectorClient,'json'>):ContentReplicaTransport {
  const base='/workspace/content-replicas',path=(id:string)=>`${base}/${encodeURIComponent(id)}`;
  const request=<T>(url:string,method='GET',body?:unknown)=>client.json<T>(url,{
    method,signal:AbortSignal.timeout(10_000),...(body===undefined?{}:{body:JSON.stringify(body),headers:{'content-type':'application/json'}})});
  return {
    capability:()=>request(base),
    install:input=>request(path(input.id),'PUT',input),
    view:id=>request(path(id)),
    observe:async id=>(await request<{proposal:Awaited<ReturnType<ContentReplicaTransport['observe']>>}>(`${path(id)}/observe`,'POST')).proposal??undefined,
    claim:(id,mutation)=>request(`${path(id)}/proposals/${encodeURIComponent(mutation)}/claim`,'POST'),
    settle:(id,mutation,receipt)=>request(`${path(id)}/proposals/${encodeURIComponent(mutation)}/receipt`,'POST',receipt),
    resolve:(id,input)=>request(`${path(id)}/resolve`,'POST',input),
    project:(id,job)=>request(`${path(id)}/project`,'POST',job),
    projectionReceipt:(id,job)=>request(`${path(id)}/projection-receipt`,'POST',job),
    revoke:async id=>{const result=await request<{id:string;revoked:boolean}>(path(id),'DELETE');
      if(result.id!==id||result.revoked!==true)throw Error('revocation-proof');},
  };
}
