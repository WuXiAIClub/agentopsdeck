import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, RefreshCw, X } from 'lucide-react';
import { ResourceToolbar } from './ResourceToolbar';
import { api, ApiResponseError, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { browserAddress, browserPoint, type BrowserInput, type BrowserState } from '../lib/workspace-browser';
import './workspace-browser.css';
import { useFileCardSettings } from '../lib/workspace-file-card-context';

export function WorkspaceBrowser({ scope, active }: { scope: string; active: boolean }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<{ enabled: boolean; hosts: string[] }>();
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<'unsupported' | 'access' | 'network'>();
  const configRequest = useRef(0);
  const [state, setState] = useState<BrowserState>(), [address, setAddress] = useState('');
  const [image, setImage] = useState(''), [title, setTitle] = useState(''), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [paused, setPaused] = useState(false);
  useFileCardSettings('browser', { title: title || t('Browser card'), url: browserAddress(address) ?? '' }, value => setAddress(value.url), !busy);
  const root = useRef<HTMLElement>(null), screen = useRef<HTMLDivElement>(null), visible = useRef(false), alive = useRef(true), current = useRef<string | undefined>(undefined);
  const busyRef = useRef(false), seq = useRef(0), hash = useRef(''), activity = useRef(Date.now()), activeRef = useRef(active);
  const controller = useRef(new AbortController()), imageRef = useRef('');
  const addressEditing = useRef(false), wake = useRef<() => void>(() => {});
  const frameFlight = useRef<Promise<unknown>>(Promise.resolve()), inputChain = useRef<Promise<unknown>>(Promise.resolve()), pending = useRef(0);
  activeRef.current = active;
  const valid = () => alive.current && recoveryScope() === scope && !controller.current.signal.aborted;
  const discardImage = () => { if (imageRef.current) URL.revokeObjectURL(imageRef.current); imageRef.current = ''; setImage(''); hash.current = ''; };
  const stop = () => {
    const id = current.current; current.current = undefined;
    if (id) void api.browserStop(id).catch(() => {});
    setState(undefined); discardImage(); setTitle(''); setText('');
  };
  const loadConfig = async () => {
    const request = ++configRequest.current;
    setConfigLoading(true); setConfigError(undefined); setConfig(undefined);
    try {
      const value = await api.browserConfig(controller.current.signal);
      if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.hosts) || value.hosts.some(host => typeof host !== 'string')) throw new Error('Invalid browser config');
      if (valid() && request === configRequest.current) setConfig(value);
    } catch (cause) {
      if (valid() && request === configRequest.current) setConfigError(cause instanceof ApiResponseError
        ? [404, 501].includes(cause.status) ? 'unsupported' : [401, 403].includes(cause.status) ? 'access' : 'network' : 'network');
    } finally {
      if (valid() && request === configRequest.current) setConfigLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true; controller.current = new AbortController();
    setConfig(undefined); setState(undefined); setImage(''); imageRef.current = ''; hash.current = '';
    setTitle(''); setText(''); setAddress(''); setError(''); addressEditing.current = false;
    const observer = new IntersectionObserver(entries => { visible.current = !!entries[0]?.isIntersecting; });
    if (root.current) observer.observe(root.current);
    void loadConfig();
    return () => {
      alive.current = false; controller.current.abort(); observer.disconnect();
      const id = current.current; current.current = undefined;
      if (id) void api.browserStop(id).catch(() => {});
      if (imageRef.current) URL.revokeObjectURL(imageRef.current);
    };
  }, [scope]);
  const start = async () => {
    if (!valid() || busyRef.current || !config?.enabled) return;
    busyRef.current = true; setBusy(true); setError('');
    const id = crypto.randomUUID(); current.current = id;
    try {
      const result = await api.browserStart(id, controller.current.signal);
      if (!valid() || current.current !== id) { void api.browserStop(id).catch(() => {}); return; }
      seq.current = result.seq; activity.current = Date.now(); setState(result);
    } catch {
      if (valid()) { stop(); setError('Browser could not start. No page was opened.'); }
    } finally { busyRef.current = false; if (valid()) setBusy(false); }
  };
  useEffect(() => {
    if (!state) return;
    const id = state.id;
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (canceled || !valid() || current.current !== id) return;
      // No work for hidden cards/tabs, no overlapping frame + input requests.
      const idle = Date.now() - activity.current > 30_000;
      const suspend = document.hidden || !visible.current || (idle && !activeRef.current);
      setPaused(suspend);
      if (!suspend && !busyRef.current && !pending.current) {
        busyRef.current = true;
        let release!: () => void;
        frameFlight.current = new Promise<void>(resolve => { release = resolve; });
        try {
          const frame = await api.browserFrame(id, hash.current, controller.current.signal);
          if (canceled || !valid() || current.current !== id) return;
          setState(old => old?.url === frame.url ? old : { id, url: frame.url, seq: frame.seq, width: frame.width, height: frame.height });
          if (!addressEditing.current && frame.url !== 'about:blank') setAddress(frame.url);
          setTitle(frame.title); seq.current = Math.max(seq.current, frame.seq);
          if (frame.image) {
            if (frame.image.length > 1_400_000) throw Error('Frame too large');
            const bytes = Uint8Array.from(atob(frame.image), c => c.charCodeAt(0));
            const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
            if (imageRef.current) URL.revokeObjectURL(imageRef.current);
            imageRef.current = next; setImage(next);
          }
          hash.current = frame.hash;
        } catch (err) {
          if (!canceled && valid() && current.current === id && !(err instanceof ApiResponseError && err.status === 409)) {
            stop(); setError('Browser disconnected or expired. Page input was not retried.');
          }
        } finally { busyRef.current = false; release(); }
      }
      if (!canceled) timer = setTimeout(() => { void poll(); }, suspend ? 2000 : idle ? 15_000 : activeRef.current ? 1200 : 5000);
    };
    // Wake after input even if the next idle refresh was scheduled far away.
    // The server capture floor is 750ms; never spin on a busy frame.
    wake.current = () => { clearTimeout(timer); timer = setTimeout(() => { void poll(); }, 800); };
    void poll();
    return () => { canceled = true; clearTimeout(timer); wake.current = () => {}; };
  }, [state?.id, scope]);
  const act = (input: BrowserInput): Promise<boolean> => {
    const id = current.current;
    if (!id || !valid()) return Promise.resolve(false);
    if (pending.current >= 32) { setError('Browser action was not accepted. Check the address or try again.'); return Promise.resolve(false); }
    pending.current++; setBusy(true); setError(''); activity.current = Date.now();
    const task = inputChain.current.then(async () => {
    await frameFlight.current;
    if (!valid() || current.current !== id) return false;
    busyRef.current = true;
    try {
      const result = await api.browserAction(id, ++seq.current, input, controller.current.signal);
      if (valid() && current.current === id) setState(result);
      return true;
    } catch (err) {
      if (valid() && current.current === id) {
        if (err instanceof ApiResponseError && [400, 409].includes(err.status)) setError('Browser action was not accepted. Check the address or try again.');
        else { stop(); setError('Browser disconnected or expired. Page input was not retried.'); }
      }
      return false;
    } finally { busyRef.current = false; }
    }).finally(() => { pending.current--; if (valid() && !pending.current) { setBusy(false); wake.current(); } });
    inputChain.current = task.catch(() => {});
    return task;
  };
  const actRef = useRef(act); actRef.current = act;
  useEffect(() => {
    const node = screen.current;
    if (!node) return;
    let delta = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => { event.preventDefault(); delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 720 : 1);
      if (!timer) timer = setTimeout(() => { const dy = Math.max(-1440, Math.min(1440, delta)); delta = 0; timer = undefined; void actRef.current({ kind: 'scroll', dy }); }, 120); };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); clearTimeout(timer); };
  }, [state?.id]);
  return <section ref={root} className="workspace-browser" aria-label={t('Browser card')} onPointerMove={() => { activity.current = Date.now(); }}>
    <ResourceToolbar><form className="workspace-browser-toolbar" onSubmit={event => { event.preventDefault(); const url = browserAddress(address);
      if (!url) { setError('Enter a valid HTTPS website address.'); return; } void act({ kind: 'navigate', url }); }}>
      <button type="button" disabled={!state || busy} aria-label={t('Back')} title={t('Back')} onClick={() => void act({ kind: 'back' })}><ArrowLeft size={14} /></button>
      <button type="button" disabled={!state || busy} aria-label={t('Forward')} title={t('Forward')} onClick={() => void act({ kind: 'forward' })}><ArrowRight size={14} /></button>
      <button type="button" disabled={!state || busy} aria-label={t('Refresh website')} title={t('Refresh website')} onClick={() => void act({ kind: 'reload' })}><RefreshCw size={14} /></button>
      <input name="workspacebrowser-input-1" aria-label={t('Website address')} value={address} placeholder={t('HTTPS website address')} autoComplete="off" spellCheck={false} maxLength={4096}
        onFocus={() => { addressEditing.current = true; }} onBlur={() => { addressEditing.current = false; }} onChange={event => setAddress(event.target.value)} />
      <button type="submit" disabled={!state || busy} aria-label={t('Go to website')} title={t('Go to website')}><Globe size={15} /></button>
      {state && <button type="button" aria-label={t('Close browser')} title={t('Close browser')} onClick={stop}><X size={14} /></button>}
    </form></ResourceToolbar>
    {!state && <div className="workspace-browser-empty">
      <Globe size={26} /><strong>{t(config && !config.enabled ? 'Browser setup required' : 'Browser card')}</strong>
      {config?.enabled ? <><p>{t('Isolated browser · cookies are cleared when closed. Do not enter sensitive credentials.')}</p>
        <button type="button" disabled={busy} onClick={() => void start()}>{busy ? t('Loading…') : t('Start browser')}</button>
        <small>{t('Allowed websites')}: {config.hosts.join(', ')}</small></>
        : configLoading ? <p role="status">{t('Loading…')}</p>
          : <><p role={configError ? 'alert' : 'status'}>{configError === 'unsupported'
            ? t('This Hub version does not provide the browser service yet. Update the Hub backend, then retry.')
            : configError === 'access' ? t('Browser access is not authorized for this account. Ask the Hub operator to grant access.')
              : configError ? t('Browser configuration could not be loaded. Check the connection and retry; no browser was started.')
                : t('The card is ready, but browser runtime or account access has not been enabled on this Hub.')}</p>
            {!configError && <small>{t('An operator must connect an isolated browser runtime and configure allowed users and websites. Refreshing this card cannot enable the service.')}</small>}
            <button type="button" onClick={() => void loadConfig()}>{t(configError ? 'Retry' : 'Check configuration again')}</button></>}
    </div>}
    {error && <p role="alert" className="workspace-browser-error">{t(error as 'Browser configuration could not be loaded.')}</p>}
    {state && <>
      <div className="workspace-browser-location" title={state.url}><span>{title || state.url}</span><small>{paused ? t('Browser updates paused') : busy ? t('Loading…') : t('Isolated browser')}</small></div>
      <div ref={screen} className="workspace-browser-screen" tabIndex={0} aria-label={t('Interactive browser page')}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
            event.preventDefault(); event.stopPropagation(); void act({ kind: 'key', key: 'ControlOrMeta+A' }); return;
          }
          if (event.nativeEvent.isComposing || event.repeat || event.altKey || event.metaKey || event.ctrlKey) return;
          if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            // Tab is intentionally allowed to leave the screen. Text input below
            // supports IME/paste without intercepting global workspace shortcuts.
            if (event.key === 'Tab') return;
            event.preventDefault(); event.stopPropagation(); void act({ kind: 'key', key: event.key });
          } else if (event.key.length === 1) {
            event.preventDefault(); event.stopPropagation(); void act({ kind: 'text', text: event.key });
          }
        }}>
        {image ? <img src={image} alt={t('Interactive browser page')} draggable={false} onClick={event => {
          event.currentTarget.parentElement?.focus(); const point = browserPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
          if (point) void act({ kind: 'click', ...point });
        }} /> : <p role="status">{t('Loading…')}</p>}
      </div>
      <form className="workspace-browser-input" onSubmit={event => { event.preventDefault(); const value = text;
        if (value) void act({ kind: 'text', text: value }).then(ok => { if (ok && valid()) setText(old => old === value ? '' : old); }); }}>
        <input name="workspacebrowser-input-2" aria-label={t('Type into website')} placeholder={t('Click a page field, then type here')} value={text} maxLength={4000} autoComplete="off" onChange={event => setText(event.target.value)} />
        <button type="submit" disabled={busy || !text}>{t('Insert text')}</button>
        <button type="button" disabled={busy} onClick={() => void act({ kind: 'key', key: 'Enter' })}>↵</button>
        <button type="button" disabled={busy} aria-label={t('Scroll page up')} onClick={() => void act({ kind: 'scroll', dy: -500 })}>↑</button>
        <button type="button" disabled={busy} aria-label={t('Scroll page down')} onClick={() => void act({ kind: 'scroll', dy: 500 })}>↓</button>
      </form>
    </>}
  </section>;
}
