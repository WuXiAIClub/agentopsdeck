import { useEffect, useRef, useState } from 'react';
import { Copy, MessageSquarePlus, StickyNote } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { ReadingDraftTransfer, ReadingNotebookTransfer } from './WorkspaceDraftTargets';

/** Parent keys this by the exact evidence payload; old clipboard receipts stay local. */
export default function ResearchSynthesisActions({ text, articles = false }: { text: string; articles?: boolean }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(false), [notebook, setNotebook] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const generation = useRef(0), copying = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  const copy = async () => {
    if (copying.current) return;
    const current = generation.current; copying.current = true;
    try { await navigator.clipboard.writeText(text); if (current === generation.current) setCopyState('copied'); }
    catch { if (current === generation.current) setCopyState('manual'); }
    finally { if (current === generation.current) copying.current = false; }
  };
  return <div className="workspace-synthesis-actions">
    <span className="workspace-reading-actions">
      <button type="button" aria-label={t('Place reading in a session draft')} title={t('Place reading in a session draft')} aria-expanded={draft} onClick={() => setDraft(!draft)}><MessageSquarePlus size={14} /></button>
      <button type="button" aria-label={t('Save reading to a notebook')} title={t('Save reading to a notebook')} aria-expanded={notebook} onClick={() => setNotebook(!notebook)}><StickyNote size={14} /></button>
      <button type="button" aria-label={t('Copy synthesis and cited snippets')} title={t('Copy synthesis and cited snippets')} onClick={() => void copy()}><Copy size={14} /></button>
    </span>
    <small>{t(articles ? 'Includes the exact submitted article text and per-paragraph citations. The summary is not independently verified.' : 'Includes selected search snippets and per-paragraph citations, not full articles. The summary is not independently verified.')}</small>
    {draft && <ReadingDraftTransfer text={text} />}
    {notebook && <ReadingNotebookTransfer text={text} />}
    {copyState === 'copied' && <small role="status">{t('Source copied')}</small>}
    {copyState === 'manual' && <div className="workspace-research-copy"><small role="status">{t('Clipboard unavailable. Copy the source text below.')}</small>
      <textarea name="researchsynthesisactions-textarea-1" readOnly value={text} aria-label={t('Source text for manual copy')} onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => setCopyState('idle')}>{t('Close')}</button></div>}
  </div>;
}
