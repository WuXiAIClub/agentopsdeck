import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SourceReferencePreview } from '../../src/components/SourceReferencePreview';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';

setRecoveryScope('e'.repeat(64));
const path = 'C:\\work\\preview.ts';
const reference = { path, href: `${path}:2`, line: 2 };
const media = { type: 'file' as const, name: 'preview.ts', sourceReference: reference,
  url: `/api/hub/v1/sessions/remote%3Alifecycle/messages/source/media/${'e'.repeat(64)}` };
function Fixture() {
  const [owners, setOwners] = useState([true, true]);
  return <>
    {[0, 1].map(i => <button key={i} id={`owner-${i}`} onClick={() => setOwners(current => current.map((value, index) => index === i ? !value : value))}>Toggle {i}</button>)}
    <input aria-label="Outside draft" />
    <div style={{ display: 'flex', gap: 10 }}>{owners.map((mounted, i) => mounted && <section key={i} data-owner={i} style={{ width: 600 }}>
      <SourceReferencePreview reference={reference} media={media} className="">Source {i}</SourceReferencePreview>
    </section>)}</div>
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
