import { useEffect, useRef, useState } from 'react';
import { api, recoveryEpoch, recoveryScope, type HubExecutionIssuer, type HubNodeGrantPage } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { confirmAction } from './ui/confirm';
import { translate, useI18n, type TranslationKey } from '../lib/i18n';

export function ExecutionSetup({ connectionId, nodeVersion, busy, run }: {
  connectionId: string; nodeVersion: number; busy: boolean;
  run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<HubExecutionIssuer>();
  const [token, setToken] = useState('');
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pending = useRef(false), credentialRevision = useRef(0);
  const scope = recoveryScope();
  const epoch = recoveryEpoch();
  const identity = JSON.stringify([scope, epoch, connectionId, nodeVersion]);
  const currentIdentity = useRef(identity), currentBusy = useRef(busy);
  const generation = useRef(0);
  if (currentIdentity.current !== identity) generation.current++;
  const capturedGeneration = generation.current;
  currentIdentity.current = identity; currentBusy.current = busy;
  useEffect(() => {
    let active = true;
    const current = () => active && currentIdentity.current === identity && recoveryEpoch() === epoch;
    setState(undefined); setError(false); setToken(''); setConfirming(false); credentialRevision.current++;
    void api.hubExecutionIssuer(connectionId).then(result => { if (current()) setState(result); })
      .catch(() => { if (current()) setError(true); });
    const clear = () => { setToken(''); credentialRevision.current++; };
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('agentopsdeck:auth-required', clear);
    return () => { active = false; currentIdentity.current = ''; credentialRevision.current++;
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('agentopsdeck:auth-required', clear); };
  }, [identity]);
  // Assign in an effect as well: cleanup of the previous identity invalidates it.
  useEffect(() => { currentIdentity.current = identity; }, [identity]);
  async function confirm(description: TranslationKey, label: TranslationKey, operation: () => Promise<unknown>, credential = false) {
    if (pending.current || busy || !state || epoch !== recoveryEpoch()) return;
    const revision = credentialRevision.current;
    const current = () => currentIdentity.current === identity && generation.current === capturedGeneration && epoch === recoveryEpoch() && !currentBusy.current
      && (!credential || credentialRevision.current === revision);
    pending.current = true; setConfirming(true);
    try {
      if (!await confirmAction({ title: t('Change environment write access?'), description: t(description), confirmLabel: t(label) }) || !current()) return;
      await run(async () => {
        // Parent run callbacks can defer execution; recheck immediately before HTTP.
        if (currentIdentity.current !== identity || generation.current !== capturedGeneration || epoch !== recoveryEpoch()
          || (credential && credentialRevision.current !== revision)) return;
        if (credential) { setToken(''); credentialRevision.current++; }
        return operation();
      });
    } catch { if (currentIdentity.current === identity && epoch === recoveryEpoch()) setError(true); }
    finally { pending.current = false; if (currentIdentity.current === identity && epoch === recoveryEpoch()) setConfirming(false); }
  }
  const disabled = busy || confirming;
  return <section aria-label={t('Shared execution setup')} className="space-y-2 rounded-xl border bg-white p-3">
    <h5 className="font-bold">{t('Environment write access setup')}</h5>
    <p>{t("Enable member execution here, then assign roles in People & access. This does not grant access to everyone. Codex tools share this environment's files and credentials.")}</p>
    <p>{t('Enabling, replacing or disabling an issuer changes node authority. Existing grants require review and reauthorization; already-admitted work is not stopped.')}</p>
    {error ? <p>{t('Setup status unavailable. Close and reopen Member execution to retry.')}</p> : !state ? <p>{t('Checking setup availability…')}</p> : state.issuer ? <>
      <p>{t('Execution issuer configured.')}</p>
      {state.issuer.creationAllowed ? <p>{t('Member session creation infrastructure enabled. Each member still needs an explicit creation grant.')}</p>
        : state.localSetupAllowed ? <Button size="sm" disabled={disabled} onClick={() => void confirm(
          'Enable member Codex session creation? Replace the dedicated issuer with a new credential including sessions:create. Existing authorizations must be reviewed and saved again; no member receives creation permission automatically.',
          'Enable member session creation', () => api.hubSetupLocalExecution(connectionId, nodeVersion, true))}>{t('Enable member session creation')}</Button>
          : <p>{t('Session creation requires an operator-issued credential with sessions:create in addition to execution scopes.')}</p>}
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void confirm(
        'Disable shared execution for this environment? Existing grants require reauthorization. Already running tasks are not stopped.',
        'Disable shared execution', () => api.hubDisableExecution(connectionId))}>{t('Disable shared execution')}</Button>
    </> : <>
      {state.localSetupAllowed ? <Button size="sm" disabled={disabled} onClick={() => void confirm(
        'Enable member Codex sessions on this environment? Existing authorizations will need review. No member is granted access automatically. Tools use shared files and credentials.',
        'Enable member sessions', () => api.hubSetupLocalExecution(connectionId, nodeVersion, true))}>{t('Enable member sessions')}</Button>
        : <p>{t('Local provisioning is not enabled for this login/environment. A Connector operator can supply a dedicated issuer credential below.')}</p>}
      <details><summary>{t('Use an operator-issued credential')}</summary>
        <p>{t('Use a dedicated execution:delegate credential bound to this Hub, not your administrator login key or ordinary Connector token. Hub ID:')} <span className="break-all font-mono">{state.hubId}</span></p>
        <Input aria-label={t('Operator execution issuer token')} type="password" autoComplete="off" value={token} onChange={event => { credentialRevision.current++; setToken(event.target.value); }} disabled={disabled} />
        <Button size="sm" disabled={disabled || !token.trim()} onClick={() => void confirm(
          'Verify and save this dedicated issuer? Existing grants require reauthorization.', 'Verify and enable execution',
          () => api.hubConfigureExecution(connectionId, token), true)}>{t('Verify and enable execution')}</Button>
      </details>
    </>}
  </section>;
}

