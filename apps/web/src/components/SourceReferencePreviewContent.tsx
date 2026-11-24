import { useI18n, translate } from '../lib/i18n';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatMessageMedia, SourceReference } from '@agentopsdeck/shared';
import { apiBaseUrl, recoveryScope, sourcePreviewUrl, sourcePreviewApproval } from '../api';
import { confirmAction } from './ui/confirm';
import { sourcePreviewCache, sourcePreviewCacheKey } from '../lib/source-preview-cache';
import { isMarkdownFile, MarkdownFile } from './MarkdownFile';
import { observeOnceVisible } from '../lib/observe-once';
import { observePreviewRetention } from '../lib/observe-preview-retention';
import { NarrowSourcePreview } from './NarrowSourcePreview';

/** Phrasing elements keep cards valid inside Markdown paragraphs/list items. */
export function SourceReferencePreview(props: {
  reference: SourceReference; media?: ChatMessageMedia | undefined; children: React.ReactNode; className: string;
}) {
  const scope = recoveryScope();
  const key = sourcePreviewCacheKey(window.location.origin, apiBaseUrl(), scope, props.media?.url, props.reference.path, props.reference.line);
  const url = props.media?.url;
  const prewarm = React.useCallback(() => {
    if (!key || !url || scope !== recoveryScope()) return;
    // Own the read only while the trigger is interested. The mounted preview
    // shares this request/cache; leaving or changing scope releases ownership.
    const release = sourcePreviewCache.subscribe(key, () => {});
    void sourcePreviewCache.load(key, signal => sourcePreviewUrl(url, signal));
    return release;
  }, [key, url, scope]);
  return <NarrowSourcePreview path={props.reference.path} line={props.reference.line} prewarm={prewarm}><InlineSourceReferencePreview {...props} /></NarrowSourcePreview>;
}

