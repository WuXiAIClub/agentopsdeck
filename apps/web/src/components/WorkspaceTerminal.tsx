import { useEffect, useRef, useState } from 'react';
import { Play, Square, RefreshCw, TerminalSquare, ShieldAlert, LoaderCircle } from 'lucide-react';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, ApiResponseError, recoveryScope, type HubConnection } from '../api';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { useFileCardSettings } from '../lib/workspace-file-card-context';
import { readTerminalPreference, saveTerminalPreference, takeTerminalResume, type TerminalPreference } from '../lib/terminal-preferences';

const tabStorage = () => { try { return window.sessionStorage; } catch { return undefined; } };

type Live = { connection: string; id: string; controller: AbortController; sequence: number; buffer: string; sending: boolean; timer?: ReturnType<typeof setTimeout> };
type TerminalError = '' | 'access' | 'catalog' | 'start' | 'stream';
/** Terminal memory is intentionally outside layout persistence and chat caches. */
export default function WorkspaceTerminal({ scope, cardId }: { scope: string; cardId: string }) {
  const { t } = useI18n(), host = useRef<HTMLDivElement>(null), terminal = useRef<XTerminal | undefined>(undefined), fit = useRef<FitAddon | undefined>(undefined), live = useRef<Live | undefined>(undefined);
  const [saved] = useState(() => readTerminalPreference(tabStorage(), scope, cardId));
  const [connections, setConnections] = useState<HubConnection[]>([]), [connection, setConnection] = useState(saved?.connection ?? '');
  const [catalogReady, setCatalogReady] = useState(false), [reconnect, setReconnect] = useState(saved?.reconnect ?? true);
  const [targets, setTargets] = useState<{ id: string; label: string; kind: string }[]>([]), [target, setTarget] = useState('');
  const [busy, setBusy] = useState(true), [running, setRunning] = useState(false), [error, setError] = useState<TerminalError>(''), [reload, setReload] = useState(0);
  const [connectedBefore, setConnectedBefore] = useState(false);
  const mounted = useRef(false), starting = useRef<AbortController | undefined>(undefined);
  const desiredTarget = useRef<{ connection: string; target: string } | undefined>(saved);
  const autoResume = useRef<TerminalPreference | undefined>(undefined), leaving = useRef(false);
  const resolvedConnection = useRef('');
  const preferences = useRef<TerminalPreference>({ connection, target, reconnect, resume: false });
  preferences.current = { connection, target, reconnect, resume: false };
  const remember = (resume = false) => saveTerminalPreference(tabStorage(), scope, cardId, { ...preferences.current, resume });
  useFileCardSettings('terminal', { title: t('Connector terminal'), connectionId: connection, targetId: target }, value => {
    // File-backed configuration is declarative, never consent to start a shell.
    autoResume.current = undefined;
    resolvedConnection.current = '';
    desiredTarget.current = { connection: value.connectionId, target: value.targetId };
    setConnection(value.connectionId); setReload(value => value + 1);
  }, !busy && !running);
  usePageRefreshGuard(() => !live.current && !starting.current);
  const valid = () => mounted.current && recoveryScope() === scope;
  const stop = () => {
    autoResume.current = undefined;
    if (!leaving.current) remember(false);
    starting.current?.abort(); starting.current = undefined;
    const value = live.current; live.current = undefined;
    if (value) { clearTimeout(value.timer); value.controller.abort(); void api.terminalStop(value.connection, value.id).catch(() => {}); }
    if (mounted.current) { setRunning(false); setBusy(false); }
  };
  const fail = () => { stop(); if (valid()) setError('stream'); };
  const flush = async (value: Live) => {
    if (value.sending || live.current !== value || !valid() || !value.buffer) return;
    const data = value.buffer; value.buffer = ''; value.sending = true;
    try {
      const result = await api.terminalInput(value.connection, value.id, ++value.sequence, data, value.controller.signal);
      if (!result.accepted) throw Error('Input not confirmed');
    } catch { if (live.current === value) fail(); }
    finally { value.sending = false; if (live.current === value && value.buffer) value.timer = setTimeout(() => void flush(value), 40); }
  };
  useEffect(() => {
    mounted.current = true;
    leaving.current = false;
    autoResume.current = takeTerminalResume(tabStorage(), scope, cardId,
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload');
    const node = host.current!;
    const term = new XTerminal({ scrollback: 1000, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', cursorBlink: true, allowProposedApi: false,
      theme: { background: '#171e2b', foreground: '#e0e7f1', cursor: '#91bcff', selectionBackground: '#405a7e' } });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(node); terminal.current = term; fit.current = addon;
    const subscription = term.onData(data => {
      const value = live.current;
      if (!value || !valid()) return;
      if (value.buffer.length + data.length > 8192) { fail(); return; }
      value.buffer += data; clearTimeout(value.timer); value.timer = setTimeout(() => void flush(value), 40);
    });
    let resizeTimer: ReturnType<typeof setTimeout>, previous = '', resizing = false, resizeAgain = false;
    const resize = async () => {
      if (!valid() || !node.clientWidth || !node.clientHeight) return;
      addon.fit();
      const value = live.current, cols = Math.min(300, Math.max(20, term.cols)), rows = Math.min(120, Math.max(5, term.rows)), size = `${value?.id}:${cols}:${rows}`;
      if (!value || size === previous) return;
      if (resizing) { resizeAgain = true; return; }
      resizing = true;
      try { await api.terminalResize(value.connection, value.id, cols, rows, value.controller.signal); previous = size; }
      catch { if (live.current === value) fail(); }
      finally { resizing = false; if (resizeAgain && valid()) { resizeAgain = false; clearTimeout(resizeTimer); resizeTimer = setTimeout(() => void resize(), 0); } }
    };
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => void resize(), 150); }); observer.observe(node);
    const hide = () => {
      // Only a connected, explicitly opted-in card may reopen on refresh.
      remember(valid() && !!live.current && preferences.current.reconnect);
      leaving.current = true; stop();
    // Persist the handoff before tearing down this card's reads.
    }; window.addEventListener('pagehide', hide, true);
    return () => { mounted.current = false; stop(); clearTimeout(resizeTimer); observer.disconnect(); subscription.dispose(); term.dispose(); window.removeEventListener('pagehide', hide, true); terminal.current = undefined; fit.current = undefined; };
  }, [scope, cardId]);
  useEffect(() => { if (running) terminal.current?.focus(); }, [running]);
  useEffect(() => {
    const controller = new AbortController(); resolvedConnection.current = ''; setCatalogReady(false); setBusy(true); setError('');
    void api.websiteConnections(controller.signal).then(result => {
      if (controller.signal.aborted || !valid()) return;
      const available = result.connections.filter(c => c.status !== 'disabled'); setConnections(available);
      setConnection(current => available.some(c => c.id === current) ? current : '');
      setCatalogReady(true);
    }).catch(cause => { if (!controller.signal.aborted && valid()) { autoResume.current = undefined; setBusy(false); setError(cause instanceof ApiResponseError && cause.status === 403 ? 'access' : 'catalog'); } });
    return () => controller.abort();
  }, [scope, reload]);
  useEffect(() => {
    if (!catalogReady) return;
    const controller = new AbortController(); resolvedConnection.current = ''; setBusy(true); setError(''); setTargets([]); setTarget(''); setConnectedBefore(false);
    void (async () => {
      try {
        if (connection) {
          const result = await api.terminalTargets(connection, controller.signal);
          if (!controller.signal.aborted && valid()) {
            resolvedConnection.current = connection;
            setTargets(result.targets);
            // Prefer execution on this Connector. Never silently select an SSH host.
            const desired = desiredTarget.current;
            setTarget(desired?.connection === connection ? result.targets.find(item => item.id === desired.target)?.id ?? '' : result.targets.find(item => item.kind === 'local')?.id ?? '');
            desiredTarget.current = undefined;
          }
        }
      } catch (cause) { if (!controller.signal.aborted && valid()) { autoResume.current = undefined; setError(cause instanceof ApiResponseError && cause.status === 403 ? 'access' : 'catalog'); } }
      finally { if (!controller.signal.aborted && valid()) setBusy(false); }
    })();
    return () => controller.abort();
  }, [scope, connection, catalogReady]);
  useEffect(() => { if (!leaving.current && !busy && connection && target && !error) remember(false); }, [connection, target, reconnect, busy, error]);
  const start = async () => {
    if (!valid() || !catalogReady || resolvedConnection.current !== connection || !connection || !target || busy || error || live.current || starting.current) return;
    autoResume.current = undefined; remember(false);
    const controller = new AbortController(); starting.current = controller; setBusy(true); setError('');
    try {
      fit.current?.fit();
      const result = await api.terminalStart(connection, target, Math.min(300, Math.max(20, terminal.current?.cols ?? 80)), Math.min(120, Math.max(5, terminal.current?.rows ?? 24)), controller.signal);
      if (controller.signal.aborted || !valid()) { void api.terminalStop(connection, result.id).catch(() => {}); return; }
      const value: Live = { connection, id: result.id, controller, sequence: 0, buffer: '', sending: false }; live.current = value; starting.current = undefined;
      terminal.current?.reset(); setBusy(false); setRunning(true); setConnectedBefore(true);
      let cursor = 0;
      while (live.current === value && valid() && !controller.signal.aborted) {
        const result = await api.terminalOutput(connection, value.id, cursor, controller.signal);
        if (live.current !== value || !valid()) break;
        if (result.truncated) terminal.current?.writeln(`\r\n[${t('Older terminal output was discarded.')} ]`);
        // Back-pressure: wait for the emulator to consume the batch before reading more.
        await new Promise<void>(resolve => {
          const done = () => { controller.signal.removeEventListener('abort', done); resolve(); };
          controller.signal.addEventListener('abort', done, { once: true });
          if (terminal.current && !controller.signal.aborted) terminal.current.write(result.data, done); else done();
        });
        cursor = result.cursor;
        if (!result.running && !result.more) { stop(); break; }
      }
    } catch (cause) {
      // Chromium may reject in-flight fetches between pagehide listeners.
      // Let the event finish so its refresh handoff wins over stream failure;
      // this defers error reporting one task, never retries I/O or input.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (!controller.signal.aborted && valid()) {
        const phase = live.current ? 'stream' : 'start';
        stop(); setError(cause instanceof ApiResponseError && cause.status === 403 ? 'access' : phase);
      }
    }
    finally { if (starting.current === controller) starting.current = undefined; if (!controller.signal.aborted && valid()) setBusy(false); }
  };
  useEffect(() => {
    if (busy || !catalogReady) return;
    const pending = autoResume.current; autoResume.current = undefined;
    if (pending && !error && pending.connection === connection && pending.target === target) void start();
  }, [busy, catalogReady, connection, target, error]);
  const selected = targets.find(item => item.id === target);
  const errorMessage = error === 'access' ? 'Terminal access is not enabled for this connection. The Connector operator must allow local shell access; SSH is not required.'
    : error === 'catalog' ? 'Could not load Connector terminals. Check the connection and retry; no terminal was started.'
      : error === 'start' ? 'Terminal startup was not confirmed. It was not retried automatically.'
        : 'Terminal disconnected. Input was not retried; reconnect explicitly.';
  return <section className="workspace-terminal" aria-label={t('Connector terminal')}>
    <ResourceToolbar>
      {!running ? <select name="workspaceterminal-select-1" aria-label={t('Choose a Connector')} value={connection} disabled={busy} onChange={e => { autoResume.current = undefined; resolvedConnection.current = ''; setConnection(e.target.value); }}><option value="">{t('Choose a Connector')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.environmentLabel || c.label}</option>)}</select>
        : <strong title={selected?.label}>{connections.find(c => c.id === connection)?.environmentLabel || connections.find(c => c.id === connection)?.label}</strong>}
      {!running && targets.length > 0 && (targets.length > 1 || targets[0]?.kind !== 'local') && <select name="workspaceterminal-select-2" aria-label={t('Execution location')} value={target} disabled={busy} onChange={e => { autoResume.current = undefined; setTarget(e.target.value); setError(''); }}><option value="">{t('Choose a target')}</option>{targets.map(item => <option key={item.id} value={item.id}>{item.kind === 'local' ? t('On this Connector') : 'SSH'} · {item.label}</option>)}</select>}
      <span role="status">{running ? t('Connected') : busy ? t('Loading…') : error || (connection && !targets.length) ? t('Unavailable') : connectedBefore ? t('Disconnected') : t('Not started')}</span>
      {(running || starting.current) ? <ResourceAction label={t('Stop')} className="danger" onClick={stop}><Square size={15}/></ResourceAction> : <ResourceAction label={t('Start terminal')} disabled={!target || busy || !!error} onClick={() => void start()}><Play size={15}/></ResourceAction>}
      {!running && <ResourceAction label={t('Refresh')} disabled={busy} onClick={() => { autoResume.current = undefined; resolvedConnection.current = ''; if (target) desiredTarget.current = { connection, target }; setReload(n => n + 1); }}><RefreshCw size={15}/></ResourceAction>}
    </ResourceToolbar>
    <div className="workspace-terminal-stage">
      <div ref={host} className="workspace-terminal-screen" inert={!running} />
      {!running && <div className="workspace-terminal-welcome">
        {busy ? <LoaderCircle size={28} className="terminal-loading-icon" /> : <TerminalSquare size={30} />}
        <strong>{busy ? t('Loading…') : selected?.label || t('Connector terminal')}</strong>
        {error ? <p role="alert">{t(errorMessage)}</p>
          : !busy && !connection ? <p>{t('Choose a Connector above to connect to its terminal.')}</p>
            : !busy && !targets.length ? <p>{t('No authorized terminal is configured on this Connector. Enable a local shell to run commands here; SSH is optional.')}</p>
              : !busy && selected && <>
                <p>{t(selected.kind === 'local' ? 'Runs directly on the selected Connector, not on the Hub or through SSH.' : 'Execution location')} {selected.kind !== 'local' && selected.label}</p>
                <p className="terminal-safety-note"><ShieldAlert size={15} />{t('Connecting allows commands and file changes as the configured OS user. This is not a sandbox.')}</p>
                <label className="terminal-reconnect"><input name="workspaceterminal-input-3" type="checkbox" checked={reconnect} onChange={e => setReconnect(e.target.checked)} />{t('Reconnect after page refresh')}</label>
                <small>{t('Refresh opens a new shell. Commands and previous output are never replayed.')}</small>
                <button type="button" className="terminal-connect" onClick={() => void start()}><Play size={16} />{t('Connect terminal')}</button>
              </>}
      </div>}
    </div>
    {running && <details className="terminal-session-details"><summary>{t('Connection details')}</summary>
      <p>{selected?.label} · {t('This terminal can change files and run commands as the configured OS user. It is not a sandbox.')}</p>
      <label className="terminal-reconnect"><input name="workspaceterminal-input-4" type="checkbox" checked={reconnect} onChange={e => setReconnect(e.target.checked)} />{t('Reconnect after page refresh')}</label>
      <p>{t('Refresh opens a new shell. Commands and previous output are never replayed.')}</p>
      <p>{t('Closing disconnects the terminal. Detached jobs may continue. Output is not saved in chat history.')}</p>
    </details>}
  </section>;
}
