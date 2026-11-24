import { useEffect, useRef, useState } from 'react';
import { json, recoveryEpoch, recoveryScope } from '../api';
import { sessionAddress } from '../lib/session-address';
import { useI18n } from '../lib/i18n';

type Facet = 'hot:read' | 'cold:read' | 'move';
type Grant = { id: string; facets: Facet[]; expiresAt: number; revokedAt: number | null };
/** Deliberate delegation only. The token lives in this mounted panel's memory,
 * never in a notebook, layout, draft, receipt or browser storage. */
export default function NotebookAgentAccess({ sessionKey, id, onClose }: { sessionKey?: string | undefined; id: string; onClose: () => void }) {
  const { t } = useI18n();
  const identity = useRef({ scope: recoveryScope(), epoch: recoveryEpoch(), invalid: false });
  const alive = useRef(true), lock = useRef(false);
  const [grants, setGrants] = useState<Grant[]>(), [busy, setBusy] = useState(false);
  const [facets, setFacets] = useState<Facet[]>([]), [confirmed, setConfirmed] = useState(false);
  const [secret, setSecret] = useState<{ id: string; token: string }>();
  const [message, setMessage] = useState(''), [uncertain, setUncertain] = useState(false);
  const path = `${sessionKey === undefined ? `/api/hub/v1/notebooks/${encodeURIComponent(id)}` : `${sessionAddress(sessionKey).path}/notebook`}/capabilities`;
  const valid = () => alive.current && !identity.current.invalid && identity.current.scope === recoveryScope() && identity.current.epoch === recoveryEpoch();
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { identity.current.invalid = true; setSecret(undefined); setGrants(undefined); setMessage('Reopen authorization after unlocking.'); };
    window.addEventListener('agentopsdeck:auth-required', invalidate);
    return () => { alive.current = false; window.removeEventListener('agentopsdeck:auth-required', invalidate); };
  }, []);
  const refresh = async () => {
    if (lock.current || !valid()) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const result = await json<{ capabilities: Grant[] }>(path, { cache: 'no-store' });
      if (!valid()) return;
      setGrants(result.capabilities); setUncertain(false);
      if (secret && !result.capabilities.some(g => g.id === secret.id && g.revokedAt === null && g.expiresAt > Date.now())) setSecret(undefined);
    } catch { if (valid()) { setGrants(undefined); setMessage('Unable to load grants. Refresh to verify the current state.'); } }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const issue = async () => {
    if (lock.current || !valid() || !confirmed || !facets.length || !grants || uncertain) return;
    lock.current = true; setBusy(true); setSecret(undefined); setMessage(''); setConfirmed(false);
    try {
      const result = await json<{ capability: Grant; token: string }>(path, { method: 'POST', cache: 'no-store', body: JSON.stringify({ facets, expiresAt: Date.now() + 3600000 }) });
      if (!valid()) return;
      setGrants(current => [...(current ?? []), result.capability]); setSecret({ id: result.capability.id, token: result.token });
    } catch { if (valid()) { setUncertain(true); setMessage('Grant outcome unconfirmed. Do not issue again yet. Refresh grants and revoke any unwanted grant; the token cannot be recovered.'); } }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const revoke = async (grantId: string) => {
    if (lock.current || !valid() || uncertain) return;
    lock.current = true; setBusy(true); setMessage('');
    if (secret?.id === grantId) setSecret(undefined);
    try {
      await json(path + '/' + encodeURIComponent(grantId), { method: 'DELETE', cache: 'no-store' });
      const result = await json<{ capabilities: Grant[] }>(path, { cache: 'no-store' });
      if (valid()) setGrants(result.capabilities);
    } catch { if (valid()) { setUncertain(true); setMessage('Revocation unconfirmed. Refresh grants to verify before taking further action.'); } }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const labels = { 'hot:read': 'Read hot notebook text', 'cold:read': 'Read cold archive text', move: 'Move text between hot and cold' } as const;
  return <section aria-label={t('Notebook Agent authorization')}>
    <header><strong>{t('Notebook Agent authorization')}</strong><button type="button" onClick={onClose}>{t('Close')}</button></header>
    <p>{t('No access by default. This grant covers only this notebook, expires in one hour, and does not start an Agent.')}</p>
    <p>{t('Revoking a login Key does not revoke these grants. Revoke each grant or wait for expiry. Revocation does not stop the Agent itself.')}</p>
    <button type="button" disabled={busy || !valid()} onClick={() => void refresh()}>{t('Refresh grants')}</button>
    <fieldset disabled={busy || !valid() || !grants || uncertain}>
      <legend>{t('Explicit notebook permissions')}</legend>
      {(['hot:read', 'cold:read', 'move'] as const).map(f => <label key={f}><input name="notebookagentaccess-input-1" type="checkbox" checked={facets.includes(f)}
        disabled={f === 'move' && (!facets.includes('hot:read') || !facets.includes('cold:read'))}
        onChange={e => { setConfirmed(false); setFacets(old => e.target.checked ? [...old, f] : old.filter(v => v !== f && (f === 'move' || v !== 'move'))); }} />{t(labels[f])}</label>)}
      <label><input name="notebookagentaccess-input-2" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('Confirm selected notebook permissions')}</label>
      <button type="button" disabled={!confirmed || !facets.length} onClick={() => void issue()}>{t('Issue notebook grant')}</button>
    </fieldset>
    {secret && <section aria-label={t('Once-only credential')}>
      <p>{t('Copy only to a trusted private credential store. Closing this panel clears this token. Never place it in chat, Git, URLs or logs. Anyone holding it can use this grant.')}</p>
      <button type="button" disabled={busy || uncertain || !valid() || !grants?.some(g => g.id === secret.id && g.revokedAt === null && g.expiresAt > Date.now())} onClick={() => {
        if (busy || uncertain || !valid() || !grants?.some(g => g.id === secret.id && g.revokedAt === null && g.expiresAt > Date.now())) { setSecret(undefined); return; }
        if (!navigator.clipboard) { setMessage('Clipboard unavailable. Keep this panel open and allow clipboard access, or revoke this grant.'); return; }
        void navigator.clipboard.writeText(secret.token).then(() => { if (valid()) setMessage('Copied'); }, () => { if (valid()) setMessage('Clipboard unavailable. Keep this panel open and allow clipboard access, or revoke this grant.'); });
      }}>{t('Copy grant token')}</button>
    </section>}
    <ul>{grants?.map(g => <li key={g.id}><code>{g.id}</code> {g.facets.map(f => t(labels[f])).join(', ')} — {t(g.revokedAt !== null ? 'Revoked grant' : g.expiresAt <= Date.now() ? 'Expired grant' : 'Active grant')}
      <button type="button" disabled={busy || uncertain || !valid() || g.revokedAt !== null} onClick={() => void revoke(g.id)}>{t('Revoke grant')}</button></li>)}</ul>
    {message && <p role="status">{t(message as Parameters<typeof t>[0])}</p>}
  </section>;
}
