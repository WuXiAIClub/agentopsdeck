import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorClientError } from './connector-client.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { sourceReferenceMedia } from '../messages/source-preview.js';

/** An upstream URL is only an address; the download endpoint proves membership. */
export function projectMessageMedia(message: ChatMessage, remoteSessionKey: string, sessionPath: string) {
  if (!message || message.sessionKey !== remoteSessionKey || typeof message.id !== 'string' || !message.id.length
    || message.id.length > 4096 || ['.', '..'].includes(message.id)) throw new ConnectorClientError(502, 'Invalid message identity');
  const base = `${sessionPath}/messages/${encodeURIComponent(message.id)}/media`;
  const media = [...(message.media ?? []), ...sourceReferenceMedia(message)];
  return media.length ? media.map(item => ({ ...item,
    // Preserve external links, without fetching them or forwarding credentials.
    url: /^https?:\/\//i.test(item.url) ? item.url : `${base}/${mediaResourceId(item.url)}`,
  })) : undefined;
}
