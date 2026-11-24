import { createContext, useContext, useState } from 'react';
import type { BoardTask } from '@agentopsdeck/shared';
import type { SourceTaskOutcome } from '../lib/source-task';
import { useI18n } from '../lib/i18n';
export const SourceTaskTargets=createContext<{targets:{id:string;title:string}[];place:(id:string,task:BoardTask)=>SourceTaskOutcome}>({targets:[],place:()=> 'unavailable'});
export function SourceTaskTransfer({task}:{task:BoardTask}) {
  const {t}=useI18n(),{targets,place}=useContext(SourceTaskTargets);
  const [id,setId]=useState(''),[outcome,setOutcome]=useState<SourceTaskOutcome>();
  const target=targets.find(v=>v.id===id);
  return <section aria-label={t('Import source task')}><label>{t('Target task board')}<select name="sourcetasktransfer-select-1" aria-label={t('Target task board')} value={target?id:''} onChange={e=>{setId(e.target.value);setOutcome(undefined);}}><option value="">{t('Choose an open task board')}</option>{targets.map(v=><option key={v.id} value={v.id}>{v.title}</option>)}</select></label>
    <p>{t('Creates a local task with source identity. Does not edit the remote issue.')}</p>
    <button type="button" disabled={!target||outcome==='applied'||outcome==='exists'} onClick={()=>{if(target)setOutcome(place(target.id,task));}}>{t('Confirm: import local task')}</button>
    {outcome&&<p role="status">{t(outcome==='applied'?'Local task added. Check the board save status.':outcome==='exists'?'This source is already on the board. Existing task preserved.':outcome==='too-large'?'Task board limit reached. Nothing was changed.':'Task board unavailable or has unsaved changes. Save or resolve it first.')}</p>}
  </section>;
}
