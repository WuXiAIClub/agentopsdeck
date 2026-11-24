/** Invalidations only, never completion/ACK truth. Retain the existing shared
 * account feed even when the current layout has no mounted session panes. */
export function createLayoutUnreadEvents() {
  const listeners = new Set<{ scope: string; keys: ReadonlySet<string>; notify(): void }>();
  let acquire: (() => { close(): void } | undefined) | undefined;
  let connection: { close(): void } | undefined;
  return {
    configure(start: typeof acquire) { acquire = start; },
    receive(scope: string, event: { type: string; sessionKey?: string; hubSessionId?: string }) {
      if (!['session.updated', 'run.updated', 'run.completed', 'completion.read', 'stream.reset', 'stream.status'].includes(event.type)) return;
      const key = event.hubSessionId ?? event.sessionKey;
      for (const listener of listeners) {
        if (listener.scope === scope && (event.type.startsWith('stream.') || (key && listener.keys.has(key)))) listener.notify();
      }
    },
    subscribe(scope: string, keys: ReadonlySet<string>, notify: () => void) {
      const listener = { scope, keys, notify }; listeners.add(listener);
      if (!connection) connection = acquire?.();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { connection?.close(); connection = undefined; }
      };
    },
  };
}
export const layoutUnreadEvents = createLayoutUnreadEvents();
