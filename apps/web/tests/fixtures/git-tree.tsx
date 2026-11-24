import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceGitTree from '../../src/components/WorkspaceGitTree';
import { setRecoveryScope } from '../../src/api';
import { WorkspaceDraftTargets, WorkspaceNotebookTargets } from '../../src/components/WorkspaceDraftTargets';
setRecoveryScope('a'.repeat(64));
function Fixture() {
  const [draft,setDraft]=useState(''),[note,setNote]=useState('');
  return <><button onClick={() => setRecoveryScope('b'.repeat(64))}>Change account</button>
    <textarea aria-label="Fixture draft" value={draft} readOnly/><textarea aria-label="Fixture note" value={note} readOnly/>
    <WorkspaceDraftTargets.Provider value={{targets:[{id:'draft',title:'Draft'}],place:(_,text)=>{if(draft)return 'occupied';setDraft(text);return 'applied';}}}>
      <WorkspaceNotebookTargets.Provider value={{targets:[{id:'note',title:'Note'}],place:(_,text)=>{setNote(text);return 'applied';}}}>
        <WorkspaceGitTree scope={'a'.repeat(64)} cardId="fixture" />
      </WorkspaceNotebookTargets.Provider>
    </WorkspaceDraftTargets.Provider></>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
