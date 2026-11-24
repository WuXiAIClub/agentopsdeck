import { createHash } from 'node:crypto';
import type { ChatMessage } from '@agentopsdeck/shared';
import { BOARD_CONTEXT_MAX_CHARS } from '../connector/workspace-board-file-format.js';

// A small durable receipt, not another copy of the prompt or transcript.
export type TurnContextProof = { hash: string; originalLength: number };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function appendTurnContext(input: any[], context: string): { input: any[]; proof?: TurnContextProof } {
  if (!context) return { input };
  if (context.length > BOARD_CONTEXT_MAX_CHARS) throw new Error('Task context limit exceeded');
  const texts = input.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text);
  // Our dispatch envelope has one user text plus images. Native thread/read
  // concatenates adjacent text inputs without the separator used by its live
  // events. Send ONE text item so both histories have the same exact proof.
  // Never reorder an unexpected multi-text/media envelope to make it match.
  if (texts.length > 1) throw new Error('Unsupported task context text envelope');
  const original = texts[0] ?? '';
  const text = original ? original + '\n\n' + context : context;
  return { input: texts.length ? input.map(item => item?.type === 'text' && typeof item.text === 'string'
    ? { ...item, text } : item) : [...input, { type: 'text', text }],
    proof: { hash: digest(text), originalLength: original.length } };
}

export function validTurnContextProof(value: TurnContextProof): boolean {
  return /^[a-f0-9]{64}$/.test(value.hash) && Number.isSafeInteger(value.originalLength)
    && value.originalLength >= 0 && value.originalLength <= 2_000_000;
}

// Identity is checked by the caller against dispatch/ACK evidence. Never trim,
// regex-strip, or hide arbitrary user text which resembles the instructions.
export function normalizeTurnContext(message: ChatMessage, proof?: TurnContextProof): ChatMessage {
  return proof && message.role === 'user' && proof.originalLength <= message.text.length
    && digest(message.text) === proof.hash ? { ...message, text: message.text.slice(0, proof.originalLength) } : message;
}
