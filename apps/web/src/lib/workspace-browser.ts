export type BrowserState = { id: string; url: string; seq: number; width: number; height: number };
export type BrowserFrame = BrowserState & { title: string; hash: string; image?: string };
export type BrowserInput = { kind: 'navigate'; url: string } | { kind: 'back' | 'forward' | 'reload' }
  | { kind: 'click'; x: number; y: number } | { kind: 'scroll'; dy: number }
  | { kind: 'text'; text: string } | { kind: 'key'; key: string };
/** Explicit URLs only. Never guess a search provider, persist queries or fix an
 * invalid scheme into an apparently harmless HTTPS address. */
export function browserAddress(input: string): string | undefined {
  const value = input.trim();
  if (!value || /[\x00-\x20\x7f\\]/.test(value) || value.length > 4096) return undefined;
  try {
    const url = new URL(value.includes('://') || /^[\w+.-]+:/.test(value) ? value : `https://${value}`);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname.includes('.') ? url.href : undefined;
  } catch { return undefined; }
}
export function browserPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }) {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return { x: Math.max(0, Math.min(1023, Math.floor((clientX - rect.left) / rect.width * 1024))),
    y: Math.max(0, Math.min(719, Math.floor((clientY - rect.top) / rect.height * 720))) };
}
