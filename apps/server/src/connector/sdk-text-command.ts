/** Compact is native control, not chat. Until its durable control lifecycle is
 * supported, reject it before admission or queue edits (including arguments).
 * Ordinary prose and similarly named commands must remain ordinary text. */
export function isSdkCompactCommand(text: string): boolean {
  return /^\/compact(?:\s|$)/.test(text.trim());
}

export class SdkUnsupportedTextCommand extends Error {
  constructor() { super('SDK manual compaction is unavailable; command was not admitted'); }
}
