import { WEBSITE_MAX_BYTES, type WebsiteSnapshot } from '@agentopsdeck/shared';
import { websitePaneTarget, websiteSnapshotTree } from './workspace-website.js';

export const READER_PAGE_LINES = 40;
export const READER_LINE_LENGTH = 1000;
export const READER_QUERY_LENGTH = 160;
export const READER_QUOTE_LENGTH = 8000;
const blocks = new Set(['P', 'DIV', 'MAIN', 'ARTICLE', 'SECTION', 'HEADER', 'FOOTER', 'NAV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'BR', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'DL', 'DT', 'DD']);

/** Project only the same inert, bounded semantic tree used by the snapshot.
 * The resulting line numbers are NOT source HTML line numbers. */
export function websiteReadingText(snapshot: WebsiteSnapshot, doc: Document): string {
  const tree = websiteSnapshotTree(snapshot.content, snapshot.format, doc);
  if (snapshot.format === 'text') return snapshot.content;
  const parts: string[] = [];
  const pending: { node: Node; end?: boolean; pre?: boolean }[] = [{ node: tree.content }];
  while (pending.length) {
    const { node, end, pre } = pending.pop()!;
    if (node.nodeType === 3) { parts.push(pre ? node.textContent ?? '' : (node.textContent ?? '').replace(/\s+/g, ' ')); continue; }
    const tag = node.nodeType === 1 ? (node as Element).tagName : '';
    if (blocks.has(tag)) parts.push('\n');
    if (end) { if (tag === 'TD' || tag === 'TH') parts.push('\t'); continue; }
    pending.push({ node, end: true });
    for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push({ node: node.childNodes[i]!, pre: pre || tag === 'PRE' });
  }
  return parts.join('').replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function websiteReadingLines(text: string): string[] {
  // Semantic boundaries can add characters to the already bounded input.
  if (text.length > WEBSITE_MAX_BYTES + 24_000) throw Error('Reading projection too large');
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.length) { lines.push(''); continue; }
    for (let offset = 0; offset < line.length;) {
      let end = Math.min(offset + READER_LINE_LENGTH, line.length);
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
      lines.push(line.slice(offset, end)); offset = end;
    }
  }
  return lines;
}

export function websiteReadingMatches(lines: readonly string[], query: string): number[] {
  const needle = query.slice(0, READER_QUERY_LENGTH).trim().toLowerCase();
  return needle ? lines.flatMap((line, index) => line.toLowerCase().includes(needle) ? [index] : []) : [];
}

export async function websiteSnapshotDigest(snapshot: WebsiteSnapshot): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([snapshot.format, snapshot.content]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return undefined; }
}

export type WebsiteCitation = {
  kind: 'agentopsdeck-website-excerpt'; version: 1;
  source: { connectionId: string; serviceId: string; label: string; fetchedAt: string; sha256: string | null };
  projection: 'semantic-lines-v1'; firstLine: number; lastLine: number; excerpt: string;
};

export function websiteCitation(snapshot: WebsiteSnapshot, connectionId: string, lines: readonly string[], first: number, last: number, digest?: string): WebsiteCitation {
  if (!websitePaneTarget(JSON.stringify([connectionId, snapshot.serviceId])) || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)
    || first < 0 || last < first || last >= lines.length || (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))) throw Error('Invalid excerpt');
  const excerpt = lines.slice(first, last + 1).join('\n');
  if (excerpt.length > READER_QUOTE_LENGTH) throw Error('Select a shorter excerpt');
  return { kind: 'agentopsdeck-website-excerpt', version: 1,
    source: { connectionId, serviceId: snapshot.serviceId, label: snapshot.label, fetchedAt: new Date(snapshot.fetchedAt).toISOString(), sha256: digest ?? null },
    projection: 'semantic-lines-v1', firstLine: first + 1, lastLine: last + 1, excerpt };
}
