import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, GitFork, Loader2, Sparkles, X } from 'lucide-react';
import type { ChatMessage, SendDeliveryMode, SessionSummary } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { CommandOutcomeUnknownError, newCommandKey } from '../lib/command-recovery';
import { useI18n } from '../lib/i18n';
import { sendMessageWithRecovery } from '../lib/message-submission';
import { sessionAddress } from '../lib/session-address';
import { createSessionWithRecovery } from '../lib/session-creation';
import {
  SESSION_HANDOFF_EVENT,
  buildSessionHandoffPrompt,
  buildSessionHandoffTitle,
  evaluateSessionWatermark,
  formatRolloutBytes,
  inheritSessionArtifacts,
  migratePersistedLayoutsForHandoff,
  pushMigratedLayoutsToCloud,
  watermarkDismissKey,
  type SessionHandoffEventDetail,
  type SessionWatermarkState,
} from '../lib/session-handoff';
import { sessionRuntimeDraft } from '../lib/session-runtime-overrides';
import { newSessionSource, sessionRuntimeUi } from '../lib/session-runtime-ui';
import { updateSettingsWithRecovery } from '../lib/session-settings';

export type SessionVolumeWatermarkBannerProps = {
  session: SessionSummary;
  messages: readonly ChatMessage[];
  deliveryMode: SendDeliveryMode;
  maxMessageChars?: number | undefined;
  compact?: boolean | undefined;
};

type HandoffStage = 'idle' | 'creating' | 'inheriting' | 'sending';

const COMPOSER_DRAFT_PREFIX = 'agentopsdeck.composerDraft:';

function resolveCreationAgentId(session: SessionSummary): string {
  if (
    session.source === 'codex' ||
    session.source === 'claude-code' ||
    session.source === 'ghcp' ||
    session.source === 'antigravity' ||
    session.source === 'hermes'
  ) {
    return session.source;
  }
  return session.agentId || 'codex';
}

function resolveConnectionId(session: SessionSummary): string {
  const explicit = (session as SessionSummary & { envConnectionId?: string }).envConnectionId;
  if (explicit && explicit.trim()) return explicit.trim();
  if (session.sessionRef?.nodeId?.trim()) return session.sessionRef.nodeId.trim();
  return 'local';
}

function saveFallbackDraft(scope: string, sessionKey: string, prompt: string) {
  if (!scope || !prompt) return;
  try {
    window.sessionStorage.setItem(`${COMPOSER_DRAFT_PREFIX}${scope}:${sessionKey}`, prompt);
  } catch {
    // Storage quota or private-mode restriction; ignore silently.
  }
}

function readDismissedFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeDismissedFlag(key: string) {
  try {
    window.sessionStorage.setItem(key, '1');
  } catch {
    // Ignore storage failure; in-memory state still dismisses for current mount.
  }
}

