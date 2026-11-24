import { createHash } from 'node:crypto';

export type NotebookMove = { requestId: string; hotRevision: number; coldRevision: number; direction: 'archive' | 'restore'; ranges: { start: number; end: number; sha256: string }[] };
export const notebookHash = (text: string) => createHash('sha256').update(text).digest('hex');
export class NotebookMoveConflict extends Error {}
export function validNotebookMove(value: unknown): value is NotebookMove {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as NotebookMove;
  return Object.keys(v).sort().join() === 'coldRevision,direction,hotRevision,ranges,requestId'
    && typeof v.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.requestId)
    && [v.hotRevision, v.coldRevision].every(n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER)
    && ['archive', 'restore'].includes(v.direction) && Array.isArray(v.ranges) && v.ranges.length > 0 && v.ranges.length <= 32
    && v.ranges.every(r => r && Object.keys(r).sort().join() === 'end,sha256,start' && Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end)
      && r.start >= 0 && r.end > r.start && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256));
}
export function moveNotebookText(source: string, destination: string, ranges: NotebookMove['ranges'], limit: number) {
  let end = 0, size = 0;
  const splitSurrogate = (offset: number) => offset > 0 && offset < source.length && /[\uD800-\uDBFF]/.test(source[offset - 1]!) && /[\uDC00-\uDFFF]/.test(source[offset]!);
  for (const r of ranges) {
    if (r.start < end || r.end > source.length || splitSurrogate(r.start) || splitSurrogate(r.end)) throw new NotebookMoveConflict('Invalid ranges');
    if (notebookHash(source.slice(r.start, r.end)) !== r.sha256) throw new NotebookMoveConflict('Selection changed');
    size += r.end - r.start; end = r.end;
  }
  if (size > 16_000) throw new NotebookMoveConflict('Move limit exceeded');
  const text = ranges.map(r => source.slice(r.start, r.end)).join('\n\n');
  const nextDestination = destination ? `${destination}\n\n${text}` : text;
  if (nextDestination.length > limit) throw new NotebookMoveConflict('Destination full');
  let nextSource = source;
  for (const r of [...ranges].reverse()) nextSource = nextSource.slice(0, r.start) + nextSource.slice(r.end);
  return { source: nextSource, destination: nextDestination, moved: size };
}
