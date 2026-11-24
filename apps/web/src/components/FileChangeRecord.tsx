import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@agentopsdeck/shared';
import { api } from '../api';
import { useI18n } from '../lib/i18n';
import { recordedFileDiff } from '../lib/session-files';

/** One explicit, message-bound detail read; unmount discards all body data. */
export function FileChangeRecord({ sessionKey, messageId, path, time }: { sessionKey: string; messageId: string; path: string; time?: number | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [message, setMessage] = useState<ChatMessage>();
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { request.current?.abort(); }, []);
  const load = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setFailed(false); setMessage(undefined);
    try {
      const result = await api.sessionMessageDetail(sessionKey, messageId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.message.sessionKey !== sessionKey || result.message.id !== messageId) throw new Error('File evidence changed');
      setMessage(result.message);
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const diff = message && recordedFileDiff(message, sessionKey, messageId, path);
  return <div className="file-change-record">
    <button type="button" aria-expanded={open} onClick={() => {
      if (open) { request.current?.abort(); setOpen(false); setLoading(false); setMessage(undefined); }
      else { setOpen(true); if (!message) void load(); }
    }}>{t('Recorded change')}{time ? ` · ${new Date(time).toLocaleString()}` : ''}</button>
    {open ? <div>
      <small>{t('Source message')}: {messageId}</small>
      {loading ? <p role="status">{t('Reading recorded change…')}</p> : null}
      {failed ? <p role="status">{t('Recorded change unavailable. Close and reopen to retry.')}</p> : null}
      {message ? diff ? <><p>{t('Historical tool diff · not the current file')}</p><pre>{diff.split('\n').map((line, i, lines) => <span key={i} className={line.startsWith('+') ? 'file-diff-add' : line.startsWith('-') ? 'file-diff-remove' : line.startsWith('@@') ? 'file-diff-hunk' : undefined}>{line}{i < lines.length - 1 ? '\n' : ''}</span>)}</pre></>
        : <p>{t('No complete structured diff was retained for this record. Current file preview is separate.')}</p> : null}
    </div> : null}
  </div>;
}
