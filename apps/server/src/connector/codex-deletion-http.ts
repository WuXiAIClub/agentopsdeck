import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Hono } from 'hono';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncCodexDeletion } from './async-codex-deletion.js';
import { registerOwnedDeletionHttp } from './sdk-deletion-http.js';

export type CodexDeletionHttp = { deletion: Pick<AsyncCodexDeletion, 'remove' | 'receipt'>;
  ready(): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics };
export function registerCodexDeletionHttp(app: Hono, path: string, deps: CodexDeletionHttp) {
  registerOwnedDeletionHttp(app, path, { ...deps,
    runtime: key => sessionRuntimeId(key) === 'codex' ? 'codex' : undefined,
    receipt: (_runtime, key, commandKey, authorization) => deps.deletion.receipt(key, commandKey, authorization),
    remove: (_runtime, key, commandKey, authorization) => deps.deletion.remove(key, commandKey, authorization),
    operation: 'codex-session-deletion',
  });
}
