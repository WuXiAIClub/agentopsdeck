import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SourceReferencePreview } from '../../src/components/SourceReferencePreview';
import { apiBaseUrl, setRecoveryScope } from '../../src/api';
import { sourcePreviewCache, sourcePreviewCacheKey } from '../../src/lib/source-preview-cache';
import '../../src/styles.css';

const path = '/fixture/retained.ts';
const url = `/api/hub/v1/sessions/remote%3Aretention/messages/code/media/${'d'.repeat(64)}`;
const reference = { path, href: `${path}:118`, line: 118 };
const media = { type: 'file' as const, name: 'retained.ts', url, sourceReference: reference };
const scope = 'd'.repeat(64);
setRecoveryScope(scope);
const preview = { path, line: 118, startLine: 106, totalLines: 200, modifiedAt: 1,
  text: Array.from({ length: 45 }, (_, i) => i === 10 ? '    const longLine = "' + 'wide'.repeat(90) + '";' : i === 11 || i === 44 ? '' : `const retainedLine${106 + i} = ${i};`).join('\n') };
const tabPath = '/fixture/tabbed.ts';
const tabReference = { path: tabPath, href: `${tabPath}:118`, line: 118 };
const tabMedia = { ...media, sourceReference: tabReference };

function Harness() {
  const [count, setCount] = useState(200), [mounted, setMounted] = useState(true), [hidden, setHidden] = useState(false);
  return <>
    <button id="grow" onClick={() => setCount(2000)}>Append to 2000 per pane</button>
    <button id="toggle" onClick={() => setMounted(value => !value)}>Toggle panes</button>
    <button id="hide" onClick={() => setHidden(value => !value)}>Hide second pane</button>
    <input id="outside" aria-label="Outside focus" />
    {mounted && <div style={{ display: 'flex', gap: 20 }}>{[0, 1].map(pane => <div key={pane} className="desktop-session-frame" data-test-pane={pane} style={{ width: 570 }} hidden={hidden && pane === 1}>
      <textarea aria-label={`Draft ${pane}`} defaultValue={`unsent draft ${pane}`} />
      <section className="message-selection-surface" style={{ height: 650, overflow: 'auto' }}>
        {Array.from({ length: count }, (_, i) => <div key={i} data-retained-message={i}>
          <p>History {pane}:{i}</p>
          <SourceReferencePreview reference={reference} media={media} className="">Retained source {pane}:{i}</SourceReferencePreview>
        </div>)}
        <div data-tabbed-preview><SourceReferencePreview reference={tabReference} media={tabMedia} className="">Tabbed source</SourceReferencePreview></div>
      </section>
    </div>)}</div>}
  </>;
}
void Promise.all([
  sourcePreviewCache.load(sourcePreviewCacheKey(location.origin, apiBaseUrl(), scope, url, path, 118)!, async () => preview),
  sourcePreviewCache.load(sourcePreviewCacheKey(location.origin, apiBaseUrl(), scope, url, tabPath, 118)!, async () => ({ ...preview, path: tabPath, text: preview.text.replace('    const longLine', '\tconst longLine') })),
])
  .then(() => createRoot(document.getElementById('root')!).render(<Harness />));
