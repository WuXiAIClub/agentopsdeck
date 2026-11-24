import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SessionGuidancePanel from '../../src/components/SessionGuidancePanel';
import { setRecoveryScope } from '../../src/api';
setRecoveryScope('a'.repeat(64));
function App() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open guidance</button><button onClick={() => setRecoveryScope('b'.repeat(64))}>Change account</button>
    {open && <SessionGuidancePanel sessionKey="codex:fixture" close={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
