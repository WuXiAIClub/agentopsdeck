import { validLayoutWrite, type LayoutDocument, type LayoutKind } from './workspace-layouts.js';

// Keep content opaque: the original JSON inside the string permits depth 72
// and 100000 nodes. Decoding it into the RPC tree would shrink that schema.
// JSON escaping can double the full 1MiB saved record; never truncate it.
export const HUB_LAYOUT_RPC_BYTES = 2 * 1024 * 1024 + 16_384;
export type HubLayoutResult = { document: LayoutDocument } | { conflict: true } | null;
export const validHubLayoutKind = (v: unknown): v is LayoutKind => v === 'current' || v === 'saved';
export const validHubLayoutDocument = (v: unknown, kind: LayoutKind): v is LayoutDocument => validLayoutWrite(v, kind);
export function validHubLayoutResult(v: unknown, save: boolean): v is HubLayoutResult {
  if (v === null) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1) return false;
  if (save && (v as { conflict?: unknown }).conflict === true) return true;
  const d = (v as { document?: Record<string, unknown> }).document;
  // Old saved content is presentation data, not authority. Validate its wire
  // envelope without reinterpreting/migrating it or resetting a final revision.
  return !!d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 2
    && Object.keys(d).every(k => k === 'revision' || k === 'content')
    && Number.isSafeInteger(d.revision) && Number(d.revision) >= 0
    && (d.content === null ? d.revision === 0 : typeof d.content === 'string' && Buffer.byteLength(d.content) <= 1_048_576);
}
