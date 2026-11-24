import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import UsageAggregationPanel from '../../src/components/UsageAggregationPanel';
import {setRecoveryScope} from '../../src/api';
import '../../src/styles.css';
const scope='a'.repeat(64);setRecoveryScope(scope);
function App(){const[open,setOpen]=useState(false);return <main style={{maxWidth:800,padding:16,overflowWrap:'anywhere'}}><button onClick={()=>setOpen(!open)}>Toggle usage</button>{open&&<UsageAggregationPanel scope={scope}/>}</main>;}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
