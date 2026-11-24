import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Search } from 'lucide-react';
import type { WebsiteSnapshot } from '@agentopsdeck/shared';
import { recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { READER_PAGE_LINES, READER_QUERY_LENGTH, websiteCitation, websiteReadingLines, websiteReadingMatches, websiteReadingText, websiteSnapshotDigest } from '../lib/website-reader';

/** Mounted only for explicit reading mode; no network, storage or timers. The
 * parent keys this by account/resource/snapshot request to discard old excerpts. */
export default function WorkspaceWebsiteReader({ snapshot, connectionId, scope }: { snapshot: WebsiteSnapshot; connectionId: string; scope: string }) {
  const { t } = useI18n();
  const lines = useMemo(() => websiteReadingLines(websiteReadingText(snapshot, document)), [snapshot]);
  const [page, setPage] = useState(0), [query, setQuery] = useState(''), [match, setMatch] = useState(0);
  const [selection, setSelection] = useState<[number, number]>(), [digest, setDigest] = useState<string>();
  const [digestReady, setDigestReady] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'ok' | 'error'>('idle');
  const mounted = useRef(false), body = useRef<HTMLDivElement>(null), copyEpoch = useRef(0);
  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(() => websiteReadingMatches(lines, deferredQuery), [lines, deferredQuery]);
  const total = Math.max(1, Math.ceil(lines.length / READER_PAGE_LINES));
  const first = selection ? Math.min(...selection) : -1, last = selection ? Math.max(...selection) : -1;
  const citation = useMemo(() => {
    if (!selection) return '';
    try { return JSON.stringify(websiteCitation(snapshot, connectionId, lines, first, last, digest), null, 2); }
    catch { return ''; }
  }, [snapshot, connectionId, lines, first, last, selection, digest]);
  useEffect(() => {
    mounted.current = true;
    void websiteSnapshotDigest(snapshot).then(value => { if (mounted.current && recoveryScope() === scope) { setDigest(value); setDigestReady(true); } });
    return () => { mounted.current = false; copyEpoch.current++; };
  }, [snapshot, scope]);
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [page]);
  useEffect(() => {
    setMatch(0);
    if (matches.length) setPage(Math.floor(matches[0]! / READER_PAGE_LINES));
  }, [matches]);
  useEffect(() => {
    const container = body.current;
    const line = container?.querySelector<HTMLElement>(`[data-reading-line="${matches[match]}"]`);
    if (container && line) container.scrollTo({ top: container.scrollTop + line.getBoundingClientRect().top - container.getBoundingClientRect().top });
  }, [page, matches, match]);
  const clearCopy = () => { copyEpoch.current++; setCopy('idle'); };
  const changePage = (next: number) => { setPage(next); setSelection(undefined); clearCopy(); };
  const chooseMatch = (next: number) => { setMatch(next); changePage(Math.floor(matches[next]! / READER_PAGE_LINES)); };
  const copyCitation = async () => {
    if (!citation || recoveryScope() !== scope) return;
    const epoch = ++copyEpoch.current;
    try {
      await navigator.clipboard.writeText(citation);
      if (mounted.current && recoveryScope() === scope && copyEpoch.current === epoch) setCopy('ok');
    } catch { if (mounted.current && recoveryScope() === scope && copyEpoch.current === epoch) setCopy('error'); }
  };
  if (recoveryScope() !== scope) return null;
  return <section className="website-reader" aria-label={t('Website reading view')}>
    <div className="website-reader-search">
      <Search size={14} aria-hidden="true" />
      <input name="workspacewebsitereader-input-1" type="search" aria-label={t('Find in this snapshot')} placeholder={t('Find in this snapshot')} maxLength={READER_QUERY_LENGTH} value={query}
        onChange={event => {
          setQuery(event.target.value); setSelection(undefined); clearCopy();
        }} />
      <span role="status">{query.trim() ? `${matches.length ? match + 1 : 0}/${matches.length}` : ''}</span>
      <button type="button" aria-label={t('Previous match')} disabled={!matches.length || query !== deferredQuery} onClick={() => chooseMatch((match + matches.length - 1) % matches.length)}><ChevronLeft size={14} /></button>
      <button type="button" aria-label={t('Next match')} disabled={!matches.length || query !== deferredQuery} onClick={() => chooseMatch((match + 1) % matches.length)}><ChevronRight size={14} /></button>
    </div>
    <p className="workspace-website-description">{t('Select a line; Shift-select for an excerpt. Line numbers refer to this reading view.')}</p>
    <div className="website-reader-body" ref={body}>
      {lines.slice(page * READER_PAGE_LINES, (page + 1) * READER_PAGE_LINES).map((line, offset) => {
        const index = page * READER_PAGE_LINES + offset;
        return <div key={index} data-reading-line={index} className={`website-reader-line${index >= first && index <= last ? ' is-selected' : ''}${matches[match] === index ? ' is-match' : ''}`}>
          <button type="button" aria-label={`${t('Select reading line')} ${index + 1}`} aria-pressed={index >= first && index <= last}
            onClick={event => { setSelection(event.shiftKey && selection ? [selection[0], index] : [index, index]); clearCopy(); }}>{index + 1}</button>
          <span>{line || '\u00a0'}</span>
        </div>;
      })}
    </div>
    <footer className="website-reader-controls">
      <button type="button" aria-label={t('Previous reading page')} disabled={page === 0} onClick={() => changePage(page - 1)}><ChevronLeft size={14} /></button>
      <span>{page + 1}/{total}</span>
      <button type="button" aria-label={t('Next reading page')} disabled={page + 1 >= total} onClick={() => changePage(page + 1)}><ChevronRight size={14} /></button>
      <button type="button" disabled={!citation || !digestReady} onClick={() => void copyCitation()}><Copy size={13} />{t('Copy excerpt with source')}</button>
    </footer>
    {selection && !citation && <p role="status">{t('Select a shorter excerpt (up to 8,000 characters).')}</p>}
    <span role="status">{copy === 'ok' ? t('Copied') : copy === 'error' ? t('Clipboard unavailable. Select and copy the source excerpt below.') : ''}</span>
    <details className="website-reader-source" open={copy === 'error' ? true : undefined}>
      <summary>{t('Source details')}</summary>
      <p>{connectionId} / {snapshot.serviceId} · {new Date(snapshot.fetchedAt).toLocaleString()}</p>
      <p>{digest ?? t('Snapshot fingerprint unavailable or being calculated.')}</p>
      <p>{t('This is a captured excerpt, not a permanent archive or a verified claim.')}</p>
      {citation && <textarea name="workspacewebsitereader-textarea-2" readOnly aria-label={t('Source excerpt')} value={citation} spellCheck={false} />}
    </details>
  </section>;
}
