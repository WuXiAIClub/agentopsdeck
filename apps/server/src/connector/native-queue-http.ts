import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Hono } from 'hono';
import type { AsyncNativeQueue } from './async-native-queue.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerOwnedQueueHttp } from './sdk-queue-http.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

export type NativeQueueHttp = { queue: Pick<AsyncNativeQueue, 'page' | 'commandPage' | 'edit' | 'cancel' | 'readReceipt'>;
  ready(runtime: 'codex' | 'openclaw'): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics };
export function registerNativeQueueHttp(app: Hono, path: string, deps: NativeQueueHttp) {
  registerOwnedQueueHttp<'codex' | 'openclaw'>(app, path, {
    ...deps, ready: runtime => deps.ready(runtime),
    runtime: key => { const runtime = sessionRuntimeId(key); return runtime === 'codex' || runtime === 'openclaw' ? runtime : undefined; },
    evidence: c => {
      const expectedNode = c.req.header(EXPECTED_NODE_HEADER), grantRef = c.req.header('x-agentopsdeck-execution-grant');
      return { ...(expectedNode !== undefined ? { expectedNode } : {}), ...(grantRef !== undefined ? { grantRef } : {}) };
    }, mutationMethod: true, operation: 'native-queue-http',
  });
}
