import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Users, AlertTriangle, Download, RotateCcw, Trash2, CheckCircle2 } from 'lucide-react';
import { validWorkspaceFileCard, type WorkspaceFileCard, type WorkspacePreferences } from '@agentopsdeck/shared';
import { api, json, recoveryScope, ApiResponseError, AuthRequiredError } from '../api';
import { useI18n } from '../lib/i18n';
import { useFileCardGuard } from '../lib/workspace-file-card-context';
import { pageRefreshGate } from '../lib/page-refresh';
import { sharedReadRecovery } from '../lib/shared-read-recovery';
import { editableSharedCard, sharedDraft, sharedPending, sharedPendingWarning, validSharedHead, validMigrationTermination, validWriteTermination, sharedRecoveryCopy, sharedOverviewSuffix, updateSharedTask, readCachedSharedSnapshot, writeCachedSharedSnapshot,
  type SharedSnapshot, type SharedDraft, type SharedPending } from '../lib/workspace-shared-content';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import './workspace-shared-content.css';

type Batch={id:string;state:'prepared'|'confirmed'|'cancelled';expiresAt:number;members:{id:string;state:string;member:{sessionId:string}}[]};
type Conflict={local:{proposal:{mutationId:string;content:string};baseContent:string};remote:{content:string};actualHash:string|null};
export default function WorkspaceSharedContent({scope,resource,ready,children,sharedView}:{scope:string;resource:string;ready:()=>boolean;children:ReactNode;sharedView?:(card:WorkspaceFileCard,revision:number,enabled:boolean)=>ReactNode}){
  const {t}=useI18n(),root=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(resource)}`;
  const key=JSON.stringify(['shared-content-v1',scope,resource]);
  const [snapshot,setSnapshot]=useState<SharedSnapshot|undefined>(()=>readCachedSharedSnapshot(scope,resource)),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const [readError,setReadError]=useState(false),[noticeOpen,setNoticeOpen]=useState(true);
  const [readDenied,setReadDenied]=useState(false);
  const noticeAnchor=useRef<HTMLButtonElement>(null),[noticePosition,setNoticePosition]=useState({left:12,top:48});
  const [draft,setDraft]=useState<SharedDraft|undefined>(()=>{try{return sharedDraft(sessionStorage.getItem(key+':draft'));}catch{return undefined;}});
  const [pending,setPending]=useState<SharedPending|undefined>(()=>{try{return sharedPending(sessionStorage.getItem(key+':pending'));}catch{return undefined;}});
  const [conflict,setConflict]=useState(false),[jsonMode,setJsonMode]=useState(false);
  const [confirmRecovery,setConfirmRecovery]=useState(false),[recovered,setRecovered]=useState(false);
  const [confirmDiscard,setConfirmDiscard]=useState(false),[copyError,setCopyError]=useState(false);
  const [sessions,setSessions]=useState<{id:string;title:string}[]>([]),[session,setSession]=useState('');
  const [prefs,setPrefs]=useState<WorkspacePreferences>(),[group,setGroup]=useState(''),[tags,setTags]=useState(''),[all,setAll]=useState(true);
  const [batchId,setBatchId]=useState(()=>{try{return sessionStorage.getItem(key+':batch')??'';}catch{return '';}}),[batch,setBatch]=useState<Batch>();
  const [conflicts,setConflicts]=useState<Record<string,Conflict[]>>({});
  const controller=useRef<AbortController|undefined>(undefined),lock=useRef(false),latest=useRef({draft,pending,snapshot});latest.current={draft,pending,snapshot};
  // A pre-write poll may complete after the new head has been saved. Only the
  // current read generation can publish a snapshot.
  const readGeneration=useRef(0);
  const recoveryWake=useRef<(()=>void)|undefined>(undefined);
  const valid=(abort=controller.current)=>!!abort&&!abort.signal.aborted&&controller.current===abort&&recoveryScope()===scope;
  const clean=()=>{const {draft,pending}=latest.current;return !pending&&(!draft||draft.text===draft.base.content);};
  useFileCardGuard(clean);
  useEffect(()=>pageRefreshGate.register(clean),[]);
  const request=<T,>(suffix=sharedOverviewSuffix(resource),method='GET',body?:unknown)=>json<T>(root+suffix,{method,signal:controller.current?.signal??null,
    ...(body===undefined?{}:{body:JSON.stringify(body),headers:{'content-type':'application/json'}})});
  const remember=(value:SharedPending|undefined)=>{if(value)sessionStorage.setItem(key+':pending',JSON.stringify(value));else sessionStorage.removeItem(key+':pending');latest.current.pending=value;setPending(value);};
  const dismissWarning=(dismissed:boolean)=>{if(busy||!valid()||!pending)return;try{remember(sharedPendingWarning(pending,dismissed));setError(false);}catch{setError(true);}};
  const edit=(value:SharedDraft)=>{if(value.text.length>2*1024*1024)throw Error('draft-budget');sessionStorage.setItem(key+':draft',JSON.stringify(value));latest.current.draft=value;setDraft(value);};
  const load=async()=>{
    const abort=controller.current,generation=++readGeneration.current;
    const current=()=>valid(abort)&&readGeneration.current===generation;
    try{const value=await request<SharedSnapshot>();if(!current())return;
      if(value.head&&!validSharedHead(value.head)||!Array.isArray(value.bindings)||typeof value.enabled!=='boolean')throw Error('snapshot');
      if(value.head&&latest.current.snapshot&&!latest.current.snapshot.head&&!ready())throw Error('unsaved-native-draft');
      latest.current.snapshot=value;writeCachedSharedSnapshot(scope,resource,value);setSnapshot(value);
      setReadError(false);setReadDenied(false);
      if(value.head&&!latest.current.pending&&(clean()||latest.current.draft?.text===value.head.content)){const fresh={base:value.head,text:value.head.content};sessionStorage.setItem(key+':draft',JSON.stringify(fresh));latest.current.draft=fresh;setDraft(fresh);}
    }catch(e){if(current()){
      if(e instanceof AuthRequiredError||e instanceof ApiResponseError&&[401,403].includes(e.status)){
        // Retain local drafts/pending intent, but never keep rendering or
        // editing an old authorized snapshot after access is denied.
        latest.current.snapshot=undefined;writeCachedSharedSnapshot(scope,resource,undefined);setSnapshot(undefined);setReadDenied(true);setOpen(false);
      }
      // An absent/failed overview does not prove native ownership. In
      // particular a 404 must not silently unlock the native writer.
      setReadError(true);throw e;
    }}
  };
  useEffect(()=>{const abort=new AbortController();controller.current=abort;lock.current=false;setBusy(false);const cached=readCachedSharedSnapshot(scope,resource);latest.current.snapshot=cached;setSnapshot(cached);
    return()=>{abort.abort();};},[scope,resource]);
  useEffect(()=>{if(!open)return;const abort=controller.current;
    void api.sessionsState().then(s=>{if(valid(abort))setSessions(s.groups.flatMap(g=>g.sessions).filter(s=>!s.archived&&['codex','claude-code','ghcp'].includes(s.sessionRef?.runtimeId??'')).map(s=>({id:s.sessionKey,title:s.title})));}).catch(()=>{});
    void api.workspacePreferences(abort?.signal).then(p=>{if(valid(abort))setPrefs(p);}).catch(()=>{});
  },[open]);
  const run=async(work:()=>Promise<void>)=>{if(lock.current||!valid())return;const abort=controller.current;lock.current=true;++readGeneration.current;setBusy(true);setError(false);
    try{await work();if(valid(abort))await load();}catch{if(valid(abort))setError(true);}finally{if(valid(abort)){lock.current=false;setBusy(false);recoveryWake.current?.();}}};
  // A refresh is only a read: its failures must not become sticky mutation
  // errors, and it must not issue two snapshot GETs through run(load).
  const refresh=async()=>{if(lock.current||!valid())return;const abort=controller.current;lock.current=true;setBusy(true);
    try{await load();if(valid(abort))setError(false);}catch{/* load records the transient read error */}
    finally{if(valid(abort)){lock.current=false;setBusy(false);}}};
  const settle=async(value:{receipt?:{mutationId:string;state?:string;result?:unknown}|null;termination?:unknown;binding?:{id:string;acknowledgedRevision:number;revoked:boolean};proposal?:{proposal:{mutationId:string;bindingId:string}}},intent:SharedPending,preserveDraft=false)=>{
    if(!valid()||latest.current.pending?.id!==intent.id)return;
    if(!value.receipt&&(intent.kind==='migration'&&validMigrationTermination(value.termination,intent.id,resource)||validWriteTermination(value.termination,intent,resource))){
      remember(undefined);setConfirmRecovery(false);setRecovered(true);return;
    }
    if(intent.kind==='binding'&&(!value.binding||value.binding.id!==intent.id||!Number.isSafeInteger(value.binding.acknowledgedRevision)||value.binding.acknowledgedRevision<0||value.binding.revoked)
      ||intent.kind==='resolution'&&(!value.proposal||value.proposal.proposal?.mutationId!==intent.id||value.proposal.proposal.bindingId!==intent.original.split('/')[2])
      ||['migration','write'].includes(intent.kind)&&(!value.receipt||value.receipt.mutationId!==intent.id))throw Error('original-unknown');
    if(intent.kind==='migration'&&!validSharedHead(value.receipt?.result))throw Error('migration-proof');
    if(intent.kind==='write'){
      if(!['committed','conflict'].includes(value.receipt?.state??''))throw Error('receipt');
      if(value.receipt!.state==='conflict')setConflict(true);
      else if(!preserveDraft){sessionStorage.removeItem(key+':draft');setDraft(undefined);latest.current.draft=undefined;setConflict(false);}
    }
    remember(undefined);latest.current.pending=undefined;
    setConfirmRecovery(false);
  };
  // Repeated exact GETs recover lost acknowledgements without replaying saves
  // or automatically fencing an unexecuted request. Reads remain card-local.
  useEffect(()=>{
    const abort=controller.current;
    const recovery=sharedReadRecovery({read:async()=>{
      if(!valid(abort)||lock.current)return;
      const intent=latest.current.pending;
      let originalError:unknown;
      if(intent){
        try{const value=await request<Parameters<typeof settle>[0]>(intent.original);
          if(!valid(abort)||lock.current)return;
          // An absent receipt is unresolved, not a failed read. Keep the lock.
          if(value.receipt||value.termination||value.binding||value.proposal){
            await settle(value,intent,true);if(!latest.current.pending)setError(false);
          }
        }catch(e){originalError=e;if(valid(abort))setError(true);}
      }
      if(valid(abort)&&!lock.current)await load();
      if(originalError)throw originalError;
    }});
    recoveryWake.current=recovery.wake;
    const wake=()=>{if(document.visibilityState!=='hidden')recovery.wake();};
    window.addEventListener('online',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
    return()=>{recovery.stop();recoveryWake.current=undefined;window.removeEventListener('online',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
  },[scope,resource]);
  const mutate=async(kind:SharedPending['kind'],path:string,method:string,body:unknown,original:string,id:string)=>{
    if(pending||!valid())return;const intent={id,kind,original};remember(intent);latest.current.pending=intent;
    const value=await request<Parameters<typeof settle>[0]>(path,method,body);await settle(value,intent);
  };
  const card=draft?editableSharedCard(draft.text):undefined;
  const copy=sharedRecoveryCopy(draft,snapshot);
  const dirty=!!draft&&draft.text!==draft.base.content;
  const canRecover=!!pending&&['migration','write'].includes(pending.kind);
  const downloadCopy=()=>{
    if(!valid()||!copy)return;
    let url:string|undefined;
    try{url=URL.createObjectURL(new Blob([copy.text],{type:'application/json;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download=copy.filename;document.body.append(a);a.click();a.remove();setCopyError(false);
    }catch{setCopyError(true);}finally{if(url)setTimeout(()=>URL.revokeObjectURL(url!),1000);}
  };
  // Neither action clears an unknown request locally. The server serializes
  // termination with the original writer before any local draft is discarded.
  const recover=async(discard:boolean)=>{
    const intent=latest.current.pending;
    if(intent){
      if(!['migration','write'].includes(intent.kind))throw Error('recovery-not-supported');
      const result=await request<Parameters<typeof settle>[0]>(intent.original+'/recover','POST',{});
      await settle(result,intent,true);
      if(!valid()||latest.current.pending)return;
    }
    // Read first. Failed/offline/foreign snapshots must leave the draft intact.
    const fresh=await request<SharedSnapshot>();if(!valid())return;
    if(fresh.head&&!validSharedHead(fresh.head)||!Array.isArray(fresh.bindings)||typeof fresh.enabled!=='boolean'||discard&&!fresh.head)throw Error('discard-snapshot');
    if(fresh.head&&(discard||latest.current.draft?.text===fresh.head.content)){
      edit({base:fresh.head,text:fresh.head.content});setConflict(false);
    }
    latest.current.snapshot=fresh;setSnapshot(fresh);setConfirmDiscard(false);
    setConfirmRecovery(false);
  };
  const change=(card:WorkspaceFileCard)=>{if(draft)try{edit({...draft,text:JSON.stringify(card)});}catch{setError(true);}};
  const label=(id:string)=>sessions.find(s=>s.id===id)?.title??id;
  const batchAction=async(action:'inspect'|'confirm'|'cancel')=>{
    const value=await request<{batch:Batch}>(`/batches/${batchId}${action==='confirm'?'/confirm':''}`,action==='inspect'?'GET':action==='confirm'?'POST':'DELETE');
    if(valid()){if(value.batch?.id!==batchId||!Array.isArray(value.batch.members))throw Error('batch');setBatch(value.batch);}
  };
  const hasNotice=!!pending||readError||error||recovered||confirmDiscard||copyError;
  useEffect(()=>{setNoticeOpen(true);},[pending?.id,readError,error,recovered]);
  useLayoutEffect(()=>{
    if(!hasNotice||!noticeOpen)return;
    const position=()=>{const rect=noticeAnchor.current?.getBoundingClientRect();const width=Math.min(400,window.innerWidth-24);
      setNoticePosition({left:Math.max(12,Math.min(rect?.right?rect.right-width:12,window.innerWidth-width-12)),top:Math.max(12,Math.min((rect?.bottom??36)+8,window.innerHeight-160))});};
    position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
    return()=>{window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);};
  },[hasNotice,noticeOpen]);
  const notice=<>
    {readError&&!pending&&<div className="shared-recovery shared-recovery--error" role="alert"><div className="shared-recovery-heading"><AlertTriangle size={18}/><div><strong>{t('Unable to read the latest version')}</strong><p>{t('Reconnecting automatically. Only this card is refreshed; your draft is kept.')}</p></div></div><div className="shared-recovery-actions"><button className="shared-recovery-primary" disabled={busy} onClick={()=>void refresh()}><RotateCcw size={14}/>{t('Refresh this card')}</button>{copy&&<button onClick={downloadCopy}><Download size={14}/>{t('Download a copy')}</button>}</div></div>}
    {error&&!pending&&!readError&&<div className="shared-recovery" role="alert"><strong>{t('Your local draft is kept. Download a copy or reconnect and try again.')}</strong><div className="shared-recovery-actions"><button disabled={busy} onClick={()=>void refresh()}>{t('Refresh this card')}</button>{copy&&<button onClick={downloadCopy}><Download size={14}/>{t('Download a copy')}</button>}</div></div>}
    {recovered&&<div className="shared-recovery shared-recovery--success" role="status"><CheckCircle2 size={18}/><div><strong>{t('Editing restored')}</strong><p>{t('The original request was not executed and is now fenced. Editing is restored; notebook content was not changed.')}</p></div><button className="shared-recovery-dismiss" aria-label={t('Dismiss notice')} onClick={()=>setRecovered(false)}>×</button></div>}
    {pending&&<section className={`shared-recovery${pending.warningDismissed?' shared-recovery--compact':''}`} aria-label={t('Sync recovery')} aria-busy={busy}>
      <div className="shared-recovery-heading">{!pending.warningDismissed&&<AlertTriangle size={19}/>}<div><strong>{t(pending.warningDismissed?'Original request pending':'Save result needs confirmation')}</strong>{!pending.warningDismissed&&<p>{t('Your content is kept. Choose how to continue without sending the same save again.')}</p>}<p className="shared-recovery-hint">{t('Checking the original result automatically. Saves are never resent.')}</p></div></div>
      <div className="shared-recovery-actions">
        {canRecover&&<button className="shared-recovery-primary" disabled={busy} onClick={()=>{setConfirmDiscard(false);setConfirmRecovery(true);}}><RotateCcw size={15}/>{t('Check original request and restore editing')}</button>}
        {copy&&<button onClick={downloadCopy}><Download size={15}/>{t('Download a copy')}</button>}
        {pending.kind==='write'&&dirty&&<button className="shared-recovery-danger" disabled={busy} onClick={()=>{setConfirmRecovery(false);setConfirmDiscard(true);}}><Trash2 size={15}/>{t('Discard local changes')}</button>}
      </div>
      {copy&&!draft&&<p className="shared-recovery-hint">{t('This copy contains the last read version, not unsaved native editor changes.')}</p>}
      {confirmRecovery&&<section className="shared-recovery-confirm" aria-label={t('Restore editing safely')}>
        <p>{t('The server will recover an existing result, or permanently prevent this unexecuted request from running. Nothing is resent and notebook content is not overwritten.')}</p>
        <div className="shared-recovery-actions"><button className="shared-recovery-primary" disabled={busy} onClick={()=>void run(()=>recover(false))}>{t('Confirm safe recovery')}</button>
        <button disabled={busy} onClick={()=>setConfirmRecovery(false)}>{t('Cancel')}</button></div>
      </section>}
      {error&&<p className="shared-recovery-error" role="alert">{t('Original result is still unavailable. The request record has been kept; nothing was resent.')}</p>}
      <details className="shared-request-record">
      <summary>{t('Request details')}</summary>
      <p role="status">{t('Original request pending')}</p>
      <p>{t('Hide only the warning. The request stays unconfirmed; shared changes remain locked. Nothing is resent or marked successful.')}</p>
      <code>{pending.id}</code>
      <div className="shared-recovery-actions"><button disabled={busy} onClick={()=>void run(async()=>settle(await request(pending.original),pending,true))}>{t('Inspect original request')}</button>
      <button disabled={busy} onClick={()=>dismissWarning(!pending.warningDismissed)}>{t(pending.warningDismissed?'Show warning again':'Hide warning and keep request')}</button></div>
      </details>
    </section>}
    {copyError&&<p className="shared-recovery-error" role="alert">{t('Download could not start. Your local content has not been discarded.')}</p>}
    {confirmDiscard&&<section className="shared-recovery shared-recovery-confirm" aria-label={t('Discard local changes?')}>
      <strong>{t('Discard local changes?')}</strong><p>{t('Download a copy first if you need it. After checking any pending save, this replaces only your local draft with the latest server version. Already saved changes are not rolled back.')}</p>
      <div className="shared-recovery-actions">{copy&&<button onClick={downloadCopy}><Download size={14}/>{t('Download a copy')}</button>}<button className="shared-recovery-danger" disabled={busy} onClick={()=>void run(()=>recover(true))}>{t('Confirm discard')}</button><button disabled={busy} onClick={()=>setConfirmDiscard(false)}>{t('Cancel')}</button></div>
    </section>}
  </>;
  return <>
    {(snapshot?.enabled||hasNotice)&&<ResourceToolbar>{snapshot?.enabled&&<ResourceAction label={t('Shared card access')} onClick={()=>setOpen(v=>!v)}><Users size={15}/></ResourceAction>}{hasNotice&&<button ref={noticeAnchor} type="button" className="shared-recovery-trigger" aria-label={t('Sync recovery')} aria-expanded={noticeOpen} onClick={()=>setNoticeOpen(v=>!v)}><AlertTriangle size={15}/><span>{t('Sync recovery')}</span></button>}</ResourceToolbar>}
    {hasNotice&&noticeOpen&&createPortal(<aside className="shared-recovery-popover" style={{...noticePosition,maxHeight:`calc(100dvh - ${noticePosition.top+12}px)`}} aria-label={t('Card sync status')}><header><strong>{t('Card sync status')}</strong><button type="button" aria-label={t('Close sync status')} onClick={()=>setNoticeOpen(false)}>×</button></header>{notice}</aside>,document.body)}
    {!snapshot?<section className="shared-content-editor" aria-label={t('Card sync status')}>
      <p role="status">{t(readDenied?'Card access needs verification':readError?'Unable to read the latest version':'Loading…')}</p>
      {readError&&<><p>{t('Reconnecting automatically. Only this card is refreshed; your draft is kept.')}</p>
        <button disabled={busy} onClick={()=>void refresh()}><RotateCcw size={14}/>{t('Refresh this card')}</button>
        {copy&&<button onClick={downloadCopy}><Download size={14}/>{t('Download a copy')}</button>}</>}
      {readError&&!readDenied&&draft&&<label>{t('Local draft — read-only until verification')}<textarea name="workspacesharedcontent-textarea-1" readOnly value={draft.text}/></label>}
    </section>:!snapshot.head?children:<section className="shared-content-editor" aria-label={t('Shared card editor')}>
      <ResourceTitle>{card?.content.title??t('Shared card editor')}</ResourceTitle>
      <p>{t('Shared revision')}: {snapshot.head.revision} · {t('Cold archive stays private. Service configuration never starts a session or service.')}</p>
      {draft&&<><fieldset disabled={busy||!!pending}>
        {card&&!jsonMode?<>
          <label>{t('Title')}<input name="workspacesharedcontent-input-2" value={card.content.title} maxLength={120} onChange={e=>change({...card,content:{...card.content,title:e.target.value}} as WorkspaceFileCard)}/></label>
          {(card.kind==='notebook'||card.kind==='report')?<label>{t('Text')}<textarea name="workspacesharedcontent-textarea-3" aria-label={t('Text')} className="shared-note-text" value={card.content.text} maxLength={50000} onChange={e=>change({...card,content:{...card.content,text:e.target.value}})}/><small>{card.content.text.length}/50000</small></label>:
          (card.kind==='taskboard'||card.kind==='statuscard')?<><div className="shared-task-list">{card.content.tasks.map(task=><div key={task.id} className="shared-task">
            <input name="workspacesharedcontent-input-4" aria-label={t('Task title')} value={task.title} maxLength={240} onChange={e=>change(updateSharedTask(card,task.id,{title:e.target.value}))}/>
            <select name="workspacesharedcontent-select-5" aria-label={t('Status')} value={task.status} onChange={e=>change(updateSharedTask(card,task.id,{status:e.target.value}))}>{(['todo','doing','done'] as const).map(s=><option key={s} value={s}>{t(s==='todo'?'To do':s==='doing'?'In progress':'Done')}</option>)}</select>
            <textarea name="workspacesharedcontent-textarea-6" aria-label={t('Details')} value={task.detail} maxLength={4000} onChange={e=>change(updateSharedTask(card,task.id,{detail:e.target.value}))}/>
          </div>)}</div><button disabled={card.content.tasks.length>=200} onClick={()=>change({...card,content:{...card.content,tasks:[...card.content.tasks,{id:crypto.randomUUID(),title:t('New task'),detail:'',status:'todo'}]}})}>{t('Add task')}</button></>:
          <textarea name="workspacesharedcontent-textarea-7" aria-label={t('Card configuration JSON')} value={draft.text} onChange={e=>{try{edit({...draft,text:e.target.value});}catch{setError(true);}}}/>}
        </>:<textarea name="workspacesharedcontent-textarea-8" aria-label={t('Card configuration JSON')} value={draft.text} onChange={e=>{try{edit({...draft,text:e.target.value});}catch{setError(true);}}}/>}
        <button onClick={()=>setJsonMode(v=>!v)}>{t('Toggle structured editor')}</button>
        <button disabled={!card||!validWorkspaceFileCard(card)||draft.text===draft.base.content||!snapshot.enabled||conflict} onClick={()=>void run(async()=>{
          const id=crypto.randomUUID(),base=draft.base;await mutate('write','/document','PUT',{mutationId:id,modeEpoch:base.epoch,baseRevision:base.revision,baseHash:base.hash,content:draft.text},`/writes/${base.epoch}/${id}`,id);
        })}>{t('Save')}</button>
      </fieldset>
      {!pending&&<div className="shared-recovery-actions">{copy&&<button onClick={downloadCopy}><Download size={14}/>{t('Download a copy')}</button>}{dirty&&<button className="shared-recovery-danger" disabled={busy} onClick={()=>{setNoticeOpen(true);setConfirmRecovery(false);setConfirmDiscard(true);}}><Trash2 size={14}/>{t('Discard local changes')}</button>}</div>}
      {(conflict||draft.base.hash!==snapshot.head.hash)&&<section aria-label={t('Content conflict')}><p>{t('Content changed. Compare all versions before explicitly rebasing your draft.')}</p>
        <div className="shared-conflict"><pre>{draft.base.content}</pre><pre>{draft.text}</pre><pre>{snapshot.head.content}</pre></div>
        <button disabled={busy||!!pending} onClick={()=>{try{edit({base:snapshot.head!,text:draft.text});setConflict(false);}catch{setError(true);}}}>{t('Keep draft with current base')}</button></section>}
      </>}
    </section>}
    {snapshot?.head&&sharedView&&editableSharedCard(snapshot.head.content)&&sharedView(editableSharedCard(snapshot.head.content)!,snapshot.head.revision,snapshot.enabled)}
    {open&&snapshot&&<section className="shared-content-access" aria-label={t('Shared card access')}>
      <p>{t('Full card access includes editing its hot content. Preview freezes group and tag members; new members are never added automatically.')}</p>
      {!snapshot.head?<><p>{t('Enable shared mode only after saving native edits and revoking old file bindings. This migration is one-way; cold archive is excluded.')}</p><button disabled={busy||!!pending||!snapshot.native||!snapshot.enabled} onClick={()=>void run(async()=>{
        if(!ready()||!snapshot.native)throw Error('native-dirty');const id=crypto.randomUUID();await mutate('migration','/migrate','POST',{requestId:id,revision:snapshot.native.revision},`/migrations/${id}`,id);
      })}>{t('Enable shared content')}</button></>:<>
        <fieldset disabled={busy||!!pending||!snapshot.enabled}><label>{t('Session')}<select name="workspacesharedcontent-select-9" value={session} onChange={e=>setSession(e.target.value)}><option value="">{t('Select session')}</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
          <button disabled={!session} onClick={()=>void run(async()=>{const id=crypto.randomUUID();await mutate('binding',`/bindings/${id}`,'PUT',{sessionId:session,epoch:snapshot.head!.epoch,revision:snapshot.head!.revision},`/bindings/${id}`,id);})}>{t('Grant full card access')}</button>
        </fieldset>
        <ul>{snapshot.bindings.map(b=><li key={b.id}>{label(b.target?.sessionId??b.id)} · {b.revoked?t('Revoked'):b.acknowledgedRevision<0?t('Binding outcome unconfirmed'):`r${b.acknowledgedRevision}`}
          {!b.revoked&&<><button disabled={busy} onClick={()=>void run(async()=>{await request(`/bindings/${b.id}/sync`,'POST');})}>{t('Sync now')}</button>
            <button disabled={busy} onClick={()=>void run(async()=>{await request(`/bindings/${b.id}`,'DELETE');})}>{t('Revoke')}</button>
            <button disabled={busy} onClick={()=>void run(async()=>{const result=await request<{conflicts:Conflict[]}>(`/bindings/${b.id}/conflicts`);if(valid())setConflicts(v=>({...v,[b.id]:result.conflicts}));})}>{t('Inspect conflicts')}</button></>}
          {conflicts[b.id]?.map(c=><section key={c.local.proposal.mutationId}><div className="shared-conflict"><pre>{c.local.baseContent}</pre><pre>{c.local.proposal.content}</pre><pre>{c.remote.content}</pre></div>
            <button disabled={busy||!!pending||!c.actualHash||b.revoked} onClick={()=>void run(async()=>{const id=crypto.randomUUID();await mutate('resolution',`/bindings/${b.id}/resolve`,'POST',{conflictId:c.local.proposal.mutationId,mutationId:id,expectedHash:c.actualHash},`/bindings/${b.id}/proposals/${id}`,id);if(valid())setConflicts(v=>({...v,[b.id]:[]}));})}>{t('Propose current session file against this version')}</button></section>)}
        </li>)}</ul>
        <h3>{t('Grant by group or tags')}</h3>
        {!batchId?<fieldset disabled={busy||!!pending||!snapshot.enabled}>
          <label>{t('Group')}<select name="workspacesharedcontent-select-10" value={group} onChange={e=>setGroup(e.target.value)}><option value="">{t('No group filter')}</option>{prefs?.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label>{t('Tags (comma-separated)')}<input name="workspacesharedcontent-input-11" value={tags} onChange={e=>setTags(e.target.value)}/></label>
          <label><input name="workspacesharedcontent-input-12" type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>{t('Match all tags')}</label>
          <button disabled={!group&&!tags.trim()} onClick={()=>void run(async()=>{const id=crypto.randomUUID();sessionStorage.setItem(key+':batch',id);setBatchId(id);
            const value=await request<{batch:Batch}>(`/batches/${id}`,'PUT',{selection:{...(group?{groupId:group}:{}),tags:[...new Set(tags.split(',').map(t=>t.trim()).filter(Boolean))],tagMode:all?'all':'any'}});
            if(valid()){if(value.batch?.id!==id)throw Error('batch');setBatch(value.batch);}
          })}>{t('Preview full card grant')}</button>
        </fieldset>:<><code>{batchId}</code><button disabled={busy} onClick={()=>void run(()=>batchAction('inspect'))}>{t('Inspect batch')}</button>
          <button disabled={busy} onClick={()=>void run(()=>batchAction('cancel'))}>{t('Revoke batch and clean up')}</button>
          {batch&&<><ul>{batch.members.map(m=><li key={m.id}>{label(m.member.sessionId)} · {m.state}</li>)}</ul>
            {batch.state==='prepared'&&<button disabled={busy||!!pending||Date.now()>=batch.expiresAt} onClick={()=>void run(()=>batchAction('confirm'))}>{t('Confirm frozen batch')}</button>}
            {batch.state==='cancelled'&&batch.members.every(m=>m.state==='cancelled')&&<button disabled={busy} onClick={()=>{try{sessionStorage.removeItem(key+':batch');setBatchId('');setBatch(undefined);}catch{setError(true);}}}>{t('Start another batch')}</button>}</>}
        </>}
      </>}
    </section>}
  </>;
}
