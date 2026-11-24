import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export function staticClosure(manifest, entry) {
  const visited = new Set();
  const visit = key => {
    if (visited.has(key)) return;
    if (!manifest[key]) throw Error(`Missing manifest import: ${key}`);
    visited.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  };
  visit(entry); return visited;
}

export function bundleBudget(manifest, readAsset) {
  const initial = staticClosure(manifest, 'index.html');
  const optional = ['hub-connections', 'NotebookEditor', 'NotebookArchive', 'MediaLibrary', 'WorkspaceDrawing', 'WorkspaceTerminal', 'WorkspaceBrowser', 'SessionGoalPanel', 'WorkspaceTaskboard', 'QuickChatPanel', 'NotebookAgentAccess', 'SourceReferencePreviewContent', 'SessionFilePanel', 'GatewayStatus', 'SharedSessionView', 'SessionSharing', 'SessionPeek', 'QuickSessionMessage', 'MessageVideoPreview', 'VideoPlayer', 'ResendMessage', 'CommandRecoveryNotice', 'SessionGoal', 'SessionSubagents', 'CardVersionHistoryModal', 'MultiScreenToolbar', 'WorkspaceOsDesktop'];
  const metrics = keys => {
    let bytes = 0, gzip = 0;
    const files = [...new Set([...keys].map(key => manifest[key].file))];
    for (const file of files) {
      const content = readAsset(file);
      bytes += content.length; gzip += gzipSync(content).length;
    }
    return { files, bytes, gzip };
  };
  const first = metrics(initial), entry = metrics(['index.html']);
  const features = {};
  for (const name of optional) {
    const key = Object.keys(manifest).find(key => key.endsWith(`/${name}.tsx`));
    if (!key) throw Error(`Missing optional feature: ${name}`);
    if (initial.has(key)) throw Error(`Optional feature eagerly loaded: ${name}`);
    features[name] = metrics([...staticClosure(manifest, key)].filter(key => !initial.has(key)));
  }
  // Raw parse budget AND gzip transfer budget. Do not hide regressions by
  // renaming the entry or raising Vite's per-chunk warning threshold.
  if (entry.bytes > 450_000 || first.bytes > 1_375_000 || first.gzip > 300_000) throw Error(`Initial JavaScript budget exceeded: ${JSON.stringify({ entry, initial: first })}`);
  return { entry, initial: first, features };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/dist'));
  const manifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8'));
  const result = bundleBudget(manifest, file => {
    const path = resolve(dist, file), local = relative(dist, path);
    if (local.startsWith('..') || isAbsolute(local) || !file.endsWith('.js')) throw Error('Invalid JavaScript asset path');
    return readFileSync(path);
  });
  console.log(JSON.stringify(result, null, 2));
}
