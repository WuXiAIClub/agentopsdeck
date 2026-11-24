import { parseSourceReference, type SourcePreview } from '@agentopsdeck/shared';

export class SourcePreviewError extends Error {
  constructor(message: string, readonly canApprove = false) { super(message); }
}
export function sourceFailure(reason: string | null, approval: string | null) {
  const messages: Record<string, string> = {
    'outside-roots': approval === 'available' ? 'This file needs Connector preview permission.' : 'The Connector does not offer one-click approval for this file.',
    missing: 'This file no longer exists on the Connector.',
    'unsafe-file': 'This file is not eligible for source preview.',
    'too-large': 'This file or excerpt exceeds the preview size limit.',
    changed: 'This file changed while being read. Retry to read its current content.',
    'unsupported-text': 'This file is not supported UTF-8 text.',
    'line-missing': 'The referenced line no longer exists. Ask for an updated reference.',
  };
  return new SourcePreviewError(messages[reason ?? ''] ?? 'This local file is outside the Connector’s preview folders, no longer exists, or the referenced line is unavailable.', reason === 'outside-roots' && approval === 'available');
}

export function sourceLink(href: string, origin: string) {
  if (/^https?:\/\//i.test(href)) {
    try { const url = new URL(href); if (url.origin !== origin || url.search) return undefined; return parseSourceReference(url.pathname + url.hash); }
    catch { return undefined; }
  }
  return parseSourceReference(href);
}

export function isSourcePreview(value: unknown): value is SourcePreview {
  if (!value || typeof value !== 'object') return false;
  const p = value as SourcePreview;
  if (typeof p.path !== 'string' || typeof p.text !== 'string') return false;
  const lines = p.text.split('\n').length;
  const fullMarkdown = /\.(md|markdown)$/i.test(p.path) && p.startLine === 1 && lines === p.totalLines;
  return typeof p.path === 'string' && typeof p.text === 'string' && p.text.length <= 96 * 1024
    && (p.temporaryApproval === undefined || typeof p.temporaryApproval === 'boolean')
    && new TextEncoder().encode(p.text).byteLength <= 96 * 1024
    && Number.isSafeInteger(p.startLine) && p.startLine >= 1 && Number.isSafeInteger(p.line) && p.line >= p.startLine
    && Number.isSafeInteger(p.totalLines) && p.totalLines >= p.line && Number.isFinite(p.modifiedAt)
    && (lines <= 45 || fullMarkdown) && p.startLine + lines - 1 <= p.totalLines && p.line < p.startLine + lines;
}

export function isSourceMediaUrl(url: string) {
  // Do not let metadata turn a credential-bearing request into an arbitrary fetch.
  if (!/^\/api\/hub\/v1\/(?:sessions\/[^/?#]+|shared\/[^/?#]+\/sessions\/[^/?#]+)\/messages\/[^/?#]+\/media\/[a-f0-9]{64}$/.test(url)) return false;
  try { return !url.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part))); } catch { return false; }
}
