import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, MessageSquarePlus, Sparkles, StickyNote, X } from 'lucide-react';
import { ReadingDraftTransfer, ReadingNotebookTransfer } from './WorkspaceDraftTargets';
import { RESEARCH_READING_BYTES, validResearchArticle, validResearchReadingRange, validResearchSynthesis, type ResearchArticle, type ResearchResult, type ResearchSource, type ResearchReadingRange, type ResearchReadingEvidence, type ResearchSynthesis } from '@agentopsdeck/shared';
import { api, ApiResponseError } from '../api';
import { useI18n } from '../lib/i18n';
import type { TranslationKey } from '../lib/translations';
import { readingCitation, readingSelection, revealReadingRange } from '../lib/workspace-article';

/** Mounted per source selection. No fetch before explicit consent, no polling or HTML rendering. */
export default function WorkspaceArticle({ result, source, target, aiTarget, onClose }: {
  result: ResearchResult; source: ResearchSource; target: string; aiTarget?: { model: string; provider: string } | undefined; onClose: () => void;
}) {
  const { t } = useI18n(), [article, setArticle] = useState<ResearchArticle>();
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<TranslationKey | ''>('');
  const request = useRef<AbortController | undefined>(undefined);
  const textElement = useRef<HTMLTextAreaElement>(null);
  const selectionKey = useRef('');
  const [aiOpen, setAiOpen] = useState(false), [mode, setMode] = useState<'full' | 'selection'>('full');
  const [range, setRange] = useState<ResearchReadingRange>();
  const [aiBusy, setAiBusy] = useState(false), [expired, setExpired] = useState(false);
  const [answer, setAnswer] = useState<ResearchSynthesis & { evidence: ResearchReadingEvidence }>();
  const [unavailable, setUnavailable] = useState(false);
  const [manualCopy, setManualCopy] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const citation = useMemo(() => article && answer ? readingCitation(result, article, answer) : '', [result, article, answer]);
  useEffect(() => () => { request.current?.abort(); request.current = undefined; }, []);
  // Native `select` also covers selection handles and programmatic citation jumps.
  // React's onSelect alone does not observe all of these in readonly controls.
  useEffect(() => {
    const element = textElement.current;
    if (!element) return;
    const selected = () => {
      if (aiBusy) return;
      const { selectionStart: start, selectionEnd: end } = element;
      const key = `${start}:${end}`;
      if (selectionKey.current === key) return;
      selectionKey.current = key;
      setRange(start < end ? { start, end } : undefined);
      if (start < end) setMode('selection');
    };
    element.addEventListener('select', selected);
    selected(); // Reconcile a selection changed while an earlier request was in flight.
    return () => element.removeEventListener('select', selected);
  }, [article, aiBusy]);
  const read = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setNotice('');
    try {
      const value = await api.researchRead(result.searchId, source.id, controller.signal);
      if (controller.signal.aborted) return;
      if (!validResearchArticle(value, result) || value.sourceId !== source.id) throw Error('Invalid article');
      setArticle(value); setTransferOpen(false); setNotebookOpen(false);
      selectionKey.current = '';
      setExpired(false); setUnavailable(false); setAnswer(undefined); setManualCopy(''); setRange(undefined); setMode('full');
    } catch (error) {
      if (controller.signal.aborted) return;
      setNotice(error instanceof ApiResponseError && error.status === 429 ? 'Reading budget reached. Wait a minute before retrying.'
        : 'Article unavailable. The source may be disallowed, expired or unreadable. Search again or retry manually.');
    } finally { if (request.current === controller) { request.current = undefined; setBusy(false); } }
  };
  const activeRange = article && (mode === 'full' ? { start: 0, end: article.text.length } : range);
  const selectedText = article && activeRange ? article.text.slice(activeRange.start, activeRange.end) : '';
  const bytes = new TextEncoder().encode(selectedText).byteLength;
  const canSend = !!article && !!activeRange && validResearchReadingRange(article.text, activeRange) && bytes <= RESEARCH_READING_BYTES;
  const synthesize = async () => {
    if (request.current || !article?.articleId || !aiTarget || !canSend || expired || unavailable) return;
    const controller = new AbortController(); request.current = controller; setAiBusy(true); setNotice(''); setAnswer(undefined); setManualCopy(''); setTransferOpen(false); setNotebookOpen(false);
    const submitted = { articleId: article.articleId, sourceId: source.id, mode, ...activeRange!, truncated: article.truncated };
    try {
      const value = await api.researchReadSynthesize(result.searchId, article.articleId, mode, mode === 'selection' ? activeRange : undefined, controller.signal, aiTarget.model);
      if (controller.signal.aborted) return;
      const evidence = (value as { evidence?: ResearchReadingEvidence } | null)?.evidence;
      if (!validResearchSynthesis(value, result, [source.id]) || !evidence || Object.entries(submitted).some(([key, expected]) => evidence[key as keyof ResearchReadingEvidence] !== expected)) throw Error('Invalid reading evidence');
      setAnswer({ ...value, evidence: submitted });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error instanceof ApiResponseError ? error.status : 0;
      if (status === 409 || status === 400) setExpired(true);
      if (status === 401 || status === 403 || status === 404) setUnavailable(true);
      setNotice(status === 409 || status === 400 ? 'Article snapshot expired. Read the article again before sending.'
        : status === 413 ? 'Selected text is too large. Select a shorter passage.'
        : status === 429 ? 'AI reading budget reached. Wait a minute before retrying.'
        : status === 401 || status === 403 || status === 404 ? 'AI reading unavailable. Check permissions and refresh the card.'
        : 'AI reading failed. No automatic retry; you can try again manually.');
    } finally { if (request.current === controller) { request.current = undefined; setAiBusy(false); } }
  };
  const cancelAi = () => { request.current?.abort(); request.current = undefined; setAiBusy(false); setNotice('AI synthesis cancelled. Provider processing may still incur usage. No automatic retry.'); };
  const locate = () => {
    const element = textElement.current;
    if (!element || !answer) return;
    revealReadingRange(element, answer.evidence.start, answer.evidence.end);
  };
  const copy = async () => {
    if (!article || !answer) return;
    const text = readingCitation(result, article, answer);
    try { await navigator.clipboard.writeText(text); setNotice('Source copied'); }
    catch { setManualCopy(text); setNotice('Clipboard unavailable. Copy the source text below.'); }
  };
  return <section className="workspace-research-article" aria-label={t('Article reader')}>
    <header><strong>{source.id} · {source.title}</strong><span className="workspace-reading-actions">
      {article?.articleId && aiTarget && <button type="button" aria-label={t('AI article reading')} title={t('AI article reading')} aria-expanded={aiOpen} onClick={() => setAiOpen(!aiOpen)} disabled={aiBusy}><Sparkles size={14} /></button>}
      <button type="button" onClick={onClose} aria-label={t('Close article')} title={t('Close article')}><X size={14} /></button></span></header>
    <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{new URL(source.url).host}<ExternalLink size={12} /></a>
    {!article && <><p className="workspace-research-hint">{t('Read this source through the configured extraction gateway. Only its URL is sent; article text is not sent to AI.')}</p><small>{target}</small>
      {busy ? <button type="button" onClick={onClose}>{t('Cancel reading')}</button> : <button type="button" onClick={() => void read()}>{t('Read this article')}</button>}</>}
    <p role="status" aria-live="polite">{busy ? t('Reading article…') : notice ? t(notice) : ''}</p>
    {article?.articleId && aiTarget && aiOpen && <section className="workspace-reading-controls" aria-label={t('AI article reading')}>
      <div className="workspace-reading-options"><select name="workspacearticle-select-1" aria-label={t('Reading scope')} value={mode} disabled={aiBusy} onChange={event => { setMode(event.target.value as typeof mode); }}>
        <option value="full">{t('Entire extracted text')}</option><option value="selection">{t('Selected passage')}</option>
      </select>{aiBusy ? <button type="button" onClick={cancelAi}>{t('Cancel AI synthesis')}</button>
        : <button type="button" disabled={!canSend || expired || unavailable || busy} onClick={() => void synthesize()}>{t('Summarize text')}</button>}</div>
      <small>{aiTarget.model}</small>
      <small>{bytes.toLocaleString()} / {RESEARCH_READING_BYTES.toLocaleString()} {t('UTF-8 bytes')}{activeRange ? ` · ${activeRange.start}–${activeRange.end}` : ''}</small>
      {mode === 'selection' && <p>{selectedText ? selectedText.slice(0, 240) + (selectedText.length > 240 ? '…' : '') : t('Select a passage in the article below, using touch, mouse or keyboard.')}</p>}
      {bytes > RESEARCH_READING_BYTES && <p role="alert">{t('Selected text is too large. Select a shorter passage.')}</p>}
      <details className="workspace-research-privacy"><summary>{t('Privacy and billing')}</summary><p>{t('Send this text, its title and search query to the displayed AI provider. Usage may be charged.')}</p></details>
      {expired && <button type="button" disabled={busy} onClick={() => void read()}>{t('Read this article')}</button>}
      {aiBusy && <p role="status">{t('Summarizing article…')}</p>}
    </section>}
    {answer && <section className="workspace-reading-answer" aria-label={t('Article summary')}>
      <header><strong>{t(answer.evidence.mode === 'full' ? 'Entire extracted text' : 'Selected passage')}</strong><span className="workspace-reading-actions">
        <button type="button" title={t('Place reading in a session draft')} aria-label={t('Place reading in a session draft')} aria-expanded={transferOpen} onClick={() => setTransferOpen(!transferOpen)}><MessageSquarePlus size={14} /></button>
        <button type="button" title={t('Save reading to a notebook')} aria-label={t('Save reading to a notebook')} aria-expanded={notebookOpen} onClick={() => setNotebookOpen(!notebookOpen)}><StickyNote size={14} /></button>
        <button type="button" title={t('Copy summary and cited text')} aria-label={t('Copy summary and cited text')} onClick={() => void copy()}><Copy size={14} /></button></span></header>
      {transferOpen && <ReadingDraftTransfer key={citation} text={citation} />}
      {notebookOpen && <ReadingNotebookTransfer key={citation} text={citation} />}
      <small>{t(answer.evidence.truncated ? 'Article shortened by the reader.' : 'Extracted article · verify the original source.')}</small>
      {answer.paragraphs.map((paragraph, index) => <p key={index}>{paragraph.text} <button type="button" onClick={locate} aria-label={t('Locate cited passage')}>{source.id} ↗</button></p>)}
      <small>{answer.caveat}</small>
      <small>{t('Citations locate the submitted text; they do not independently verify the summary.')}</small>
    </section>}
    {manualCopy && <div className="workspace-research-copy"><textarea name="workspacearticle-textarea-2" readOnly value={manualCopy} aria-label={t('Source text for manual copy')} onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => setManualCopy('')}>{t('Close')}</button></div>}
    {article && <><small>{new Date(article.fetchedAt).toLocaleString()} · {t(article.truncated ? 'Article shortened by the reader.' : 'Extracted article · verify the original source.')}</small>
      <textarea name="workspacearticle-textarea-3" key={article.articleId ?? article.fetchedAt} ref={textElement} className="workspace-research-article-text" readOnly rows={14} value={article.text} aria-label={t('Extracted article text')}
        onKeyDown={event => {
          // Chromium readonly textareas scroll, but do not move the caret with arrow keys.
          // Keep native mouse/touch selection and add non-editing keyboard range navigation.
          if (event.altKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
            || ((event.ctrlKey || event.metaKey) && event.key.startsWith('Arrow'))) return;
          const element = event.currentTarget;
          const next = readingSelection(element.value, { start: element.selectionStart, end: element.selectionEnd, backward: element.selectionDirection === 'backward' }, event.key, event.shiftKey, event.ctrlKey || event.metaKey);
          event.preventDefault();
          element.setSelectionRange(next.start, next.end, next.backward ? 'backward' : 'forward');
        }} /></>}
  </section>;
}