export function SessionVolumeWatermarkBanner({
  session,
  messages,
  deliveryMode,
  maxMessageChars,
  compact = false,
}: SessionVolumeWatermarkBannerProps) {
  const { t } = useI18n();
  const scope = recoveryScope() ?? '';
  const address = useMemo(() => sessionAddress(session.sessionKey), [session.sessionKey]);
  const watermark: SessionWatermarkState = useMemo(
    () => evaluateSessionWatermark(session, messages.length),
    [session, messages.length],
  );

  const dismissStorageKey = useMemo(
    () => (watermark.severity ? watermarkDismissKey(scope, session.sessionKey, watermark.severity) : ''),
    [scope, session.sessionKey, watermark.severity],
  );

  const [dismissed, setDismissed] = useState<boolean>(() =>
    dismissStorageKey ? readDismissedFlag(dismissStorageKey) : false,
  );
  const [stage, setStage] = useState<HandoffStage>('idle');
  const [error, setError] = useState<string>('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setDismissed(dismissStorageKey ? readDismissedFlag(dismissStorageKey) : false);
    setError('');
    setStage('idle');
  }, [dismissStorageKey]);

  const handleDismiss = useCallback(() => {
    if (dismissStorageKey) writeDismissedFlag(dismissStorageKey);
    setDismissed(true);
  }, [dismissStorageKey]);

  const handleHandoff = useCallback(async () => {
    if (stage !== 'idle' || address.shared) return;
    const startScope = recoveryScope() ?? '';
    const agentId = resolveCreationAgentId(session);
    const connectionId = resolveConnectionId(session);
    const handoffTitle = buildSessionHandoffTitle(session.title, session.sessionKey);
    const envLabel = (session as SessionSummary & { envConnectionLabel?: string }).envConnectionLabel;

    setError('');
    setStage('creating');

    try {
      await createSessionWithRecovery({ agentId, connectionId }, handoffTitle, async (created) => {
        if (recoveryScope() !== startScope) return;

        const nextSummary: SessionSummary = {
          sessionKey: created.key,
          agentId,
          title: handoffTitle,
          status: 'idle',
          source: newSessionSource(agentId),
          lastActiveAt: Date.now(),
          messageCount: 0,
          ...((session as SessionSummary & { cwd?: string }).cwd
            ? { cwd: (session as SessionSummary & { cwd?: string }).cwd }
            : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
          ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
          ...(connectionId ? { envConnectionId: connectionId } : {}),
          ...(envLabel ? { envConnectionLabel: envLabel } : {}),
        } as SessionSummary;

        if (mountedRef.current) setStage('inheriting');

        const inherited = await inheritSessionArtifacts(session.sessionKey, created.key, {
          isSharedSession: false,
          applyModelSettings: async () => {
            const draft = sessionRuntimeDraft(session);
            if (!draft.model && !draft.thinking) return false;
            const ui = sessionRuntimeUi(session);
            if (ui.configuredModel) return false;
            await updateSettingsWithRecovery(created.key, {
              model: draft.model || null,
              ...(!ui.sdk ? { thinking: draft.thinking || null } : {}),
            });
            return true;
          },
          readSessionNotebook: (key) => api.sessionNotebook(key),
          saveSessionNotebook: (key, value) => api.saveSessionNotebook(key, value),
          readSessionGuidance: (key, sig) => api.sessionGuidance(key, sig),
          saveSessionGuidance: (key, value, sig) => api.saveSessionGuidance(key, value, sig),
          listWorkspaceBoards: (sig) => api.workspaceBoards(sig),
          readFileBoardBinding: (id, sig) => api.fileBoardBinding(id, sig),
          revokeFileBoard: (id, bindingId, sig) => api.revokeFileBoard(id, bindingId, sig),
          readWorkspaceBoard: (id, sig) => api.workspaceBoard(id, sig),
          bindFileBoard: (id, input, sig) => api.bindFileBoard(id, input, sig),
          listHubNotebooks: (after) => api.hubNotebooks(after),
          readFileCardBinding: (id, sig) => api.fileCardBinding(id, sig),
          revokeFileCard: (id, bindingId, sig) => api.revokeFileCard(id, bindingId, sig),
          readFileCard: (id, sig) => api.fileCard(id, sig),
          bindFileCard: (id, input, sig) => api.bindFileCard(id, input, sig),
        });

        if (recoveryScope() !== startScope) return;
        if (mountedRef.current) setStage('sending');

        const prompt = buildSessionHandoffPrompt({
          sourceSession: session,
          messages,
          watermark,
          inherited,
          maxChars: maxMessageChars,
        });

        try {
          await sendMessageWithRecovery(created.key, prompt, deliveryMode, [], newCommandKey());
        } catch (sendErr) {
          if (!(sendErr instanceof CommandOutcomeUnknownError)) {
            saveFallbackDraft(startScope, created.key, prompt);
          }
        }

        if (recoveryScope() !== startScope) return;
        const migratedLayouts = migratePersistedLayoutsForHandoff({
          scope: startScope,
          fromSessionKey: session.sessionKey,
          toSessionKey: created.key,
          replaceSourcePane: true,
        });
        const detail: SessionHandoffEventDetail = {
          fromSessionKey: session.sessionKey,
          toSessionKey: created.key,
          session: nextSummary,
          replaceSourcePane: true,
        };
        window.dispatchEvent(new CustomEvent<SessionHandoffEventDetail>(SESSION_HANDOFF_EVENT, { detail }));
        const pendingSavedForCloud = detail.claimedSavedSync ? null : migratedLayouts.savedSerialized;
        const pendingCurrentForCloud = detail.claimedCurrentSync ? null : migratedLayouts.currentSerialized;
        if (pendingSavedForCloud || pendingCurrentForCloud) {
          void pushMigratedLayoutsToCloud({
            scope: startScope,
            isCurrentScope: () => recoveryScope() === startScope,
            savedSerialized: pendingSavedForCloud,
            currentSerialized: pendingCurrentForCloud,
            loadLayout: (kind, sig) => api.workspaceLayouts(kind, sig),
            saveLayout: (kind, val, sig) => api.saveWorkspaceLayouts(kind, val, sig),
            fromSessionKey: session.sessionKey,
            toSessionKey: created.key,
            replaceSourcePane: true,
          });
        }
      });
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) {
        setStage('idle');
      }
    }
  }, [address.shared, deliveryMode, maxMessageChars, messages, session, stage, watermark]);

  if (!watermark.triggered || !watermark.severity || dismissed || address.shared) {
    return null;
  }

  const isCritical = watermark.severity === 'critical';
  const busy = stage !== 'idle';

  const metricBadges: string[] = [];
  if (watermark.metrics.rolloutBytes > 0) {
    metricBadges.push(
      t('Rollout {size}', { size: formatRolloutBytes(watermark.metrics.rolloutBytes) }),
    );
  }
  if (watermark.metrics.messageCount > 0) {
    metricBadges.push(
      t('{count} msgs', { count: watermark.metrics.messageCount.toLocaleString() }),
    );
  }
  if (watermark.metrics.turnCompactions > 0) {
    metricBadges.push(
      t('{count} compactions/turn', { count: watermark.metrics.turnCompactions }),
    );
  }

  const stageLabel =
    stage === 'creating'
      ? t('Creating continuation session…')
      : stage === 'inheriting'
        ? t('Syncing notebooks & taskboards…')
        : stage === 'sending'
          ? t('Sending handoff summary…')
          : t('Summarize & Handoff Session');

  return (
    <div
      className={`session-watermark-banner${isCritical ? ' is-critical' : ' is-warning'}${compact ? ' is-compact' : ''}`}
      role="region"
      aria-label={t('Session volume watermark notice')}
    >
      <div className="session-watermark-main">
        <span className="session-watermark-icon" aria-hidden="true">
          {isCritical ? <AlertTriangle size={15} /> : <Sparkles size={15} />}
        </span>
        <div className="session-watermark-copy">
          <div className="session-watermark-headline">
            <strong className="session-watermark-title">
              {t(
                isCritical
                  ? 'Session volume is critically large'
                  : 'Session volume reached handoff watermark',
              )}
            </strong>
            {metricBadges.length > 0 ? (
              <span className="session-watermark-pills">
                {metricBadges.map((badge) => (
                  <span key={badge} className="session-watermark-pill">
                    {badge}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
          {!compact ? (
            <p className="session-watermark-desc">
              {t(
                'Forking to a clean session carries over summary context, working directory, model settings, and Notebook / Taskboard bindings to keep memory and latency fast.',
              )}
            </p>
          ) : null}
          {error ? (
            <p className="session-watermark-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="session-watermark-actions">
        <button
          type="button"
          className="session-watermark-cta"
          disabled={busy}
          onClick={() => void handleHandoff()}
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <GitFork size={13} aria-hidden="true" />
          )}
          <span>{stageLabel}</span>
        </button>
        <button
          type="button"
          className="session-watermark-dismiss"
          disabled={busy}
          onClick={handleDismiss}
          aria-label={t('Dismiss watermark notice')}
          title={t('Dismiss watermark notice')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
