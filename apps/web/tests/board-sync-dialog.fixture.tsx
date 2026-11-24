import { StrictMode, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import Dialog from '../src/components/WorkspaceFileCardDialog';
import { setRecoveryScope } from '../src/api';
import '../src/styles.css';

const scope = 'a'.repeat(64);
setRecoveryScope(scope);
localStorage.setItem('agentopsdeck.locale', 'en');
function App() {
  const [open, setOpen] = useState(false);
  const settings = useRef();
  return <><button onClick={() => setOpen(true)}>Open sync</button>
    {open && <Dialog scope={scope} resource='["taskboard","default"]' settings={settings}
      onDocument={() => {}} onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
