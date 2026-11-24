import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import WorkspaceSharedContent from '../../src/components/WorkspaceSharedContent';
import {setRecoveryScope} from '../../src/api';
import '../../src/components/resource-cards.css';
const scope='a'.repeat(64);setRecoveryScope(scope);
function App(){
  const [native,setNative]=useState('saved native');
  return <main style={{width:'100%',maxWidth:1000,margin:'auto'}}><WorkspaceSharedContent scope={scope} resource={JSON.stringify(['taskboard','default'])} ready={()=>native==='saved native'}>
    <label>Native editor<input value={native} onChange={e=>setNative(e.target.value)}/></label>
  </WorkspaceSharedContent></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
