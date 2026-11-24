import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceFiles from '../../src/components/WorkspaceFiles';
import { MediaLibrary } from '../../src/components/MediaLibrary';
import { WorkspaceFileLinksProvider, FileLinkButton } from '../../src/components/WorkspaceFileLinks';
import { PaneToolbarScope } from '../../src/components/PaneToolbar';
import { CardConnectionsButton } from '../../src/components/CardConnectionsButton';
import WorkspaceBindingLines from '../../src/components/WorkspaceBindingLines';
import { toggleFileLink } from '../../src/lib/workspace-file-links';
import { fileEditorsReady } from '../../src/lib/file-editor-guard';
import { type Pane } from '../../src/lib/workspace-layout';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';
setRecoveryScope('a'.repeat(64));
const initial: Pane[] = ['file-browser', 'file-editor', 'image-viewer'].map((kind, i) => ({ id: `p${i}`, kind, resourceId: `00000000-0000-4000-8000-00000000000${i}` } as Pane));
const caption = new URLSearchParams(location.search).has('caption');
initial.push({ id: 'media', kind: 'media', resourceId: 'library' });
function Fixture() {
  const surface = useRef<HTMLDivElement>(null);
  const [panes, setPanes] = useState(initial), [width, setWidth] = useState(caption ? 1100 : 330), [height, setHeight] = useState(540), [blocked, setBlocked] = useState(false);
  return <>{!caption && <style>{`[data-pane] header:not(.session-pane-caption) { flex-wrap: wrap; } [data-pane] .session-pane-custom-actions { flex-wrap: wrap; max-width: 100%; }`}</style>}<button onClick={() => setWidth(240)}>Narrow</button><button onClick={() => setWidth(420)}>Comfortable</button><button onClick={() => setWidth(1100)}>Wide</button><button onClick={() => setRecoveryScope('b'.repeat(64))}>Change account</button>
    <button onClick={() => { setWidth(240); setHeight(240); }}>Compact</button>
    {blocked && <p>Draft prevented close</p>}
    <WorkspaceFileLinksProvider panes={panes} toggle={(a, b) => setPanes(p => toggleFileLink(p, a, b))}>
      <div ref={surface} style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', gap: 8 }}><WorkspaceBindingLines surface={surface} panes={panes} scope={'a'.repeat(64)}/>{panes.map(pane => <section key={pane.id} data-pane={pane.id} data-workspace-pane data-remote-pane={pane.id} data-resource-card={caption || undefined} style={{ width, height, containerType: 'inline-size', border: '1px solid #999', display: 'flex', flexDirection: 'column' }}>
        <PaneToolbarScope resource={caption}>{(slot, status, title) => <><header className={caption ? 'session-pane-caption' : ''} style={{ display: 'flex' }}><span className="session-pane-drag-title"><span className="resource-caption-fallback">{pane.kind}</span>{title}</span>{status}{slot}<button aria-label={`Close ${pane.id}`} onClick={() => { if (!fileEditorsReady(pane.id)) setBlocked(true); else setPanes(p => p.filter(item => item.id !== pane.id)); }}>×</button></header>
          <FileLinkButton id={pane.id}/><CardConnectionsButton/><div className="session-pane-content" style={{ flex: 1, minHeight: 0 }}>{pane.kind === 'media' ? <MediaLibrary paneId={pane.id}/> : <WorkspaceFiles id={pane.id} kind={pane.kind as 'file-browser' | 'file-editor' | 'image-viewer'}/>}</div></>}</PaneToolbarScope>
      </section>)}</div>
    </WorkspaceFileLinksProvider></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
