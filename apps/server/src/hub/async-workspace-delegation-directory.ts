import { sessionRuntimeId, validBoardUuid } from '@agentopsdeck/shared';
import { HTTPException } from 'hono/http-exception';
import type { AsyncHubDelegations } from './async-delegations.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { HubMemberRequestError } from './async-member-request.js';
import { encodeHubSessionId, decodeHubSessionId } from './session-id.js';
import { createDelegationPreview, type DelegationMember, type DelegationSelection } from './workspace-delegation-preview.js';

export type DelegationScope = Awaited<ReturnType<AsyncHubDelegations['begin']>>;
export type DelegationRemote = {runtime:string;sessionId:string;ready:boolean;binding:null|{
  id:string;runtime:string;sessionId:string;expiresAt:number;state:string}};
export const validDelegationRemote = (r: DelegationRemote | undefined, m: DelegationMember): r is DelegationRemote => !!r
  && r.runtime === m.runtime && validBoardUuid(r.sessionId) && typeof r.ready === 'boolean'
  && (r.binding === null || !!r.binding && validBoardUuid(r.binding.id) && r.binding.runtime === r.runtime
    && r.binding.sessionId === r.sessionId && Number.isSafeInteger(r.binding.expiresAt) && ['installed','removed'].includes(r.binding.state));

/** Original transport ownership is retained through cancellation. Directory
 * reads use the general policy; binding effects use the dedicated token. */
export async function delegationRemoteLane(scope: DelegationScope, request: Request, member: DelegationMember,
  clients: AsyncConnectorClientResolver | undefined) {
  await scope.check(); if (!clients) throw new HubMemberRequestError(503);
  const decoded = decodeHubSessionId(member.sessionId);
  if (!decoded || decoded.connectionId !== member.connectionId) throw new HubMemberRequestError(503);
  const client = await clients(request,member.connectionId,{expectedUserId:scope.owner,boardBindingsOnly:true});
  await scope.check();
  return {client,path:`/sessions/${encodeURIComponent(decoded.remoteSessionKey)}/board-binding`};
}
export async function readDelegationRemote(lane: Awaited<ReturnType<typeof delegationRemoteLane>>, member: DelegationMember, signal: AbortSignal) {
  const value = await lane.client.jsonOriginal<DelegationRemote>(lane.path,{signal});
  if (!validDelegationRemote(value,member)) throw new HTTPException(502); return value;
}

/** Server-owned complete catalog. A cursor break, duplicate, disabled/unpinned
 * node, limit or local fence change rejects the WHOLE selection. Browser input
 * cannot supply catalog facts or supported status. */
export async function asyncDelegationCatalog(scope: DelegationScope, request: Request, boardId: string,
  selection: DelegationSelection, taskIds: string[], fields: ('status'|'detail')[], clients?: AsyncConnectorClientResolver) {
  if (!clients) throw new HubMemberRequestError(503);
  const {snapshot} = await scope.command({action:'snapshot',boardId});
  if (!snapshot.enabled) throw new HubMemberRequestError(409);
  const fence = {generation:snapshot.generation,preferencesRevision:snapshot.preferencesRevision};
  const check = () => scope.command({action:'check',boardId,fence});
  const prefs = new Map(snapshot.sessions.map(s => [s.sessionId,s]));
  const members: DelegationMember[] = [], seen = new Set<string>();
  const signal = AbortSignal.any([request.signal,AbortSignal.timeout(15_000)]);
  for (const connection of snapshot.connections) {
    const client = await clients(request,connection.id,{expectedUserId:scope.owner}); await check();
    let after: string | undefined, sourceCursor: string | undefined; const cursors = new Set<string>();
    for (let pages = 0; ; pages++) {
      signal.throwIfAborted(); if (pages >= 101) throw new HubMemberRequestError(409);
      const page = await client.sessionDirectoryOriginal({limit:100,...(after ? {after} : {})},signal); await check();
      if (!page.sourceCursor || sourceCursor !== undefined && sourceCursor !== page.sourceCursor) throw new HubMemberRequestError(409);
      sourceCursor = page.sourceCursor;
      for (const entry of page.sessions) {
        const sessionId = encodeHubSessionId(connection.id,entry.sessionKey), p = prefs.get(sessionId);
        if (members.length >= 10_000 || seen.has(sessionId) || sessionRuntimeId(entry.sessionKey) !== entry.runtime) throw new HubMemberRequestError(409);
        seen.add(sessionId); members.push({owner:scope.owner,nodeId:connection.nodeId,connectionId:connection.id,runtime:entry.runtime,
          sessionId,authorityEpoch:connection.epoch,groupId:p?.groupId ?? null,tags:p?.tags ?? [],taskBinding:'unknown'});
      }
      if (page.nextCursor === null) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new HubMemberRequestError(409);
      cursors.add(page.nextCursor); after = page.nextCursor;
    }
  }
  const input = {owner:scope.owner,catalog:{owner:scope.owner,...fence,complete:true,members},selection,board:snapshot.board,taskIds,fields};
  const selected = createDelegationPreview(input,Date.now()).members, supported = new Set<string>();
  for (const member of selected) {
    if (!['codex','claude-code','ghcp'].includes(member.runtime)) continue;
    const lane = await delegationRemoteLane(scope,request,member,clients);
    const remote = await readDelegationRemote(lane,member,signal); await check();
    if (remote.ready && remote.binding?.state !== 'installed') supported.add(member.sessionId);
  }
  await check();
  return {...fence,members:members.map(m => ({sessionId:m.sessionId,taskBinding:supported.has(m.sessionId) ? 'supported' as const : 'unknown' as const}))};
}
