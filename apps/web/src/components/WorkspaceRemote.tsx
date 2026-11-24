import { useEffect, useMemo, useRef, useState } from 'react';
import { REMOTE_TEXT_LIMIT, type RemoteDevice, type RemoteOutcome, type RemoteTarget } from '@agentopsdeck/shared';
import { api } from '../api';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { getSpeechRecognitionConstructor, getVoiceUnavailableReason, type SpeechRecognitionLike } from '../lib/session-utils';
import { formatElapsedDuration } from '../lib/live-session';
import { confirmAction } from './ui/confirm';

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
};

function parseHashQuery(): { device?: string; warroom: boolean } {
  if (typeof window === 'undefined') return { warroom: false };
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return { warroom: false };
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const dev = params.get('device') || undefined;
  const mode = params.get('mode');
  return { ...(dev ? { device: dev } : {}), warroom: mode === 'warroom' || mode === 'tactical' };
}

function formatCompactTokens(tokens?: number): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export default function WorkspaceRemote() {
  const { t } = useI18n();
  const initialParams = useMemo(() => parseHashQuery(), []);
  const [devices, setDevices] = useState<RemoteDevice[]>([]), [id, setId] = useState(initialParams.device ?? ''), [target, setTarget] = useState('');
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState<TranslationKey | ''>(''), [listening, setListening] = useState(false);
  const [picker, setPicker] = useState(false), [filter, setFilter] = useState('');
  const [warRoom, setWarRoom] = useState(initialParams.warroom);
  const [alwaysOn, setAlwaysOn] = useState(initialParams.warroom);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const uncertain = useRef(false);
  const device = devices.find(d => d.id === id), selected = device?.targets.find(item => item.id === target);
  const pending = useRef(false), abort = useRef<AbortController | undefined>(undefined), mic = useRef<SpeechRecognitionLike | undefined>(undefined);
  const mounted = useRef(true);
  const refreshVersion = useRef(0);
  const screen = useRef<HTMLElement>(null);

  useEffect(() => {
    // Mobile keyboards may shrink only the visual viewport, not 100dvh.
    const viewport = window.visualViewport;
    const resize = () => screen.current?.style.setProperty('--remote-viewport-height', `${viewport?.height ?? innerHeight}px`);
    resize(); viewport?.addEventListener('resize', resize); window.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); };
  }, []);

  // Screen WakeLock management for War-Room Always-Display mode
  useEffect(() => {
    let cancelled = false;
    async function acquireWakeLock() {
      if (!alwaysOn || document.hidden) return;
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
      if (!nav.wakeLock?.request) return;
      try {
        const sentinel = await nav.wakeLock.request('screen');
        if (cancelled) {
          await sentinel.release().catch(() => {});
          return;
        }
        wakeLockRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener?.('release', () => {
          if (!cancelled) setWakeLockActive(false);
        });
      } catch {
        if (!cancelled) setWakeLockActive(false);
      }
    }
    async function releaseWakeLock() {
      const current = wakeLockRef.current;
      wakeLockRef.current = null;
      setWakeLockActive(false);
      if (current) await current.release().catch(() => {});
    }
    if (alwaysOn) {
      void acquireWakeLock();
    } else {
      void releaseWakeLock();
    }
    const onVisibility = () => {
      if (!document.hidden && alwaysOn) void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void releaseWakeLock();
    };
  }, [alwaysOn]);

  const stopMic = () => { const recognition = mic.current; mic.current = undefined; recognition?.abort(); setListening(false); };
  async function refresh(signal?: AbortSignal) {
    const version = ++refreshVersion.current;
    const result = await api.remoteDevices(signal);
    if (mounted.current && !signal?.aborted && version === refreshVersion.current) {
      setDevices(result.devices);
      setId(current => result.devices.some(d => d.id === current) ? current : result.devices.length === 1 ? result.devices[0]!.id : '');
    }
  }
  useEffect(() => {
    setTarget(current => device?.targets.some(item => item.id === current) ? current : device?.active ?? device?.targets[0]?.id ?? '');
  }, [device]);

  const pollIntervalMs = warRoom ? 4000 : 15000;
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setNotice('Remote unavailable. Refresh the device list.'); });
    const stop = () => { ++refreshVersion.current; controller.abort(); abort.current?.abort(); stopMic(); setDevices([]); setText(''); setTarget(''); setId(''); };
    const onVisibility = () => {
      if (document.hidden) stopMic();
      else if (!pending.current) void refresh(controller.signal).catch(() => {});
    };
    window.addEventListener('agentopsdeck:auth-required', stop); window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => { if (!document.hidden && !pending.current) void refresh(controller.signal).catch(() => {}); }, pollIntervalMs);
    return () => { clearInterval(timer); mounted.current = false; controller.abort(); abort.current?.abort(); mic.current?.abort(); mic.current = undefined;
      window.removeEventListener('agentopsdeck:auth-required', stop); window.removeEventListener('pagehide', stop); document.removeEventListener('visibilitychange', onVisibility); };
  }, [pollIntervalMs]);

  const outcomes: Record<RemoteOutcome, TranslationKey> = { applied: 'Applied on desktop. Nothing sent to the Agent.', occupied: 'Desktop input already has a draft. Nothing overwritten.', unavailable: 'Panel changed or is unavailable. Refresh the device list.', unknown: 'Result unconfirmed. Check the desktop; do not resend automatically.' };
  async function send(action: 'focus' | 'draft' | 'send', targetId = target, overrideText?: string) {
    const payloadText = overrideText ?? text;
    if (pending.current || !device || !targetId) return;
    if (action === 'send' && device.targets.find(item => item.id === targetId)?.kind !== 'session') return;
    if (action === 'send' && uncertain.current && !await confirmAction({ title: t('Send again?'), description: t('The previous message may already be running. Check the desktop first. Sending again can duplicate it.'), confirmLabel: t('Send again') })) return;
    if (pending.current || !mounted.current) return;
    stopMic(); ++refreshVersion.current; pending.current = true; setBusy(true); setNotice('');
    const controller = new AbortController(); abort.current = controller;
    try {
      const response = await api.remoteCommand(device.id, { id: crypto.randomUUID(), revision: device.revision, sequence: device.sequence + 1, action, target: targetId,
        ...(action !== 'focus' ? { text: payloadText } : {}) }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setNotice(action === 'send' && response.result === 'applied' ? 'Message accepted. It may be queued while the Agent is busy.' : outcomes[response.result]);
      if (action === 'send') uncertain.current = response.result === 'unknown';
      if (action !== 'focus' && response.result === 'applied' && overrideText === undefined) setText('');
      // A later directory read failing must not downgrade an acknowledged send.
      // The next command is still sequence/revision checked by the mailbox.
      await refresh(controller.signal).catch(() => {});
    } catch { if (action === 'send') uncertain.current = true; if (mounted.current && !controller.signal.aborted) setNotice('Result unconfirmed. Check the desktop; do not resend automatically.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function voice() {
    if (listening) { mic.current?.stop(); return; }
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition || getVoiceUnavailableReason()) { setNotice('Voice input unavailable'); return; }
    const recognition = new Recognition(), base = text;
    mic.current = recognition; recognition.lang = navigator.language || 'zh-CN'; recognition.continuous = false; recognition.interimResults = true;
    recognition.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      if (mic.current !== recognition) return;
      let transcript = ''; for (let index = 0; index < event.results.length; index++) transcript += event.results[index]?.[0]?.transcript ?? '';
      setText([base, transcript].filter(Boolean).join('\n').slice(0, REMOTE_TEXT_LIMIT));
    };
    recognition.onerror = () => { if (mic.current === recognition) { mic.current = undefined; setListening(false); setNotice('Voice input unavailable'); } };
    recognition.onend = () => { if (mic.current === recognition) { mic.current = undefined; setListening(false); } };
    try { recognition.start(); setListening(true); } catch { mic.current = undefined; setNotice('Voice input unavailable'); }
  }
  function select(next: string, apply = true) { stopMic(); setTarget(next); setPicker(false); setShowMatrix(false); setFilter(''); if (apply) void send('focus', next); }
  const index = device?.targets.findIndex(item => item.id === target) ?? -1;

  const telemetry = useMemo(() => {
    const targets = device?.targets ?? [];
    let running = 0, waiting = 0, unread = 0, tokens = 0;
    for (const item of targets) {
      if (item.status === 'running') running++;
      if (item.status === 'waiting' || item.status === 'error') waiting++;
      if (item.unread) unread++;
      if (item.tokens) tokens += item.tokens;
    }
    return { total: targets.length, running, waiting, unread, tokens };
  }, [device]);

  const statusBadge = (item?: RemoteTarget) => {
    if (!item || item.kind === 'notebook') return null;
    const st = item.status ?? 'idle';
    const label = st === 'running'
      ? `${t('Running')}${item.elapsedSec ? ` · ${formatElapsedDuration(item.elapsedSec)}` : ''}`
      : st === 'waiting'
        ? t('Waiting')
        : st === 'error'
          ? t('Failed')
          : t('Idle');
    return <span className={`remote-status-pill is-${st}`}>{label}</span>;
  };

  return <main ref={screen} className={`workspace-phone-remote${warRoom ? ' is-warroom' : ''}`}>
    <header>
      <div className="remote-header-title">
        <h1>{t('Phone remote')}</h1>
        <button
          type="button"
          className={`remote-warroom-toggle${warRoom ? ' is-active' : ''}`}
          aria-pressed={warRoom}
          onClick={() => {
            const next = !warRoom;
            setWarRoom(next);
            setAlwaysOn(next);
          }}
        >
          {warRoom ? `⚡ ${t('War-Room HUD')}` : t('War-Room HUD')}
        </button>
        {warRoom && (
          <button
            type="button"
            className={`remote-wakelock-pill${alwaysOn ? ' is-on' : ''}`}
            aria-pressed={alwaysOn}
            onClick={() => setAlwaysOn(v => !v)}
            title={t('Keep screen awake')}
          >
            {wakeLockActive ? `☀ ${t('Always-On')}` : alwaysOn ? t('WakeLock') : t('Dim allowed')}
          </button>
        )}
      </div>
      <a href="#/">{t('Back to workspace')}</a>
    </header>
    <div className="remote-device-row">
      <select name="workspaceremote-select-1" aria-label={t('Desktop device')} value={id} disabled={busy} onChange={e => { stopMic(); setId(e.target.value); setTarget(''); setPicker(false); setNotice(''); }}>
        <option value="">{t('Choose a device')}</option>
        {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      {device && (
        <button
          type="button"
          className={`remote-matrix-toggle${showMatrix ? ' is-open' : ''}`}
          aria-expanded={showMatrix}
          onClick={() => { setShowMatrix(v => !v); setPicker(false); }}
        >
          {t('Matrix')} ({telemetry.total})
        </button>
      )}
      <button type="button" aria-label={t('Refresh devices')} disabled={busy} onClick={() => { void refresh().catch(() => setNotice('Remote unavailable. Refresh the device list.')); }}>↻</button>
    </div>
    {!device && <p>{t('Enable remote control on your desktop, then choose it here. Use the same account.')}</p>}
    {device && <>
      <div className="remote-tactical-strip" aria-label={t('Tactical status summary')}>
        <span className={`remote-metric${telemetry.running > 0 ? ' is-running' : ''}`}>
          <b>{telemetry.running}</b> {t('Running')}
        </span>
        <span className={`remote-metric${telemetry.unread > 0 ? ' is-unread' : ''}`}>
          <b>{telemetry.unread}</b> {t('Unread')}
        </span>
        {telemetry.waiting > 0 && (
          <span className="remote-metric is-waiting">
            <b>{telemetry.waiting}</b> {t('Attention')}
          </span>
        )}
        {telemetry.tokens > 0 && (
          <span className="remote-metric">
            <b>{formatCompactTokens(telemetry.tokens)}</b> {t('Tokens')}
          </span>
        )}
      </div>
      <div className="remote-dial" role="group" aria-label={t('Panel dial')}>
        <button type="button" disabled={busy || !device.targets.length} aria-label={t('Previous panel')} onClick={() => select(device.targets[(index - 1 + device.targets.length) % device.targets.length]!.id)}>‹</button>
        <button type="button" className="remote-target-title" disabled={busy} aria-label={t('Choose a panel')} aria-expanded={picker} onClick={() => { setPicker(value => !value); setShowMatrix(false); }}>
          <strong>{selected?.title ?? t('Choose a panel')}</strong>
          <small>
            {index + 1} / {device.targets.length} · {t(selected?.kind === 'notebook' ? 'Notebook' : 'Session')}
            {selected?.unread ? ` · ● ${t('Unread')}` : ''} ▾
          </small>
        </button>
        <button type="button" disabled={busy || !device.targets.length} aria-label={t('Next panel')} onClick={() => select(device.targets[(index + 1) % device.targets.length]!.id)}>›</button>
      </div>
      {warRoom && selected && (selected.status || selected.snippet || selected.tokens) && !picker && !showMatrix && (
        <div className="remote-selected-telemetry">
          <div className="remote-selected-telemetry-top">
            {statusBadge(selected)}
            {selected.tokens ? <span className="remote-token-chip">{formatCompactTokens(selected.tokens)} {t('Tokens')}</span> : null}
            {selected.snippet ? <span className="remote-snippet-preview">{selected.snippet}</span> : null}
          </div>
          {selected.kind === 'session' && (
            <div className="remote-quick-presets" role="group" aria-label={t('Quick presets')}>
              {(['继续推进', '汇总当前进度', '跑核心测试验证'] as const).map(preset => (
                <button
                  key={preset}
                  type="button"
                  className="remote-preset-chip"
                  disabled={busy}
                  onClick={() => setText(current => current ? `${current}\n${preset}`.slice(0, REMOTE_TEXT_LIMIT) : preset)}
                >
                  +{preset}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="remote-editor-area">
      {showMatrix && (
        <section className="remote-target-matrix" aria-label={t('Live target matrix')}>
          <div className="remote-matrix-grid">
            {device.targets.map(item => (
              <button
                type="button"
                key={item.id}
                className={`remote-matrix-card${item.id === target ? ' is-active' : ''}${item.status === 'running' ? ' is-running' : ''}`}
                aria-pressed={item.id === target}
                onClick={() => select(item.id)}
              >
                <div className="remote-matrix-card-head">
                  <strong>{item.title}</strong>
                  {item.unread && <span className="remote-unread-dot" aria-label={t('Unread')} />}
                </div>
                <div className="remote-matrix-card-meta">
                  <small>{t(item.kind === 'notebook' ? 'Notebook' : 'Session')}</small>
                  {statusBadge(item)}
                  {item.tokens ? <small>{formatCompactTokens(item.tokens)} {t('Tokens')}</small> : null}
                </div>
                {item.snippet && <p className="remote-matrix-snippet">{item.snippet}</p>}
              </button>
            ))}
          </div>
        </section>
      )}
      {picker && <section className="remote-target-picker" aria-label={t('Choose a panel')}><input name="workspaceremote-input-2" autoFocus aria-label={t('Search panels')} placeholder={t('Search panels')} value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setPicker(false); }} /><div>{device.targets.filter(item => item.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(item => <button type="button" key={item.id} aria-pressed={item.id === target} onClick={() => select(item.id)}><span>{item.title}</span>{statusBadge(item)}<small>{t(item.kind === 'notebook' ? 'Notebook' : 'Session')}</small></button>)}</div></section>}
      <label>{t('Draft for selected panel')}<textarea name="workspaceremote-textarea-3" value={text} maxLength={REMOTE_TEXT_LIMIT} disabled={busy} rows={3} onChange={e => { stopMic(); setText(e.target.value); }} /></label>
      </div>
      <div className="remote-draft-actions"><button type="button" disabled={busy} aria-pressed={listening} onClick={voice}>{t(listening ? 'Stop voice input' : 'Start voice input')}</button>
        <button type="button" disabled={!selected || !text.trim() || busy || listening} onClick={() => void send('draft')}>{t('Transfer draft')}</button>
        {selected?.kind === 'session' && <button type="button" className="remote-send-button" disabled={!text.trim() || busy || listening} onClick={() => void send('send')}>{t('Send')}</button>}</div>
    </>}
    <p role="status">{busy ? t('Applying on desktop…') : notice ? t(notice) : ''}</p>
    <small className="remote-privacy-hint">{t('Voice uses the browser speech service. Only Send submits to the Agent; drafts are never overwritten.')}</small>
  </main>;
}
