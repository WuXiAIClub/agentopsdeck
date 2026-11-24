export type SourceSelection={connection:string;source:string;kind?:'issue'|'work_item';state?:'all'|'open'|'closed'};
const valid=(v:unknown):v is SourceSelection=>{
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const x=v as SourceSelection;
  return Object.keys(x).every(k=>['connection','source','kind','state'].includes(k))&&[x.connection,x.source].every(s=>typeof s==='string'&&s.length<=256&&!/[\x00-\x1f\x7f]/.test(s))
    &&(x.kind===undefined||['issue','work_item'].includes(x.kind))&&(x.state===undefined||['all','open','closed'].includes(x.state));
};
const key=(scope:string)=>/^[a-f0-9]{64}$/.test(scope)?`agentopsdeck.source-selection.v1:${scope}`:undefined;
function entries(scope:string):[string,SourceSelection][]{
  try{const k=key(scope);if(!k)return [];const raw=localStorage.getItem(k);if(!raw||raw.length>65536)return [];
    const values=JSON.parse(raw);return Array.isArray(values)&&values.length<=64?values.filter(v=>Array.isArray(v)&&v.length===2&&typeof v[0]==='string'&&v[0].length<=256&&valid(v[1])):[];
  }catch{return [];}
}
/** Metadata only. Never persist previews, access tokens, path tokens or cursors. */
export function readSourceSelection(scope:string,card:string){return entries(scope).find(([id])=>id===card)?.[1];}
export function saveSourceSelection(scope:string,card:string,value:SourceSelection){
  const k=key(scope);if(!k||!card||card.length>256||!valid(value))return;
  try{const values=entries(scope).filter(([id])=>id!==card);values.push([card,value]);localStorage.setItem(k,JSON.stringify(values.slice(-64)));}catch{/* Optional preference, never block a read. */}
}
