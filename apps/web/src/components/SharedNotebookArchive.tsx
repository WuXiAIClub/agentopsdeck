import { useEffect, useSyncExternalStore } from 'react';
import { NOTEBOOK_ARCHIVE_MAX_CHARS } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { useFileCardGuard } from '../lib/workspace-file-card-context';
import { useNotebookController } from './SessionNotebook';
import NotebookFileSync from './NotebookFileSync';
import NotebookArchiveToggle from './NotebookArchiveToggle';

/** Cold-only editor: shared hot writes cannot use the legacy two-area move API. */
export default function SharedNotebookArchive(props: { sessionKey?: string; id: string; paused: boolean }) {
  return <NotebookArchiveToggle><ColdEditor {...props} /></NotebookArchiveToggle>;
}
function ColdEditor({ sessionKey, id, paused }: { sessionKey?: string; id: string; paused: boolean }) {
  const { t } = useI18n(), scope = recoveryScope();
  const controller = useNotebookController(JSON.stringify(['archive', sessionKey === undefined ? 'hub' : 'session', sessionKey ?? id]), {
    read: () => api.notebookArchive(sessionKey, id), write: value => api.saveNotebookArchive(sessionKey, id, value),
    storage: () => sessionStorage, key: `agentopsdeck.notebook-archive-draft:${JSON.stringify([scope, sessionKey ?? null, id])}`,
    maxChars: NOTEBOOK_ARCHIVE_MAX_CHARS,
  });
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  useEffect(() => { if(!paused && controller.get().phase === 'closed')void controller.load(); }, [controller, paused]);
  useFileCardGuard(() => !controller.dirty() && state.phase === 'ready');
  return <section className="notebook-archive">
    <NotebookFileSync sessionKey={sessionKey} id={id} paused={paused} ready={() => !controller.dirty() && state.phase === 'ready'}
      onChanged={() => { void controller.reconcile(); }} />
    <textarea name="sharednotebookarchive-textarea-1" aria-label={t('Notebook archive')} value={state.text} maxLength={NOTEBOOK_ARCHIVE_MAX_CHARS}
      disabled={paused || !state.document || ['closed','loading','conflict'].includes(state.phase)}
      onChange={e => controller.edit(e.target.value)} onBlur={() => void controller.flush()} />
    <span role="status">{t(state.phase === 'error' ? 'Notebook unavailable · retrying automatically' : state.phase === 'conflict' ? 'Notebook changed elsewhere' : state.phase === 'saving' ? 'Saving…' : controller.dirty() ? 'Unsaved changes' : state.phase === 'ready' ? 'Saved' : 'Loading notebook…')}</span>
    <span>{t('{count} / {limit} characters', {count: state.text.length.toLocaleString(), limit: NOTEBOOK_ARCHIVE_MAX_CHARS.toLocaleString()})}</span>
    {state.phase === 'error' && <button disabled={paused} onClick={() => void controller.retry()}>{t('Retry')}</button>}
    {state.phase === 'conflict' && state.remote && <div role="alert">
      <p>{t('Another tab saved this note. Compare before choosing which version to keep.')}</p>
      <details><summary>{t('View saved version')}</summary><pre>{state.remote.text}</pre></details>
      <button disabled={paused} onClick={() => controller.resolve(false)}>{t('Use saved version')}</button>
      {state.remote.resourceId === state.document?.resourceId && <button disabled={paused} onClick={() => controller.resolve(true)}>{t('Save my draft instead')}</button>}
    </div>}
    {state.localUnavailable && <p role="alert">{t('Local draft backup unavailable. Keep this page open until saved.')}</p>}
  </section>;
}
