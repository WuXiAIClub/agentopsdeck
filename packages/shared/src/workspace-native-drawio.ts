/** Opaque native XML, NOT sanitized HTML. Never render or resolve it in the Hub. */
export const NATIVE_DRAWIO_MAX_XML_BYTES = 1024 * 1024;
export const NATIVE_DRAWIO_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const NATIVE_DRAWIO_MAX_DOCUMENTS = 32;
export type NativeDrawioContent = { format: 'drawio-xml'; version: 1; title: string; xml: string };
export type NativeDrawioDocument = NativeDrawioContent & { resourceId: string; revision: number; updatedAt: number | null };
export type NativeDrawioWrite = NativeDrawioContent & { revision: number; mutationId: string };
export type NativeDrawioSummary = Pick<NativeDrawioDocument, 'resourceId' | 'title' | 'revision' | 'updatedAt'>;
export const emptyNativeDrawio = (): NativeDrawioContent => ({ format: 'drawio-xml', version: 1, title: 'draw.io',
  xml: '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>' });
export const nativeDrawioContent = (v: NativeDrawioContent): NativeDrawioContent => ({ format: 'drawio-xml', version: 1, title: v.title, xml: v.xml });
/** Budget/envelope check only; editor/parser validates structure. No decompression or URL fetch. */
export function nativeDrawioEnvelope(xml: unknown): xml is string {
  return typeof xml === 'string' && xml.length <= NATIVE_DRAWIO_MAX_XML_BYTES
    && new TextEncoder().encode(xml).byteLength <= NATIVE_DRAWIO_MAX_XML_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)
    && !/<!|<\?(?!xml\s)/i.test(xml)
    && /^(?:\s*<\?xml\s[^?]*\?>)?\s*<mxfile(?:\s|>)/.test(xml)
    && /<\/mxfile>\s*$/.test(xml);
}
export function validNativeDrawioWrite(value: unknown, allowEmptyTitle = false): value is NativeDrawioWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ['format', 'version', 'title', 'xml', 'revision', 'mutationId'].includes(key))
    && v.format === 'drawio-xml' && v.version === 1 && typeof v.title === 'string' && v.title.length <= 160
    && (allowEmptyTitle || !!v.title.trim()) && nativeDrawioEnvelope(v.xml)
    && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0 && (v.revision as number) < Number.MAX_SAFE_INTEGER
    && typeof v.mutationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.mutationId);
}
/** No query, hash, embedded credentials, or implicit public editor default. */
export function nativeDrawioEditorUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}
