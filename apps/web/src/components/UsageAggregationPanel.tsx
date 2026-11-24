import {useEffect,useRef,useState} from 'react';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import {api,recoveryScope,type HubConnection} from '../api';
import {useI18n} from '../lib/i18n';
import {parseBindingReceipt} from '../lib/workspace-binding-receipt';
import {validUsageManifest,type UsageManifestView,type UsageTotals} from '../lib/usage-manifest';

/** On-demand, bounded snapshot UI. No background model call or polling; only a
 * UUID is remembered, and reload may only GET that original manifest. */
export default function UsageAggregationPanel({scope}:{scope:string}) {
  const{t,locale}=useI18n(),key=JSON.stringify(['usage-manifest-v1',scope]);
  const[prefs,setPrefs]=useState<WorkspacePreferences>(),[connections,setConnections]=useState<HubConnection[]>([]),[layouts,setLayouts]=useState<{id:string;name:string}[]>([]);
  const[group,setGroup]=useState(''),[tags,setTags]=useState(''),[mode,setMode]=useState<'all'|'any'>('all'),[connection,setConnection]=useState(''),[runtime,setRuntime]=useState(''),[layout,setLayout]=useState(''),[hours,setHours]=useState(24);
  const[pending,setPending]=useState<string|undefined>(()=>{try{return parseBindingReceipt(sessionStorage.getItem(key));}catch{return;}});
  const[manifest,setManifest]=useState<UsageManifestView>(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const controller=useRef<AbortController|undefined>(undefined),lock=useRef(false);
  const valid=(abort:AbortController)=>controller.current===abort&&!abort.signal.aborted&&scope===recoveryScope();
  const accept=(v:UsageManifestView,id:string)=>{if(!validUsageManifest(v,id))throw Error('manifest');setManifest(v);};
  const action=async(a:'inspect'|'confirm'|'continue'|'cancel',id=pending)=>{
    const abort=controller.current;if(!abort||!valid(abort)||lock.current||!id)return;
    lock.current=true;setBusy(true);setError(false);
    try{const r=await api.usageManifest(id,a,abort.signal);if(valid(abort)){
      if(r.manifest)accept(r.manifest,id);
      else if(r.cancelled===true&&r.requestId===id){sessionStorage.removeItem(key);setPending(undefined);setManifest(undefined);}
      else throw Error('Invalid cancellation');
    }}
    catch{if(valid(abort))setError(true);}finally{if(controller.current===abort){lock.current=false;if(valid(abort))setBusy(false);}}
  };
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;lock.current=false;
    void Promise.all([api.workspacePreferences(abort.signal),api.websiteConnections(abort.signal),api.workspaceLayouts('saved',abort.signal)]).then(([p,c,l])=>{
      if(!valid(abort))return;setPrefs(p);setConnections(c.connections.filter(c=>c.status!=='disabled'&&!!c.nodeId));
      const parsed=l.content?JSON.parse(l.content):[];if(!Array.isArray(parsed))throw Error('layouts');
      setLayouts(parsed.filter((v:{id?:unknown;name?:unknown})=>typeof v.id==='string'&&typeof v.name==='string').map((v:{id:string;name:string})=>({id:v.id,name:v.name})));
    }).catch(()=>{if(valid(abort))setError(true);});
    if(pending)void action('inspect',pending);return()=>abort.abort();
  },[scope]);
  const selectedTags=[...new Set(tags.split(',').map(t=>t.trim()).filter(Boolean))];
  const prepare=async()=>{
    const abort=controller.current;if(!abort||!valid(abort)||lock.current||pending||selectedTags.length>8||selectedTags.some(t=>t.length>32))return;
    const id=crypto.randomUUID(),to=Date.now();
    try{sessionStorage.setItem(key,id);setPending(id);}catch{setError(true);return;}
    lock.current=true;setBusy(true);setError(false);
    try{const r=await api.prepareUsageManifest({requestId:id,from:Math.max(0,to-hours*3600000),to,bucketMs:3600000,tags:selectedTags,tagMode:mode,
      ...(group?{groupId:group}:{}),...(connection?{connectionId:connection}:{}),...(runtime?{runtime}:{}),...(layout?{layoutId:layout}:{})},abort.signal);
      if(valid(abort))accept(r.manifest,id);
    }catch{if(valid(abort))setError(true);}finally{if(controller.current===abort){lock.current=false;if(valid(abort))setBusy(false);}}
  };
  const forget=()=>{if(!manifest||!['complete','cancelled'].includes(manifest.state))return;
    try{sessionStorage.removeItem(key);setPending(undefined);setManifest(undefined);setError(false);}catch{setError(true);}};
  const metrics=(value:UsageTotals)=>Object.entries(value.metrics).map(([name,m])=><li key={name}>{name}: {m.knownSubtotal.toLocaleString(locale)} · {t('Unknown samples: {count}',{count:m.unknownSampleCount})}</li>);
  return <section aria-label={t('Usage by group, tag and environment')}>
    <p>{t('Query-time membership, root-agent observations only. Overlapping groups are not additive. Missing usage is not zero; credit estimates are unavailable without verified rules.')}</p>
    {busy&&<p role="status">{t('Working…')}</p>}{error&&<p role="alert">{t('Usage outcome unavailable. Inspect the original request; do not repeat collection.')}</p>}
    {!pending&&<fieldset disabled={busy||!prefs}>
      <label>{t('Group')}<select name="usageaggregationpanel-select-1" value={group} onChange={e=>setGroup(e.target.value)}><option value="">{t('No group filter')}</option>{prefs?.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
      <label>{t('Tags (comma separated)')}<input name="usageaggregationpanel-input-2" value={tags} maxLength={263} onChange={e=>setTags(e.target.value)}/></label>
      <label>{t('Tag matching')}<select name="usageaggregationpanel-select-3" value={mode} onChange={e=>setMode(e.target.value as 'all'|'any')}><option value="all">{t('All selected tags')}</option><option value="any">{t('Any selected tag')}</option></select></label>
      <label>{t('Target environment')}<select name="usageaggregationpanel-select-4" value={connection} onChange={e=>setConnection(e.target.value)}><option value="">{t('All environments')}</option>{connections.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label>{t('Agent runtime')}<select name="usageaggregationpanel-select-5" value={runtime} onChange={e=>setRuntime(e.target.value)}><option value="">{t('All runtimes')}</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="ghcp">GitHub Copilot</option></select></label>
      <label>{t('Layout scope')}<select name="usageaggregationpanel-select-6" value={layout} onChange={e=>setLayout(e.target.value)}><option value="">{t('All layouts')}</option><option value="current">{t('Current layout')}</option>{layouts.filter(l=>l.id!=='current').map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label>{t('Usage range')}<select name="usageaggregationpanel-select-7" value={hours} onChange={e=>setHours(Number(e.target.value))}><option value="1">{t('{count} hours',{count:1})}</option><option value="24">{t('{count} hours',{count:24})}</option><option value="168">{t('{count} days',{count:7})}</option><option value="744">{t('{count} days',{count:31})}</option></select></label>
      <button disabled={selectedTags.length>8||selectedTags.some(t=>t.length>32)} onClick={()=>void prepare()}>{t('Preview usage scope')}</button>
    </fieldset>}
    {pending&&<><p>{t('Original request')}: <code>{pending}</code></p><button disabled={busy} onClick={()=>void action('inspect')}>{t('Inspect usage request')}</button>
      {!manifest&&<button disabled={busy} onClick={()=>void action('cancel')}>{t('Cancel usage preview')}</button>}
      {manifest&&<><p>{t('Frozen members: {count}',{count:manifest.members.length})} · {new Date(manifest.selection.from).toLocaleString(locale)} – {new Date(manifest.selection.to).toLocaleString(locale)}</p>
        <ul>{manifest.members.map(m=><li key={m.requestId}>{m.sessionId} · {m.state==='complete'?t('Snapshot collected'):m.state==='unknown'?t('Outcome unknown'):t('Not collected')}</li>)}</ul>
        {manifest.state==='prepared'&&<><button disabled={busy||Date.now()>=manifest.expiresAt} onClick={()=>void action('confirm')}>{t('Confirm usage collection')}</button><button disabled={busy} onClick={()=>void action('cancel')}>{t('Cancel usage preview')}</button></>}
        {manifest.state==='collecting'&&<p>{t('Incomplete collection: no combined total is available. Recovery only reads original snapshots.')}</p>}
        {manifest.state==='collecting'&&manifest.members.some(m=>m.state==='prepared')&&<button disabled={busy} onClick={()=>void action('continue')}>{t('Collect remaining undispatched members')}</button>}
        {manifest.result&&<><h4>{t('Known token subtotal')}</h4><ul>{metrics(manifest.result.total)}</ul><details><summary>{t('Usage dimensions')}</summary>{manifest.result.groups.map(g=><section key={g.name}><h5>{g.name}</h5><ul>{metrics(g)}</ul></section>)}</details></>}
        {['complete','cancelled'].includes(manifest.state)&&<button disabled={busy} onClick={forget}>{t('Start another usage query')}</button>}
      </>}
    </>}
  </section>;
}
