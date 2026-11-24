import { NATIVE_DRAWIO_MAX_BODY_BYTES, nativeDrawioContent, nativeDrawioEditorUrl, nativeDrawioEnvelope, validNativeDrawioWrite,
  type NativeDrawioContent, type NativeDrawioDocument, type NativeDrawioWrite } from '@agentopsdeck/shared';
export const nativeDrawioDraftKey = (scope: string, id: string) => `agentopsdeck.native-drawio-draft.v1:${JSON.stringify([scope, id])}`;
export const nativeDrawioEqual = (a: NativeDrawioContent, b: NativeDrawioContent) => a.title === b.title && a.xml === b.xml;
export function parseNativeDrawioDraft(raw: string | null): NativeDrawioWrite | undefined {
  if (!raw || raw.length > NATIVE_DRAWIO_MAX_BODY_BYTES) return undefined;
  try { const v: unknown = JSON.parse(raw); return validNativeDrawioWrite(v, true) ? v : undefined; } catch { return undefined; }
}
export function reconcileNativeDrawio(remote: NativeDrawioDocument, local: NativeDrawioWrite | undefined, mutationId: string) {
  const dirty = !!local && !nativeDrawioEqual(remote, local);
  return { draft: dirty ? local : { ...nativeDrawioContent(remote), revision: remote.revision, mutationId }, conflict: dirty && local.revision !== remote.revision };
}
export function isolatedDrawioUrl(raw: string | null | undefined, hubOrigin: string) {
  const configured = nativeDrawioEditorUrl(raw ?? undefined);
  if (!configured || new URL(configured).origin === hubOrigin) return undefined;
  const url = new URL(configured);
  for (const [key, value] of Object.entries({ embed: '1', proto: 'json', spin: '1', offline: '1', noExitBtn: '1', libraries: '0' })) url.searchParams.set(key, value);
  return url;
}
export type NativeDrawioEvent = { event: 'init' } | { event: 'load' } | { event: 'save' | 'autosave'; xml: string };
export function readNativeDrawioEvent(data: unknown): NativeDrawioEvent | undefined {
  // draw.io JSON protocol uses strings. Check the budget BEFORE parsing attacker-controlled data.
  if (typeof data !== 'string' || data.length > NATIVE_DRAWIO_MAX_BODY_BYTES) return undefined;
  try {
    const v: unknown = JSON.parse(data);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const e = v as Record<string, unknown>;
    if (e.event === 'init' || e.event === 'load') return { event: e.event };
    if ((e.event === 'save' || e.event === 'autosave') && nativeDrawioEnvelope(e.xml)) return { event: e.event, xml: e.xml };
  } catch { /* Ignore malformed/spoofed events without surfacing their contents. */ }
  return undefined;
}
/** Browser-only structural validation; never mount returned XML into the Hub DOM. */
export function validateNativeDrawioXml(xml: string) {
  if (!nativeDrawioEnvelope(xml)) return false;
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (document.querySelector('parsererror') || root.tagName !== 'mxfile' || root.namespaceURI) return false;
  const pages = [...root.children];
  if (!pages.length || pages.length > 32 || pages.some(page => page.tagName !== 'diagram' || page.children.length !== 1
    || page.firstElementChild?.tagName !== 'mxGraphModel' || [...page.childNodes].some(node => node.nodeType === 3 && !!node.textContent?.trim()))) return false;
  // No compressed-page expansion. Bound graph complexity before loading the trusted editor.
  let count = 0;
  const stack: { node: Element; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 50_000 || depth > 64) return false;
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return true;
}
