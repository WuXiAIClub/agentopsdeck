// Production-built layout harness: real workspace/portals, observable synthetic
// controllers. No live Hub, Connector, messages, credentials or business writes.
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { SessionWorkspaceView } from '../../src/components/SessionWorkspaceView';
import { PaneToolbar } from '../../src/components/PaneToolbar';
import { setRecoveryScope } from '../../src/api';
import { currentLayoutKey, layoutSnapshot } from '../../src/lib/current-layout';
import { presetWorkspace } from '../../src/lib/workspace-layout';
import { useI18n } from '../../src/lib/i18n';
import '../../src/styles.css';

const scope = 'e'.repeat(64);
const sessions = ['one', 'two', 'three'].map(id => ({ sessionKey: `remote:${id}`, title: id, source: 'codex', agentId: 'codex', status: 'idle' } as SessionSummary));
const layout = layoutSnapshot(presetWorkspace(sessions.map((session, i) => ({ id: `pane-${i}`, sessionKey: session.sessionKey })), 'left-stack'), new Set());
localStorage.setItem(currentLayoutKey(scope)!, JSON.stringify(layout));
setRecoveryScope(scope);
const stats = { entries: 0, renders: 0, mounts: 0, unmounts: 0 };
Object.assign(window, { layoutStats: stats });
const dismissed = new Set<string>();
const noop = () => {};

function Probe({ session, generation }: { session: SessionSummary; generation: number }) {
  stats.renders++;
  const [draft, setDraft] = useState('');
  const [updates, setUpdates] = useState(0);
  const { locale } = useI18n();
  useEffect(() => { stats.mounts++; return () => { stats.unmounts++; }; }, []);
  return <div data-probe={session.sessionKey} style={{ height: '100%', overflow: 'auto' }}>
    <PaneToolbar><button data-probe-update onClick={() => setUpdates(value => value + 1)}>Local update {updates}</button></PaneToolbar>
    <p data-probe-status>{session.title}:{generation}:{updates}:{locale}</p>
    <textarea aria-label={`Draft ${session.sessionKey}`} value={draft} onChange={event => setDraft(event.target.value)} />
    {Array.from({ length: 200 }, (_, i) => <p key={i} data-probe-row>History {i} <span>retained</span><code>code {i}</code></p>)}
  </div>;
}
function Harness() {
  const [items, setItems] = useState(sessions);
  const [selected, setSelected] = useState(sessions[0]!);
  const [generation, setGeneration] = useState(0);
  const [mounted, setMounted] = useState(true);
  const renderPane = useCallback((session: SessionSummary) => {
    stats.entries++;
    return <Probe session={session} generation={generation} />;
  }, [generation]);
  return <>
    <button id="change-renderer" onClick={() => setGeneration(value => value + 1)}>Change callback</button>
    <button id="toggle-workspace" onClick={() => setMounted(value => !value)}>Toggle workspace</button>
    <button id="change-metadata" onClick={() => {
      const next = { ...items[0]!, title: 'updated' };
      setItems([next, ...items.slice(1)]); setSelected(next);
    }}>Change metadata</button>
    <div style={{ position: 'absolute', inset: '32px 0 0' }}>
      {mounted && <SessionWorkspaceView sessions={items} selected={selected} selectedKey={selected.sessionKey} dismissed={dismissed}
        emptyState={null} onSelect={setSelected} onOpenKeys={noop} renderPane={renderPane} />}
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
