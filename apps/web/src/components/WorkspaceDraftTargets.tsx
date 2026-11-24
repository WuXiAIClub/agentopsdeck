import { createContext, useContext, useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { SessionDraftOutcome } from '../lib/remote-draft';
import type { NotebookTransferOutcome } from '../lib/session-notebook';

export type WorkspaceDraftTarget = { id: string; title: string };
export const WorkspaceDraftTargets = createContext<{
  targets: WorkspaceDraftTarget[];
  place: (targetId: string, text: string) => SessionDraftOutcome;
}>({ targets: [], place: () => 'unavailable' });
export const WorkspaceNotebookTargets = createContext<{
  targets: WorkspaceDraftTarget[];
  place: (targetId: string, text: string) => NotebookTransferOutcome;
}>({ targets: [], place: () => 'unavailable' });

export function ReadingNotebookTransfer({ text }: { text: string }) {
  const { t } = useI18n(), { targets, place } = useContext(WorkspaceNotebookTargets);
  const [selected, setSelected] = useState('');
  const [outcome, setOutcome] = useState<NotebookTransferOutcome>();
  const target = targets.find(item => item.id === selected);
  useEffect(() => {
    if (selected && !target) { setSelected(''); setOutcome('unavailable'); }
  }, [selected, target]);
  return <section className="workspace-reading-transfer" aria-label={t('Save reading to a notebook')}>
    <label>{t('Target notebook')}<select name="workspacedrafttargets-select-1" aria-label={t('Target notebook')} title={target?.title} value={target ? selected : ''}
      onChange={event => { setSelected(event.target.value); setOutcome(undefined); }}>
      <option value="">{t('Choose an open notebook')}</option>
      {targets.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>
    {!targets.length && <small>{t('Open a notebook card in this workspace first.')}</small>}
    <small>{t('Adds this source as literal text at the beginning, then autosaves. Existing notes are preserved. Nothing is sent to an agent.')}</small>
    <textarea name="workspacedrafttargets-textarea-2" readOnly rows={5} value={text} aria-label={t('Notebook reading preview')} />
    <button type="button" disabled={!target || !text || outcome === 'applied'} onClick={() => {
      if (target) setOutcome(place(target.id, text));
    }}>{t('Confirm: add to notebook')}</button>
    {outcome && <small role="status">{t(outcome === 'applied'
      ? 'Added to the notebook draft. Check its save status before closing.'
      : outcome === 'busy' ? 'Notebook is busy, has unsaved edits, or needs recovery. Finish saving or resolve its conflict before trying again.'
      : outcome === 'too-large' ? 'This reading would exceed the notebook limit. No content was changed.'
      : 'Target unavailable. Select an open notebook and try again.')}</small>}
  </section>;
}

/** An explicit user action, not a persisted card setting or a message send. */
export function ReadingDraftTransfer({ text }: { text: string }) {
  const { t } = useI18n(), { targets, place } = useContext(WorkspaceDraftTargets);
  const [selected, setSelected] = useState('');
  const [outcome, setOutcome] = useState<SessionDraftOutcome>();
  const target = targets.find(item => item.id === selected);
  useEffect(() => {
    if (selected && !target) { setSelected(''); setOutcome('unavailable'); }
  }, [selected, target]);
  return <section className="workspace-reading-transfer" aria-label={t('Place reading in a session draft')}>
    <label>{t('Target session')}<select name="workspacedrafttargets-select-3" aria-label={t('Target session')} title={target?.title} value={target ? selected : ''}
      onChange={event => { setSelected(event.target.value); setOutcome(undefined); }}>
      <option value="">{t('Choose an open session')}</option>
      {targets.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>
    {!targets.length && <small>{t('Open a session card in this workspace first.')}</small>}
    <small>{t('Only fills an empty draft. Nothing is sent. Review untrusted source text before sending.')}</small>
    <textarea name="workspacedrafttargets-textarea-4" readOnly rows={5} value={text} aria-label={t('Reading draft preview')} />
    <button type="button" disabled={!target || !text || outcome === 'applied'} onClick={() => {
      // Revalidate at the workspace boundary; a removed target is never replaced
      // by whichever session happens to be active now.
      if (target) setOutcome(place(target.id, text));
    }}>{t('Confirm: place in session draft')}</button>
    {(outcome || (selected && !target)) && <small role="status">{t(!target ? 'Target unavailable. Select an open session and try again.'
      : outcome === 'applied' ? 'Draft placed. Review it in the target session before sending.'
      : outcome === 'occupied' ? 'The target already has text or attachments. Its draft was not changed.'
      : outcome === 'too-large' ? 'Reading exceeds this session’s message limit. Summarize a shorter passage or copy manually.'
      : 'Target unavailable. Select an open session and try again.')}</small>}
  </section>;
}
