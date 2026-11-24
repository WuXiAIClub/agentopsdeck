import type { ChatMessageMedia } from '@agentopsdeck/shared';
import { isSourceMediaUrl } from './source-preview.js';

/** Only existing, server-authorized attachment routes; never arbitrary file/remote links. */
export function isVideoAttachment(item: ChatMessageMedia) {
  // Source references return JSON text excerpts, not media bytes.
  if (item.sourceReference) return false;
  if (!/^\/api\/artifacts\/[a-f0-9]+$/i.test(item.url) && !isSourceMediaUrl(item.url)) return false;
  return !!item.mimeType?.toLowerCase().startsWith('video/') || /\.(?:mp4|m4v|mov|webm|ogv)$/i.test(item.name);
}
