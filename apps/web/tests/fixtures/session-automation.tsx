import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SessionAutomationPanel from '../../src/components/SessionAutomationPanel';
import { setRecoveryScope } from '../../src/api';
setRecoveryScope('a'.repeat(64));
function App() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open automation</button>
    {open && <SessionAutomationPanel sessionKey="node:Y29kZXg6Zml4dHVyZQ" close={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
