import { boundedToolInputPreview } from '../claude/tool-details.js';
import type { CopilotProjectedMessage } from './message-projection.js';

export const COPILOT_TOOL_DETAIL_CHARS = 64_000;
export type CopilotToolDetail = { text: string; truncated: boolean };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Separate bounded IPC payload, never part of eager message history. Read
 * only native text fields; binary results/attachments/metadata are omitted. */
export function projectCopilotToolDetail(event: unknown, row?: CopilotProjectedMessage): CopilotToolDetail | undefined {
  if (row?.role !== 'tool' || !record(event) || !record(event.data)) return;
  const data = event.data;
  if (row.toolPhase === 'call') return boundedToolInputPreview(data.arguments, COPILOT_TOOL_DETAIL_CHARS);
  const result = record(data.result) ? data.result : undefined;
  const error = record(data.error) ? data.error : undefined;
  const value = typeof result?.detailedContent === 'string' ? result.detailedContent
    : typeof result?.content === 'string' ? result.content : typeof error?.message === 'string' ? error.message : '';
  const binary = /^data:[^,]{0,200};base64,/i.test(value);
  return { text: binary ? '[binary omitted]' : value.slice(0, COPILOT_TOOL_DETAIL_CHARS),
    truncated: binary || value.length > COPILOT_TOOL_DETAIL_CHARS || !!result?.binaryResultsForLlm };
}

export function validateCopilotToolDetail(value: unknown, row: Pick<CopilotProjectedMessage, 'role'>): CopilotToolDetail | undefined {
  if (value === undefined) return;
  if (row.role !== 'tool' || !record(value) || typeof value.text !== 'string'
    || value.text.length > COPILOT_TOOL_DETAIL_CHARS || typeof value.truncated !== 'boolean') {
    throw new Error('Invalid Copilot tool detail');
  }
  return { text: value.text, truncated: value.truncated };
}
