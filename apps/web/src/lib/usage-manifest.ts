export type UsageManifestInput={requestId:string;from:number;to:number;bucketMs:number;tags:string[];tagMode:'all'|'any';groupId?:string;connectionId?:string;runtime?:string;layoutId?:string};
type Metric={knownSubtotal:number;knownSampleCount:number;unknownSampleCount:number};
export type UsageTotals={events:number;metrics:Record<'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens',Metric>};
export type UsageManifestView={requestId:string;selection:UsageManifestInput;directoryRevision:string;createdAt:number;expiresAt:number;
  state:'prepared'|'collecting'|'complete'|'cancelled';members:{sessionId:string;connectionId:string;runtime:string;groupId:string|null;tags:string[];requestId:string;state:'prepared'|'unknown'|'complete'}[];
  result:null|{version:1;membership:'query-time';memberCount:number;manifestDigest:string;total:UsageTotals;groups:({name:string}&UsageTotals)[];
    coverageReasons:string[];creditEstimate:{status:'unavailable';reason:string}}};
const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
const text=(v:unknown,n=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=n&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const tags=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=8&&v.every(t=>text(t,32))&&new Set(v).size===v.length;
export function validUsageManifest(raw:unknown,id:string):raw is UsageManifestView {
  if(!raw||typeof raw!=='object')return false;
  const v=raw as UsageManifestView,s=v.selection;
  if(!uuid(id)||v.requestId!==id||!s||s.requestId!==id||!['prepared','collecting','complete','cancelled'].includes(v.state)
    ||!integer(s.from)||!integer(s.to)||s.to<=s.from||s.to-s.from>31*86400000||!integer(s.bucketMs)||s.bucketMs<60000||s.bucketMs>86400000
    ||!tags(s.tags)||!['all','any'].includes(s.tagMode)||s.runtime!==undefined&&!['codex','claude-code','ghcp'].includes(s.runtime)
    ||[s.groupId,s.connectionId,s.layoutId].some(x=>x!==undefined&&!text(x))
    ||!integer(v.createdAt)||!integer(v.expiresAt)||v.expiresAt<v.createdAt||!digest(v.directoryRevision)
    ||!Array.isArray(v.members)||v.members.length>128
    ||v.members.some(m=>!m||!text(m.sessionId,2048)||!uuid(m.requestId)||m.requestId===id||!text(m.connectionId)
      ||!['codex','claude-code','ghcp'].includes(m.runtime)||m.groupId!==null&&!text(m.groupId)||!tags(m.tags)||!['prepared','unknown','complete'].includes(m.state))
    ||new Set(v.members.map(m=>m.sessionId)).size!==v.members.length||new Set(v.members.map(m=>m.requestId)).size!==v.members.length)return false;
  if(v.state!=='complete')return v.result===null;
  const r=v.result;if(!r||r.version!==1||r.membership!=='query-time'||r.memberCount!==v.members.length||v.members.some(m=>m.state!=='complete')
    ||!digest(r.manifestDigest)||!Array.isArray(r.groups)||r.groups.length>2048||r.groups.some(g=>!g||!text(g.name,1024))||new Set(r.groups.map(g=>g.name)).size!==r.groups.length
    ||!Array.isArray(r.coverageReasons)||r.coverageReasons.length>32||!r.coverageReasons.every(reason=>text(reason,256))
    ||r.creditEstimate?.status!=='unavailable'||!text(r.creditEstimate.reason,256))return false;
  return [r.total,...r.groups].every(t=>t&&integer(t.events)&&['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].every(k=>{
    const m=t.metrics?.[k as keyof UsageTotals['metrics']];return m&&integer(m.knownSubtotal)&&integer(m.knownSampleCount)&&integer(m.unknownSampleCount)
      &&m.knownSampleCount+m.unknownSampleCount===t.events;
  }));
}
