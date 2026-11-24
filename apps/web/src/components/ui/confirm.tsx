import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './button';
import { useI18n } from '../../lib/i18n';

let confirming = false;
/** One modal at a time; cancel is the safe default. No mutation occurs here. */
export function confirmAction({ title, description, confirmLabel, signal }: {
  title: string; description: string; confirmLabel?: string; signal?: AbortSignal;
}): Promise<boolean> {
  if (confirming || signal?.aborted) return Promise.resolve(false);
  confirming = true;
  const previous = document.activeElement;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  return new Promise(resolve => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return; settled = true;
      root.unmount(); host.remove(); confirming = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(accepted && !signal?.aborted);
    };
    function Confirmation() {
      const { t } = useI18n();
      const dialog = useRef<HTMLDialogElement>(null);
      useEffect(() => {
        const cancel = () => finish(false);
        const abort = () => queueMicrotask(cancel);
        try { dialog.current?.showModal(); } catch { queueMicrotask(cancel); }
        window.addEventListener('agentopsdeck:auth-required', cancel);
        window.addEventListener('pagehide', cancel);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) queueMicrotask(cancel);
        return () => { window.removeEventListener('agentopsdeck:auth-required', cancel); window.removeEventListener('pagehide', cancel); signal?.removeEventListener('abort', abort); };
      }, []);
      return <dialog ref={dialog} className="action-dialog" aria-labelledby="action-dialog-title" aria-describedby="action-dialog-description"
        onCancel={event => { event.preventDefault(); finish(false); }} onClose={() => finish(false)}>
        <h2 id="action-dialog-title" className="text-lg font-semibold text-slate-950">{title}</h2>
        <p id="action-dialog-description" className="my-4 whitespace-pre-line text-sm leading-6 text-slate-600">{description}</p>
        <div className="flex justify-end gap-2"><Button autoFocus type="button" variant="secondary" onClick={() => finish(false)}>{t('Cancel')}</Button>
          <Button type="button" className="action-dialog-danger" onClick={() => finish(true)}>{confirmLabel ?? t('Delete')}</Button></div>
      </dialog>;
    }
    root.render(<Confirmation />);
  });
}
