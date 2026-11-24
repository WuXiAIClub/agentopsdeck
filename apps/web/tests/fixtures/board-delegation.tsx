import { StrictMode,useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceBoardDelegation from '../../src/components/WorkspaceBoardDelegation';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';
const scope = 'a'.repeat(64); setRecoveryScope(scope);
function App() {
  const [open, setOpen] = useState(false);
  return <main style={{ maxWidth: 800, padding: 16 }}><button onClick={() => setOpen(!open)}>Toggle batch</button>{open && <WorkspaceBoardDelegation
    scope={scope} resourceId="default" taskIds={['00000000-0000-4000-8000-000000000001']} detail={false} minutes={15} selectionReady />}</main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
