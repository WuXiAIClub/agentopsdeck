import type { Hono } from 'hono';
import { registerRuntimeReadsHttp, type RuntimeReadsHttp } from './runtime-reads-http.js';

export type CodexReadsHttp = RuntimeReadsHttp;
export function registerCodexReadsHttp(app: Hono, path: string, deps: CodexReadsHttp) {
  registerRuntimeReadsHttp(app, path, deps, 'codex');
}
