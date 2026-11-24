import type { Hono } from 'hono';
import { registerSessionCreationHttp, type SessionCreationHttp } from './hermes-creation-http.js';

export type CodexCreationHttp = SessionCreationHttp;
export function registerCodexCreationHttp(app: Hono, base: string, deps: CodexCreationHttp) {
  registerSessionCreationHttp(app, base, deps, 'codex');
}
