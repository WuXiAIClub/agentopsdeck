import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import NotebookArchive from '../../src/components/NotebookArchive';
import { GlobalNotebookProvider } from '../../src/components/SessionNotebook';
import { api, setRecoveryScope } from '../../src/api';
import { NotebookController } from '../../src/lib/session-notebook';
import { useLayoutUnread } from '../../src/lib/use-layout-unread';
import { presetWorkspace } from '../../src/lib/workspace-layout';
import '../../src/styles.css';
const scope = new URLSearchParams(location.search).get('scope') ?? 'a'.repeat(64); setRecoveryScope(scope);
const sessionKey = `node:${btoa('codex:one')}`;
const workspace = presetWorkspace([{ id: 'one', sessionKey }], 'single');
const hot = new NotebookController({ read: () => api.hubNotebookById('default'), write: v => api.saveHubNotebookById('default', v),
  key: 'fixture-hot', current: () => true, storage: () => sessionStorage });
function App() {
  const state = useSyncExternalStore(hot.subscribe, hot.get), unread = useLayoutUnread(scope, [workspace, workspace]);
  const [active, setActive] = useState(true);
  useEffect(() => { void hot.load(); return () => hot.close(); }, []);
  return <main style={{ padding: 16, maxWidth: 640 }}>
    <div data-workspace-pane data-remote-pane="one" data-active={active} style={{ height: 80 }}>Synthetic active session</div>
    <button onClick={() => setActive(!active)}>Toggle active pane</button>
    <button disabled={unread.busy} onClick={() => void unread.markActive(workspace)}>Mark read</button>
    <output aria-label="Unread">{unread.count(workspace)}</output>
    <output aria-label="Hot text">{state.text}</output>
    <NotebookArchive paused={false} hotController={hot} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<GlobalNotebookProvider><App /></GlobalNotebookProvider>);
