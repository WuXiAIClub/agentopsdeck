import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Plus, Send, Settings2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, recoveryEpoch, recoveryScope, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { quickConfig, quickHistory, quickId, quickModels, quickProfile, quickResult, type QuickConfig, type QuickResult, type QuickTurn } from '../lib/quick-chat';
import './session-goal-control.css';

export default function QuickChatPanel({ close }: { close: () => void }) {
  const { t } = useI18n(), title = useId(), dialog = useRef<HTMLDialogElement>(null), request = useRef<AbortController | null>(null), lock = useRef(false);
  const scope = recoveryScope(), epoch = recoveryEpoch(), storageKey = JSON.stringify(['agentopsdeck.quick-chat.v1', scope]);
  const [config, setConfig] = useState<QuickConfig>(), [selected, setSelected] = useState(''), [name, setName] = useState('Temporary');
  const [model, setModel] = useState('');
  const [turns, setTurns] = useState<QuickTurn[]>([]), [settings, setSettings] = useState(false);
  const transcript = useRef<HTMLDivElement>(null), follow = useRef(true), composer = useRef<HTMLTextAreaElement>(null), focusComposer = useRef(true);
  const [input, setInput] = useState(''), [pending, setPending] = useState<string>(), [result, setResult] = useState<QuickResult>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [storageOk, setStorageOk] = useState(false);
  const profileSave = useRef<{ id: string; revision: number; name: string; target: string; model: string; outputLimit: number } | undefined>(undefined);
  const current = (c: AbortController) => request.current === c && !c.signal.aborted && !!scope && recoveryScope() === scope && recoveryEpoch() === epoch;
  const remember = (id?: string) => {
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); setPending(id); setStorageOk(true); return true; }
    catch { setStorageOk(false); setError(true); return false; }
  };
  const accept = (v: unknown, id: string) => {
    if (!quickResult(v, id)) throw Error('Invalid receipt'); setResult(v);
    setConfig(old => old ? { ...old, receipts: [v.receipt, ...old.receipts.filter(r => r.requestId !== id)].slice(0, 32) } : old);
    setTurns(old => old.some(turn => turn.requestId === id)
      ? old.map(turn => turn.requestId === id ? { ...turn, result: v } : turn)
      : [...old, { requestId: id, question: '', result: v }].slice(-32));
    if (['completed', 'failed'].includes(v.receipt.state)) remember();
  };
  useEffect(() => {
    const el = transcript.current; if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);
  useEffect(() => {
    if (config && !busy && !pending && !settings && focusComposer.current) { composer.current?.focus(); focusComposer.current = false; }
  }, [config, busy, pending, settings]);
  const load = async (c: AbortController) => {
    const value = await api.quickChatConfig(c.signal); if (!current(c)) return;
    if (!quickConfig(value)) throw Error('Invalid configuration'); setConfig(value);
    const savedProfile = profileSave.current;
    const savedId = savedProfile?.id ?? sessionStorage.getItem(storageKey + '.profile');
    if (savedId && !quickId(savedId)) throw Error('Invalid original profile');
    if (savedId && value.profiles.some(p => p.id === savedId)) {
      setSelected(savedId); profileSave.current = undefined; sessionStorage.removeItem(storageKey + '.profile');
    }
    setSelected(old => value.profiles.some(p => p.id === old) ? old : value.profiles[0]?.id ?? '');
  };
  useEffect(() => {
    const c = new AbortController(); request.current = c; lock.current = true; setBusy(true);
    const previous = document.activeElement, el = dialog.current; el?.showModal();
    const invalidate = () => { c.abort(); setInput(''); setTurns([]); setResult(undefined); setConfig(undefined); close(); };
    const unsubscribe = subscribeRecoveryScope(invalidate); window.addEventListener('agentopsdeck:auth-required', invalidate);
    void (async () => {
      const saved = sessionStorage.getItem(storageKey); if (saved && !quickId(saved)) throw Error('Invalid original ID');
      if (!remember(saved ?? undefined)) return;
      await load(c);
      if (saved && current(c)) { const v = await api.quickChatRequest(saved, 'inspect', c.signal); if (current(c)) accept(v, saved); }
    })().catch(() => { if (current(c)) setError(true); }).finally(() => { if (request.current === c) { lock.current = false; if (current(c)) setBusy(false); } });
    return () => { c.abort(); unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', invalidate); el?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [scope, epoch]);
  const profile = config?.profiles.find(p => p.id === selected), models = quickModels(config?.target ?? null);
  useEffect(() => { setName(profile?.name ?? 'Temporary'); setModel(profile?.model ?? config?.target?.model ?? ''); }, [selected, config]);
  const modelAvailable = models.some(m => m.id === model);
  const dirty = !!profile && (profile.model !== model || profile.name !== name.trim());
  const compatible = config?.target && (!profile || profile.target === config.target.id) && modelAvailable;
  const saveProfile = async (c: AbortController) => {
    if (!config?.target || !name.trim() || !modelAvailable || pending) throw Error('Invalid profile');
    // Save the selected model as part of the user's Send action. A lost config
    // ACK retains its exact identity and must be reconciled, never duplicated.
    const original = profileSave.current ??= { id: sessionStorage.getItem(storageKey + '.profile') ?? profile?.id ?? crypto.randomUUID(),
      revision: profile?.revision ?? 0, name: name.trim(), target: config.target.id, model, outputLimit: profile?.outputLimit ?? config.target.maxOutput };
    if (!quickId(original.id) || original.model !== model || original.name !== name.trim() || original.target !== config.target.id) throw Error('Reconcile profile first');
    sessionStorage.setItem(storageKey + '.profile', original.id);
    const value = await api.quickChatProfile(original.id, { revision: original.revision, name: original.name, target: original.target, model: original.model, outputLimit: original.outputLimit }, c.signal) as { profile?: unknown };
    if (!current(c)) throw Error('Authority changed');
    if (!quickProfile(value?.profile) || value.profile.id !== original.id || value.profile.model !== original.model
      || value.profile.revision !== original.revision + 1 || value.profile.target !== original.target) throw Error('Invalid saved profile');
    const saved = value.profile;
    profileSave.current = undefined; sessionStorage.removeItem(storageKey + '.profile');
    setConfig(old => old ? { ...old, profiles: [...old.profiles.filter(p => p.id !== saved.id), saved] } : old);
    setSelected(saved.id); return saved;
  };
  const act = async (action: 'reload' | 'save' | 'send' | 'inspect' | 'clear' | 'cancel', inspectId = pending ?? result?.receipt.requestId) => {
    const c = request.current; if (!c || !current(c) || lock.current || !storageOk) return;
    if (action === 'send' && (pending || !compatible || !input.trim())) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      if (action === 'reload') await load(c);
      else if (action === 'save') {
        await saveProfile(c);
      } else if (action === 'send') {
        const saved = !profile || dirty ? await saveProfile(c) : profile;
        if (!current(c) || profileSave.current) throw Error('Reconcile profile first');
        const id = crypto.randomUUID(); if (!remember(id)) return;
        const question = input, history = quickHistory(turns, question);
        follow.current = true; setResult(undefined); setInput('');
        setTurns(old => [...old, { requestId: id, question }].slice(-32));
        const v = await api.quickChatSend({ requestId: id, profileId: saved.id, revision: saved.revision, input: question, history }, c.signal);
        if (current(c)) { accept(v, id); focusComposer.current = true; }
      } else if (inspectId) {
        if (!remember(inspectId)) return;
        const v = await api.quickChatRequest(inspectId, action as 'inspect' | 'clear' | 'cancel', c.signal);
        if (current(c)) accept(v, inspectId);
      }
    } catch { if (current(c)) setError(true); }
    finally { lock.current = false; if (current(c)) setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="goal-control-dialog quick-chat-dialog" aria-labelledby={title} onCancel={e => { e.preventDefault(); close(); }}>
    <header className="quick-chat-header">
      <div className="quick-chat-heading"><MessageSquare size={20} /><div><h2 id={title}>{t('Temporary chat')}</h2><small>{t('Chat freely. No long-term session to maintain.')}</small></div></div>
      <div className="quick-chat-header-actions">
        <button type="button" title={t('New temporary chat')} aria-label={t('New temporary chat')} disabled={busy || !!pending} onClick={() => { setTurns([]); setResult(undefined); setInput(''); follow.current = true; composer.current?.focus(); }}><Plus size={17} /></button>
        <button type="button" title={t('Model and profiles')} aria-label={t('Model and profiles')} aria-expanded={settings} onClick={() => setSettings(old => !old)}><Settings2 size={17} /></button>
        <button type="button" title={t('Close')} aria-label={t('Close')} onClick={close}><X size={17} /></button>
      </div>
    </header>
    <div className="quick-chat-toolbar">
      <label>{t('Model')}<select name="quickchatpanel-select-1" aria-label={t('Model')} value={model} disabled={busy || !!pending || !config?.target} onChange={e => setModel(e.target.value)}>
        {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        {model && !modelAvailable && <option value={model} disabled>{model} · {t('Unavailable')}</option>}
      </select></label>
      <span>{t('Temporary')}</span>
    </div>
    {settings && <section className="quick-chat-settings" aria-label={t('Model and profiles')}>
      <header><h3>{t('Model and profiles')}</h3><button type="button" disabled={busy} onClick={() => void act('reload')}>{t('Refresh')}</button></header>
      {config?.target && <>
        <label>{t('Quick profile')}<select name="quickchatpanel-select-2" value={selected} disabled={busy || !!pending} onChange={e => setSelected(e.target.value)}>
          <option value="">{t('Select profile')}</option>{config.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>
        <label>{t('Name')}<input name="quickchatpanel-input-3" value={name} maxLength={80} disabled={busy || !!pending} onChange={e => setName(e.target.value)} /></label>
        <div className="quick-chat-profile-actions">
          <button type="button" disabled={busy || !!pending || !name.trim() || !modelAvailable || (!profile && config.profiles.length >= 32) || (!!profile && !dirty)} onClick={() => void act('save')}>{t('Save profile')}</button>
          <button type="button" disabled={busy || !!pending || config.profiles.length >= 32} onClick={() => { setSelected(''); setName('Temporary'); setModel(config.target!.model); }}>{t('Add quick profile')}</button>
        </div>
      </>}
      <details className="quick-chat-privacy"><summary>{t('Privacy and billing')}</summary>{config?.target && <p>{config.target.label} · {config.target.provider}</p>}<p>{t('This temporary chat sends its own recent messages only. Closing clears the conversation, not an in-flight request or its billing.')}</p><p>{t('Results stay private for up to 24 hours. A lost provider response can remain unknown; it is never resent automatically.')}</p></details>
      {!!config?.receipts.length && <details><summary>{t('Recent quick requests')}</summary>{config.receipts.map(r => <button type="button" key={r.requestId} disabled={busy || (!!pending && pending !== r.requestId)} onClick={() => void act('inspect', r.requestId)}>{r.profile.name} · {r.state}</button>)}</details>}
    </section>}
    <div ref={transcript} className="quick-chat-transcript" role="region" aria-label={t('Temporary conversation')} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {!turns.length && <div className="quick-chat-empty"><MessageSquare size={32} /><h3>{t('What would you like to talk about?')}</h3><p>{t('Ask, follow up, or start over. This conversation stays here only while open.')}</p></div>}
      {turns.map(turn => <div className="quick-chat-turn" key={turn.requestId}>
        {turn.question && <article className="quick-chat-message is-user" aria-label={t('You')}><small>{t('You')}</small><div className="quick-chat-user-text">{turn.question}</div></article>}
        <article className="quick-chat-message is-assistant" aria-label={t('Assistant')}>
          <small>{turn.result?.receipt.profile.model ?? model}</small>
          {turn.result?.output != null ? <><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{turn.result.output}</ReactMarkdown>
            <button className="quick-chat-result-action" type="button" disabled={busy || !!pending} onClick={() => void act('clear', turn.requestId)}>{t('Clear private result')}</button></>
            : <p role="status">{t(!turn.result && busy ? 'Thinking…' : turn.result?.receipt.state === 'completed' ? 'Result cleared or expired.' : turn.result?.receipt.state === 'failed' ? 'Request failed.' : 'Response not confirmed. Check the original request; do not resend.')}</p>}
        </article>
      </div>)}
    </div>
    <div className="quick-chat-status">
      {!config && busy && <p role="status">{t('Loading configuration…')}</p>}
      {config && !config.target && <p>{t('No standalone model configured for this account.')} <button type="button" disabled={busy} onClick={() => void act('reload')}>{t('Refresh')}</button></p>}
      {config?.target?.catalogState === 'unavailable' && <p role="status">{t('Model list unavailable. Only the configured default is available; refresh to retry.')}</p>}
      {pending && !busy && <div className="quick-chat-recovery"><p>{t('Response not confirmed. Check the original request; do not resend.')}</p><button type="button" onClick={() => void act('inspect')}>{t('Check original receipt')}</button>{result?.receipt.state === 'admitted' && <button type="button" onClick={() => void act('cancel')}>{t('Cancel unsent request')}</button>}</div>}
      {error && <p role="alert">{t('Quick question unavailable. Reload settings or inspect the original request; do not resend.')} <button type="button" disabled={busy} onClick={() => void act(pending ? 'inspect' : 'reload')}>{t(pending ? 'Check original receipt' : 'Refresh')}</button></p>}
    </div>
    <form className="quick-chat-composer" onSubmit={e => { e.preventDefault(); void act('send'); }}>
      <textarea name="quickchatpanel-textarea-4" ref={composer} autoFocus aria-label={t('Question')} placeholder={t('Write a message…')} rows={3} value={input} maxLength={8000} disabled={busy || !!pending} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void act('send'); } }} />
      <footer><small>{t('Only this temporary conversation is included.')}</small><button className="quick-chat-send" type="submit" disabled={busy || !!pending || !compatible || !input.trim() || !storageOk || !name.trim() || (!profile && (config?.profiles.length ?? 0) >= 32)}><Send size={16} />{t(busy ? 'Sending…' : 'Send')}</button></footer>
    </form>
  </dialog>, document.body);
}
