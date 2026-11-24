import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { ConnectorClientResolver } from './connector-client.js';
import { encodeHubSessionId, decodeHubSessionId } from './session-id.js';
import type { DelegationCatalogSource } from './workspace-delegation-catalog.js';
import type { DelegationMember } from './workspace-delegation-preview.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

/** Local fence is deliberately NOT a remote membership version. Every preview
 * and confirmation enumerates the remote paginated directory again. A changed
 * source cursor, partial page, offline node or exceeded bound fails the whole
 * catalog; none can silently turn a group into a smaller successful grant. */
type DirectoryClients = (...args: [...Parameters<ConnectorClientResolver>, signal?: AbortSignal]) =>
  ReturnType<ConnectorClientResolver> | Promise<ReturnType<ConnectorClientResolver>>;
export function delegationDirectory(store: HubStore, clients: DirectoryClients): DelegationCatalogSource {
  // These constant-sized original-writer versions invalidate display assembly;
  // they do NOT replace per-member node/authority checks or grant transactions.
  const fence = (owner: string) => ({ generation: store.connectionDirectoryVersion(owner),
    preferencesRevision: store.workspacePreferencesRevision(owner) });
  const authorized: DelegationCatalogSource['authorized'] = (owner, member) => {
    const c = store.getConnection(member.connectionId, owner), decoded = decodeHubSessionId(member.sessionId);
    return member.owner === owner && !!c?.nodeId && c.nodeId === member.nodeId && c.status !== 'disabled'
      && store.connectionAuthority(c.id, owner) === member.authorityEpoch
      && decoded?.connectionId === c.id && sessionRuntimeId(decoded.remoteSessionKey) === member.runtime;
  };
  return {
    fence,
    authorized,
    async enumerate(owner, limit, signal) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-delegation-directory-read');
      let failed = true;
      trace.add('pending', 1); trace.reportPending();
      try {
        const before = fence(owner);
        const check = () => {
          signal.throwIfAborted();
          const after = fence(owner);
          if (after.generation !== before.generation || after.preferencesRevision !== before.preferencesRevision)
            throw Error('catalog-changed');
        };
        check();
        const connections = (await store.listConnectionsAsync(owner)).filter(c => c.status !== 'disabled')
          .sort((a, b) => a.id.localeCompare(b.id));
        check();
        const prefs = await store.workspacePreferencesAsync(owner);
        check();
        const members: DelegationMember[] = [];
        for (const connection of connections) {
          const authorityEpoch = store.connectionAuthority(connection.id, owner);
          if (!connection.nodeId || authorityEpoch === undefined) throw Error('catalog-unpinned');
          const client = await clients(connection.id, false, owner, undefined, undefined, signal), cursors = new Set<string>();
          check();
          let after: string | undefined, sourceCursor: string | undefined;
          for (let pageCount = 0; ; pageCount++) {
            if (signal.aborted || pageCount >= 101) throw Error('catalog-limit');
            const page = await client.sessionDirectory({ limit: 100, ...(after ? { after } : {}) }, signal);
            check();
            if (!page.sourceCursor) throw Error('catalog-source-unavailable');
            if (sourceCursor !== undefined && sourceCursor !== page.sourceCursor) throw Error('catalog-source-changed');
            sourceCursor = page.sourceCursor;
            for (const entry of page.sessions) {
              if (members.length >= limit || sessionRuntimeId(entry.sessionKey) !== entry.runtime) throw Error('catalog-limit');
              const sessionId = encodeHubSessionId(connection.id, entry.sessionKey), preference = prefs.sessions[sessionId];
              members.push({ owner, nodeId: connection.nodeId, connectionId: connection.id, runtime: entry.runtime, sessionId,
                authorityEpoch, groupId: preference?.groupId ?? null, tags: preference?.tags ?? [], taskBinding: 'unknown' });
            }
            if (page.nextCursor === null) break;
            if (!page.nextCursor || cursors.has(page.nextCursor)) throw Error('catalog-cursor-loop');
            cursors.add(page.nextCursor); after = page.nextCursor;
          }
        }
        check(); trace.add('records', members.length); failed = false;
        return { complete: true, members };
      } finally {
        // Cancellation ends the catalog wait, not original SQL ownership.
        trace.add('settled', 1); if (failed) trace.add(signal.aborted ? 'cancelled' : 'deferred', 1);
        trace.finish(failed);
      }
    },
  };
}
