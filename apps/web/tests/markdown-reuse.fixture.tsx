import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { setRecoveryScope } from '../src/api';
// Export injected only by markdown-reuse.browser.mjs.
// @ts-expect-error test-only export
import { markdownReuseSubject as Subject } from '../src/components/messages';

const probe = window as any;
setRecoveryScope('a'.repeat(64));
const root = createRoot(document.getElementById('root')!);
probe.renderMarkdown = (rows: any[]) => flushSync(() => root.render(<>{rows.map(row =>
  <section key={row.id} data-probe={row.id}><Subject {...row} /></section>)}</>));
probe.unmountMarkdown = () => flushSync(() => root.unmount());
probe.markdownReady = true;
