import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GoalAction, GoalControl, GoalControlSnapshot } from '@agentopsdeck/shared';
import { api, recoveryScope, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { updateSettingsWithRecovery } from '../lib/session-settings';
import { mergeGoalNotice, type GoalNotice } from '../lib/goal-feedback';
import { CommandJournal, CommandNotSubmittedError, CommandRejectedError, isUnresolvedSettingsFence, recoverSavedCommand } from '../lib/command-recovery';
import { SessionGoal } from './SessionGoal';
import './session-goal-control.css';

export default function SessionGoalPanel({ sessionKey, close }: { sessionKey: string; close: () => void }) {
  const { t } = useI18n(), title = useId(), dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false), request = useRef<AbortController | undefined>(undefined);
  const operation = useRef(false);
  const [data, setData] = useState<GoalControlSnapshot>(), [busy, setBusy] = useState(false);
  const [objective, setObjective] = useState(''), [budget, setBudget] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<GoalNotice>('idle');
  const [receiptSaveFailed, setReceiptSaveFailed] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [pending, setPending] = useState(false), [storageOk, setStorageOk] = useState(true);
  const inspectJournal = () => {
    try {
      const scope = recoveryScope();
      if (!scope) throw new Error('No account');
      const rows = new CommandJournal(window.sessionStorage).list(scope, sessionKey, 'all');
      const unresolved = rows.some(isUnresolvedSettingsFence);
      setPending(unresolved); setStorageOk(true);
    } catch { setPending(true); setStorageOk(false); }
  };
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setData(undefined); setConfirmed(false); setReadFailed(false);
    try {
      const snapshot = await api.sessionGoal(sessionKey, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setData(snapshot); setObjective(snapshot.goal?.objectiveTruncated ? '' : snapshot.goal?.objective ?? '');
      setBudget(snapshot.goal?.tokenBudget == null ? '' : String(snapshot.goal.tokenBudget));
    } catch { if (alive.current && !controller.signal.aborted) setReadFailed(true); }
    finally { if (alive.current && !controller.signal.aborted) { setBusy(false); inspectJournal(); } }
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement, element = dialog.current;
    element?.showModal(); inspectJournal(); void load();
    const finish = () => close(), unsubscribe = subscribeRecoveryScope(finish);
    window.addEventListener('agentopsdeck:auth-required', finish);
    window.addEventListener('agentopsdeck:commands-changed', inspectJournal);
    return () => {
      alive.current = false; request.current?.abort(); unsubscribe(); element?.close();
      window.removeEventListener('agentopsdeck:auth-required', finish);
      window.removeEventListener('agentopsdeck:commands-changed', inspectJournal);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const act = async (action: GoalAction) => {
    if (!data || operation.current || busy || pending || !storageOk || !confirmed) return;
    const control: GoalControl = { action, expectedRevision: data.revision };
    if (action === 'create' || action === 'edit') {
      if (action === 'create' || objective !== (data.goal?.objectiveTruncated ? '' : data.goal?.objective ?? '')) control.objective = objective;
      if (budget !== '' && (action === 'create' || Number(budget) !== data.goal?.tokenBudget)) control.tokenBudget = Number(budget);
    }
    operation.current = true; setBusy(true); setConfirmed(false);
    try {
      await updateSettingsWithRecovery(sessionKey, { goal: control });
      if (alive.current) { setNotice('accepted'); await load(); }
    } catch (error) {
      if (alive.current) {
        setNotice(error instanceof CommandRejectedError ? 'rejected' : error instanceof CommandNotSubmittedError ? 'not-sent' : 'unknown');
        setData(undefined); // Any subsequent intent requires a fresh observation.
      }
    } finally { operation.current = false; if (alive.current) { setBusy(false); inspectJournal(); } }
  };
  const checkReceipt = async () => {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    try {
      const scope = recoveryScope(); if (!scope) throw new Error('No account');
      const journal = new CommandJournal(window.sessionStorage);
      let outcome: typeof notice = 'idle';
      setReceiptSaveFailed(false);
      for (const row of journal.list(scope, sessionKey, 'all').filter(row => row.settings && isUnresolvedSettingsFence(row))) {
        if (!alive.current || recoveryScope() !== scope) return;
        try {
          let released = false;
          const state = await recoverSavedCommand(journal, row, async () => {
            const value = await api.settingsCommand(sessionKey, row.key, scope);
            if (recoveryScope() !== scope) throw new Error('Account changed');
            released = value.command.settingsStartReleased === true;
            return value.command;
          }, () => { if (alive.current) setReceiptSaveFailed(true); });
          outcome = mergeGoalNotice(outcome, state === 'outcome_unknown' ? released ? 'released' : 'unknown' : state);
        } catch {
          // An unavailable original receipt does not starve independent ACKs.
          // Keep that row unresolved, and never retry a settings write.
          outcome = mergeGoalNotice(outcome, 'unknown');
        }
      }
      if (!alive.current || recoveryScope() !== scope) return;
      window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
      if (alive.current) { setNotice(outcome); await load(); }
    } catch { if (alive.current) setNotice('unknown'); }
    finally { operation.current = false; if (alive.current) { setBusy(false); inspectJournal(); } }
  };
  const validBudget = /^\d+$/.test(budget) && Number.isSafeInteger(Number(budget)) && Number(budget) > 0;
  const editedObjective = objective !== (data?.goal?.objectiveTruncated ? '' : data?.goal?.objective ?? '');
  const validEdit = (!editedObjective || !!objective.trim()) && (!budget || validBudget)
    && (editedObjective || budget !== '' && Number(budget) !== data?.goal?.tokenBudget);
  const unsaved = !!data?.goal && (editedObjective || budget !== '' && Number(budget) !== data.goal.tokenBudget);
  const disabled = busy || pending || !storageOk || !confirmed;
  return createPortal(<dialog ref={dialog} className="goal-control-dialog" aria-labelledby={title} onCancel={close} onClose={close}>
    <header><h2 id={title}>{t('Manage Codex Goal')}</h2><button type="button" autoFocus onClick={close} aria-label={t('Close')}><X size={18} /></button></header>
    <p>{t('Native Goal controls can continue work and spend tokens. They do not send a chat message.')}</p>
    <p>{t('Goal changes are checked before submission, not atomically locked against other native clients.')}</p>
    <p>{t('Pausing the goal does not confirm that the current turn or sub-agents have stopped.')}</p>
    <div role="status">{busy ? t('Loading…') : notice === 'accepted' ? t('Goal command acknowledged. Current state is read separately.')
      : notice === 'released' ? t('Original outcome remains unknown; starts were released by an audited recovery. Reload before a new change.')
      : notice === 'unknown' ? t('Goal change unconfirmed. Check the original receipt; do not repeat the change.')
      : notice === 'rejected' ? t('Goal change rejected. Reload the current goal before a new change.')
      : notice === 'not-sent' ? t('Goal change was not submitted. Check recovery storage and pending commands.') : null}</div>
    {receiptSaveFailed ? <p role="status">{t('Receipt checked, but browser recovery storage could not be updated. Nothing was resent; check again before refreshing.')}</p> : null}
    {readFailed ? <p role="status">{t('Current Goal state is unavailable. Reload explicitly; reading does not submit a change.')}</p> : null}
    {pending ? <p>{t('An unresolved settings change or deletion blocks new Goal changes.')}</p> : null}
    {!storageOk ? <p>{t('Goal change was not submitted. Check recovery storage and pending commands.')}</p> : null}
    {data ? <>{data.goal ? <SessionGoal goal={data.goal} /> : <p>{t('No native Goal is set.')}</p>}
      {data.goal?.objectiveTruncated ? <p>{t('The current objective is a preview. Leave the replacement blank to preserve the full objective.')}</p> : null}
      <label htmlFor={`${title}-objective`}>{t('Goal objective')}</label>
      <textarea id={`${title}-objective`} maxLength={2000} value={objective} disabled={busy || pending} onChange={e => { setObjective(e.target.value); setConfirmed(false); }} />
      <label htmlFor={`${title}-budget`}>{t('Goal token budget')}</label>
      <input id={`${title}-budget`} inputMode="numeric" value={budget} disabled={busy || pending} onChange={e => { setBudget(e.target.value); setConfirmed(false); }} />
      <p>{t('Budget is the total Goal token limit, not extra tokens. Enter a positive integer. Blank preserves an existing budget.')}</p>
      {unsaved ? <p role="status">{t('Unsaved objective or budget edits apply only with Save Goal changes. Pause, Resume and Clear use the current native Goal.')}</p> : null}
      <label className="goal-control-confirm"><input name="sessiongoalpanel-input-3" type="checkbox" checked={confirmed} disabled={busy || pending} onChange={e => setConfirmed(e.target.checked)} />{t('I authorize this Goal change, including native continuation when creating or resuming.')}</label>
      <div className="goal-control-actions">
        <button type="button" disabled={disabled || (data.goal ? !validEdit : !objective.trim() || !validBudget)} onClick={() => void act(data.goal ? 'edit' : 'create')}>{t(data.goal ? 'Save Goal changes' : 'Create Goal')}</button>
        {data.goal ? <><button type="button" disabled={disabled || data.goal.status === 'paused'} onClick={() => void act('pause')}>{t('Pause Goal')}</button>
          <button type="button" disabled={disabled || data.goal.status === 'active'} onClick={() => void act('resume')}>{t('Resume Goal')}</button>
          <button type="button" disabled={disabled} onClick={() => void act('clear')}>{t('Clear Goal')}</button></> : null}
      </div></> : null}
    <footer><button type="button" disabled={busy} onClick={() => { setNotice('idle'); void load(); }}>{t('Reload current Goal')}</button>
      {pending ? <button type="button" disabled={busy || !storageOk} onClick={() => void checkReceipt()}>{t('Check original settings receipt')}</button> : null}</footer>
  </dialog>, document.body);
}
