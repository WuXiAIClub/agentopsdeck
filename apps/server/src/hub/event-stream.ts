import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import type { HubEventBrokers } from './event-broker.js';
import type { HubDeliveryEvent, HubStore } from './hub-store.js';
import { WORKSPACE_REVISION_TYPES } from './delivery-reader-protocol.js';
import type { HubEventReplayPort } from './async-event-replay.js';
import type { HubRequestWork } from './async-request-work.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Delivery = Omit<HubDeliveryEvent, 'id'> & { id?: string };

// Owner and resource views share replay, cancellation and backpressure handling.
// A resource view supplies both authority and a whitelist projection; it never
// receives an unfiltered browser feed or gets its own duplicate durable journal.
export function hubEventResponse(c: Context, deps: {
  ownerUserId: string; subscription: ReturnType<HubEventBrokers['acquire']>;
  authorize: () => void | Promise<void>; connectionId?: string;
  workspaceResources?: boolean;
  work?: Pick<HubRequestWork, 'run'>; signal?: AbortSignal;
  project?: (event: Delivery) => (object & { type: string }) | undefined;
} & ({ replay: HubEventReplayPort; store?: HubStore } | { store: HubStore; replay?: undefined })) {
  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-store');
  let released = false;
  const release = () => { if (!released) { released = true; deps.subscription.release(); } };
  const response = streamSSE(c, stream => {
    const run = async () => {
    const trace = guardedTrace(performanceDiagnostics, 'hub-event-stream'); let failed = false;
    const controller = new AbortController();
    const abort = () => { controller.abort(); stream.abort(); };
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    deps.signal?.addEventListener('abort', abort, { once: true });
    stream.onAbort(() => controller.abort());
    const { events } = deps.subscription;
    events.closedSignal.addEventListener('abort', abort, { once: true });
    const write = async (event: string, data: string, id?: string) => {
      if (controller.signal.aborted || events.isClosed) return;
      if (!await authorized()) return;
      const timer = setTimeout(() => {
        failed = true; trace.add('timedOut', 1);
        trace.reportPending({ step: 1, pending: 1, timedOut: 1 });
        abort();
      }, 10_000);
      try {
        if (id === '') {
          await stream.write('id:\n');
          if (controller.signal.aborted || events.isClosed) return;
          if (!await authorized()) return;
        }
        await stream.writeSSE({ event, data, ...(id !== undefined ? { id } : {}) });
      } finally { clearTimeout(timer); }
    };
    const deliver = async (event: Delivery) => {
      if (deps.connectionId !== undefined && event.envConnectionId !== deps.connectionId) return;
      const projected = deps.project ? deps.project(event) : event;
      if (projected) {
        await write(projected.type, JSON.stringify(projected), event.id);
        if (!controller.signal.aborted) trace.add('records', 1);
      }
    };
    const readUntilAbort = <T>(read: () => Promise<T>) =>
      new Promise<T | undefined>((resolve, reject) => {
        // Disconnect releases the subscription immediately, not after SQL's
        // deadline. The original reader still tracks and drains accepted SQL;
        // abandoning this response is not permission to close its database.
        const stopped = () => { controller.signal.removeEventListener('abort', stopped); resolve(undefined); };
        controller.signal.addEventListener('abort', stopped, { once: true });
        if (controller.signal.aborted || events.isClosed) { stopped(); return; }
        // Publish cancellation before starting the original read, and consume
        // late settlement without replaying it or releasing its SQL owner.
        void Promise.resolve().then(() => {
          if (controller.signal.aborted || events.isClosed) return undefined;
          return read();
        }).then(value => {
          controller.signal.removeEventListener('abort', stopped); resolve(value);
        }, error => { controller.signal.removeEventListener('abort', stopped); reject(error); });
      });
    const authorized = async () => {
      const ok = await readUntilAbort(async () => { await deps.authorize(); return true; });
      return ok === true && !controller.signal.aborted && !events.isClosed;
    };
    try {
      if (c.req.raw.signal.aborted || deps.signal?.aborted || events.isClosed) { abort(); return; }
      let cursor = c.req.header('last-event-id') ?? c.req.query('lastEventId')
        ?? (deps.replay ? deps.replay.initialCursor : deps.store.latestDeliveryCursor(deps.ownerUserId));
      await write('heartbeat', '');
      // Capture the initial cursor BEFORE waiting: events arriving during the
      // original enumeration must remain replayable. Never advance an empty
      // initial scope past them. Heartbeat and disconnect stay independent of
      // SQL readiness, and the broker retains the original read on release.
      await readUntilAbort(() => events.directoryReady());
      if (controller.signal.aborted || events.isClosed) return;
      let heartbeatAt = Date.now() + 10_000;
      let denied = '';
      let resourceCheckAt = 0;
      const resourceSnapshots = new Map<string, string>();
      while (!controller.signal.aborted && !events.isClosed) {
        if (!await authorized()) break;
        // Owner stream only. Resource revisions are a separate, level-triggered
        // snapshot, not Connector deliveries. Reconnect replays current versions
        // independently of the bounded chat journal and its Last-Event-ID.
        if (deps.workspaceResources && !deps.project && deps.connectionId === undefined && Date.now() >= resourceCheckAt) {
          resourceCheckAt = Date.now() + 2_000;
          const revisions = await readUntilAbort(() => deps.replay ? deps.replay.revisions() : deps.store.workspaceRevisionsAsync(deps.ownerUserId)).catch(() => {
            // Display invalidations and chat replay have different failure
            // scopes. Preserve existing messages/delivery cursors and retry
            // display metadata with backoff; never fabricate an empty version.
            trace.add('deferred', 1); resourceCheckAt = Date.now() + 10_000;
            return undefined;
          });
          if (controller.signal.aborted || events.isClosed) break;
          if (!await authorized()) break;
          if (revisions) for (const resourceType of WORKSPACE_REVISION_TYPES) {
            const resources = revisions[resourceType];
            const snapshot = JSON.stringify(resources);
            if (snapshot !== (resourceSnapshots.get(resourceType) ?? '[]')) {
              await write('workspace.revisions', JSON.stringify({ type: 'workspace.revisions', resourceType, resources }));
              resourceSnapshots.set(resourceType, snapshot);
            }
          }
        }
        const revision = events.revision;
        const observedDenied = await readUntilAbort(() => events.deniedConnectionsAsync?.() ?? Promise.resolve(events.deniedConnections()));
        if (!observedDenied || controller.signal.aborted || events.isClosed) break;
        const deniedConnections = observedDenied.filter(event => deps.connectionId === undefined || event.envConnectionId === deps.connectionId);
        const nextDenied = JSON.stringify(deniedConnections);
        if (nextDenied !== denied) {
          for (const event of deniedConnections) await deliver(event);
          denied = nextDenied;
        }
        const domains = await readUntilAbort(() => events.visibleDomainsAsync?.() ?? Promise.resolve(events.visibleDomains()));
        if (!domains || controller.signal.aborted || events.isClosed) break;
        if (deps.connectionId !== undefined) for (const id of domains.keys()) if (id !== deps.connectionId) domains.delete(id);
        const page = await readUntilAbort(() => deps.replay ? deps.replay.page(cursor, domains) : deps.store.deliveryPageAsync(cursor, domains, deps.ownerUserId));
        if (!page || controller.signal.aborted || events.isClosed) break;
        if (!await authorized()) break;
        if (page.reset) await write('stream.reset', JSON.stringify({ type: 'stream.reset', ts: Date.now(), payload: { reason: 'cursor_expired' } }), page.cursor ?? '');
        for (const event of page.events) {
          if (controller.signal.aborted) break;
          if (!await authorized()) break;
          // Recheck only the original target authority, not a full directory
          // scan for every event in the page. An absent/rotated domain cannot
          // be revived by this earlier readonly replay snapshot.
          const domain = domains.get(event.envConnectionId);
          const visible = domain === undefined ? undefined : await readUntilAbort(() =>
            events.visibleDomainAsync?.(event.envConnectionId) ?? Promise.resolve(events.visibleDomain(event.envConnectionId)));
          if (domain === undefined || visible !== domain) continue;
          await deliver(event);
        }
        const advanced = page.cursor !== cursor;
        cursor = page.cursor;
        if (Date.now() >= heartbeatAt) { await write('heartbeat', ''); heartbeatAt = Date.now() + 10_000; }
        // Login/grant changes are still polled until their own durable wakeups
        // are wired. Every frame rechecks the captured proof independently.
        if (!advanced) await events.wait(revision, controller.signal, Math.min(2_000, Math.max(1, heartbeatAt - Date.now())));
      }
    } catch (error) {
      failed = true; addSqlFailure(trace, error); abort();
    } // No private upstream/storage/auth errors in SSE frames.
    finally {
      c.req.raw.signal.removeEventListener('abort', abort);
      deps.signal?.removeEventListener('abort', abort);
      events.closedSignal.removeEventListener('abort', abort);
      controller.abort();
      try { release(); trace.add('settled', 1); }
      catch (error) { failed = true; trace.add('unknown', 1); addSqlFailure(trace, error); }
      trace.add('step', 3); trace.finish(failed);
    }
    };
    // The outer HTTP request ends at headers; retain the original stream
    // callback separately through cancellation and subscription release.
    return deps.work ? deps.work.run(run).catch(() => { release(); stream.abort(); }) : run();
  });
  // streamSSE installs no-cache. Middleware may have materialized c.res;
  // Hono then merges that context's headers over this returned response.
  // Update both original context and response so composition cannot undo it.
  c.header('Cache-Control', 'no-store, no-transform');
  response.headers.set('Cache-Control', 'no-store, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
}
