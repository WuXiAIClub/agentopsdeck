import { useEffect, useRef, useState } from 'react';
import { createCommandKey } from '@agentopsdeck/shared';
import { api, ApiResponseError, json, recoveryEpoch, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';

type Snapshot = { title: string; canSend: boolean; turns: { id: string; prompt: string; response: string; active: boolean }[] };

export function AhpChat({ connectionId }: { connectionId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [view, setView] = useState<Snapshot>();
  const [text, setText] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<'not-sent' | 'unknown'>();
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const path = `/api/hub/v1/connections/${encodeURIComponent(connectionId)}/ahp`;
  const pendingKey = `aod-ahp-pending:${connectionId}`;

  useEffect(() => {
    const epoch = recoveryEpoch();
    let active = true;
    void api.hubConnectionCapabilities(connectionId).then(caps => {
      if (active && epoch === recoveryEpoch()) setSupported(caps.features.vsCodeChat === true);
    }, () => { if (active) setSupported(false); });
    return () => { active = false; };
  }, [connectionId]);

  useEffect(() => {
    if (!open || !supported) return;
    const epoch = recoveryEpoch(), scope = recoveryScope(), identity = ++generation.current;
    const controller = new AbortController();
    try { if (window.sessionStorage.getItem(pendingKey)) setNotice('unknown'); }
    catch { setNotice('unknown'); }
    let timer: number | undefined;
    const refresh = async () => {
      if (epoch !== recoveryEpoch() || scope !== recoveryScope()) { setView(undefined); return; }
      try {
        const snapshot = await json<Snapshot>(path, { signal: controller.signal,
          ...(scope ? { headers: { 'X-AgentOpsDeck-Recovery-Scope': scope } } : {}) });
        if (identity !== generation.current || epoch !== recoveryEpoch() || scope !== recoveryScope()) return;
        setView(snapshot); setUnavailable(false);
      } catch (error) {
        if (identity !== generation.current) return;
        setView(undefined); setUnavailable(true);
        if (error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) return;
      }
      timer = window.setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => { generation.current++; controller.abort(); window.clearTimeout(timer); };
  }, [open, path, pendingKey, supported]);

  async function send() {
    const scope = recoveryScope();
    if (!scope || !view?.canSend || !text.trim() || inFlight.current || notice === 'unknown') return;
    const identity = generation.current, epoch = recoveryEpoch();
    const current = () => identity === generation.current && epoch === recoveryEpoch() && scope === recoveryScope();
    inFlight.current = true; setSending(true); setNotice(undefined);
    let key: string;
    try {
      if (window.sessionStorage.getItem(pendingKey)) {
        inFlight.current = false; setSending(false); setNotice('unknown');
        return;
      }
      key = createCommandKey(crypto.randomUUID());
      window.sessionStorage.setItem(pendingKey, key);
    } catch {
      inFlight.current = false; setSending(false); setNotice('not-sent');
      return;
    }
    try {
      await json<{ id: string }>(path, { method: 'POST', headers: {
        'Idempotency-Key': key, 'X-AgentOpsDeck-Recovery-Scope': scope,
      }, body: JSON.stringify({ text }) });
      if (window.sessionStorage.getItem(pendingKey) === key) window.sessionStorage.removeItem(pendingKey);
      if (current()) { setText(''); setView(previous => previous ? { ...previous, canSend: false } : previous); }
    } catch (error) {
      if (current()) setNotice('unknown');
    } finally {
      inFlight.current = false;
      if (identity === generation.current) setSending(false);
    }
  }

  if (!supported) return null;
  return <section className="mt-3 rounded-xl border p-2 sm:col-span-2">
    <Button type="button" size="sm" variant="secondary" aria-expanded={open} disabled={sending} onClick={() => setOpen(!open)}>
      {t(open ? 'Close VS Code chat' : 'Open VS Code chat')}
    </Button>
    {open && <div className="mt-2 space-y-2">
      {!view && <p role="status">{t(unavailable ? 'VS Code chat is unavailable on this Connector.' : 'Connecting to VS Code chat…')}</p>}
      {view && <>
        <h3 className="break-words font-semibold">{view.title}</h3>
        <div className="max-h-[26rem] space-y-2 overflow-auto" tabIndex={0} aria-label={t('Recent VS Code chat messages')}>
          {view.turns.map(turn => <div key={turn.id} className="space-y-1 border-b pb-2">
            <p className="whitespace-pre-wrap break-words font-semibold">{turn.prompt}</p>
            <p className="whitespace-pre-wrap break-words">{turn.response}</p>
            {turn.active && <p>{t('VS Code is processing this turn.')}</p>}
          </div>)}
        </div>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void send(); }}>
          <label className="block" htmlFor={`ahp-text-${connectionId}`}>{t('Message to VS Code')}</label>
          <textarea id={`ahp-text-${connectionId}`} className="w-full rounded-md border p-2" rows={3}
            value={text} onChange={event => setText(event.currentTarget.value)} disabled={sending} />
          <Button type="submit" size="sm" disabled={sending || !view.canSend || !text.trim() || notice === 'unknown'}>{t('Send to VS Code')}</Button>
        </form>
      </>}
      {notice && <p role="alert">{t(notice === 'unknown' ? 'Message may have been sent. Check VS Code before sending again.' : 'Message was not sent.')}</p>}
      {notice === 'unknown' && <Button type="button" size="sm" variant="secondary" disabled={sending} onClick={() => {
        try { window.sessionStorage.removeItem(pendingKey); setText(''); setNotice(undefined); }
        catch { setNotice('unknown'); }
      }}>{t('I checked VS Code')}</Button>}
    </div>}
  </section>;
}
