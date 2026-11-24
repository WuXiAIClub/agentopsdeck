import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { AsyncCodexCatalog } from './async-codex-catalog.js';
import { runNativeOperation } from './native-operation.js';

export type CodexCatalogHttp = {
  catalog: Pick<AsyncCodexCatalog, 'models' | 'skills'>; timeoutMs?: number;
  authorization?(context: Context): string;
  around?(context: Context, work: () => Promise<Response>): Promise<Response>;
};
/** Same URLs and response schema; selected Codex requests never enter legacy
 * authority, even on timeout or rejection. Other runtimes retain their routes. */
export function registerCodexCatalogHttp(app: Hono, base: string, deps: CodexCatalogHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite catalog deadline required');
  for (const kind of ['models', 'skills'] as const) {
    app.get(kind === 'models' ? `${base}/models/:runtime` : `${base}/sessions/:sessionKey/skills`, async (c, next) => {
      const key = c.req.param('sessionKey') ?? '';
      if (kind === 'models' ? c.req.param('runtime') !== 'codex' : sessionRuntimeId(key) !== 'codex') return next();
      const work = async () => {
        c.header('Cache-Control', 'no-store');
        if (kind === 'skills' && c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Skill discovery requires owner authority' }, 403);
        try {
          const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
          // Preserve the legacy catalog endpoint's 403 for missing credentials.
          if (!authorization.trim()) return c.json({ error: `missing ${kind === 'models' ? 'models:read' : 'messages:read'} scope` }, 403);
          const result = await runNativeOperation(async () => kind === 'models' ? await deps.catalog.models({ authorization })
            : await deps.catalog.skills({ authorization, key }), { timeoutMs, signal: c.req.raw.signal });
          if ('error' in result) return c.json({ error: 'Catalog authority or session unavailable' }, result.error);
          return c.json(kind === 'models' ? { models: result.value } : result.value);
        } catch (error) {
          if (error instanceof HTTPException) return error.getResponse();
          return c.json({ error: kind === 'models' ? 'Model catalog unavailable; retry when the runtime is ready'
            : 'Skill discovery unavailable; this Codex may not support skills/list' }, 503);
        }
      };
      return deps.around ? deps.around(c, work) : work();
    });
  }
}
