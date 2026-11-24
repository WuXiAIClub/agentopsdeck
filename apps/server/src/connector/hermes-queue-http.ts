import type { Hono } from 'hono';
import type { AsyncHermesQueue } from './async-hermes-queue.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerOwnedQueueHttp } from './sdk-queue-http.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

export type HermesQueueHttp = { queue: Pick<AsyncHermesQueue, 'page' | 'commandPage' | 'edit' | 'cancel' | 'readReceipt'>;
  ready(): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics };
export function registerHermesQueueHttp(app: Hono, path: string, deps: HermesQueueHttp) {
  registerOwnedQueueHttp<'hermes'>(app, path, {
    ...deps, ready: () => deps.ready(),
    runtime: key => key.startsWith('hermes:') && key !== 'hermes:' ? 'hermes' : undefined,
    evidence: c => {
      const expectedNode = c.req.header(EXPECTED_NODE_HEADER), grantRef = c.req.header('x-agentopsdeck-execution-grant');
      return { ...(expectedNode !== undefined ? { expectedNode } : {}), ...(grantRef !== undefined ? { grantRef } : {}) };
    }, mutationMethod: true, operation: 'hermes-queue-http',
  });
}
