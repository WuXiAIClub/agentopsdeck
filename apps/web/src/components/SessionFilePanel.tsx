import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ChatMessage, SessionFilePage, SessionFileRebuild } from '@agentopsdeck/shared';
import { api, ApiResponseError, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { collectSessionFiles, mergeIndexedSessionFiles, fileRecordHistory } from '../lib/session-files';
import { SourceReferencePreview } from './SourceReferencePreview';
import { FileRecordHistory } from './FileRecordHistory';

export default function FilePanel({ sessionKey, messages, close }: { sessionKey: string; messages: ChatMessage[]; close: () => void }) {
  const { t } = useI18n();
  const titleId = useId(), dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const loaded = useMemo(() => collectSessionFiles(messages, sessionKey), [messages, sessionKey]);
  const [index, setIndex] = useState<SessionFilePage>();
  const [loading, setLoading] = useState(false), [issue, setIssue] = useState<'failed' | 'changed'>();
  const [supported, setSupported] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const rebuildRequest = useRef<AbortController | undefined>(undefined), cancelRebuild = useRef(false);
  const [rebuilding, setRebuilding] = useState(false), [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<SessionFileRebuild>();
  const [rebuildFailed, setRebuildFailed] = useState(false);
  const files = useMemo(() => mergeIndexedSessionFiles(loaded.files, index?.entries ?? []), [loaded.files, index]);
  const history = useMemo(() => fileRecordHistory(messages, index?.entries ?? [], sessionKey, selected), [messages, index, sessionKey, selected]);
  const limited = loaded.limited || index?.limited || (index?.entries.length ?? 0) >= 1000;
  const load = async (cursor?: string, negotiate = false) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setIssue(undefined);
    try {
      if (negotiate) {
        const available = await api.sessionFileIndexAvailable(sessionKey, controller.signal);
        if (controller.signal.aborted) return;
        setSupported(available);
        if (!available) return;
      }
      const page = await api.sessionFiles(sessionKey, controller.signal, cursor);
      if (controller.signal.aborted) return;
      if (cursor && (!index || page.generation !== index.generation || page.revision !== index.revision)) {
        setIndex(undefined); setSelected(''); setIssue('changed'); return;
      }
      setIndex(previous => {
        if (!cursor) return page;
        if (!previous || page.generation !== previous.generation || page.revision !== previous.revision) return undefined;
        return { ...page, entries: [...previous.entries, ...page.entries].slice(0, 1000) };
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      // No stale preview remains on cursor conflict, revocation or read failure.
      setIndex(undefined); setSelected('');
      setIssue(error instanceof ApiResponseError && error.status === 409 ? 'changed' : 'failed');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const rebuild = async () => {
    if (rebuildRequest.current) return;
    const controller = new AbortController(); rebuildRequest.current = controller; cancelRebuild.current = false;
    setRebuilding(true); setCancelling(false); setProgress(undefined); setRebuildFailed(false);
    try {
      let next = await api.rebuildSessionFiles(sessionKey, controller.signal);
      while (!controller.signal.aborted) {
        setProgress(next);
        if (next.state !== 'scanning') break;
        // One bounded batch at a time. Only explicit user work has a timer;
        // neither opening the panel nor ordinary chat sync starts a rebuild.
        await rebuildPause(controller.signal);
        if (controller.signal.aborted) return;
        next = await api.rebuildSessionFiles(sessionKey, controller.signal, next, cancelRebuild.current);
      }
      if (!controller.signal.aborted && next.state === 'completed') await load();
    } catch {
      // Do not automatically repeat an uncertain mutation. The server stops
      // without another step and expires abandoned metadata after five minutes.
      if (!controller.signal.aborted) setRebuildFailed(true);
    } finally {
      if (!controller.signal.aborted) { setRebuilding(false); setCancelling(false); }
      if (rebuildRequest.current === controller) rebuildRequest.current = undefined;
    }
  };
  useEffect(() => {
    void load(undefined, true);
    return () => { request.current?.abort(); rebuildRequest.current?.abort(); };
  }, [sessionKey]);
  const visible = files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()));
  const current = files.find(file => file.path === selected);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    const finish = () => closeRef.current();
    const unsubscribe = subscribeRecoveryScope(finish);
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    window.addEventListener('agentopsdeck:auth-required', finish);
    window.addEventListener('pagehide', finish);
    return () => {
      unsubscribe();
      window.removeEventListener('agentopsdeck:auth-required', finish);
      window.removeEventListener('pagehide', finish);
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="session-files-dialog" data-font-area="chat" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section>
      <header><div><h2 id={titleId}>{t('Session files')}</h2><p>{t(index?.coverage === 'partial' ? 'Indexed tool changes and loaded references · historical coverage is partial' : 'Loaded messages only · not a complete edit history')}</p></div><button type="button" onClick={close} aria-label={t('Close')} autoFocus><X size={18} /></button></header>
      <div className="session-files-content">
        <nav aria-label={t('Session file list')}>
          <input name="sessionfilepanel-input-1" type="search" placeholder={t('Filter files')} aria-label={t('Filter files')} maxLength={2048} value={filter} onChange={event => setFilter(event.target.value)} />
          <div className="session-files-index-controls" aria-live="polite">
            {loading ? <span>{t('Reading file index…')}</span> : null}
            {issue ? <span role="status">{t(issue === 'changed' ? 'The file index changed. Refresh to read a consistent list.' : 'File index unavailable. Loaded references are still shown.')}</span> : null}
            {index?.coverage === 'stale' ? <span>{t('File index needs rebuilding. Coverage may be incomplete.')}</span> : null}
            {index?.coverage === 'unavailable' ? <span>{t('No indexed tool evidence yet. Older history is not scanned automatically.')}</span> : null}
            {index && index.source !== 'none' ? <p className="session-files-note">{t(index.source === 'durable-events' ? 'Source: saved structured tool events' : 'Source: verified native history projection')}</p> : null}
            {index?.retained ? <p className="session-files-note">{t('Retained indexed records')}: {index.retained.count.toLocaleString()}
              {index.retained.count > 0 ? <><br />{timestamp(index.retained.earliest!)} – {timestamp(index.retained.latest!)}<br />{t('Recorded timestamps only; gaps and missing tools are not covered.')}</> : null}</p> : null}
            {supported || issue ? <button type="button" disabled={loading || rebuilding} onClick={() => void load(undefined, !supported)}>{t('Refresh file index')}</button> : null}
            {index?.rebuildAvailable ? <>
              <p className="session-files-note">{t('Scan saved summaries only. Older records without file metadata remain unavailable.')}</p>
              <p className="session-files-note">{t('Closing stops further scan requests. Click again to resume your unfinished scan before it expires; opening this panel never scans automatically.')}</p>
              {!rebuilding ? <button type="button" disabled={loading} onClick={() => void rebuild()}>{t('Scan or resume older file records')}</button>
                : <button type="button" disabled={cancelling} onClick={() => { cancelRebuild.current = true; setCancelling(true); }}>{t(cancelling ? 'Cancelling file scan…' : 'Cancel file scan')}</button>}
            </> : null}
            {progress ? <span role="status">{t('Saved summaries scanned')}: {progress.scanned.toLocaleString()} · {t('File records')}: {progress.found.toLocaleString()}
              {progress.state === 'completed' ? ` · ${t(progress.limited ? 'Scan budget reached · recent results saved' : 'Scan finished · coverage remains partial')}`
                : progress.state === 'cancelled' ? ` · ${t('Scan cancelled · previous index preserved')}`
                  : progress.state === 'conflict' ? ` · ${t('Session changed · previous index preserved. Retry when idle.')}` : ''}</span> : null}
            {rebuildFailed || progress?.state === 'failed' ? <span role="status">{t('File scan stopped. No automatic retry; temporary work expires within five minutes.')}</span> : null}
          </div>
          {limited ? <p className="session-files-note">{t('Showing a bounded recent selection. Load older chat messages for earlier references.')}</p> : null}
          {!visible.length ? <p className="session-files-note">{t('No file evidence in these loaded messages.')}</p> : null}
          {visible.map(file => <button type="button" key={file.path} className="session-file-row" aria-pressed={file.path === selected} onClick={() => setSelected(file.path)}>
            <strong>{file.path.split(/[\\/]/).at(-1)}</strong><span title={file.path}>{file.path}</span>
            <small className={file.change ? 'has-file-change' : ''}>{t(file.change ? 'Tool-recorded change' : 'Message reference')}{file.change === 'deleted' ? ` · ${t('Deleted file')}` : ''}</small>
          </button>)}
          {index?.nextCursor && index.entries.length < 1000 ? <button className="session-files-more" type="button" disabled={loading || rebuilding} onClick={() => void load(index.nextCursor)}>{t('Load more file records')}</button> : null}
        </nav>
        <div className="session-file-preview" aria-label={t('Selected file preview')}>
          {current?.changeMessageId ? <FileRecordHistory key={`${sessionKey}:${current.path}`} sessionKey={sessionKey}
            path={current.path} records={history.records} limited={history.limited} /> : null}
          {!current ? <p>{t('Select a file to preview. No files are read until selected.')}</p>
            : current.change === 'deleted' ? <p>{t('The tool recorded a deletion. No current file is requested.')}</p>
            : current.media?.sourceReference ? <><p>{t('Current Connector file · read-only, not a historical diff')}</p>
              <SourceReferencePreview key={`${sessionKey}:${current.path}`} className="" reference={current.media.sourceReference} media={current.media}>{t('Source preview')}</SourceReferencePreview></>
              : <p>{t('Preview is unavailable for this record. Connector access is not expanded automatically.')}</p>}
        </div>
      </div>
    </section>
  </dialog>, document.body);
}

function rebuildPause(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { window.clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = window.setTimeout(finish, 750);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function timestamp(value: number) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
