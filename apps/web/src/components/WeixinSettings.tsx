import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { WeixinStatus } from '@agentopsdeck/shared';
import { api, recoveryEpoch, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { confirmAction } from './ui/confirm';

export default function WeixinSettings() {
  const { t } = useI18n();
  const [data, setData] = useState<WeixinStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [verify, setVerify] = useState(''), [stage, setStage] = useState(''), [clock, setClock] = useState(Date.now());
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const operation = useRef<AbortController | null>(null), alive = useRef(false);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current || !alive.current) return;
    const controller = new AbortController(), epoch = recoveryEpoch(); operation.current = controller; setBusy(true); setError(false);
    // API rejects changed recovery scope; the second guard also protects synthetic/late responses.
    const valid = () => alive.current && !controller.signal.aborted && epoch === recoveryEpoch();
    try { await action(controller.signal); }
    catch { if (valid()) { setData(null); setError(true); setStage(''); setVerify(''); } }
    finally { if (operation.current === controller) operation.current = null; if (valid()) setBusy(false); }
  }
  const accept = (value: WeixinStatus, signal: AbortSignal, epoch: number) => {
    if (alive.current && !signal.aborted && epoch === recoveryEpoch()) setData(value);
  };
  const refresh = () => run(async signal => { const epoch = recoveryEpoch(); accept(await api.weixinStatus(signal), signal, epoch); });
  const poll = () => run(async signal => {
    if (!data?.binding) return;
    const epoch = recoveryEpoch(), result = await api.weixinPoll(data.binding.id, verify || undefined, signal);
    if (alive.current && !signal.aborted && epoch === recoveryEpoch()) { accept(result.status, signal, epoch); setStage(result.state); setVerify(''); }
  });
  useEffect(() => {
    alive.current = true; void refresh();
    const clock = setInterval(() => setClock(Date.now()), 1000);
    const visibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    const unsubscribe = subscribeRecoveryScope(() => { operation.current?.abort(); operation.current = null; setData(null); setVerify(''); setStage(''); setBusy(false); setError(true); });
    return () => { alive.current = false; operation.current?.abort(); operation.current = null; clearInterval(clock); document.removeEventListener('visibilitychange', visibility); unsubscribe(); };
  }, []);
  const binding = data?.binding, expired = !!binding && binding.expiresAt <= clock;
  // Serial polling, only while an explicitly requested QR is on screen. No auto-create or auto-send.
  useEffect(() => {
    if (binding?.state !== 'qr' || expired || busy || error || stage === 'verify' || !visible) return;
    const timer = setTimeout(() => { void poll(); }, 2500); return () => clearTimeout(timer);
  }, [binding, expired, busy, error, stage, visible]);
  return <section className="weixin-settings mt-5 space-y-3" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3 className="font-semibold">{t('WeChat connection')}</h3>
    <p className="text-sm text-slate-600">{t('Bind by scanning. Uses your current Hub permissions; revoking the linked Key disables this connection. No message content is sent by default.')}</p>
    {error && <p role="alert">{t('WeChat result is unknown. Refresh status before another action; nothing is retried automatically.')}</p>}
    {data && !data.available && <p>{t('An encrypted Hub vault is required before binding WeChat.')}</p>}
    {data && !data.personalKey && !data.administratorKey && <p>{t('Sign in with a personal Hub Key or the administrator Key to bind. Passkey-only sessions cannot create a binding.')}</p>}
    {data?.administratorKey && <p>{t('This binding belongs to the shared administrator account. Changing the administrator Key disables it.')}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" disabled={busy} onClick={() => { void refresh(); }}>{t('Refresh WeChat status')}</Button>
      {data?.available && (data.personalKey || data.administratorKey) && !binding && <Button type="button" disabled={busy} onClick={() => { void run(async signal => { const epoch = recoveryEpoch(); setStage(''); accept(await api.weixinStart(crypto.randomUUID(), signal), signal, epoch); }); }}>{t('Create binding QR code')}</Button>}
      {binding && <Button type="button" variant="secondary" disabled={busy} onClick={() => { void run(async signal => {
        const epoch = recoveryEpoch();
        if (!await confirmAction({ title: t('Unlink WeChat?'), description: t('Removes credentials and subscriptions. Messages already accepted by WeChat cannot be recalled.'), confirmLabel: t('Unlink'), signal }) || signal.aborted || epoch !== recoveryEpoch()) return;
        await api.weixinRemove(binding.id, signal);
        if (!alive.current || signal.aborted || epoch !== recoveryEpoch()) return;
        accept(await api.weixinStatus(signal), signal, epoch);
        if (alive.current && !signal.aborted && epoch === recoveryEpoch()) { setStage(''); setVerify(''); }
      }); }}>{t('Unlink')}</Button>}
    </div>
    {binding?.state === 'creating' && <p>{t('QR creation has no confirmed result. Refresh status, or unlink before explicitly starting again.')}</p>}
    {expired && <p>{t('This binding has expired. Refresh status before starting again.')}</p>}
    {binding?.state === 'qr' && !expired && <div className="space-y-3">
      {binding.qrUrl && <QRCodeSVG value={binding.qrUrl} size={240} marginSize={4} title={t('Scan with WeChat')} style={{ maxWidth: '100%', height: 'auto', background: 'white' }} />}
      <p>{t('Scan with WeChat')} · {t('{value} seconds', { value: Math.max(0, Math.ceil((binding.expiresAt - clock) / 1000)) })}</p>
      {stage === 'scanned' && <p>{t('Scanned. Confirm in WeChat.')}</p>}
      {stage === 'verify' && <label>{t('WeChat verification code')}<input name="weixinsettings-input-1" inputMode="numeric" autoComplete="off" maxLength={8} value={verify} onChange={e => setVerify(e.target.value.replace(/\D/g, ''))} className="w-full rounded border p-2" /></label>}
      <Button type="button" variant="secondary" disabled={busy || stage === 'verify' && !/^\d{4,8}$/.test(verify)} onClick={() => { void poll(); }}>{t('Check scan result')}</Button>
    </div>}
    {binding?.state === 'bound' && !expired && <div className="space-y-2 text-sm">
      <p>{t('WeChat bound')} · {t('Subscriptions')}: {binding.subscriptions}</p>
      <p>{t(binding.contextReady ? 'Reply context is available.' : 'Send help to the bound bot in WeChat first to enable replies and notifications.')}</p>
      <p>{t('Commands: sessions, status ID, watch ID, unwatch ID, questions ID, answer CODE TEXT, allow CODE, deny CODE. stop ID then confirm CODE stops only the observed Codex turn.')}</p>
      <p>{t('questions explicitly sends question text to WeChat. Stop requires a second confirmation. Unknown delivery is never replayed.')}</p>
      {binding.receipt && <p>{t(binding.receipt.state === 'accepted' ? 'WeChat API accepted the message; this is not a read receipt.' : 'Last delivery is unknown; no automatic retry.')}</p>}
    </div>}
  </section>;
}
