/** Fail-closed parser for the native apply_patch envelope. File contents are
 * never interpreted as paths. Unknown syntax is rejected, not partially scanned. */
export function copilotPatchPaths(value: unknown): { path: string; create: boolean; destructive: boolean }[] | undefined {
  if (typeof value !== 'string' || value.length > 1_048_576 || value.includes('\0')) return;
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return;
  const paths: { path: string; create: boolean; destructive: boolean }[] = [];
  let mode: string | undefined, content = false, movable = false;
  const add = (path: string, create: boolean, destructive: boolean) => {
    if (!path || path !== path.trim() || /[\x00-\x1f\x7f]/.test(path) || paths.length >= 128) return false;
    paths.push({ path, create, destructive }); return true;
  };
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (mode && mode !== 'Delete' && !content) return;
      mode = header[1]; content = false; movable = mode === 'Update';
      if (!add(header[2]!, mode === 'Add', mode === 'Delete')) return;
    } else if (line.startsWith('*** Move to: ') && movable && !content) {
      paths.at(-1)!.destructive = true;
      if (!add(line.slice('*** Move to: '.length), true, true)) return;
      movable = false;
    } else if (mode === 'Add' && line.startsWith('+')) content = true;
    else if (mode === 'Update' && (/^[ +\-]/.test(line) || line === '@@' || line.startsWith('@@ ') || line === '*** End of File')) {
      content = true; movable = false;
    } else return;
  }
  if (!paths.length || mode !== 'Delete' && !content) return;
  return paths;
}
