import type { ChatMessage } from '@agentopsdeck/shared';

export const TOOL_HISTORY_PREVIEW_CHARS = 1_000;

/** List/event payloads carry metadata, never the tool's full output. Details
 * remain in the Connector or its verified record index and require the same
 * session authority. */
export function summarizeToolMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool') return message;
  const preview = (message.toolPreview ?? message.text).slice(0, TOOL_HISTORY_PREVIEW_CHARS);
  return { ...message, text: preview, toolPreview: preview,
    toolDetailAvailable: message.toolDetailAvailable === true || message.text !== preview,
    toolLineCount: message.toolLineCount ?? countLines(message.text) };
}

function countLines(text: string): number {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}
