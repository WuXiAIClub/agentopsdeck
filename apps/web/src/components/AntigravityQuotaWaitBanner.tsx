import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Play, X } from 'lucide-react';
import {
  formatQuotaCountdown,
  parseAntigravityQuotaWait,
  type AntigravityQuotaWaitState,
  type ChatMessage,
  type SessionSummary,
} from '@agentopsdeck/shared';
import { useI18n } from '../lib/i18n';
import './antigravity-quota-wait.css';

export function resolveActiveQuotaWait(
  session: SessionSummary,
  messages: readonly ChatMessage[],
  now = Date.now(),
): AntigravityQuotaWaitState | undefined {
  if (session.hasActiveRun || session.status === 'running') return undefined;
  if (session.quotaWait && session.quotaWait.retryAt > now) {
    return session.quotaWait;
  }
  const isAntigravity = session.source === 'antigravity'
    || session.agentId === 'antigravity'
    || session.sessionKey.startsWith('antigravity:');
  if (!isAntigravity) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role === 'user') break;
    if (msg.role !== 'assistant' || !msg.text) continue;
    const parsed = parseAntigravityQuotaWait(msg.text, msg.createdAt || now);
    if (parsed && parsed.retryAt > now) {
      return parsed;
    }
    break;
  }
  return undefined;
}

export function AntigravityQuotaWaitBanner({
  session,
  messages,
  onRetryNow,
  onAutoResume,
}: {
  session: SessionSummary;
  messages: readonly ChatMessage[];
  onRetryNow: () => void;
  onAutoResume?: () => void;
}) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [cancelledForDetectedAt, setCancelledForDetectedAt] = useState<number | null>(null);
  const autoResumedForRef = useRef<number | null>(null);

  const wait = useMemo(() => resolveActiveQuotaWait(session, messages, now), [session, messages, now]);
  const cancelled = wait ? cancelledForDetectedAt === wait.detectedAt : false;

  useEffect(() => {
    if (!wait || cancelled) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [wait?.detectedAt, wait?.retryAt, cancelled]);

  useEffect(() => {
    if (!wait || cancelled || !wait.autoRetry || !onAutoResume) return;
    const remaining = wait.retryAt - now;
    if (remaining <= 0 && autoResumedForRef.current !== wait.detectedAt) {
      autoResumedForRef.current = wait.detectedAt;
      onAutoResume();
    }
  }, [wait, cancelled, now, onAutoResume]);

  if (!wait || cancelled) return null;

  const remainingMs = Math.max(0, wait.retryAt - now);
  const progress = wait.retryAfterMs > 0
    ? Math.max(0, Math.min(1, 1 - remainingMs / wait.retryAfterMs))
    : 1;
  const resumeAtLabel = new Date(wait.retryAt).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div
      className="antigravity-quota-wait-banner"
      data-antigravity-quota-wait
      role="status"
      aria-live="polite"
    >
      <div className="antigravity-quota-wait-main">
        <span className="antigravity-quota-wait-icon" aria-hidden="true">
          <Clock3 size={15} />
        </span>
        <div className="antigravity-quota-wait-copy">
          <div className="antigravity-quota-wait-head">
            <strong>{t('Waiting for Antigravity quota reset')}</strong>
            <span className="antigravity-quota-wait-countdown">{formatQuotaCountdown(remainingMs)}</span>
          </div>
          <p className="antigravity-quota-wait-meta">
            {t('Auto-continues at {time}', { time: resumeAtLabel })}
          </p>
        </div>
        <div className="antigravity-quota-wait-actions">
          <button
            type="button"
            className="antigravity-quota-wait-btn is-primary"
            onClick={() => {
              setCancelledForDetectedAt(wait.detectedAt);
              onRetryNow();
            }}
          >
            <Play size={12} aria-hidden="true" />
            <span>{t('Retry now')}</span>
          </button>
          <button
            type="button"
            className="antigravity-quota-wait-btn"
            aria-label={t('Cancel auto-retry')}
            title={t('Cancel auto-retry')}
            onClick={() => setCancelledForDetectedAt(wait.detectedAt)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="antigravity-quota-wait-track" aria-hidden="true">
        <span className="antigravity-quota-wait-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}
