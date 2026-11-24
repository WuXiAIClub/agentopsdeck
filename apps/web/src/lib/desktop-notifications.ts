import type { HubDeckEvent } from '../api.js';
import type { SessionSummary } from '@agentopsdeck/shared';
import { translate, type Locale } from './i18n.js';

export function notificationForEvent(event: HubDeckEvent) {
  const payload = event.payload as any;
  const session = payload?.session ?? payload;
  if (session?.runtime?.operation === 'compact') return;
  if (event.type === 'run.completed') return { title: session?.status === 'failed' || session?.runtime?.phase === 'failed' ? 'AgentOpsDeck run failed' : 'AgentOpsDeck run finished' };
  if (event.type === 'queued_message.failed') return { title: 'Queued message failed' };
  return undefined;
}

export function createCompletionTracker() {
  const active = new Map<string, boolean>();
  const seen = new Set<string>();
  const remember = (key: string, running: boolean) => {
    active.set(key, running);
    if (active.size > 1000) active.delete(active.keys().next().value!);
  };
  const busy = (phase?: string) => ['starting', 'running', 'waiting', 'finalizing'].includes(phase ?? '');
  const track = (event: HubDeckEvent) => {
    const payload = event.payload as any, session = payload?.session ?? payload;
    const key = `${event.envConnectionId ?? ''}:${event.sessionKey ?? session?.sessionKey ?? ''}`;
    if (event.type === 'stream.reset') { active.clear(); return; }
    if (session?.runtime?.operation === 'compact') { remember(key, false); return; }
    // Terminal execution evidence can precede canonical history. Keep the
    // witnessed run until the current-history terminal update arrives.
    if (session?.runtime && (event.type === 'run.completed' || ['completed', 'failed', 'interrupted'].includes(session.runtime.phase))
      && session.runtime.sync !== undefined && session.runtime.sync !== 'current') {
      if (event.type === 'run.completed') remember(key, true);
      return;
    }
    let notification = notificationForEvent(event);
    if (event.type === 'session.updated' && session?.runtime) {
      const phase = session.runtime.phase;
      if (active.get(key) && ['completed', 'failed', 'interrupted'].includes(phase)) {
        notification = { title: phase === 'completed' ? 'AgentOpsDeck run finished' : `AgentOpsDeck run ${phase}` };
      }
      remember(key, busy(phase));
    }
    if (!notification) return;
    const identity = `${event.type === 'queued_message.failed' ? 'queue' : 'run'}:${key}:${session?.runtime?.turnId ?? session?.runId ?? session?.id ?? session?.runCompletedAt ?? event.id}`;
    if (seen.has(identity)) return;
    seen.add(identity); if (seen.size > 500) seen.delete(seen.values().next().value!);
    return { ...notification, tag: identity, body: session?.title || session?.label || 'Open AgentOpsDeck to view the result.' };
  };
  // Initial HTTP snapshots seed in-progress work without notifying for old
  // completions or overwriting more recent SSE observations.
  return Object.assign(track, { seed(sessions: (SessionSummary & { envConnectionId?: string })[]) {
    for (const session of sessions) {
      const key = `${session.envConnectionId ?? ''}:${session.sessionKey}`;
      if (!active.has(key)) remember(key, session.runtime?.operation !== 'compact' && busy(session.runtime?.phase));
    }
  } });
}

/** Completion evidence also covers finalizing: fetch now, notify only later. */
export function isCompletionRefreshEvent(event: HubDeckEvent) {
  const payload = event.payload as any, session = payload?.session ?? payload;
  if (session?.runtime?.operation === 'compact') return false;
  return event.type === 'run.completed' || event.type === 'session.updated' &&
    (['completed', 'failed', 'interrupted'].includes(session?.runtime?.phase)
      || session?.runtime?.phase === 'finalizing' && !!session?.runCompletedAt);
}

export function notificationsEnabled() {
  try { return localStorage.getItem('agentopsdeck.notifications') !== 'off'; } catch { return true; }
}

