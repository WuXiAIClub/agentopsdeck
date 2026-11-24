import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, Search, X } from 'lucide-react';
import { RESEARCH_QUERY_LIMIT, researchCitation, researchQuery, validResearchResult, validResearchSynthesis, type ResearchResult, type ResearchSource, type ResearchSynthesis } from '@agentopsdeck/shared';
import { api, ApiResponseError } from '../api';
import { useI18n } from '../lib/i18n';
import type { TranslationKey } from '../lib/translations';
import WorkspaceArticle from './WorkspaceArticle';
import WorkspaceMultiReading from './WorkspaceMultiReading';
import { useFileCardSettings } from '../lib/workspace-file-card-context';
import { synthesisCitation } from '../lib/research-synthesis-citation';
import ResearchSynthesisActions from './ResearchSynthesisActions';

/** Intentionally no shared query cache, storage or background refresh. */
export default function WorkspaceResearch({ scope }: { scope: string }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');
  const [reload, setReload] = useState(0), [query, setQuery] = useState('');
  const [result, setResult] = useState<ResearchResult>(), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | ''>(''), [manualCopy, setManualCopy] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false), [aiBusy, setAiBusy] = useState(false);
  const [aiTarget, setAiTarget] = useState<{ model: string; provider: string }>();
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [autoSynthesis, setAutoSynthesis] = useState(true), [editSources, setEditSources] = useState(false);
  const [answer, setAnswer] = useState<ResearchSynthesis>();
  const citation = useMemo(() => {
    if (!result || !answer) return '';
    try { return synthesisCitation(result, answer, selected); } catch { return ''; }
  }, [result, answer, selected]);
  const [reader, setReader] = useState<{ target: string; origins: string[] }>();
  const [articleSource, setArticleSource] = useState<ResearchSource>();
  const [articleAiEnabled, setArticleAiEnabled] = useState(false);
  const [multiEnabled, setMultiEnabled] = useState(false), [multiSources, setMultiSources] = useState<ResearchSource[]>();
  const [fileSources, setFileSources] = useState<{ title: string; url: string; excerpt: string }[]>([]);
  useFileCardSettings('research', { title: t('Search and sources · Preview'), query, sources: result
    ? result.sources.map(source => ({ title: source.title, url: source.url, excerpt: source.snippet })) : fileSources }, value => {
    setQuery(value.query); setFileSources(value.sources); setResult(undefined); setAnswer(undefined); setArticleSource(undefined); setMultiSources(undefined); setSelected([]);
  }, !busy && !aiBusy);
  const answerElement = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (answer) answerElement.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [answer]);
  const request = useRef<AbortController | undefined>(undefined), epoch = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort(); request.current = undefined; epoch.current++;
    setConfig('loading'); setResult(undefined); setManualCopy(''); setNotice('');
    setAiEnabled(false); setAiTarget(undefined); setModels([]); setAiBusy(false); setBusy(false); setSelected([]); setAnswer(undefined); setAutoSynthesis(true); setEditSources(false);
    setReader(undefined); setArticleSource(undefined); setFileSources([]); setArticleAiEnabled(false);
    setMultiEnabled(false); setMultiSources(undefined);
    void api.researchConfig(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (!value || typeof value !== 'object' || typeof (value as { enabled?: unknown }).enabled !== 'boolean') throw Error('Invalid research config');
      setConfig((value as { enabled: boolean }).enabled ? 'enabled' : 'disabled');
      const reading = value as { readerEnabled?: unknown; readerTarget?: unknown; readerOrigins?: unknown };
      setArticleAiEnabled((value as { articleSynthesisEnabled?: unknown }).articleSynthesisEnabled === true);
      setMultiEnabled((value as { multiArticleSynthesisEnabled?: unknown }).multiArticleSynthesisEnabled === true);
      if (reading.readerEnabled === true && typeof reading.readerTarget === 'string' && reading.readerTarget.length <= 2048
        && Array.isArray(reading.readerOrigins) && reading.readerOrigins.length <= 64 && reading.readerOrigins.every(origin => typeof origin === 'string' && origin.length <= 2048))
        setReader({ target: reading.readerTarget, origins: reading.readerOrigins });
      const target = (value as { synthesisTarget?: { model?: unknown; provider?: unknown; models?: unknown } }).synthesisTarget;
      if ((value as { synthesisEnabled?: unknown }).synthesisEnabled === true && target && typeof target.model === 'string' && target.model.length <= 128
        && typeof target.provider === 'string' && target.provider.length <= 2048) {
        const listed = Array.isArray(target.models) && target.models.length > 0 && target.models.length <= 512
          && target.models.every(m => m && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 128
            && typeof m.label === 'string' && m.label.length <= 128)
          ? target.models as Array<{ id: string; label: string }> : [{ id: target.model, label: target.model }];
        setModels(listed); setAiTarget({ model: target.model, provider: target.provider }); setAiEnabled(true);
      }
    }).catch(() => { if (!controller.signal.aborted) setConfig('error'); });
    return () => { controller.abort(); request.current?.abort(); epoch.current++; };
  }, [scope, reload]);
  const cancel = () => { epoch.current++; request.current?.abort(); request.current = undefined; setBusy(false); setAiBusy(false);
    setNotice(aiBusy ? 'AI synthesis cancelled. Provider processing may still incur usage. No automatic retry.' : 'Search cancelled. No automatic retry.'); };
  const clear = () => { cancel(); setQuery(''); setResult(undefined); setFileSources([]); setManualCopy(''); setNotice(''); setSelected([]); setAnswer(undefined); setArticleSource(undefined); setMultiSources(undefined); setEditSources(false); };
  const search = async () => {
    const value = researchQuery(query);
    if (!value || config !== 'enabled' || request.current) return;
    const controller = new AbortController(), generation = ++epoch.current;
    let synthesizing = false;
    request.current = controller; setBusy(true); setResult(undefined); setNotice(''); setManualCopy('');
    setArticleSource(undefined); setMultiSources(undefined); setFileSources([]);
    setSelected([]); setAnswer(undefined); setEditSources(false);
    try {
      const response = await api.researchSearch(value, controller.signal);
      if (controller.signal.aborted || generation !== epoch.current) return;
      if (!validResearchResult(response) || response.query !== value) throw Error('Invalid research result');
      setResult(response);
      const ids = response.sources.map(source => source.id);
      setSelected(ids);
      if (aiEnabled && autoSynthesis && ids.length) {
        synthesizing = true; setBusy(false); setAiBusy(true);
        const synthesized = await api.researchSynthesize(response.searchId, ids, controller.signal, aiTarget?.model);
        if (controller.signal.aborted || generation !== epoch.current) return;
        if (!validResearchSynthesis(synthesized, response, ids)) throw Error('Invalid synthesis');
        setAnswer(synthesized);
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== epoch.current) return;
      if (error instanceof ApiResponseError && [401, 403].includes(error.status)) { setConfig('disabled'); setResult(undefined); }
      setNotice(error instanceof ApiResponseError && error.status === 429
        ? synthesizing ? 'AI synthesis budget reached or another synthesis is active. Wait a minute before retrying.'
          : 'Search budget reached or another search is active. Wait a minute before retrying.'
        : synthesizing ? 'Answer failed. Retry with existing sources below.'
          : 'Search unavailable. Check access and provider configuration, then retry manually.');
    } finally { if (generation === epoch.current) { request.current = undefined; setBusy(false); setAiBusy(false); } }
  };
  const synthesize = async () => {
    if (!result || !aiEnabled || !selected.length || request.current) return;
    const controller = new AbortController(), generation = ++epoch.current, sourceIds = [...selected];
    request.current = controller; setAiBusy(true); setNotice(''); setAnswer(undefined);
    try {
      const response = await api.researchSynthesize(result.searchId, sourceIds, controller.signal, aiTarget?.model);
      if (controller.signal.aborted || generation !== epoch.current) return;
      if (!validResearchSynthesis(response, result, sourceIds)) throw Error('Invalid synthesis');
      setAnswer(response);
    } catch (error) {
      if (controller.signal.aborted || generation !== epoch.current) return;
      if (error instanceof ApiResponseError && [401, 403].includes(error.status)) {
        setAiEnabled(false); setConfig('disabled'); setResult(undefined); setAnswer(undefined); setManualCopy('');
      }
      setNotice(error instanceof ApiResponseError && error.status === 429
        ? 'AI synthesis budget reached or another synthesis is active. Wait a minute before retrying.'
        : 'AI synthesis unavailable or sources expired. Check access, search again and retry manually. No automatic retry.');
    } finally { if (generation === epoch.current) { request.current = undefined; setAiBusy(false); } }
  };
  const copy = async (source: ResearchSource) => {
    if (!result) return;
    const generation = epoch.current, text = researchCitation(result, source);
    try {
      await navigator.clipboard.writeText(text);
      if (generation === epoch.current) { setNotice('Source copied'); setManualCopy(''); }
    } catch { if (generation === epoch.current) { setManualCopy(text); setNotice('Clipboard unavailable. Copy the source text below.'); } }
  };
  return <section className="workspace-research" aria-label={t('Search and sources · Preview')}>
    {config === 'enabled' && aiEnabled && <div className="workspace-research-toolbar">
      <label className="workspace-research-model">{t('Model')}<select name="workspaceresearch-select-1" aria-label={t('Model')} value={aiTarget?.model ?? ''} disabled={busy || aiBusy || !!articleSource || !!multiSources}
        onChange={event => setAiTarget(target => target ? { ...target, model: event.target.value } : target)}>
        {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select></label>
      <label className="workspace-research-auto"><input name="workspaceresearch-input-2" type="checkbox" checked={autoSynthesis} disabled={busy || aiBusy}
        onChange={event => setAutoSynthesis(event.target.checked)} />{t('Auto answer')}</label>
    </div>}
    {config === 'loading' ? <p role="status">{t('Loading…')}</p> : config !== 'enabled' ? <div className="workspace-research-empty">
      <p role="status">{t(config === 'disabled' ? 'Search is unavailable. The Hub needs a configured search provider and access for this user.' : 'Could not check search access.')}</p>
      <button type="button" onClick={() => setReload(value => value + 1)}>{t('Check search access')}</button>
    </div> : <>
      <form className="workspace-research-form" onSubmit={event => { event.preventDefault(); void search(); }}>
        <input name="workspaceresearch-input-3" aria-label={t('Search query')} placeholder={t('Search the web…')} value={query} maxLength={RESEARCH_QUERY_LIMIT} disabled={busy || aiBusy} onChange={event => setQuery(event.target.value)} />
        {busy || aiBusy ? <button key="cancel" type="button" onClick={cancel}><X size={14} />{t(aiBusy ? 'Cancel synthesis' : 'Cancel search')}</button>
          : <button key="submit" type="submit" disabled={!researchQuery(query)}><Search size={14} />{t(aiEnabled && autoSynthesis ? 'Search and answer' : 'Search')}</button>}
        {(query || result) && <button type="button" aria-label={t('Clear search')} title={t('Clear search')} onClick={clear}><X size={14} /></button>}
      </form>
      <details className="workspace-research-privacy"><summary>{t('Privacy and billing')}</summary>
        <p>{t('Your query is sent to the configured search provider. Do not include secrets.')}</p>
        {aiEnabled && <p>{t('Only the search query and selected titles/snippets are sent to the configured model. No chat, files or Connector content. Up to 2,000 output tokens; usage may be charged.')}</p>}
      </details>
    </>}
    <div className="workspace-research-status" role="status" aria-live="polite">{aiBusy ? t('Synthesizing selected snippets…') : busy ? t('Searching…') : notice ? t(notice) : result ? `${result.sources.length} · ${new Date(result.fetchedAt).toLocaleTimeString()}` : ''}</div>
    {answer && result && <div ref={answerElement} className="workspace-research-answer" aria-label={t('AI synthesis result')}>
      <strong>{t('AI synthesis result')}</strong><p className="workspace-research-hint">{t('Citation IDs were checked, not factual accuracy. Verify the original sources.')}</p>
      {citation && <ResearchSynthesisActions key={`${scope}:${citation}`} text={citation} />}
      {answer.paragraphs.map((paragraph, index) => <div key={index}><p>{paragraph.text}</p><div className="workspace-research-citations">
        {paragraph.citations.map(id => { const source = result.sources.find(value => value.id === id)!;
          return <a key={id} href={source.url} title={source.title} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{id}<ExternalLink size={11} /></a>; })}
      </div></div>)}<p className="workspace-research-hint">{answer.caveat}</p>
    </div>}
    {result && result.sources.length > 0 && <header><strong>{t('Sources')} · {result.sources.length}</strong>
      {aiEnabled && <button type="button" disabled={busy || aiBusy} aria-expanded={editSources} onClick={() => setEditSources(value => !value)}>{t('Adjust sources')}</button>}
      {aiEnabled && !aiBusy && (!answer || editSources) && <button type="button" disabled={!selected.length || busy} onClick={() => void synthesize()}>{t('Generate answer')}</button>}
    </header>}
    {result && <div className="workspace-research-results" aria-label={t('Search results')}>
      {result.sources.length === 0 ? <p>{t('No search results')}</p> : result.sources.map(source => <article key={source.id}>
        <header>{aiEnabled && editSources && <input name="workspaceresearch-input-4" type="checkbox" aria-label={`${t('Select source')} ${source.id}`} checked={selected.includes(source.id)} disabled={aiBusy}
          onChange={event => { setSelected(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id)); setAnswer(undefined); }} />}
          <span className="workspace-research-source-id">{source.id}</span><a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.title}<ExternalLink size={12} /></a>
          <button type="button" aria-label={`${t('Copy source')} ${source.id}`} title={t('Copy source')} onClick={() => void copy(source)}><Copy size={13} /></button></header>
        <small>{new URL(source.url).host}</small><p>{source.snippet || t('No snippet available')}</p>
        {reader?.origins.includes(new URL(source.url).origin) && <button type="button" onClick={() => { setMultiSources(undefined); setArticleSource(source); }}>{t('Open article reader')}</button>}
      </article>)}
    </div>}
    {!result && fileSources.length > 0 && <div className="workspace-research-results" aria-label={t('Search results')}>{fileSources.map((source, index) => <article key={index}>
      <header><a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.title}<ExternalLink size={12} /></a></header><p>{source.excerpt}</p>
    </article>)}</div>}
    {editSources && multiEnabled && reader && aiTarget && result && <button type="button" disabled={busy || aiBusy || selected.length < 2 || selected.length > 3 || result.sources.some(s => selected.includes(s.id) && !reader.origins.includes(new URL(s.url).origin))}
      onClick={() => { setArticleSource(undefined); setMultiSources(result.sources.filter(s => selected.includes(s.id))); }}>{t('Read multiple articles')}</button>}
    {reader && aiTarget && result && multiSources && <WorkspaceMultiReading key={`${scope}:${result.searchId}:${multiSources.map(s => s.id).join(',')}`} result={result} sources={multiSources} target={reader.target} aiTarget={aiTarget} onClose={() => setMultiSources(undefined)} />}
    {reader && result && articleSource && <WorkspaceArticle key={`${scope}:${result.searchId}:${articleSource.id}`} result={result} source={articleSource} target={reader.target} aiTarget={articleAiEnabled ? aiTarget : undefined} onClose={() => setArticleSource(undefined)} />}
    {manualCopy && <div className="workspace-research-copy"><textarea name="workspaceresearch-textarea-5" aria-label={t('Source text for manual copy')} readOnly value={manualCopy} onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => { setManualCopy(''); setNotice(''); }}>{t('Close')}</button></div>}
  </section>;
}
