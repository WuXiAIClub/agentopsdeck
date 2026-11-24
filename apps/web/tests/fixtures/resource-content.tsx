import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionSummary } from '@agentopsdeck/shared';
import { PaneToolbarScope } from '../../src/components/PaneToolbar';
import WorkspaceReport from '../../src/components/WorkspaceReport';
import { WorkspaceDashboard } from '../../src/components/WorkspaceDashboard';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';

const scope = 'a'.repeat(64);
setRecoveryScope(scope);
const sessions: SessionSummary[] = Array.from({ length: 65 }, (_, i) => ({ sessionKey: `s${i}`, title: `Session ${i}`, status: 'idle', agentId: i % 2 ? 'claude' : 'codex' }));
sessions.push({ sessionKey: 'hidden', title: 'Hidden session', status: 'idle', hidden: true });
sessions.push({ sessionKey: 'archived', title: 'Archived session', status: 'idle', archived: true });

function Fixture() {
  const [width, setWidth] = useState(1000), [selected, setSelected] = useState('');
  return <><button onClick={() => setWidth(240)}>Narrow</button><button onClick={() => setWidth(1000)}>Wide</button><output aria-label="Selected session">{selected}</output>
    {['report', 'dashboard'].map(kind => <section key={kind} data-workspace-pane data-resource-card data-pane={kind} style={{ width, maxWidth: '100%', height: 440, display: 'flex', flexDirection: 'column' }}>
      <PaneToolbarScope resource>{(slot, status, title) => <><header className="session-pane-caption"><span className="session-pane-drag-title">{title}</span>{status}{slot}<button aria-label={`Window ${kind}`}>−</button></header>
        <div className="session-pane-content" style={{ flex: 1, minHeight: 0 }}>{kind === 'report' ? <WorkspaceReport scope={scope} resourceId="00000000-0000-4000-8000-000000000001" /> : <WorkspaceDashboard sessions={sessions} onSelect={session => setSelected(session.sessionKey)} />}</div>
      </>}</PaneToolbarScope>
    </section>)}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
