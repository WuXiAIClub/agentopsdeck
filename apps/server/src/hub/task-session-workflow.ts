import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardContent, validBoardId, validBoardUuid, copyBoardTask, type BoardTask } from '@agentopsdeck/shared';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type TaskSessionIntent = {
  owner: string; requestId: string; nodeId: string; connectionId: string; runtime: string; authorityEpoch: number;
  boardId: string; boardRevision: number; title: string; model?: string; tasks: BoardTask[]; fields: ('status'|'detail')[]; expiresAt: number;
};
type State = 'prepared'|'creation_unknown'|'creation_rejected'|'created'|'binding_unknown'|'binding_rejected'|'bound'|'cancelled';
export type TaskSessionReceipt = {
  intent: TaskSessionIntent; fingerprint: string; creationRequestId: string; bindingRequestId: string;
  state: State; sessionId: string|null; bindingId: string|null;
};
const text = (v:string) => typeof v==='string' && v.length>0 && v.length<=512 && v===v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const integer = (v:number) => Number.isSafeInteger(v) && v>=0;
const hash = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Stable, distinct UUIDs for the two effects; no IDs are regenerated after loss.
function phaseId(owner:string,id:string,phase:string) {
  const h=hash([owner,id,phase]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Internal reference coordinator. No session creation/binding transport here.
 * Caller supplies an authoritative frozen task selection and rechecks authority
 * through the callback. Only claims returned true may perform ONE external write.
 * Lost responses require original-request lookup, never another claim or ID.
 * A failed binding leaves the already-created session intact; no auto-delete. */
export class TaskSessionWorkflow {
  constructor(private readonly db:DatabaseSync, private readonly authorized:(intent:TaskSessionIntent)=>boolean,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    if(db.isTransaction)throw Error('workflow-outer-transaction');
    db.exec('CREATE TABLE IF NOT EXISTS hub_task_session_workflows(owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,budget_bytes INTEGER NOT NULL,PRIMARY KEY(owner,id))');
    db.exec('CREATE TABLE IF NOT EXISTS hub_task_session_cancellations(owner TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(owner,id))');
  }
  private atomic<T>(fn:(check:(value:unknown)=>void)=>T extends PromiseLike<unknown> ? never : T, verify?:()=>void):T {
    requireConnectionReady(this.db);
    if(this.db.isTransaction)throw Error('workflow-outer-transaction');
    return observedTransaction(this.db, 'task-session-change', (_commit,check) => { check(verify?.()); return fn(check); }, this.diagnostics);
  }
  private normalize(i:TaskSessionIntent):TaskSessionIntent {
    if(![i.owner,i.nodeId,i.connectionId,i.runtime].every(text)||!validBoardUuid(i.requestId)||!validBoardId(i.boardId)
      ||![i.authorityEpoch,i.boardRevision,i.expiresAt].every(integer)||!validBoardContent({title:i.title,tasks:i.tasks})||!i.tasks.length||i.tasks.length>32
      ||!Array.isArray(i.fields)||!i.fields.length||new Set(i.fields).size!==i.fields.length||i.fields.some(f=>f!=='status'&&f!=='detail'))throw Error('workflow-input');
    if(i.model!==undefined&&(!text(i.model)||i.model.length>256))throw Error('workflow-model');
    return {owner:i.owner,requestId:i.requestId,nodeId:i.nodeId,connectionId:i.connectionId,runtime:i.runtime,authorityEpoch:i.authorityEpoch,...(i.model!==undefined?{model:i.model}:{}),
      boardId:i.boardId,boardRevision:i.boardRevision,title:i.title,tasks:i.tasks.map(copyBoardTask).sort((a,b)=>a.id.localeCompare(b.id)),fields:[...i.fields].sort(),expiresAt:i.expiresAt};
  }
  private authority(i:TaskSessionIntent) {if(!this.authorized(structuredClone(i)))throw Error('workflow-forbidden');}
  private raw(owner:string,id:string):TaskSessionReceipt|undefined {
    if(!text(owner)||!validBoardUuid(id))throw Error('workflow-scope');
    const row=this.db.prepare('SELECT payload FROM hub_task_session_workflows WHERE owner=? AND id=?').get(owner,id);
    return row?JSON.parse(String(row.payload)) as TaskSessionReceipt:undefined;
  }
  read(owner:string,id:string,verify?:()=>void):TaskSessionReceipt|undefined {
    if(verify)return this.atomic(()=>this.read(owner,id),verify);
    const r=this.raw(owner,id);if(r)this.authority(r.intent);return r;
  }
  private required(owner:string,id:string) {const r=this.read(owner,id);if(!r)throw Error('workflow-unavailable');return r;}
  private save(r:TaskSessionReceipt) {this.db.prepare('UPDATE hub_task_session_workflows SET payload=? WHERE owner=? AND id=?').run(JSON.stringify(r),r.intent.owner,r.intent.requestId);return r;}
  prepare(input:TaskSessionIntent,verify?:()=>void) {
    const intent=this.normalize(input);this.authority(intent);const fingerprint=hash(intent);
    return this.atomic(()=>{
      this.authority(intent);const old=this.raw(intent.owner,intent.requestId);
      if(this.db.prepare('SELECT 1 FROM hub_task_session_cancellations WHERE owner=? AND id=?').get(intent.owner,intent.requestId))throw Error('workflow-cancelled');
      if(old){if(old.fingerprint!==fingerprint)throw Error('workflow-request-reused');return old;}
      const n=this.db.prepare('SELECT count(*) n,coalesce(sum(budget_bytes),0) bytes FROM hub_task_session_workflows').get()!;
      const r:TaskSessionReceipt={intent,fingerprint,creationRequestId:phaseId(intent.owner,intent.requestId,'create'),bindingRequestId:phaseId(intent.owner,intent.requestId,'bind'),state:'prepared',sessionId:null,bindingId:null};
      const payload=JSON.stringify(r);
      // Reserve ample room for final identities; never age-prune unknown receipts.
      const budget=Buffer.byteLength(payload)+8192;
      if(Number(n.n)>=1024||Number(n.bytes)+budget>32*1024*1024)throw Error('workflow-capacity');
      this.db.prepare('INSERT INTO hub_task_session_workflows VALUES(?,?,?,?)').run(intent.owner,intent.requestId,payload,budget);return r;
    },verify);
  }
  claim(owner:string,id:string,phase:'create'|'bind',verify?:()=>void,participate?:(receipt:TaskSessionReceipt)=>void) {
    return this.atomic(check=>{const r=this.required(owner,id),expected=phase==='create'?'prepared':'created';
      if(r.state!==expected)return {claimed:false,receipt:r};
      r.state=phase==='create'?'creation_unknown':'binding_unknown';
      // Trusted in-process participant only. Its SQL and the unknown receipt
      // commit together; no dispatch permission escapes an outer transaction.
      check(participate?.(structuredClone(r)));return {claimed:true,receipt:this.save(r)};
    },verify);
  }
  recordCreation(owner:string,id:string,outcome:{requestId:string;state:'created';sessionId:string}|{requestId:string;state:'rejected'|'unknown'},verify?:()=>void) {
    return this.atomic(()=>{const r=this.required(owner,id);
      if(outcome.requestId!==r.creationRequestId)throw Error('workflow-receipt');
      if(r.sessionId!==null){
        if(outcome.state==='created'&&outcome.sessionId!==r.sessionId)throw Error('workflow-receipt');return r;
      }
      if(r.state!=='creation_unknown')throw Error('workflow-not-dispatched');
      if(outcome.state==='created'){if(!text(outcome.sessionId))throw Error('workflow-receipt');r.sessionId=outcome.sessionId;r.state='created';}
      else if(outcome.state==='rejected')r.state='creation_rejected';
      return this.save(r);
    },verify);
  }
  recordBinding(owner:string,id:string,outcome:{requestId:string;state:'bound';bindingId:string;sessionId:string}|{requestId:string;state:'rejected'|'unknown'},verify?:()=>void) {
    return this.atomic(()=>{const r=this.required(owner,id);
      if(outcome.requestId!==r.bindingRequestId)throw Error('workflow-receipt');
      if(outcome.state==='bound'&&(!text(outcome.bindingId)||outcome.sessionId!==r.sessionId))throw Error('workflow-receipt');
      if(r.state==='bound'){if(outcome.state==='bound'&&outcome.bindingId!==r.bindingId)throw Error('workflow-receipt');return r;}
      if(r.state!=='binding_unknown')throw Error('workflow-not-dispatched');
      if(outcome.state==='bound'){r.bindingId=outcome.bindingId;r.state='bound';}
      else if(outcome.state==='rejected')r.state='binding_rejected';
      return this.save(r);
    },verify);
  }
  cancelPrepared(owner:string,id:string,verify?:()=>void) {return this.atomic(()=>{const r=this.required(owner,id);if(r.state!=='prepared')throw Error('workflow-already-dispatched');r.state='cancelled';return this.save(r);},verify);}
  cancel(owner:string,id:string,verify?:()=>void) { return this.atomic(()=>{
    const r=this.read(owner,id); if(r && !['prepared','cancelled'].includes(r.state))throw Error('workflow-already-dispatched');
    if(!this.db.prepare('SELECT 1 FROM hub_task_session_cancellations WHERE owner=? AND id=?').get(owner,id)) {
      if(Number(this.db.prepare('SELECT count(*) n FROM hub_task_session_cancellations').get()!.n)>=1024)throw Error('workflow-capacity');
      this.db.prepare('INSERT INTO hub_task_session_cancellations VALUES(?,?)').run(owner,id);
    }
    if(!r)return null;r.state='cancelled';return this.save(r);
  },verify); }
}
