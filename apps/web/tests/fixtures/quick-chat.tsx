import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QuickChatPanel from '../../src/components/QuickChatPanel';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';
setRecoveryScope('a'.repeat(64));
function Fixture() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Open quick question</button>{open && <QuickChatPanel close={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
