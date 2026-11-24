import type { Hono } from 'hono';
import { registerRuntimeReadsHttp, type RuntimeReadsHttp } from './runtime-reads-http.js';

export type OpenClawReadsHttp = RuntimeReadsHttp;
export function registerOpenClawReadsHttp(app: Hono, path: string, deps: OpenClawReadsHttp) {
  registerRuntimeReadsHttp(app, path, deps, 'openclaw');
}
