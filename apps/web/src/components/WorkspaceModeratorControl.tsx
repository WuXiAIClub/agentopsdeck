import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Mic, Pause, Play, Radio, Send, Sparkles, Volume2 } from 'lucide-react';
import { workspaceFileCardResource, type BoardSummary, type SessionSummary } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { sendMessageWithRecovery } from '../lib/message-submission';
import {
  DEFAULT_STT_CONFIG,
  loadModeratorSttConfig,
  saveModeratorSttConfig,
  startModeratorLiveCapture,
  upsertLiveSttSegment,
  type AudioSourceMode,
  type ModeratorLiveCaptureHandle,
  type SttBatch,
  type SttProviderConfig,
  type SttProviderId,
  type SttSegment,
} from '../lib/moderator-stt';
import {
  appendModeratorNotes,
  buildModeratorBatchPrompt,
  buildModeratorGuidancePrimer,
  DEFAULT_MODERATOR_PROMPT,
  loadModeratorOrchestrationConfig,
  mergeModeratorTasks,
  MODERATOR_CONFIG_EVENT,
  parseModeratorDirectives,
  saveModeratorOrchestrationConfig,
  type ModeratorOrchestrationConfig,
} from '../lib/moderator-orchestrator';
import { displayTitle } from '../lib/session-utils';
import { useI18n } from '../lib/i18n';
import { publishBoardSaved, writeCachedBoardDocument } from '../lib/workspace-board';
import { writeCachedNotebookDocument } from '../lib/session-notebook';


export type ModeratorFlowEventDetail = {
  scope: string;
  stage: 'stt-to-moderator' | 'moderator-to-notebook' | 'moderator-to-taskboard' | 'moderator-to-scout';
  moderatorSessionKey?: string | undefined;
  scoutSessionKey?: string | undefined;
  notebookTarget?: 'session' | 'hub' | undefined;
  notebookId?: string | undefined;
  taskboardId?: string | undefined;
};

export const MODERATOR_FLOW_EVENT = 'agentopsdeck:moderator-flow';

function emitModeratorFlow(detail: ModeratorFlowEventDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(MODERATOR_FLOW_EVENT, { detail }));
  } catch {
    // Ignore in headless environments
  }
}

export type ModeratorBatchRecord = {
  id: string;
  text: string;
  reason: 'pause' | 'window' | 'manual';
  createdAt: number;
  status: 'dispatched' | 'manual-queued' | 'failed';
};

