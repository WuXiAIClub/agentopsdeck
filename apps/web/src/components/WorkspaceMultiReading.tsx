import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { RESEARCH_READING_BYTES, validResearchArticle, type ResearchResult, type ResearchSource, type ResearchReadingSelection } from '@agentopsdeck/shared';
import { api, ApiResponseError } from '../api';
import { useI18n } from '../lib/i18n';
import type { TranslationKey } from '../lib/translations';
import { multiReadingCitation, readingDocuments, type ReadingDocument, type MultiReadingAnswer } from '../lib/multi-reading';
import { readingSelection, revealReadingRange } from '../lib/workspace-article';
import ResearchSynthesisActions from './ResearchSynthesisActions';

function ArticleScope({ document, disabled, onChange, register }: { document: ReadingDocument; disabled: boolean;
  onChange: (selection: ResearchReadingSelection) => void; register: (element: HTMLTextAreaElement | null) => void }) {
  const { t } = useI18n(), element = useRef<HTMLTextAreaElement | null>(null);
  const { article, selection } = document;
  useEffect(() => {
    const node = element.current; if (!node) return;
    const select = () => {
      // Browsers can dispatch multiple select events for focus + setSelectionRange.
      // Keep the citation range suppressed until the selection actually changes.
      const jump = node.dataset.citationJump;
      if (jump === `${node.selectionStart}:${node.selectionEnd}`) return;
      delete node.dataset.citationJump;
      if (disabled || node.selectionStart === node.selectionEnd) return;
      const range = { start: node.selectionStart, end: node.selectionEnd };
      if (selection.mode !== 'selection' || range.start !== selection.range?.start || range.end !== selection.range?.end)
        onChange({ articleId: article.articleId!, mode: 'selection', range });
    };
    node.addEventListener('select', select); return () => node.removeEventListener('select', select);
  }, [article.articleId, selection, disabled, onChange]);
  return <article className="workspace-research-article">
    <strong>{article.sourceId} · {article.title}</strong>
    <a href={article.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{new URL(article.url).host}</a>
    <label>{t('Reading scope')} <select name="workspacemultireading-select-1" aria-label={`${t('Reading scope')} ${article.sourceId}`} value={selection.mode} disabled={disabled}
      onChange={e => onChange({ articleId: article.articleId!, mode: e.target.value as 'full' | 'selection' })}>
      <option value="full">{t('Entire extracted text')}</option><option value="selection">{t('Selected passage')}</option>
    </select></label>
    {selection.mode === 'selection' && <small>{selection.range ? `${selection.range.start}–${selection.range.end} · UTF-16` : t('Select a passage in the article below, using touch, mouse or keyboard.')}</small>}
    {article.truncated && <small>{t('Extraction is truncated; this is not the complete article.')}</small>}
    <textarea name="workspacemultireading-textarea-2" className="workspace-research-article-text" aria-label={`${t('Extracted article text')} ${article.sourceId}`} readOnly rows={8} value={article.text}
      ref={node => { element.current = node; register(node); }} onKeyDown={event => {
        if (event.altKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          || ((event.ctrlKey || event.metaKey) && event.key.startsWith('Arrow'))) return;
        const node = event.currentTarget;
        const next = readingSelection(node.value, { start: node.selectionStart, end: node.selectionEnd, backward: node.selectionDirection === 'backward' }, event.key, event.shiftKey, event.ctrlKey || event.metaKey);
        event.preventDefault(); node.setSelectionRange(next.start, next.end, next.backward ? 'backward' : 'forward');
      }} />
  </article>;
}

/** Explicit extraction and user-initiated AI synthesis. No provider calls on mount or retry loops. */
export default function WorkspaceMultiReading({ result, sources, target, aiTarget, onClose }: {
  result: ResearchResult; sources: ResearchSource[]; target: string; aiTarget: { model: string; provider: string }; onClose: () => void;
}) {
  const { t } = useI18n(), [documents, setDocuments] = useState<ReadingDocument[]>([]);
  const [busy, setBusy] = useState<'read' | 'ai' | ''>('');
  const [notice, setNotice] = useState<TranslationKey | ''>(''), [expired, setExpired] = useState(false), [unavailable, setUnavailable] = useState(false);
  const [answer, setAnswer] = useState<{ value: MultiReadingAnswer; text: string }>();
  const request = useRef<AbortController | undefined>(undefined), nodes = useRef(new Map<string, HTMLTextAreaElement>());
  useEffect(() => {
    const clear = () => { request.current?.abort(); request.current = undefined; setDocuments([]); setAnswer(undefined); setBusy(''); setUnavailable(true); setNotice('AI reading unavailable. Check permissions and refresh the card.'); };
    window.addEventListener('pagehide', clear); window.addEventListener('agentopsdeck:auth-required', clear);
    return () => { request.current?.abort(); request.current = undefined; window.removeEventListener('pagehide', clear); window.removeEventListener('agentopsdeck:auth-required', clear); };
  }, []);
  let bytes = 0, valid = false;
  try { bytes = readingDocuments(result, documents).reduce((sum, d) => sum + new TextEncoder().encode(d.text).byteLength, 0); valid = true; } catch { /* Invalid/incomplete selections cannot send. */ }
  const failure = (error: unknown, reading: boolean) => {
    const status = error instanceof ApiResponseError ? error.status : 0;
    if (status === 409 || status === 400) setExpired(true);
    if ([401, 403, 404].includes(status)) { setUnavailable(true); setDocuments([]); }
    setNotice(status === 409 || status === 400 ? 'Article snapshot expired. Read the article again before sending.'
      : status === 413 ? 'Selected text is too large. Select a shorter passage.'
      : status === 429 ? reading ? 'Reading budget reached. Wait a minute before retrying.' : 'AI reading budget reached. Wait a minute before retrying.'
      : [401, 403, 404].includes(status) ? 'AI reading unavailable. Check permissions and refresh the card.'
      : 'AI reading failed. No automatic retry; you can try again manually.');
  };
  const read = async () => {
    if (request.current || unavailable) return;
    const controller = new AbortController(); request.current = controller; setBusy('read'); setNotice(''); setDocuments([]); setAnswer(undefined);
    try {
      const next: ReadingDocument[] = [];
      for (const source of sources) {
        const value = await api.researchRead(result.searchId, source.id, controller.signal, next.length > 0);
        if (controller.signal.aborted) return;
        if (!validResearchArticle(value, result) || value.sourceId !== source.id || !value.articleId) throw Error('Invalid article');
        next.push({ article: value, selection: { articleId: value.articleId, mode: 'full' } });
      }
      setDocuments(next); setExpired(false);
    } catch (error) { if (!controller.signal.aborted) failure(error, true); }
    finally { if (request.current === controller) { request.current = undefined; setBusy(''); } }
  };
  const synthesize = async () => {
    if (request.current || !valid || expired || unavailable) return;
    const controller = new AbortController(); request.current = controller; setBusy('ai'); setNotice(''); setAnswer(undefined);
    try {
      const value = await api.researchReadManySynthesize(result.searchId, documents.map(d => d.selection), controller.signal, aiTarget.model);
      if (controller.signal.aborted) return;
      const text = multiReadingCitation(result, documents, value);
      setAnswer({ value: value as MultiReadingAnswer, text });
    } catch (error) { if (!controller.signal.aborted) failure(error, false); }
    finally { if (request.current === controller) { request.current = undefined; setBusy(''); } }
  };
  const locate = (sourceId: string) => {
    const evidence = answer?.value.evidence.find(e => e.sourceId === sourceId), node = nodes.current.get(sourceId);
    if (!evidence || !node) return;
    // Citation navigation is not a new selection/edit and must not invalidate the answer.
    node.dataset.citationJump = `${evidence.start}:${evidence.end}`; revealReadingRange(node, evidence.start, evidence.end);
  };
  return <section className="workspace-research-article" aria-label={t('Read multiple articles')}>
    <header><strong>{t('Read multiple articles')}</strong><button onClick={onClose} aria-label={t('Close article')}><X size={14} /></button></header>
    <p>{t('Read 2–3 selected articles first, then review their text or select passages. Nothing is sent to AI until you confirm.')}</p>
    <small>{target}</small><small>{sources.map(s => `${s.id} · ${s.title}`).join(' / ')}</small>
    <button disabled={!!busy || unavailable} onClick={() => void read()}>{t('Read selected articles')}</button>
    <p role="status" aria-live="polite">{notice ? t(notice) : busy === 'read' ? t('Reading article…') : ''}</p>
    {documents.map((document, index) => <ArticleScope key={document.article.articleId} document={document} disabled={!!busy}
      register={node => { if (node) nodes.current.set(document.article.sourceId, node); else nodes.current.delete(document.article.sourceId); }}
      onChange={selection => {
        setDocuments(old => old.map((d, i) => i === index ? { ...d, selection } : d)); setAnswer(undefined);
      }} />)}
    {documents.length > 0 && <div className="workspace-reading-controls">
      <small>{aiTarget.model}</small>
      <small>{valid ? `${bytes} / ${RESEARCH_READING_BYTES} ${t('UTF-8 bytes')}` : t('Choose valid passages within the combined 32,000-byte limit.')}</small>
      <details className="workspace-research-privacy"><summary>{t('Privacy and billing')}</summary><p>{t('Send this text, its title and search query to the displayed AI provider. Usage may be charged.')}</p></details>
      <button disabled={!!busy || !valid || expired || unavailable} onClick={() => void synthesize()}>{t('Summarize selected articles')}</button>
    </div>}
    {busy && <button onClick={() => { request.current?.abort(); request.current = undefined; setBusy(''); setNotice('AI synthesis cancelled. Provider processing may still incur usage. No automatic retry.'); }}>{t('Cancel reading')}</button>}
    {answer && <div className="workspace-research-answer">{answer.value.paragraphs.map((p, i) => <p key={i}>{p.text} {p.citations.map(id => <button key={id} onClick={() => locate(id)}>{id}</button>)}</p>)}
      <small>{answer.value.caveat}</small><ResearchSynthesisActions key={answer.text} text={answer.text} articles />
    </div>}
  </section>;
}
