import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SavedLayouts } from '../../src/components/SavedLayouts';
import { setRecoveryScope } from '../../src/api';
import { presetWorkspace } from '../../src/lib/workspace-layout';
import { savedLayoutKey, type SavedLayout } from '../../src/lib/saved-layouts';
import '../../src/styles.css';
const scope = 'a'.repeat(64); setRecoveryScope(scope);
const a = presetWorkspace([{ id: 'one', sessionKey: 'one' }, { id: 'two', sessionKey: 'two' }], 'columns');
const b = presetWorkspace([{ id: 'one', sessionKey: 'one' }, { id: 'two', sessionKey: 'two' }], 'rows');
const items: SavedLayout[] = [{ id: 'a', name: 'Laptop', workspace: a, collapsedKeys: [] }, { id: 'b', name: 'External', workspace: b, collapsedKeys: [] }];
const key = savedLayoutKey(scope)!;
if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(items));
localStorage.setItem(`${key}:selected`, 'a');
function Fixture() {
  const [workspace, setWorkspace] = useState(a), [host, setHost] = useState<HTMLDivElement | null>(null), [restored, setRestored] = useState('a'), [count, setCount] = useState(0), [blocked, setBlocked] = useState(false);
  return <main style={{ padding: 20 }}><div ref={setHost}/><SavedLayouts workspace={workspace} collapsedKeys={new Set()} quickSwitchHost={host} onRestore={saved => { if (blocked) return false; setWorkspace(saved.workspace); setRestored(saved.id); setCount(n => n + 1); return true; }}/>
    <output data-testid="restored">{restored}</output><output data-testid="count">{count}</output>
    <button onClick={() => setWorkspace({ ...workspace, floating: [{ id: 'one', x: .1, y: .1, width: .4, height: .4 }] })}>Dirty layout</button>
    <button onClick={() => setBlocked(v => !v)}>File draft guard</button>
    <button onClick={() => setRecoveryScope('b'.repeat(64))}>Change account</button>
    <textarea aria-label="Notebook draft" defaultValue="Keep this draft"/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