const deliveryMessages = {
  unsupported: 'Notifications are not supported in this browser. On iOS, install AgentOpsDeck on the Home Screen and open it there.',
  permission: 'Notifications are blocked. Allow notifications in this browser’s site settings, then retry.',
  disabled: 'Notifications are disabled in AgentOpsDeck browser settings.',
  workerAccepted: 'Browser accepted the notification. If no banner appeared, check OS notification permissions and Focus / Do Not Disturb. AgentOpsDeck cannot verify OS display.',
  workerUnknown: 'No confirmation from the notification worker. The browser may still display it; check OS settings before retrying.',
  desktopUnknown: 'No display confirmation from the browser. Check site and OS notification settings, then retry.',
  desktopShown: 'Browser reported the notification displayed. OS settings may still hide its banner.',
  desktopFailed: 'Browser reported a notification delivery error. Check site and OS permissions.',
  unavailable: 'Notification unavailable. Check browser and operating system permissions.',
} as const;
export type NotificationDelivery = { accepted: boolean; code: keyof typeof deliveryMessages; transport?: 'worker' | 'desktop'; detail: string };
export function notificationDeliveryMessage(result: NotificationDelivery, locale: Locale) {
  return translate(deliveryMessages[result.code], locale);
}

async function notificationDeadline<T>(promise: Promise<T>, message: string, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}

/** Bound registration AND activation; a blocked worker must not trap Settings. */
export async function prepareNotificationWorker(worker: Pick<ServiceWorkerContainer, 'register' | 'ready'>, timeout = 8000): Promise<boolean> {
  try {
    await notificationDeadline((async () => {
      await worker.register('/sw.js', { updateViaCache: 'none' });
      await worker.ready;
    })(), 'Notification worker is not ready. Retry shortly.', timeout);
    return true;
  } catch { return false; }
}

/** Browser acceptance is observable; OS presentation / Focus mode is not. */
export async function requestDesktopNotification(title: string, options: NotificationOptions = {}): Promise<NotificationDelivery> {
  if (typeof Notification === 'undefined') return { accepted: false, code: 'unsupported', detail: deliveryMessages.unsupported };
  if (Notification.permission !== 'granted') return { accepted: false, code: 'permission', detail: deliveryMessages.permission };
  if (!notificationsEnabled()) return { accepted: false, code: 'disabled', detail: deliveryMessages.disabled };
  try {
    // Mobile browsers require a service worker; desktop can use it as well.
    if ('serviceWorker' in navigator) {
      try {
        const registration = await notificationDeadline(navigator.serviceWorker.getRegistration(), 'Notification worker lookup timed out.');
        if (registration?.active) {
          // Once submitted, a timeout is unknown, not permission to send twice.
          try {
            await notificationDeadline(registration.showNotification(title, options), 'No confirmation from the notification worker. The browser may still display it; check OS settings before retrying.');
            return { accepted: true, code: 'workerAccepted', transport: 'worker', detail: deliveryMessages.workerAccepted };
          } catch { return { accepted: false, code: 'workerUnknown', transport: 'worker', detail: deliveryMessages.workerUnknown }; }
        }
      } catch { /* Nothing was submitted; a desktop attempt is still safe. */ }
    }
    const notification = new Notification(title, options);
    notification.onclick = () => { window.focus(); notification.close(); };
    return await new Promise<NotificationDelivery>(resolve => {
      const finish = (result: NotificationDelivery) => { clearTimeout(timer); notification.onshow = null; notification.onerror = null; resolve(result); };
      const timer = setTimeout(() => finish({ accepted: false, code: 'desktopUnknown', detail: deliveryMessages.desktopUnknown }), 5000);
      notification.onshow = () => finish({ accepted: true, code: 'desktopShown', transport: 'desktop', detail: deliveryMessages.desktopShown });
      notification.onerror = () => finish({ accepted: false, code: 'desktopFailed', detail: deliveryMessages.desktopFailed });
    });
  } catch {
    return { accepted: false, code: 'unavailable', detail: deliveryMessages.unavailable };
  }
}

export async function showDesktopNotification(title: string, options: NotificationOptions = {}) {
  return (await requestDesktopNotification(title, options)).accepted;
}
