import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { CodexNativeNotification } from '../codex/native-notification.js';

/** Sole-owner assembly port, not an optional second writer. The original
 * receiver owns effects/projections and physically drains this command. */
export class AsyncCodexNotifications {
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>) {}
  settle(event: CodexNativeNotification) { return this.owner.command('codexNativeNotification', event); }
  settleConnectionPage(after: string, previousConnectionId: string | undefined, nextConnectionId: string | undefined) {
    return this.owner.command('codexConnectionRecoveryPage', { after, limit: 64,
      previousConnectionId: previousConnectionId ?? null, nextConnectionId: nextConnectionId ?? null });
  }
}