export function WorkspaceModeratorControl({
  scope,
  sessions,
  notebooks,
  onSelectSession,
  onRetarget,
}: {
  scope: string;
  sessions: readonly SessionSummary[];
  notebooks: readonly { id: string; title?: string }[];
  onSelectSession?: (session: SessionSummary) => void;
  onRetarget?: (previous: ModeratorOrchestrationConfig, next: ModeratorOrchestrationConfig) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const [sttSettings, setSttSettings] = useState<SttProviderConfig>(() => loadModeratorSttConfig(scope));
  const [orchConfig, setOrchConfig] = useState<ModeratorOrchestrationConfig>(() => loadModeratorOrchestrationConfig(scope));

  const [listening, setListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [liveSegments, setLiveSegments] = useState<SttSegment[]>([]);
  const [manualInput, setManualInput] = useState('');
  const [batches, setBatches] = useState<ModeratorBatchRecord[]>([]);
  const [appliedDirectivesCount, setAppliedDirectivesCount] = useState({ notes: 0, tasks: 0, scouts: 0 });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const handleRef = useRef<ModeratorLiveCaptureHandle | null>(null);
  const captureControllerRef = useRef<AbortController | null>(null);
  const captureAliveRef = useRef(true);
  const captureScope = recoveryScope(), captureEpoch = recoveryEpoch();
  const captureIdentity = JSON.stringify([scope, captureScope, captureEpoch, orchConfig.moderatorSessionKey, sttSettings]);
  const captureIdentityRef = useRef(captureIdentity);
  captureIdentityRef.current = captureIdentity;
  const liveStreamRef = useRef<HTMLElement | null>(null);
  const batchesStreamRef = useRef<HTMLElement | null>(null);
  const processedMessageIdsRef = useRef<Set<string>>(new Set());
  const injectedGuidanceSessionsRef = useRef<Set<string>>(new Set());
  const latestOrchRef = useRef(orchConfig);
  latestOrchRef.current = orchConfig;
  const directiveIdentity = JSON.stringify([scope, captureScope, captureEpoch, orchConfig]);
  const directiveIdentityRef = useRef(directiveIdentity);
  directiveIdentityRef.current = directiveIdentity;

  useEffect(() => {
    saveModeratorSttConfig(scope, sttSettings);
  }, [scope, sttSettings]);

  const [boards, setBoards] = useState<BoardSummary[]>([]);

  useEffect(() => {
    const abort = new AbortController();
    void api.workspaceBoards(abort.signal).then(res => {
      if (!abort.signal.aborted) setBoards(res.boards ?? []);
    }).catch(() => {});
    return () => abort.abort();
  }, [scope, orchConfig.taskboardId]);

  useEffect(() => {
    const onExternalUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; config: ModeratorOrchestrationConfig }>).detail;
      if (!detail || detail.scope !== (scope || 'default')) return;
      latestOrchRef.current = detail.config;
      setOrchConfig(prev => JSON.stringify(prev) === JSON.stringify(detail.config) ? prev : detail.config);
    };
    window.addEventListener(MODERATOR_CONFIG_EVENT, onExternalUpdate);
    return () => window.removeEventListener(MODERATOR_CONFIG_EVENT, onExternalUpdate);
  }, [scope]);

  useEffect(() => {
    saveModeratorOrchestrationConfig(scope, orchConfig);
  }, [scope, orchConfig]);

  useEffect(() => {
    const el = liveStreamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveSegments]);

  useEffect(() => {
    const el = batchesStreamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [batches]);


  async function sendGuidancePrimerToSession(targetCfg = latestOrchRef.current) {
    if (!targetCfg.moderatorSessionKey) return;
    const primer = buildModeratorGuidancePrimer(targetCfg);
    try {
      emitModeratorFlow({
        scope: scope || 'default',
        stage: 'stt-to-moderator',
        moderatorSessionKey: targetCfg.moderatorSessionKey,
      });
      await sendMessageWithRecovery(targetCfg.moderatorSessionKey, primer, 'web-only', [], crypto.randomUUID());
      injectedGuidanceSessionsRef.current.add(`${targetCfg.moderatorSessionKey}::${targetCfg.systemPrompt.trim()}`);
      setStatusMessage(t('Sent Moderator Guidance primer to session.'));
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('Failed to dispatch speech batch.'));
    }
  }

  function applyTargetReplacement(patch: Partial<ModeratorOrchestrationConfig>) {
    const prev = latestOrchRef.current;
    const next: ModeratorOrchestrationConfig = { ...prev, ...patch };
    setOrchConfig(next);
    latestOrchRef.current = next;
    onRetarget?.(prev, next);
    setStatusMessage(t('Replaced card in layout and updated bindings.'));

    if (next.moderatorSessionKey) {
      const noteResource = workspaceFileCardResource('notebook', `${next.notebookTarget}:${next.notebookId || 'default'}`);
      void api.bindFileCard(noteResource, {
        requestId: crypto.randomUUID(),
        sessionId: next.moderatorSessionKey,
        revision: 0,
      }).catch(() => {});
      void api.bindFileBoard(next.taskboardId || 'default', {
        requestId: crypto.randomUUID(),
        sessionId: next.moderatorSessionKey,
        revision: 0,
      }).catch(() => {});
    }

    if (patch.moderatorSessionKey && patch.moderatorSessionKey !== prev.moderatorSessionKey) {
      void sendGuidancePrimerToSession(next);
    }
  }

  function cancelLiveCapture() {
    const controller = captureControllerRef.current;
    captureControllerRef.current = null;
    controller?.abort();
    const handle = handleRef.current;
    handleRef.current = null;
    handle?.stop();
  }

  useEffect(() => {
    captureAliveRef.current = true;
    setListening(false);
    setAudioLevel(0);
    const expire = () => {
      cancelLiveCapture();
      setListening(false);
      setAudioLevel(0);
    };
    window.addEventListener('agentopsdeck:auth-required', expire);
    window.addEventListener('pagehide', expire);
    return () => {
      captureAliveRef.current = false;
      cancelLiveCapture();
      window.removeEventListener('agentopsdeck:auth-required', expire);
      window.removeEventListener('pagehide', expire);
    };
  }, [captureIdentity]);

  async function dispatchBatchToModerator(
    batch: Pick<SttBatch, 'text' | 'reason' | 'startedAtMs' | 'flushedAtMs'>,
    cfg = latestOrchRef.current,
    isCurrent = () => captureAliveRef.current && captureIdentityRef.current === captureIdentity
      && captureScope === recoveryScope() && captureEpoch === recoveryEpoch(),
  ) {
    if (!isCurrent()) return;
    const clean = batch.text.trim();
    if (!clean) return;
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    if (!cfg.moderatorSessionKey) {
      setBatches(prev => [...prev.slice(-29), { id: batchId, text: clean, reason: batch.reason, createdAt: Date.now(), status: 'manual-queued' }]);
      setErrorMessage(t('Select a Moderator session to receive live speech batches.'));
      return;
    }
    const prompt = buildModeratorBatchPrompt(batch, cfg, false);
    try {
      emitModeratorFlow({
        scope: scope || 'default',
        stage: 'stt-to-moderator',
        moderatorSessionKey: cfg.moderatorSessionKey,
      });
      await sendMessageWithRecovery(cfg.moderatorSessionKey, prompt, 'web-only', [], crypto.randomUUID());
      if (!isCurrent()) return;
      setBatches(prev => [...prev.slice(-29), { id: batchId, text: clean, reason: batch.reason, createdAt: Date.now(), status: 'dispatched' }]);
      setStatusMessage(t('Dispatched speech batch to Moderator session.'));
      setErrorMessage('');
    } catch (error) {
      if (!isCurrent()) return;
      setBatches(prev => [...prev.slice(-29), { id: batchId, text: clean, reason: batch.reason, createdAt: Date.now(), status: 'failed' }]);
      setErrorMessage(error instanceof Error ? error.message : t('Failed to dispatch speech batch.'));
    }
  }

  useEffect(() => {
    const modKey = orchConfig.moderatorSessionKey;
    if (!modKey) return;
    let cancelled = false;
    let polling = false;
    const configIdentity = JSON.stringify(orchConfig);
    const isCurrent = () => !cancelled && Boolean(captureScope)
      && directiveIdentityRef.current === directiveIdentity
      && recoveryScope() === captureScope && recoveryEpoch() === captureEpoch
      && JSON.stringify(latestOrchRef.current) === configIdentity;

    async function pollModeratorDirectives() {
      if (polling || !isCurrent()) return;
      polling = true;
      try {
        const snapshot = await api.sessionMessages(modKey, 50).catch(() => api.cachedSessionMessages(modKey, 50));
        if (!isCurrent() || !snapshot?.messages?.length) return;
        for (const msg of snapshot.messages) {
          if (!isCurrent()) return;
          if (msg.role !== 'assistant' || !msg.text) continue;
          const directives = parseModeratorDirectives(msg.text);
          if (!directives.notes.length && !directives.tasks.length && !directives.scoutQueries.length) {
            continue;
          }
          const signature = `${msg.id}::${JSON.stringify(directives)}`;
          if (processedMessageIdsRef.current.has(signature)) continue;
          processedMessageIdsRef.current.add(signature);
          const cfg = latestOrchRef.current;

          if (cfg.autoSyncNotebook && directives.notes.length > 0) {
            try {
              const targetId = cfg.notebookId || 'default';
              if (cfg.notebookTarget === 'session' && cfg.moderatorSessionKey) {
                const existing = await api.sessionNotebook(cfg.moderatorSessionKey);
                if (!isCurrent()) return;
                const merged = appendModeratorNotes(existing.text ?? '', directives.notes);
                if (merged.changed) {
                  const savedDoc = await api.saveSessionNotebook(cfg.moderatorSessionKey, {
                    resourceId: existing.resourceId || cfg.moderatorSessionKey,
                    text: merged.text,
                    revision: existing.revision,
                  });
                  if (!isCurrent()) return;
                  writeCachedNotebookDocument(JSON.stringify([scope, 'content', 'session', cfg.moderatorSessionKey]), savedDoc);
                  window.dispatchEvent(new CustomEvent('agentopsdeck:notebook-updated', { detail: { target: 'session', id: cfg.moderatorSessionKey } }));
                }
              } else if (targetId === 'default') {
                const existing = await api.hubNotebook();
                if (!isCurrent()) return;
                const merged = appendModeratorNotes(existing.text ?? '', directives.notes);
                if (merged.changed) {
                  const savedDoc = await api.saveHubNotebook({
                    resourceId: existing.resourceId || 'default',
                    text: merged.text,
                    revision: existing.revision,
                  });
                  if (!isCurrent()) return;
                  writeCachedNotebookDocument(JSON.stringify([scope, 'content', 'hub', 'default']), savedDoc);
                  window.dispatchEvent(new CustomEvent('agentopsdeck:notebook-updated', { detail: { target: 'hub', id: 'default' } }));
                }
              } else {
                const existing = await api.hubNotebookById(targetId, false);
                if (!isCurrent()) return;
                const merged = appendModeratorNotes(existing.text ?? '', directives.notes);
                if (merged.changed) {
                  const savedDoc = await api.saveHubNotebookById(targetId, {
                    resourceId: existing.resourceId || JSON.stringify(['hub-notebook', 1, targetId]),
                    text: merged.text,
                    revision: existing.revision,
                  }, false);
                  if (!isCurrent()) return;
                  writeCachedNotebookDocument(JSON.stringify([scope, 'content', 'hub', targetId]), savedDoc);
                  window.dispatchEvent(new CustomEvent('agentopsdeck:notebook-updated', { detail: { target: 'hub', id: targetId } }));
                }
              }
              if (!isCurrent()) return;
              emitModeratorFlow({
                scope: scope || 'default',
                stage: 'moderator-to-notebook',
                moderatorSessionKey: cfg.moderatorSessionKey,
                notebookTarget: cfg.notebookTarget,
                notebookId: targetId,
              });
              setAppliedDirectivesCount(prev => ({ ...prev, notes: prev.notes + directives.notes.length }));
            } catch {
              // Best effort notebook sync
            }
          }

          if (cfg.autoSyncTaskboard && directives.tasks.length > 0) {
            if (!isCurrent()) return;
            try {
              const boardId = cfg.taskboardId || 'default';
              const board = await api.workspaceBoard(boardId);
              if (!isCurrent()) return;
              const merged = mergeModeratorTasks(board.tasks ?? [], directives.tasks);
              if (merged.changed) {
                const savedBoard = await api.saveWorkspaceBoard(boardId, {
                  title: board.title || 'Task board',
                  revision: board.revision,
                  mutationId: crypto.randomUUID(),
                  tasks: merged.tasks,
                });
                if (!isCurrent()) return;
                writeCachedBoardDocument(scope || 'default', boardId, savedBoard);
                publishBoardSaved(scope || 'default', savedBoard);
              }
              emitModeratorFlow({
                scope: scope || 'default',
                stage: 'moderator-to-taskboard',
                moderatorSessionKey: cfg.moderatorSessionKey,
                taskboardId: boardId,
              });
              setAppliedDirectivesCount(prev => ({ ...prev, tasks: prev.tasks + directives.tasks.length }));
            } catch {
              // Best effort taskboard sync
            }
          }

          if (cfg.autoDispatchScout && cfg.scoutSessionKey && directives.scoutQueries.length > 0) {
            for (const scoutQuery of directives.scoutQueries) {
              if (!isCurrent()) return;
              try {
                await sendMessageWithRecovery(
                  cfg.scoutSessionKey,
                  `[Scout Request from Moderator]\n${scoutQuery}`,
                  'web-only',
                  [],
                  crypto.randomUUID(),
                );
                if (!isCurrent()) return;
                emitModeratorFlow({
                  scope: scope || 'default',
                  stage: 'moderator-to-scout',
                  moderatorSessionKey: cfg.moderatorSessionKey,
                  scoutSessionKey: cfg.scoutSessionKey,
                });
                setAppliedDirectivesCount(prev => ({ ...prev, scouts: prev.scouts + 1 }));
              } catch {
                // Best effort scout dispatch
              }
            }
          }
        }
      } catch {
        // Ignore transient polling errors
      } finally {
        polling = false;
      }
    }

    const expire = () => { cancelled = true; };
    window.addEventListener('agentopsdeck:auth-required', expire);
    window.addEventListener('pagehide', expire);
    void pollModeratorDirectives();
    const timer = window.setInterval(() => void pollModeratorDirectives(), 4500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('agentopsdeck:auth-required', expire);
      window.removeEventListener('pagehide', expire);
    };
  }, [directiveIdentity]);

  async function toggleListening() {
    if (captureControllerRef.current || listening) {
      cancelLiveCapture();
      setListening(false);
      setAudioLevel(0);
      setStatusMessage(t('Moderator live capture paused.'));
      return;
    }
    if (!captureAliveRef.current || captureIdentityRef.current !== captureIdentity
      || captureScope !== recoveryScope() || captureEpoch !== recoveryEpoch()) return;
    const controller = new AbortController();
    captureControllerRef.current = controller;
    const cfg = latestOrchRef.current;
    const isCurrent = () => captureAliveRef.current && !controller.signal.aborted
      && captureControllerRef.current === controller && captureIdentityRef.current === captureIdentity
      && captureScope === recoveryScope() && captureEpoch === recoveryEpoch()
      && latestOrchRef.current.moderatorSessionKey === cfg.moderatorSessionKey;
    setListening(true);
    setErrorMessage('');
    try {
      const handle = await startModeratorLiveCapture(sttSettings, {
        onSegment: segment => {
          if (!isCurrent()) return;
          setLiveSegments(prev => upsertLiveSttSegment(prev, segment, 30));
        },
        onBatch: batch => {
          if (isCurrent()) void dispatchBatchToModerator(batch, cfg, isCurrent);
        },
        onLevel: rms => { if (isCurrent()) setAudioLevel(rms); },
        onError: message => {
          if (!isCurrent()) return;
          setErrorMessage(message);
        },
      }, controller.signal);
      if (!isCurrent()) { handle.stop(); return; }
      handleRef.current = handle;
      setListening(true);
      setStatusMessage(t('Moderator live capture started.'));
    } catch (error) {
      if (!isCurrent()) return;
      cancelLiveCapture();
      setListening(false);
      setErrorMessage(error instanceof Error ? error.message : t('Unable to start audio capture.'));
    }
  }

  function flushNow() {
    const flushed = handleRef.current?.flushNow() ?? null;
    if (manualInput.trim()) {
      const now = Date.now();
      const text = manualInput.trim();
      setManualInput('');
      void dispatchBatchToModerator({ text, reason: 'manual', startedAtMs: now, flushedAtMs: now });
    } else if (!flushed) {
      setStatusMessage(t('No pending transcript segment to flush.'));
    }
  }

  const moderatorSession = useMemo(
    () => sessions.find(item => item.sessionKey === orchConfig.moderatorSessionKey),
    [sessions, orchConfig.moderatorSessionKey],
  );
  const scoutSession = useMemo(
    () => sessions.find(item => item.sessionKey === orchConfig.scoutSessionKey),
    [sessions, orchConfig.scoutSessionKey],
  );

  const meterPercent = Math.min(100, Math.round(audioLevel * 320));

  return (
    <div className="workspace-moderator-control" data-listening={listening} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.85rem', height: '100%', overflowY: 'auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Radio size={18} />
          <strong>{t('Moderator Control Center')}</strong>
          <span className="badge" style={{ fontSize: '0.75rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: listening ? 'rgba(16, 185, 129, 0.18)' : 'rgba(148, 163, 184, 0.16)' }}>
            {listening ? t('LIVE STT') : t('Standby')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', opacity: 0.85 }}>
          <span>{t('Notes synced')}: {appliedDirectivesCount.notes}</span>
          <span>·</span>
          <span>{t('Tasks synced')}: {appliedDirectivesCount.tasks}</span>
          <span>·</span>
          <span>{t('Scout dispatches')}: {appliedDirectivesCount.scouts}</span>
        </div>
      </header>

      <section aria-label={t('Live voice controls')} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '0.75rem', borderRadius: '0.65rem', border: '1px solid rgba(148, 163, 184, 0.24)', background: 'rgba(15, 23, 42, 0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => void toggleListening()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.5rem 0.95rem',
              borderRadius: '0.5rem',
              fontWeight: 600,
              background: listening ? '#dc2626' : '#2563eb',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {listening ? <Pause size={15} /> : <Play size={15} />}
            {listening ? t('Stop listening') : t('Start Moderator STT')}
          </button>

          <button
            type="button"
            onClick={flushNow}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.8rem',
              borderRadius: '0.5rem',
              border: '1px solid rgba(148, 163, 184, 0.35)',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <Send size={14} />
            {t('Flush segment to Moderator now')}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: '140px' }} title={t('Audio input level')}>
            <Volume2 size={14} />
            <div style={{ flex: 1, height: '8px', borderRadius: '999px', background: 'rgba(148, 163, 184, 0.2)', overflow: 'hidden' }}>
              <div style={{ width: `${meterPercent}%`, height: '100%', background: meterPercent > 75 ? '#f59e0b' : '#10b981', transition: 'width 120ms ease-out' }} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.45rem' }}>
          <input
            id={`${uid}-manual-batch`}
            name="moderator-manual-batch"
            type="text"
            value={manualInput}
            onChange={event => setManualInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && manualInput.trim()) {
                event.preventDefault();
                const now = Date.now();
                const text = manualInput.trim();
                setManualInput('');
                void dispatchBatchToModerator({ text, reason: 'manual', startedAtMs: now, flushedAtMs: now });
              }
            }}
            placeholder={t('Type or paste meeting snippet to send directly to Moderator…')}
            style={{ flex: 1, padding: '0.4rem 0.6rem', borderRadius: '0.4rem', border: '1px solid rgba(148, 163, 184, 0.3)', background: 'transparent' }}
          />
          <button
            type="button"
            disabled={!manualInput.trim()}
            onClick={() => {
              const text = manualInput.trim();
              if (!text) return;
              const now = Date.now();
              setManualInput('');
              void dispatchBatchToModerator({ text, reason: 'manual', startedAtMs: now, flushedAtMs: now });
            }}
            style={{ padding: '0.4rem 0.75rem', borderRadius: '0.4rem', cursor: 'pointer' }}
          >
            {t('Send snippet')}
          </button>
        </div>

        {statusMessage && <p role="status" style={{ margin: 0, fontSize: '0.78rem', color: '#10b981' }}>{statusMessage}</p>}
        {errorMessage && <p role="alert" style={{ margin: 0, fontSize: '0.78rem', color: '#f87171' }}>{errorMessage}</p>}
      </section>

      <section aria-label={t('STT & Audio configuration')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: '0.55rem', padding: '0.65rem', borderRadius: '0.55rem', border: '1px solid rgba(148, 163, 184, 0.2)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span><Mic size={12} style={{ display: 'inline', marginRight: 4 }} />{t('Audio source')}</span>
          <select
            name="moderator-audio-source"
            value={sttSettings.sourceMode}
            onChange={event => setSttSettings(prev => ({ ...prev, sourceMode: event.target.value as AudioSourceMode }))}
          >
            <option value="microphone">{t('Microphone')}</option>
            <option value="system-audio">{t('System audio (Screen/Tab share)')}</option>
            <option value="both">{t('Microphone + System audio')}</option>
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('STT Provider')}</span>
          <select
            name="moderator-stt-provider"
            value={sttSettings.provider}
            onChange={event => setSttSettings(prev => ({ ...prev, provider: event.target.value as SttProviderId }))}
          >
            <option value="web-speech">{t('Browser Web Speech (Zero config)')}</option>
            <option value="deepgram-ws">{t('Deepgram Nova-2 WebSocket')}</option>
            <option value="openai-whisper">{t('OpenAI Whisper / Compatible HTTP')}</option>
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('Language')}</span>
          <input
            name="moderator-stt-language"
            type="text"
            value={sttSettings.lang}
            onChange={event => setSttSettings(prev => ({ ...prev, lang: event.target.value }))}
            placeholder={t('zh-CN / en-US')}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('Pause auto-flush (ms)')}</span>
          <input
            name="moderator-pause-ms"
            type="number"
            min={500}
            max={60000}
            step={500}
            value={sttSettings.pauseMs}
            onChange={event => setSttSettings(prev => ({ ...prev, pauseMs: Math.max(500, Number(event.target.value) || DEFAULT_STT_CONFIG.pauseMs) }))}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('Fixed window flush (ms)')}</span>
          <input
            name="moderator-window-ms"
            type="number"
            min={3000}
            max={300000}
            step={1000}
            value={sttSettings.fixedWindowMs}
            onChange={event => setSttSettings(prev => ({ ...prev, fixedWindowMs: Math.max(3000, Number(event.target.value) || DEFAULT_STT_CONFIG.fixedWindowMs) }))}
          />
        </label>

        {sttSettings.provider !== 'web-speech' && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
              <span>{t('Provider API Key')}</span>
              <input
                name="moderator-api-key"
                type="password"
                autoComplete="off"
                value={sttSettings.apiKey}
                onChange={event => setSttSettings(prev => ({ ...prev, apiKey: event.target.value }))}
                placeholder={t(sttSettings.provider === 'deepgram-ws' ? 'Deepgram API Key' : 'Bearer API Key')}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
              <span>{t('Custom Endpoint (optional)')}</span>
              <input
                name="moderator-endpoint"
                type="text"
                value={sttSettings.endpointUrl}
                onChange={event => setSttSettings(prev => ({ ...prev, endpointUrl: event.target.value }))}
                placeholder={t('Optional custom STT endpoint URL')}
              />
            </label>
          </>
        )}
      </section>

      <section aria-label={t('Moderator orchestration bindings')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))', gap: '0.55rem', padding: '0.65rem', borderRadius: '0.55rem', border: '1px solid rgba(148, 163, 184, 0.2)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span><Sparkles size={12} style={{ display: 'inline', marginRight: 4 }} />{t('Moderator Session (Organizes notes & tasks)')}</span>
          <select
            name="moderator-primary-session"
            value={orchConfig.moderatorSessionKey}
            onChange={event => applyTargetReplacement({ moderatorSessionKey: event.target.value })}
          >
            <option value="">{t('Select Moderator session…')}</option>
            {sessions.map(session => (
              <option key={session.sessionKey} value={session.sessionKey}>{displayTitle(session)}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {moderatorSession && onSelectSession && (
              <button type="button" onClick={() => onSelectSession(moderatorSession)} style={{ fontSize: '0.72rem', padding: '0.1rem 0.4rem' }}>
                {t('Focus Moderator session')}
              </button>
            )}
            {orchConfig.moderatorSessionKey && (
              <button type="button" onClick={() => void sendGuidancePrimerToSession()} style={{ fontSize: '0.72rem', padding: '0.1rem 0.4rem' }}>
                {t('Send Guidance Primer')}
              </button>
            )}
          </div>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('Scout Session (Dispatched for lookups)')}</span>
          <select
            name="moderator-scout-session"
            value={orchConfig.scoutSessionKey}
            onChange={event => applyTargetReplacement({ scoutSessionKey: event.target.value })}
          >
            <option value="">{t('None / Select Scout session…')}</option>
            {sessions.filter(s => s.sessionKey !== orchConfig.moderatorSessionKey).map(session => (
              <option key={session.sessionKey} value={session.sessionKey}>{displayTitle(session)}</option>
            ))}
          </select>
          {scoutSession && onSelectSession && (
            <button type="button" onClick={() => onSelectSession(scoutSession)} style={{ alignSelf: 'flex-start', fontSize: '0.72rem', padding: '0.1rem 0.4rem' }}>
              {t('Focus Scout session')}
            </button>
          )}
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('Target Notebook')}</span>
          <select
            name="moderator-notebook-target"
            value={`${orchConfig.notebookTarget}:${orchConfig.notebookId}`}
            onChange={event => {
              const [target, resourceId] = event.target.value.split(':');
              applyTargetReplacement({
                notebookTarget: target === 'session' ? 'session' : 'hub',
                notebookId: resourceId || 'default',
              });
            }}
          >
            <option value="hub:default">{t('Global notebook (default)')}</option>
            {orchConfig.moderatorSessionKey && (
              <option value={`session:${orchConfig.moderatorSessionKey}`}>{t('Moderator Session Notebook')}</option>
            )}
            {orchConfig.notebookTarget === 'hub' && orchConfig.notebookId !== 'default' && !notebooks.some(n => n.id === orchConfig.notebookId) && (
              <option value={`hub:${orchConfig.notebookId}`}>{orchConfig.notebookId.slice(0, 8)}</option>
            )}
            {notebooks.map(note => (
              <option key={note.id} value={`hub:${note.id}`}>{note.title || note.id}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem' }}>
          <span>{t('Target Taskboard')}</span>
          <select
            name="moderator-taskboard-target"
            value={orchConfig.taskboardId || 'default'}
            onChange={event => applyTargetReplacement({ taskboardId: event.target.value || 'default' })}
          >
            <option value="default">{t('Default taskboard')}</option>
            {orchConfig.taskboardId && orchConfig.taskboardId !== 'default' && !boards.some(b => b.resourceId === orchConfig.taskboardId) && (
              <option value={orchConfig.taskboardId}>{orchConfig.taskboardId.slice(0, 8)}</option>
            )}
            {boards.filter(b => b.resourceId !== 'default').map(board => (
              <option key={board.resourceId} value={board.resourceId}>{board.title || board.resourceId}</option>
            ))}
          </select>
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.76rem', justifyContent: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input
              name="moderator-auto-note"
              type="checkbox"
              checked={orchConfig.autoSyncNotebook}
              onChange={event => setOrchConfig(prev => ({ ...prev, autoSyncNotebook: event.target.checked }))}
            />
            {t('Auto-append [MODERATOR_NOTE] to Notebook')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input
              name="moderator-auto-task"
              type="checkbox"
              checked={orchConfig.autoSyncTaskboard}
              onChange={event => setOrchConfig(prev => ({ ...prev, autoSyncTaskboard: event.target.checked }))}
            />
            {t('Auto-sync [MODERATOR_TASK] to Taskboard')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input
              name="moderator-auto-scout"
              type="checkbox"
              checked={orchConfig.autoDispatchScout}
              onChange={event => setOrchConfig(prev => ({ ...prev, autoDispatchScout: event.target.checked }))}
            />
            {t('Auto-dispatch [MODERATOR_SCOUT] to Scout session')}
          </label>
        </div>
      </section>

      <details style={{ border: '1px solid rgba(148, 163, 184, 0.2)', borderRadius: '0.55rem', padding: '0.5rem 0.65rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
          {t('Moderator Prompt Template (Injected with speech batches)')}
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.5rem' }}>
          <textarea
            name="moderator-system-prompt"
            rows={4}
            value={orchConfig.systemPrompt}
            onChange={event => setOrchConfig(prev => ({ ...prev, systemPrompt: event.target.value }))}
            style={{ width: '100%', fontSize: '0.76rem', fontFamily: 'monospace', padding: '0.45rem', borderRadius: '0.4rem' }}
          />
          <button
            type="button"
            onClick={() => setOrchConfig(prev => ({ ...prev, systemPrompt: DEFAULT_MODERATOR_PROMPT }))}
            style={{ alignSelf: 'flex-end', fontSize: '0.74rem', padding: '0.2rem 0.55rem' }}
          >
            {t('Reset to default Moderator prompt')}
          </button>
        </div>
      </details>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.6rem', flex: 1, minHeight: '140px' }}>
        <section ref={liveStreamRef} data-moderator-live-stream="true" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', padding: '0.6rem', borderRadius: '0.5rem', border: '1px solid rgba(148, 163, 184, 0.18)', overflowY: 'auto' }}>
          <strong style={{ fontSize: '0.78rem' }}>{t('Live STT Stream')}</strong>
          {liveSegments.length === 0 ? (
            <p style={{ margin: 0, fontSize: '0.76rem', opacity: 0.65 }}>{t('Speech segments will appear here in real time…')}</p>
          ) : (
            liveSegments.map(seg => (
              <div key={seg.id} data-segment-final={seg.isFinal} style={{ fontSize: '0.76rem', opacity: seg.isFinal ? 1 : 0.7 }}>
                <span style={{ opacity: 0.55, marginRight: 6 }}>[{new Date(seg.timestampMs).toLocaleTimeString()}]</span>
                <span>{seg.text}</span>
              </div>
            ))
          )}
        </section>

        <section ref={batchesStreamRef} data-moderator-batches-stream="true" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', padding: '0.6rem', borderRadius: '0.5rem', border: '1px solid rgba(148, 163, 184, 0.18)', overflowY: 'auto' }}>
          <strong style={{ fontSize: '0.78rem' }}>{t('Dispatched Batches')} ({batches.length})</strong>
          {batches.length === 0 ? (
            <p style={{ margin: 0, fontSize: '0.76rem', opacity: 0.65 }}>{t('Flushed batches sent to Moderator session appear here…')}</p>
          ) : (
            batches.map(batch => (
              <div key={batch.id} style={{ fontSize: '0.75rem', padding: '0.35rem 0.45rem', borderRadius: '0.35rem', background: 'rgba(148, 163, 184, 0.08)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7, fontSize: '0.7rem' }}>
                  <span>{batch.reason.toUpperCase()} · {batch.status}</span>
                  <span>{new Date(batch.createdAt).toLocaleTimeString()}</span>
                </div>
                <div style={{ marginTop: 2 }}>{batch.text}</div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
