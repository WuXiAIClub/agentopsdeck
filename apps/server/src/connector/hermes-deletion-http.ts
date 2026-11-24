import type { Hono } from 'hono';
import type { AsyncHermesDeletion } from './async-hermes-deletion.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerOwnedDeletionHttp } from './sdk-deletion-http.js';

export type HermesDeletionHttp = {
  lifecycle: Pick<AsyncHermesDeletion, 'remove' | 'receipt'>;
  ready(): boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
/** Same legacy deletion wire format; runtime/worker own all effects and drain. */
export function registerHermesDeletionHttp(app: Hono, path: string, deps: HermesDeletionHttp) {
  registerOwnedDeletionHttp(app, path, {
    ...deps,
    runtime: key => key.startsWith('hermes:') && key !== 'hermes:' ? 'hermes' : undefined,
    receipt: (_runtime, key, commandKey, authorization) => deps.lifecycle.receipt(key, commandKey, authorization),
    remove: (_runtime, key, commandKey, authorization) => deps.lifecycle.remove(key, commandKey, authorization),
    operation: 'hermes-session-deletion',
  });
}
