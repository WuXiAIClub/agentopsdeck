import { lazy, Suspense, type ReactNode } from 'react';
import type { ChatMessageMedia, SourceReference } from '@agentopsdeck/shared';
const Content = lazy(() => import('./SourceReferencePreviewContent').then(module => ({ default: module.SourceReferencePreview })));
/** Load source rendering only when a message actually contains a reference.
 * Keep a phrasing fallback so Markdown paragraphs remain valid while loading. */
export function SourceReferencePreview(props: {
  reference: SourceReference; media?: ChatMessageMedia | undefined; children: ReactNode; className: string;
}) {
  return <Suspense fallback={<span className={props.className}>{props.children}</span>}><Content {...props} /></Suspense>;
}
