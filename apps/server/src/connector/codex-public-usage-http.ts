import type { Hono } from 'hono';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { registerOwnedUsageHttp, type OwnedUsageHttp } from './sdk-usage-http.js';

export type CodexPublicUsageHttp = Pick<OwnedUsageHttp<'codex'>, 'usage' | 'timeoutMs' | 'authorization' | 'around' | 'requestUsage'>;
export function registerCodexPublicUsageHttp(app: Hono, base: string, deps: CodexPublicUsageHttp) {
  return registerOwnedUsageHttp(app, base, { ...deps, select: key => sessionRuntimeId(key) === 'codex' ? 'codex' : undefined });
}
