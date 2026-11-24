import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ServerConfig } from '../config.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncWorkspaceFiles } from './async-workspace-files.js';
import { AsyncWorkspaceContent } from './async-workspace-content.js';
import { boardFileCodec } from './workspace-board-file-format.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { fileBoardRuntimes } from './workspace-board-file-policy.js';
import { registerAsyncConnectorWorkspaceFiles, type WorkspaceFileHttpAuthority } from './workspace-board-files-http.js';
import { registerAsyncConnectorContentReplicas } from './workspace-content-http.js';
import type { WorkspaceFileActor } from './connector-workspace-file-domain.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';

export type WorkspaceSessionRead = (key: string) => Promise<{ exists: boolean; ready: boolean }>;
type WorkspaceConfig = Pick<ServerConfig, 'claude' | 'copilot'> & { boardFiles: NonNullable<ServerConfig['boardFiles']> };

/** Original file effects and content receipts on the startup owner's authority.
 * Construction is inert. The native binding supplies session readiness; Deck
 * presence is not evidence that a native session is writable or even exists. */
export function registerAsyncConnectorWorkspaceHttp(app: Hono, options: {
  owner: Pick<AsyncConnectorOwner, 'command' | 'authorityChanges'>;
  config: WorkspaceConfig;
  session: WorkspaceSessionRead;
  available(): boolean;
  diagnostics?: PerformanceDiagnostics;
}) {
  const { owner, config } = options;
  const boards = new AsyncWorkspaceFiles(owner, config.boardFiles.root, boardFileCodec);
  const cards = new AsyncWorkspaceFiles(owner, config.boardFiles.root, cardFileCodec());
  const replicas = new AsyncWorkspaceContent(owner, cards);
  const authority: WorkspaceFileHttpAuthority<WorkspaceFileActor> = {
    changes: owner.authorityChanges,
    authenticate: async request => {
      if (!available()) throw new HTTPException(503);
      const actor = await cards.authenticate(request);
      if (!available()) throw new HTTPException(503);
      return actor ? { id: actor.tokenId, actor } : null;
    },
    hasScope: tokenId => owner.command('tokenHasScope', { tokenId, scope: 'boards:files' }),
  };
  const requests = createTaskDrain();
  let state: 'created' | 'starting' | 'ready' | 'failed' | 'closing' | 'closed' = 'created';
  let starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  const available = () => state === 'ready' && options.available();
  app.use('/api/connector/v1/workspace/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'Workspace service unavailable' }, 503);
    try {
      return await requests.run(async () => {
        await next();
        // Retain already accepted effects, but never publish stale authority
        // or a successful response after the root's synchronous close fence.
        // Hono ignores a returned replacement once the downstream handler has
        // finalized the context. Replace the finalized response explicitly.
        if (!available()) c.res = c.json({ error: 'Workspace service unavailable' }, 503);
      });
    } catch { c.res = c.json({ error: 'Workspace service unavailable' }, 503); }
  });
  const deps = { authority, session: options.session, deferredStart: true,
    runtimes: (tokenId: string) => fileBoardRuntimes(tokenId, config) };
  const boardRoutes = registerAsyncConnectorWorkspaceFiles(app, { ...deps, boards });
  const cardRoutes = registerAsyncConnectorWorkspaceFiles(app, { ...deps, boards: cards });
  registerAsyncConnectorContentReplicas(app, { authority, files: cards, replicas, available,
    session: options.session, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) });
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    state = 'closing';
    const trace = guardedTrace(options.diagnostics ?? performanceDiagnostics, 'connector-runtime-assembly');
    trace.add('step', 32);
    // Freeze all routes before waiting; do not close file executors while an
    // accepted content effect can still need its original file settlement.
    const drained = requests.close();
    boardRoutes.freeze(); cardRoutes.freeze();
    void (async () => {
      await drained;
      const content = await Promise.allSettled([replicas.close()]);
      const files = await Promise.allSettled([boardRoutes.close(), cardRoutes.close()]);
      state = 'closed';
      if ([...content, ...files].some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
    })().then(() => { trace.finish(false); resolve(); }, () => { trace.finish(true); reject(new ConnectorOwnerUnavailable()); });
    return closing;
  };
  const start = (): Promise<void> => {
    if (state === 'closing' || state === 'closed' || state === 'failed') return Promise.reject(new ConnectorOwnerUnavailable());
    if (starting) return starting;
    state = 'starting';
    const trace = guardedTrace(options.diagnostics ?? performanceDiagnostics, 'connector-runtime-assembly');
    trace.add('step', 30);
    starting = Promise.resolve().then(async () => {
      if (state !== 'starting') throw new ConnectorOwnerUnavailable();
      const result = await Promise.allSettled([boardRoutes.start(), cardRoutes.start()]);
      if (state !== 'starting' || result.some(entry => entry.status === 'rejected')) throw new ConnectorOwnerUnavailable();
      state = 'ready';
      trace.finish(false);
    }).catch(async () => {
      trace.finish(true);
      if (state !== 'closing' && state !== 'closed') state = 'failed';
      await close(); throw new ConnectorOwnerUnavailable();
    });
    return starting;
  };
  return { boards, cards, replicas, start, close, get state() { return state; } };
}
