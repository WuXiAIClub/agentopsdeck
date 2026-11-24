import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { validBoardUuid, workspaceFileCardResource } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import type { FileBoardBinding } from '../lib/workspace-file-board';
import './notebook-file-sync.css';
const AgentAccess = lazy(() => import('./NotebookAgentAccess'));
type Pending = { bindingId: string; requestId: string; revision: number };

/** The ordinary file binding is the archive authority. Standalone API tokens
 * are optional, not a second requirement for the already associated Agent. */
type Props = {
  sessionKey?: string | undefined; id?: string; resource?: string; paused?: boolean; onChanged?: () => void; ready?: () => boolean; apiAccess?: boolean;
};
export default function NotebookFileSync(props: Props) {
  return <FileSync key={JSON.stringify([recoveryScope(), recoveryEpoch(), props.resource, props.sessionKey, props.id])} {...props} />;
}
function FileSync({ sessionKey, id = 'default', resource: explicitResource, paused = false, onChanged, ready, apiAccess = true }: Props) {
  const { t } = useI18n(), scope = recoveryScope(), epoch = recoveryEpoch();
  const resource = explicitResource ?? workspaceFileCardResource('notebook', sessionKey === undefined ? `hub:${id}` : `session:${sessionKey}`);
  const key = JSON.stringify(['agentopsdeck.notebook-archive-sync', scope, resource]);
  const [state, setState] = useState<{ binding: FileBoardBinding | null; revision: number; full: boolean }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [consent, setConsent] = useState(false), [access, setAccess] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const lock = useRef(false), life = useRef<AbortController>(new AbortController()), latest = useRef({ onChanged, ready });
  latest.current = { onChanged, ready };
  const { notice } = useWorkspaceBoardRevision(scope ?? '', resource, 'card-file-binding');
  const valid = (signal = life.current.signal) => !!scope && !signal.aborted && recoveryScope() === scope && recoveryEpoch() === epoch;
  const load = async (signal = life.current.signal) => {
    const [binding, doc] = await Promise.all([api.fileCardBinding(resource, signal), api.fileCard(resource, signal)]);
    if (valid(signal) && doc.kind === 'notebook') setState({ binding: binding.binding, revision: doc.revision, full: !!binding.binding && doc.content.archive !== undefined });
  };
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (lock.current || !valid() || paused) return;
    const signal = life.current.signal;
    lock.current = true; setBusy(true); setError(false);
    try { await operation(signal); } catch { if (valid(signal)) setError(true); }
    finally { lock.current = false; if (valid(signal)) setBusy(false); }
  };
  const remember = (value?: Pending) => {
    if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
    setPending(value);
  };
  const settle = async (value: Pending, signal: AbortSignal) => {
    const result = await api.inspectFileCardWrite(resource, value.bindingId, value.requestId, signal);
    if (!valid(signal)) return;
    if (result.receipt.state === 'uncertain') { setError(true); return; }
    remember(); setConsent(false); await load(signal);
    if (valid(signal)) latest.current.onChanged?.();
    if (result.receipt.state === 'conflict') setError(true);
  };
  useEffect(() => {
    const controller = new AbortController(); life.current = controller;
    return () => controller.abort();
  }, [scope, epoch, resource]);
  useEffect(() => {
    const controller = life.current;
    queueMicrotask(() => { if (!controller.signal.aborted) void run(async signal => {
      const raw = sessionStorage.getItem(key);
      let saved: Pending | undefined;
      if (raw) {
        saved = JSON.parse(raw) as Pending;
        if (!saved || Object.keys(saved).sort().join(',') !== 'bindingId,requestId,revision'
          || !validBoardUuid(saved.bindingId) || !validBoardUuid(saved.requestId) || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw Error('Invalid archive sync receipt');
        setPending(saved);
      }
      await load(signal);
      if (saved && valid(signal)) await settle(saved, signal);
    }); });
  }, [scope, epoch, resource, paused]);
  const observed = useRef(0);
  useEffect(() => {
    if (!notice || busy || paused || observed.current === notice) return;
    observed.current = notice;
    void run(async signal => {
      await load(signal);
      if (pending && valid(signal)) await settle(pending, signal);
      if (valid(signal)) latest.current.onChanged?.();
    });
  }, [notice, busy, paused]);
  const inspect = () => void run(async signal => {
    if (!pending) return;
    await settle(pending, signal);
  });
  const upgrade = () => void run(async signal => {
    if (!state?.binding || state.full || !consent || pending || latest.current.ready?.() === false) return;
    const value = { bindingId: state.binding.bindingId, requestId: crypto.randomUUID(), revision: state.revision };
    remember(value); // Persist BEFORE POST; an unknown result is queried, never resent.
    const result = await api.includeFileCardArchive(resource, value.bindingId, { requestId: value.requestId, revision: value.revision }, signal);
    if (!valid(signal)) return;
    if ('notAdmitted' in result) {
      remember(); setConsent(false); await load(signal); setError(true); return;
    }
    if (result.receipt.state !== 'uncertain') remember();
    setConsent(false); await load(signal); if (valid(signal)) latest.current.onChanged?.();
    if (result.receipt.state !== 'saved') setError(true);
  });
  // Normal synchronized state needs no permanent explanatory banner.
  // Keep explicit legacy-scope consent and original-request recovery available.
  if (!pending && !error && (!state || state.full || (!state.binding && !apiAccess))) return null;
  return <section className="notebook-file-sync">
    {pending && <p>{t('Archive sync outcome pending. Check the original request; it will not be resent.')}</p>}
    {state?.binding && !state.full && !pending && <>
      <label><input name="notebookfilesync-input-1" type="checkbox" checked={consent} disabled={paused || busy || state.binding.state !== 'active'} onChange={e => setConsent(e.target.checked)} />{t('Include this private archive in the existing Agent file binding.')}</label>
      <button type="button" disabled={paused || busy || !consent || state.binding.state !== 'active'} onClick={upgrade}>{t('Include archive in file sync')}</button>
    </>}
    {pending && <button type="button" disabled={paused || busy} onClick={inspect}>{t('Check original receipt')}</button>}
    {error && <><p role="status">{t('Archive sync could not be confirmed. Content is retained; inspect the original request or check Connector support.')}</p><button type="button" disabled={paused || busy} onClick={() => void run(load)}>{t('Refresh')}</button></>}
    {apiAccess && !pending && state && !state.full && <details onToggle={e => { if (e.currentTarget.open) setAccess(true); }}>
      <summary>{t('Standalone notebook API access (optional)')}</summary>
      {access && <Suspense fallback={null}><AgentAccess sessionKey={sessionKey} id={id} onClose={() => setAccess(false)} /></Suspense>}
    </details>}
  </section>;
}
