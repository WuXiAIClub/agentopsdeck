import type { Context, Hono } from 'hono';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import type { AsyncSdkMetadata } from './async-sdk-metadata.js';

export type SdkMetadataHttp = {
  metadata: Pick<AsyncSdkMetadata, 'state' | 'models'>;
  ready: (runtime: SdkAgentId) => boolean;
  configured: (runtime: SdkAgentId) => boolean;
  authorization?(context: Context): string;
  around?(context: Context, work: () => Promise<Response>): Promise<Response>;
};
/** Original protocol/node guards precede this port; legacy SQL must not. */
export function registerSdkMetadataHttp(app: Hono, base: string, deps: SdkMetadataHttp) {
  for (const state of [true, false]) app.get(`${base}/${state ? 'sessions/:sessionKey/state' : 'models/:runtime'}`, async (c, next) => {
    const key = c.req.param('sessionKey'), runtime = state ? sessionRuntimeId(key!) : c.req.param('runtime');
    if (runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity') return next();
    const work = async () => {
      c.header('Cache-Control', 'no-store');
      if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'SDK metadata requires owner authority' }, 403);
      try {
        const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
        if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
        const result = state ? await deps.metadata.state({ runtime, key: key!, authorization, connected: deps.ready(runtime) === true }, c.req.raw)
          : await deps.metadata.models({ runtime, authorization }, c.req.raw);
        if ('error' in result) return c.json({ error: result.error === 404 ? 'session or runtime not found' : 'SDK metadata authority unavailable' }, result.error);
        // Keep the original configured-runtime boundary, not readiness: offline
        // SDKs may expose their catalog, disabled SDKs may not. Reauthorize first.
        if (!state && deps.configured(runtime) !== true) return c.json({ error: 'Model catalog unavailable for this runtime' }, 404);
        return c.json(result.body);
      } catch (error) { return c.json({ error: 'SDK metadata unavailable' }, error instanceof ReadRequestError ? error.status : 503); }
    };
    return deps.around ? deps.around(c, work) : work();
  });
}
