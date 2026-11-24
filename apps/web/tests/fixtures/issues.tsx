import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceIssues from '../../src/components/WorkspaceIssues';
import { setRecoveryScope } from '../../src/api';
import { WorkspaceDraftTargets,WorkspaceNotebookTargets } from '../../src/components/WorkspaceDraftTargets';
import { SourceTaskTargets } from '../../src/components/SourceTaskTransfer';
import { placeSourceTask } from '../../src/lib/source-task';
import WorkspaceTaskboard from '../../src/components/WorkspaceTaskboard';
import '../../src/styles.css';
const scope='a'.repeat(64);
setRecoveryScope('a'.repeat(64));
function Fixture(){
  const host=useRef<HTMLDivElement>(null),[draft,setDraft]=useState(''),[note,setNote]=useState('');
  return <><button onClick={() => setRecoveryScope('b'.repeat(64))}>Change account</button>
    <textarea aria-label="Fixture draft" value={draft} readOnly/><textarea aria-label="Fixture note" value={note} readOnly/>
    <WorkspaceDraftTargets.Provider value={{targets:[{id:'draft',title:'Draft'}],place:(_,text)=>{if(draft)return 'occupied';setDraft(text);return 'applied';}}}>
      <WorkspaceNotebookTargets.Provider value={{targets:[{id:'note',title:'Note'}],place:(_,text)=>{setNote(text);return 'applied';}}}>
        <SourceTaskTargets.Provider value={{targets:[{id:'board',title:'Board'}],place:(_,task)=>host.current?placeSourceTask(host.current,task):'unavailable'}}>
          <WorkspaceIssues scope={scope} cardId="fixture" />
        </SourceTaskTargets.Provider>
      </WorkspaceNotebookTargets.Provider>
    </WorkspaceDraftTargets.Provider>
    <div ref={host}><WorkspaceTaskboard scope={scope} onOpen={()=>{}}/></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
