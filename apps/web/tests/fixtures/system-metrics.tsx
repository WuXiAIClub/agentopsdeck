import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SystemMetricsPanel from '../../src/components/SystemMetricsPanel';
import { setRecoveryScope } from '../../src/api';
const scope = 'a'.repeat(64); setRecoveryScope(scope);
function App() {
  const [open, setOpen] = useState(false);
  return <main><button onClick={() => setOpen(!open)}>Toggle metrics</button>{open && <SystemMetricsPanel scope={scope} />}</main>;
}
createRoot(document.getElementById('root')!).render(<App />);
