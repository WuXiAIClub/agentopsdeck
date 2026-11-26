import { useEffect, useRef, useState } from 'react';
import { api, recoveryScope, type HubConnection } from '../api';
import { useI18n } from '../lib/i18n';
import { parseBindingReceipt } from '../lib/workspace-binding-receipt';
import { validTaskSessionReceipt, type TaskSessionReceipt } from '../lib/workspace-task-session';

/** On-demand panel. Only an opaque request UUID is remembered; reopening reads
 * the original receipt. Creating a session never sends a prompt or auto-binds. */
export default function WorkspaceTaskSession({scope,resourceId,taskIds,detail,minutes,selectionReady}:{
  scope:string;resourceId:string;taskIds:string[];detail:boolean;minutes:number;selectionReady:boolean;
}) {
  const {t}=useI18n(),key=JSON.stringify(['task-session-v1',scope,resourceId]);
  const controller=useRef<AbortController|undefined>(undefined),lock=useRef(false);
  const [connections,setConnections]=useState<HubConnection[]>([]),[connection,setConnection]=useState(''),[runtime,setRuntime]=useState('codex'),[title,setTitle]=useState('');
  const [pending,setPending]=useState<string|undefined>(()=>{try{return parseBindingReceipt(sessionStorage.getItem(key));}catch{return;}});
  const [receipt,setReceipt]=useState<TaskSessionReceipt>(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const [models,setModels]=useState<Array<{id:string;label:string}>>([]),[model,setModel]=useState('');
  const current=(abort:AbortController)=>controller.current===abort&&!abort.signal.aborted&&scope===recoveryScope();
  const accept=(r:TaskSessionReceipt,id:string)=>{if(!validTaskSessionReceipt(r,id,resourceId))throw Error('Invalid receipt');setReceipt(r);};
  const remember=(id?:string)=>{try{if(id)sessionStorage.setItem(key,id);else sessionStorage.removeItem(key);setPending(id);return true;}catch{setError(true);return false;}};
  const action=async(a:'inspect'|'create'|'bind'|'cancel',id=pending)=>{
    const abort=controller.current;if(!abort||!current(abort)||lock.current||!id)return;
    lock.current=true;setBusy(true);setError(false);
    try{const result=await api.taskSession(resourceId,id,a,abort.signal);if(!current(abort))return;
      if(result.receipt)accept(result.receipt,id);
      else if(a==='cancel'&&result.cancelled===true&&result.requestId===id){remember();setReceipt(undefined);}
      else throw Error('Missing receipt');
    }catch{if(current(abort))setError(true);}finally{if(controller.current===abort){lock.current=false;if(current(abort))setBusy(false);}}
  };
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;lock.current=false;
    void api.websiteConnections(abort.signal).then(r=>{if(current(abort))setConnections(r.connections.filter(c=>c.status!=='disabled'&&!!c.nodeId));}).catch(()=>{if(current(abort))setError(true);});
    if(pending)void action('inspect',pending);
    return()=>abort.abort();
  },[scope,resourceId]);
  useEffect(()=>{
    const abort=new AbortController();setModels([]);setModel('');
    if(connection&&!pending)void api.runtimeModels(connection,runtime,abort.signal).then(result=>{
      if(abort.signal.aborted||scope!==recoveryScope())return;
      if(!Array.isArray(result.models)||result.models.length>512||result.models.some(m=>!m||typeof m.id!=='string'||!m.id.trim()||m.id!==m.id.trim()||m.id.length>256||/[\x00-\x1f\x7f]/.test(m.id)||typeof m.label!=='string'||m.label.length>512))throw Error('Invalid model catalog');
      setModels(result.models);
    }).catch(()=>{if(!abort.signal.aborted&&scope===recoveryScope())setError(true);});
    return()=>abort.abort();
  },[scope,connection,runtime,pending]);
  const prepare=async()=>{
    const abort=controller.current;if(!abort||!current(abort)||lock.current||pending||!selectionReady||!taskIds.length||taskIds.length>32||!connection||!title.trim()||!models.some(m=>m.id===model))return;
    const id=crypto.randomUUID();if(!remember(id))return;lock.current=true;setBusy(true);setError(false);
    try{const r=await api.prepareTaskSession(resourceId,{requestId:id,connectionId:connection,runtime,title:title.trim(),model,taskIds:[...taskIds],fields:detail?['status','detail']:['status'],expiresAt:Date.now()+minutes*60000},abort.signal);
      if(current(abort))accept(r.receipt,id);
    }catch{if(current(abort))setError(true);}finally{if(controller.current===abort){lock.current=false;if(current(abort))setBusy(false);}}
  };
  return <section aria-label={t('Create session for selected tasks')}>
    <p>{t('Preview the frozen tasks, create once, then confirm binding separately. No message is sent. A failed binding keeps the created session.')}</p>
    {error&&<p role="alert">{t('Task session outcome unavailable. Inspect the original request; do not create another session.')}</p>}
    {busy&&<p role="status">{t('Working…')}</p>}
    {!pending&&<fieldset disabled={busy||!selectionReady}>
      <label>{t('Target environment')}<select name="workspacetasksession-select-1" value={connection} onChange={e=>setConnection(e.target.value)}><option value="">{t('Choose environment')}</option>{connections.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label>{t('Agent runtime')}<select name="workspacetasksession-select-2" value={runtime} onChange={e=>setRuntime(e.target.value)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="ghcp">GitHub Copilot</option><option value="antigravity">Antigravity</option></select></label>
      <label>{t('Model')}<select name="workspacetasksession-select-3" value={model} onChange={e=>setModel(e.target.value)}><option value="">—</option>{models.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <label>{t('New session title')}<input name="workspacetasksession-input-4" value={title} maxLength={120} onChange={e=>setTitle(e.target.value)}/></label>
      <p>{t('Selected tasks: {count}',{count:taskIds.length})}</p>
      <button type="button" disabled={!connection||!model||!title.trim()||!taskIds.length||taskIds.length>32} onClick={()=>void prepare()}>{t('Preview task session')}</button>
    </fieldset>}
    {pending&&<><p>{t('Original request')}: <code>{pending}</code></p><button type="button" disabled={busy} onClick={()=>void action('inspect')}>{t('Inspect task session')}</button>
      {(!receipt||receipt.state==='prepared')&&<button type="button" disabled={busy} onClick={()=>void action('cancel')}>{t('Cancel before creation')}</button>}
      {receipt&&<><p>{receipt.intent.title} · {t(states[receipt.state])}</p>
        <p>{t('Frozen task selection')}: {receipt.intent.tasks.map(t=>t.title).join(' · ')}</p>
        <p>{t('Agent runtime')}: {receipt.intent.runtime} · {t('Model')}: {receipt.intent.model??'—'}</p>
        <p>{receipt.intent.fields.includes('detail')?t('Status and details'):t('Status only')} · {t('Expires at')} {new Date(receipt.intent.expiresAt).toLocaleString()}</p>
        {receipt.sessionId&&<p>{t('Created session')}: <code>{receipt.sessionId}</code></p>}
        {receipt.state==='prepared'&&<button type="button" disabled={busy||Date.now()>=receipt.intent.expiresAt} onClick={()=>void action('create')}>{t('Confirm session creation')}</button>}
        {receipt.state==='created'&&<button type="button" disabled={busy||Date.now()>=receipt.intent.expiresAt} onClick={()=>void action('bind')}>{t('Confirm selected task binding')}</button>}
        {['bound','cancelled','creation_rejected','binding_rejected'].includes(receipt.state)&&<button type="button" disabled={busy} onClick={()=>{if(remember()){setReceipt(undefined);setError(false);}}}>{t('Start another task session')}</button>}
      </>}
    </>}
  </section>;
}
const states={prepared:'Prepared, not created',creation_unknown:'Creation outcome unconfirmed',creation_rejected:'Creation rejected',created:'Created, not bound',binding_unknown:'Binding outcome unconfirmed',binding_rejected:'Binding unavailable',bound:'Session bound',cancelled:'Cancelled'} as const;
