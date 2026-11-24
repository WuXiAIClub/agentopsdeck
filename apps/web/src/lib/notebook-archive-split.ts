export const DEFAULT_ARCHIVE_SHARE = 45;
export function archiveShare(value: number): number {
  return Number.isFinite(value) ? Math.min(85, Math.max(15, value)) : DEFAULT_ARCHIVE_SHARE;
}
/** Moving the horizontal boundary upward gives the archive more room. */
export function dragArchiveShare(start: number, deltaY: number, height: number): number {
  return Number.isFinite(height) && height > 0 && Number.isFinite(deltaY)
    ? archiveShare(start - deltaY / height * 100) : archiveShare(start);
}
