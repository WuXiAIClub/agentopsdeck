import type { ChatMessage } from '@agentopsdeck/shared';

export const INVALID_ASSISTANT_OUTPUT_LABEL = 'Run finished · model output unavailable';
export const INVALID_ASSISTANT_OUTPUT_TEXT = 'The model returned only image boundary markers, not a usable answer. Original history is preserved. No automatic retry was sent.';

export function hasInvalidAssistantOutput(message: ChatMessage) {
  return message.role === 'assistant' && !message.parentToolUseId && !message.toolName
    && !message.toolCallId && !message.toolPhase && !message.media?.length
    && typeof message.text === 'string' && /^\s*(?:<end_of_image>\s*)+$/.test(message.text);
}

export function assistantDisplayText(message: ChatMessage) {
  return hasInvalidAssistantOutput(message) ? INVALID_ASSISTANT_OUTPUT_TEXT : message.text;
}
