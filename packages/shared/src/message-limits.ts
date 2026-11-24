/** UTF-16 code units, matching browser inputs and JS string.length. */
export const MAX_MESSAGE_CHARS = 100_000;
/** Until the target advertises its limit, keep compatibility with v1 protocol peers. */
export const LEGACY_MAX_MESSAGE_CHARS = 20_000;
export type MessageLimits = { maxMessageChars: number };
/** Treat wire metadata as untrusted, never increase the local safety ceiling. */
export function resolveMessageLimits(value: unknown): MessageLimits {
  const limit = value && typeof value === 'object' ? (value as Record<string, unknown>).maxMessageChars : undefined;
  return { maxMessageChars: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, MAX_MESSAGE_CHARS) : LEGACY_MAX_MESSAGE_CHARS };
}
/** JSON escaping can take six bytes per code unit, plus envelope metadata. */
export const MAX_TEXT_MESSAGE_BODY_BYTES = MAX_MESSAGE_CHARS * 6 + 64 * 1024;
/** Presentation only: the exact original text is still sent and persisted. */
export const LONG_MESSAGE_PREVIEW_CHARS = 4_000;
