import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceFileCardScope from '../../src/components/WorkspaceFileCardScope';
import { GlobalNotebookProvider } from '../../src/components/SessionNotebook';
import { useFileCardSettings } from '../../src/lib/workspace-file-card-context';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';
const scope='a'.repeat(64);setRecoveryScope(scope);
const notebook=new URLSearchParams(location.search).get('kind')==='notebook';
function Service(){
  const [url,setUrl]=useState('https://example.invalid/original');
  useFileCardSettings('browser',{title:'Browser',url},value=>setUrl(value.url));
  return <section aria-label="Native service"><output aria-label="Service address">{url}</output><button onClick={()=>setUrl('manually used')}>Use native service</button></section>;
}
function App(){
  return <main className="session-pane-content" style={{width:'100%',maxWidth:1000,margin:'auto',height:700,flex:'none'}}><WorkspaceFileCardScope scope={scope}
    pane={notebook?{id:'fixture-note',kind:'notebook',target:'hub',resourceId:'default'}:{id:'fixture-service',kind:'browser',resourceId:'default'}}>
    {notebook?<p>Native note</p>:<Service/>}
  </WorkspaceFileCardScope></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><GlobalNotebookProvider><App/></GlobalNotebookProvider></StrictMode>);
