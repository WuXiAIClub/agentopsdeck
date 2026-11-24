import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './button';
import { useI18n } from '../../lib/i18n';

let editing = false;
/** Native modal focus trap, app styling; retain the draft when a save fails. */
export function editText({ title, initial, maxLength, onSave }: { title: string; initial: string; maxLength: number; onSave: (text: string) => Promise<void> }) {
  if (editing) return;
  editing = true;
  const previous = document.activeElement;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let closed = false;
  const finish = () => {
    if (closed) return; closed = true;
    root.unmount(); host.remove(); editing = false;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
  function Editor() {
    const dialog = useRef<HTMLDialogElement>(null);
    const pending = useRef(false);
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const { t } = useI18n();
    useEffect(() => {
      try { dialog.current?.showModal(); } catch { queueMicrotask(finish); }
      window.addEventListener('agentopsdeck:auth-required', finish);
      window.addEventListener('pagehide', finish);
      return () => { window.removeEventListener('agentopsdeck:auth-required', finish); window.removeEventListener('pagehide', finish); };
    }, []);
    return <dialog ref={dialog} className="action-dialog" aria-labelledby="edit-text-title" onCancel={event => { event.preventDefault(); if (!pending.current) finish(); }}>
      <form onSubmit={async event => {
        event.preventDefault(); if (!draft.trim() || pending.current) return;
        pending.current = true; setSaving(true); setError('');
        try { await onSave(draft.trim()); finish(); }
        catch (e) { if (!closed) setError(e instanceof Error ? e.message : String(e)); }
        finally { pending.current = false; if (!closed) setSaving(false); }
      }}>
        <h2 id="edit-text-title" className="mb-4 text-lg font-semibold">{title}</h2>
        <input name="edit-text-input-1" autoFocus required aria-label={title} maxLength={maxLength} value={draft} onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} className="w-full rounded-xl border border-slate-300 p-3 text-base outline-blue-500" />
        {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={finish}>{t('Cancel')}</Button><Button type="submit" disabled={saving || !draft.trim()}>{t(saving ? 'Saving…' : 'Save changes')}</Button></div>
      </form>
    </dialog>;
  }
  root.render(<Editor />);
}