function InlineSourceReferencePreview({ reference, media, children }: {
  reference: SourceReference; media?: ChatMessageMedia | undefined; children: React.ReactNode; className: string;
}) {
  const { t: tr } = useI18n();
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false), [expanded, setExpanded] = useState(false), [details, setDetails] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [compactCode, setCompactCode] = useState(false);
  const [approving, setApproving] = useState(false), [approvalError, setApprovalError] = useState('');
  const key = sourcePreviewCacheKey(window.location.origin, apiBaseUrl(), recoveryScope(), media?.url, reference.path, reference.line);
  const subscribe = React.useCallback((listener: () => void) => sourcePreviewCache.subscribe(key, listener), [key]);
  const entry = useSyncExternalStore(subscribe, () => sourcePreviewCache.peek(key));
  const preview = entry?.preview;
  const canApprove = !!(entry?.canApprove && media && !media.url.includes('/shared/'));
  // Inline line-number gutters participate in tab stops. Keep tabbed sources
  // detailed rather than changing their horizontal geometry during retention.
  const retainDetails = preview?.text.includes('\t') ?? false;
  const error = entry?.error || (visible && !key ? tr('Preview unavailable · refresh the conversation after updating the Hub and Connector.') : '');
  const [copied, setCopied] = useState<'' | 'Copied' | 'Copy unavailable'>('');
  const copy = (text: string) => {
    if (!navigator.clipboard) { setCopied('Copy unavailable'); return; }
    void navigator.clipboard.writeText(text).then(() => setCopied('Copied'), () => setCopied('Copy unavailable'));
  };
  const approval = async (approve: boolean) => {
    if (!media || !key || approving || (approve && !canApprove)) return;
    const scope = recoveryScope();
    if (!approve && !await confirmAction({ title: tr('Revoke temporary file access?'),
      description: `${reference.path}\n${tr('Only this file in the current session. Access expires in one hour or on restart.')}`,
      confirmLabel: tr('Revoke access') })) return;
    if (scope !== recoveryScope()) return;
    setApproving(true); setApprovalError('');
    try {
      await sourcePreviewApproval(media.url, approve);
      if (scope === recoveryScope()) await sourcePreviewCache.load(key, signal => sourcePreviewUrl(media.url, signal), true);
    } catch (error) { setApprovalError(error instanceof Error ? error.message : tr('Source approval was not confirmed.')); }
    finally { setApproving(false); }
  };
  useEffect(() => {
    if (root.current) return observeOnceVisible(root.current, () => setVisible(true));
  }, []);
  useEffect(() => {
    setCompactCode(false);
    if (root.current && !isMarkdownFile(reference.path) && !retainDetails) return observePreviewRetention(root.current, setCompactCode);
  }, [reference.path, retainDetails]);
  useEffect(() => {
    setCopied(''); setExpanded(false); setDetails(false);
    if (visible && !collapsed && key && media) void sourcePreviewCache.load(key, signal => sourcePreviewUrl(media.url, signal));
    // Shared requests survive an individual card unmount; the API deadline and
    // access invalidation still abort them. Other cards may be awaiting the same read.
  }, [visible, collapsed, key, media?.url, entry === undefined]);
  const lines = preview?.text.split('\n') ?? [];
  const first = preview ? Math.max(0, reference.line - preview.startLine - 3) : 0;
  const shown = expanded ? lines : lines.slice(first, first + 7);
  const raw = preview ? <span className="source-inline-code" tabIndex={0} aria-label={tr("Source code")} data-source-rendering={compactCode ? 'compact' : 'full'}><code className={compactCode ? 'source-inline-plain' : undefined}>{compactCode ? shown.map(line => line || ' ').join('\n') : shown.map((line, i) => {
    const number = preview.startLine + (expanded ? 0 : first) + i;
    return <span className={`source-inline-line${number === reference.line ? ' source-inline-target' : ''}`} data-source-target={number === reference.line || undefined} key={number}>
      <span className="source-inline-number" aria-hidden="true">{number}</span>{line || ' '}
    </span>;
  })}</code></span> : null;
  // Unavailable local references are not broken web links or cached snippets.
  // Keep their identity/actions useful without filling the chat with error panels.
  if (error) return <span ref={root} className="source-reference-unavailable" role="region" aria-label={tr('File reference {path}:{line}', reference)}>
    <span className="source-reference-summary">
      <span className="source-reference-label" title={reference.path}>{children}</span>
      <span className="source-reference-status" role="status">{tr(canApprove ? 'Preview permission required' : 'Preview unavailable')}</span>
      <span className="source-reference-actions">
        {canApprove ? <button type="button" className="source-reference-approve" disabled={approving || entry?.loading} onClick={() => void approval(true)}>{tr(approving ? 'Allowing preview…' : 'Allow preview')}</button> : null}
        <button type="button" aria-expanded={details} onClick={() => setDetails(value => !value)}>{tr(details ? 'Hide details' : 'Details')}</button>
        <button type="button" onClick={() => copy(reference.path)}>{tr(copied || 'Copy path')}</button>
        {media && key && !canApprove ? <button type="button" disabled={approving || entry?.loading} onClick={() => {
          void sourcePreviewCache.load(key, signal => sourcePreviewUrl(media.url, signal), true);
        }}>{tr("Retry")}</button> : null}
      </span>
    </span>
    {canApprove ? <span className="source-reference-grant-note">{tr('Read-only access to this file for up to one hour.')}</span> : null}
    {details ? <span className="source-reference-details">
      <span className="source-reference-file">{reference.path}:{reference.line}</span>
      <span>{translate(error)} {!canApprove ? tr('For generated reports, ask for a download attachment instead of a local file link.') : null}</span>
    </span> : null}
    {approvalError ? <span role="alert">{translate(approvalError)}</span> : null}
  </span>;
  return <span ref={root} className="source-inline-card" role="region" aria-label={tr('Source preview {path}:{line}', reference)}>
    <span className="source-inline-header">
      <span className="source-inline-icon" aria-hidden="true">&lt;/&gt;</span>
      <span className="source-inline-name" title={reference.path}>{reference.path.split(/[\\/]/).at(-1)}<span className="source-inline-location">:{reference.line}</span></span>
      <span className="source-inline-readonly">{tr("READ ONLY")}</span>
      <button type="button" className="source-preview-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? tr("Show preview") : tr("Hide preview")}</button>
    </span>
    {!collapsed ? <>
    <span className="source-inline-path" title={reference.path}>{reference.path}</span>
    {!preview ? <span className="source-inline-notice" role="status">{tr(visible ? 'Loading source…' : 'Source preview')}<span className="source-inline-skeleton" aria-hidden="true" /></span>
      : isMarkdownFile(reference.path) ? <><MarkdownFile key={key} text={preview.text} limited={!expanded} />{preview.startLine > 1 || lines.length < preview.totalLines ? <span className="source-inline-notice">{tr('Document excerpt · lines {start}–{end} of {total}', { start: preview.startLine, end: preview.startLine + lines.length - 1, total: preview.totalLines })}</span> : null}</> : raw}
    <span className="source-inline-footer">
      <span title={preview && !preview.temporaryApproval ? tr('Preview cached in this tab for up to 5 minutes; refresh to read the current Connector file') : undefined}>{children}{preview ? ` · ${tr(preview.temporaryApproval ? 'Temporary file access' : 'cached preview')}` : ''}</span>
      <span className="source-inline-actions">
        {preview?.temporaryApproval && media && !media.url.includes('/shared/') ? <button type="button" disabled={approving} onClick={() => void approval(false)}>{tr('Revoke access')}</button> : null}
        {preview ? <><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{tr(expanded ? 'Collapse' : 'Expand')}</button>
          <button type="button" onClick={() => copy(preview.text)}>{tr(copied || 'Copy')}</button></> : null}
        {media && key ? <button type="button" disabled={entry?.loading} onClick={() => {
          void sourcePreviewCache.load(key, signal => sourcePreviewUrl(media.url, signal), true);
        }}>{tr(entry?.loading ? 'Refreshing…' : 'Refresh source')}</button> : null}
      </span>
    </span>
    {approvalError ? <span role="alert">{translate(approvalError)}</span> : null}
    </> : null}
  </span>;
}
