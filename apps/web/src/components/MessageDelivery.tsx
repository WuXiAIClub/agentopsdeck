import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ChatMessage } from '@agentopsdeck/shared';
import { hasQueuedMessageControls, showsQueuedMessage } from '../lib/live-session';
import { useI18n } from '../lib/i18n';

export const QueueMessageControls = createContext<{
  active: boolean;
  editingId?: string | undefined;
  render: (message: ChatMessage, onCancelled: () => void) => React.ReactNode;
} | undefined>(undefined);

/** The queue editor replaces the message body, rather than duplicating it. */
export function QueueMessageBody({ message, children }: { message: ChatMessage; children: React.ReactNode }) {
  const controls = useContext(QueueMessageControls);
  return controls?.editingId === message.id && hasQueuedMessageControls(message, controls.active) ? null : <>{children}</>;
}

export function MessageDelivery({ message, placement = 'footer' }: { message: ChatMessage; placement?: 'header' | 'footer' }) {
  const { t } = useI18n();
  const controls = useContext(QueueMessageControls);
  const [showSending, setShowSending] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    setShowSending(false);
    if (placement !== 'footer' || message.status !== 'sending') return;
    const timer = window.setTimeout(() => setShowSending(true), 700);
    return () => window.clearTimeout(timer);
  }, [message.id, message.status, placement]);
  if (message.role !== 'user') return null;
  if (cancelled) return <p className="mb-2 text-xs opacity-80" role="status">{t('Cancelled · will not be sent')}</p>;
  // Idle durable admission is an implementation detail, not a waiting queue.
  if (message.queueDisposition === 'preparing' && (message.queueObservation === 'dispatching' || message.queueObservation === 'absent')) return null;
  if (placement === 'header' && message.queueObservation) return <div className="message-delivery" data-delivery="accepted" role="status">
    <span className="queue-card-label">{t(message.queueObservation === 'dispatching' ? 'Starting…'
      : message.queueObservation === 'blocked' ? 'Blocked · not sent'
      : message.queueObservation === 'unknown' ? 'Delivery status unconfirmed' : 'Left queue · syncing history…')}</span>
  </div>;
  if (placement === 'header' && showsQueuedMessage(message, controls?.active ?? false)) return <div className="message-delivery" data-delivery="queued">
    {controls && hasQueuedMessageControls(message, controls.active)
      ? controls.render(message, () => setCancelled(true))
      : <span className="queue-card-label" role="status">{t(controls ? '◷ Queued · confirming controls' : '◷ Queued')}</span>}
  </div>;
  if (placement === 'header' && message.status === 'sending' && message.queueDisposition === 'waiting') {
    return <div className="message-delivery" data-delivery="submitting"><span className="queue-card-label" role="status">{t('◷ Queueing…')}</span></div>;
  }
  if (message.status === 'sending' && message.queueDisposition === 'waiting') return null;
  return placement === 'footer' && message.status === 'sending' && showSending ? <p className="mt-2 text-xs opacity-80" role="status">{t('Sending…')}</p> : null;
}
