import { useEffect, useRef, useState } from 'react';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { parseBindingReceipt } from '../lib/workspace-binding-receipt';
import { validDelegationBatch, type DelegationBatch } from '../lib/workspace-delegation';

/** Lazy metadata-only panel. The sole persisted browser value is the original
 * batch UUID, scoped to owner installation and board. Never persist grants or
 * automatically repeat a confirmation after lost responses/reload. */
export default function WorkspaceBoardDelegation({ scope, resourceId, taskIds, detail, minutes, selectionReady }: {
  scope: string; resourceId: string; taskIds: string[]; detail: boolean; minutes: number; selectionReady: boolean;
}) {
  const { t } = useI18n(), key = JSON.stringify(['board-delegation-v1', scope, resourceId]);
  const [pending, setPending] = useState(() => { try { return parseBindingReceipt(sessionStorage.getItem(key)); } catch { return undefined; } });
  const [batch, setBatch] = useState<DelegationBatch>(), [prefs, setPrefs] = useState<WorkspacePreferences>();
  const [names, setNames] = useState<Record<string, string>>({}), [group, setGroup] = useState(''), [tags, setTags] = useState('');
  const [mode, setMode] = useState<'all' | 'any'>('all'), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined), lock = useRef(false);
  const valid = (abort = controller.current) => scope === recoveryScope() && !!abort && controller.current === abort && !abort.signal.aborted;
  const accept = (value: DelegationBatch, id: string) => { if (!validDelegationBatch(value, id, resourceId)) throw Error('receipt mismatch'); setBatch(value); };
  const action = async (action: 'inspect' | 'confirm' | 'cancel', id = pending) => {
    if (!id || !valid() || lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    const abort = controller.current!;
    try {
      const result = await api.boardDelegation(resourceId, id, action, abort.signal);
      if (!valid() || controller.current !== abort) return;
      if (result.batch) accept(result.batch, id);
      else if (action === 'cancel' && result.cancelled === true && result.batchId === id) {
        sessionStorage.removeItem(key); setPending(undefined); setBatch(undefined);
      } else throw Error('Invalid receipt');
    }
    catch { if (valid(abort)) setError(true); }
    finally { if (controller.current === abort) { lock.current = false; if (valid(abort)) setBusy(false); } }
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; lock.current = false;
    void api.workspacePreferences(abort.signal).then(p => { if (valid(abort)) setPrefs(p); }).catch(() => { if (valid(abort)) setError(true); });
    void api.sessionsState().then(p => { if (valid(abort)) setNames(Object.fromEntries(p.groups.flatMap(g => g.sessions).map(s => [s.sessionKey, s.title]))); }).catch(() => {});
    if (pending) void action('inspect', pending);
    return () => { abort.abort(); };
  }, [scope, resourceId]);
  const selectedTags = [...new Set(tags.split(',').map(t => t.trim()).filter(Boolean))];
  const prepare = async () => {
    if (!valid() || lock.current || pending || !selectionReady || !taskIds.length || (!group && !selectedTags.length)) return;
    const abort = controller.current!, id = crypto.randomUUID();
    try { sessionStorage.setItem(key, id); setPending(id); } catch { setError(true); return; }
    lock.current = true; setBusy(true); setError(false);
    try {
      const result = await api.prepareBoardDelegation(resourceId, { batchId: id, selection: { ...(group ? { groupId: group } : {}), tags: selectedTags, tagMode: mode },
        taskIds: [...taskIds], fields: detail ? ['status', 'detail'] : ['status'], expiresAt: Date.now() + minutes * 60_000 }, abort.signal);
      if (valid(abort)) accept(result.batch, id);
    } catch { if (valid(abort)) setError(true); }
    finally { if (controller.current === abort) { lock.current = false; if (valid(abort)) setBusy(false); } }
  };
  const forget = () => {
    // Prepared batches have issued no grant, but must still be cancelled first.
    if (!batch || batch.state !== 'cancelled' || batch.members.some(m => m.state === 'cleanup_pending')) return;
    try { sessionStorage.removeItem(key); setPending(undefined); setBatch(undefined); setError(false); } catch { setError(true); }
  };
  return <section aria-label={t('Bind tasks by group or tags')}>
    <p>{t('Preview freezes up to 32 sessions and selected tasks. Confirming grants access only; it sends no message.')}</p>
    {error && <p role="alert">{t('Batch outcome unavailable. Inspect the original request; do not repeat confirmation.')}</p>}
    {busy && <p role="status">{t('Working…')}</p>}
    {!pending && <fieldset disabled={busy || !prefs || !selectionReady}>
      <label>{t('Group')}<select name="workspaceboarddelegation-select-1" value={group} onChange={e => setGroup(e.target.value)}><option value="">{t('No group filter')}</option>{prefs?.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
      <label>{t('Tags (comma separated)')}<input name="workspaceboarddelegation-input-2" value={tags} maxLength={263} onChange={e => setTags(e.target.value)} /></label>
      <label>{t('Tag matching')}<select name="workspaceboarddelegation-select-3" value={mode} onChange={e => setMode(e.target.value as 'all' | 'any')}><option value="all">{t('All selected tags')}</option><option value="any">{t('Any selected tag')}</option></select></label>
      <p>{t('Selected tasks: {count}', { count: taskIds.length })}</p>
      <button type="button" disabled={!taskIds.length || (!group && !selectedTags.length) || selectedTags.length > 8 || selectedTags.some(t => t.length > 32)} onClick={() => void prepare()}>{t('Preview batch grant')}</button>
    </fieldset>}
    {pending && <><p>{t('Original batch request')}: <code>{pending}</code></p>
      <button type="button" disabled={busy} onClick={() => void action('inspect')}>{t('Inspect batch')}</button>
      <button type="button" disabled={busy} onClick={() => void action('cancel')}>{t('Revoke batch and clean up')}</button>
      {batch && <><p>{t('Frozen task selection')}: {batch.preview.resource.tasks.map(t => t.title).join(' · ')}</p>
        <p>{batch.preview.resource.fields.includes('detail') ? t('Status and details') : t('Status only')} · {t('Expires at')} {new Date(batch.grantExpiresAt).toLocaleString()}</p>
        <ul>{batch.members.map(m => <li key={m.requestId}>{names[m.member.sessionId] ?? m.member.sessionId} · {t(memberLabels[m.state])}</li>)}</ul>
        {batch.state === 'prepared' && <button type="button" disabled={busy || Date.now() >= batch.preview.expiresAt} onClick={() => void action('confirm')}>{t('Confirm frozen batch')}</button>}
        {batch.state === 'cancelled' && !batch.members.some(m => m.state === 'cleanup_pending') && <button type="button" disabled={busy} onClick={forget}>{t('Start another batch')}</button>}
      </>}
    </>}
  </section>;
}
const memberLabels = { prepared: 'Binding prepared', dispatching: 'Binding outcome unconfirmed', installed: 'Session bound', rejected: 'Binding unavailable',
  unknown: 'Binding outcome unconfirmed', cancelled: 'Revoked', cleanup_pending: 'Remote cleanup pending', revoked: 'Revoked' } as const;
