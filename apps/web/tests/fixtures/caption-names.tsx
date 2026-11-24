import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GripVertical, Search, X } from 'lucide-react';
import { CaptionOverflow } from '../../src/components/CaptionOverflow';
import { PaneToolbarScope } from '../../src/components/PaneToolbar';
import { ResourceTitle, ResourceToolbar, ResourceAction } from '../../src/components/ResourceToolbar';
import '../../src/styles.css';

function Card({ kind }: { kind: string }) {
  const [name, setName] = useState('任务与笔记：名称优先完整显示 Long card title');
  return <section data-case={kind} data-resource-card={kind} style={{ width: 'var(--card-width, 800px)', containerType: 'inline-size', containerName: 'sessionpane', marginBottom: 50 }}>
    <PaneToolbarScope>{(tools, status, title) => <>
      <div className="session-pane-caption">
        <button aria-label="Drag pane"><GripVertical size={14} /></button>
        <span className="session-pane-drag-title"><span className="resource-caption-fallback">Fallback</span>{title}</span>
        <CaptionOverflow>{status}{tools}<button className="caption-icon-button" aria-label="Session reference"><Search size={15} /></button><button aria-label="Close pane"><X size={13} /></button></CaptionOverflow>
      </div>
      <ResourceTitle>{kind === 'taskboard' ? <input aria-label="Board name" value={name} onChange={event => setName(event.target.value)} /> : name}</ResourceTitle>
      <ResourceToolbar>{Array.from({ length: 12 }, (_, i) => <ResourceAction key={i} label={`Action ${i}`} priority={i * 10}><Search size={13 + i % 4} /></ResourceAction>)}</ResourceToolbar>
      <button onClick={() => setName('外部更新：这是一段新的卡片标题 Updated title')}>External rename</button>
    </>}</PaneToolbarScope>
  </section>;
}
localStorage.setItem('agentopsdeck.locale', 'en');
createRoot(document.getElementById('root')!).render(<><Card kind="taskboard" /><Card kind="notebook" /></>);