export function EnvironmentExecutionSettings({ connectionId }: { connectionId: string }) {
  const { t } = useI18n();
  const [page, setPage] = useState<HubNodeGrantPage>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const scope = recoveryScope(), epoch = recoveryEpoch(), active = useRef(false), pending = useRef(false);
  const identity = JSON.stringify([scope, epoch, connectionId]), latest = useRef(identity), generation = useRef(0);
  if (latest.current !== identity) { latest.current = identity; generation.current++; }
  const capturedGeneration = generation.current;
  const current = () => active.current && latest.current === identity && generation.current === capturedGeneration && epoch === recoveryEpoch();
  useEffect(() => {
    active.current = true;
    setPage(undefined); setError(''); setNotice(''); setBusy(false);
    void api.hubNodeGrants(connectionId).then(next => { if (current()) setPage(next); })
      .catch(() => { if (current()) setError('Environment setup unavailable. Close and reopen to retry.'); });
    return () => { active.current = false; };
  }, [identity]);
  async function run(operation: () => Promise<unknown>) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await operation();
      if (current()) setNotice('Environment setup saved. Review existing member authorizations; no member role was automatically granted.');
    } catch { if (current()) setError('Setup result unknown. Nothing was retried. Check current status before making another change.'); }
    finally {
      if (current()) {
        setPage(undefined);
        try { const next = await api.hubNodeGrants(connectionId); if (current()) { setPage(next); setRevision(value => value + 1); } }
        catch { if (current()) setError('Current setup unavailable. Close and reopen to check; do not repeat the write blindly.'); }
      }
      pending.current = false; if (current()) setBusy(false);
    }
  }
  return <div className="space-y-2 text-xs">
    {error ? <p role="alert" className="text-red-700">{translate(error)}</p> : null}
    {notice ? <p role="status" className="text-emerald-800">{translate(notice)}</p> : null}
    {page ? <ExecutionSetup key={`${page.nodeVersion}:${revision}`} connectionId={connectionId} nodeVersion={page.nodeVersion} busy={busy || !page.verified} run={run} /> : !error ? <p>{t('Checking member execution…')}</p> : null}
  </div>;
}
