import { validBoardUuid } from '@agentopsdeck/shared';
/** Public metadata only; no Connector paths, credentials or caller authority. */
export type FileBoardBinding = {
  bindingId: string; resourceId: string; sessionId: string;
  state: 'prepared' | 'active' | 'revoked'; problem: string | null;
};
export type FileBoardIntent = { requestId: string; sessionId: string; revision: number };
export function parseFileBoardIntent(text: string | null): FileBoardIntent | undefined {
  try {
    const value = JSON.parse(text ?? 'null');
    if (value && Object.keys(value).sort().join(',') === 'requestId,revision,sessionId'
      && validBoardUuid(value.requestId)
      && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 1024
      && Number.isSafeInteger(value.revision) && value.revision >= 0) return value;
  } catch { /* A corrupt local record never becomes a new mutation. */ }
}
