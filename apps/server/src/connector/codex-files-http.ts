import type { Hono } from 'hono';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { registerOwnedFilesHttp, type OwnedFilesHttp } from './sdk-files-http.js';

export type CodexFilesHttp = Pick<OwnedFilesHttp<'codex'>, 'files' | 'timeoutMs' | 'authorization' | 'around' | 'requestFiles'>;
export function registerCodexFilesHttp(app: Hono, base: string, deps: CodexFilesHttp) {
  return registerOwnedFilesHttp(app, base, { ...deps, select: key => sessionRuntimeId(key) === 'codex' ? 'codex' : undefined });
}
