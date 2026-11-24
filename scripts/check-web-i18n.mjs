import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// A deliberately bounded guard: static JSX text, conditional/fallback JSX expressions, and accessible attributes.
// Dynamic server diagnostics, user content and generated text still need review.
const exceptions = [
  ...['components/UsageAggregationPanel.tsx', 'components/WorkspaceTaskSession.tsx'].flatMap(file =>
    ['Codex', 'Claude Code', 'GitHub Copilot'].map(name => [file, 'text', name, 'Product name'])),
  ['components/WorkspaceSubagentCompanion.tsx', 'text', 'Codex', 'Product name'],
  ['components/WorkspaceSubagentCompanion.tsx', 'text', 'GHCP', 'Product abbreviation'],
  ['components/SystemMetricsPanel.tsx', 'text', 'CPU', 'Standard processor abbreviation'],
  ['components/WorkspaceGitTree.tsx', 'text', 'B', 'SI byte unit'],
  ['components/WorkspaceBoardAccess.tsx', 'text', 'GET / POST /api/workspace-agent/v1/board', 'Literal machine API methods and path'],
  ['components/WorkspaceBoardAccess.tsx', 'text', 'Authorization: Bearer &lt;token&gt;', 'Literal HTTP authorization header example, no credential'],
  ['components/AccessRoleMatrix.tsx', 'text', 'Codex', 'Product name'],
  ['components/AccessRoleMatrix.tsx', 'text', 'OpenClaw', 'Product name'],
  ['components/BrowserSettings.tsx', 'text', 'English', 'Native language name'],
  ['components/BrowserSettings.tsx', 'text', '简体中文', 'Native language name'],
  ['components/auth.tsx', 'text', 'English', 'Native language name'],
  ['components/auth.tsx', 'text', '简体中文', 'Native language name'],
  ['components/GatewayStatus.tsx', 'text', 'OpenClaw Gateway', 'Product name'],
  ['components/MediaLibrary.tsx', 'text', 'Windows', 'Operating system name'],
  ['components/MediaLibrary.tsx', 'text', 'AOD_MEDIA_LIBRARY_DIRS=/srv/agentopsdeck/videos', 'Literal Linux configuration example'],
  ['components/MediaLibrary.tsx', 'text', 'AOD_MEDIA_LIBRARY_DIRS=D:\\AgentOpsDeck\\Videos', 'Literal Windows configuration example'],
  ['components/SourceReferencePreviewContent.tsx', 'text', '&lt;/&gt;', 'Source icon'],
  ['components/WorkspaceBoardSyncDialog.tsx', 'text', 'card.json', 'Literal sync filename'],
  ['components/WorkspaceBoardSyncDialog.tsx', 'text', 'tasks.json', 'Literal sync filename'],
  ['components/WorkspaceFileBoardBinding.tsx', 'text', 'card.json', 'Literal sync filename'],
  ['components/WorkspaceFileBoardBinding.tsx', 'text', 'tasks.json', 'Literal sync filename'],
  ['components/WorkspaceOsDesktop.tsx', 'text', 'docker run', 'Literal CLI command'],
  ['components/WorkspaceOsDesktop.tsx', 'text', 'docker-compose.yml', 'Literal filename'],
  ['components/WorkspaceOsDesktop.tsx', 'text', 'Dockerfile', 'Literal filename'],
  ['components/WorkspaceTerminal.tsx', 'text', 'SSH', 'Standard protocol abbreviation'],
  ['components/hub-connections.tsx', 'text', 'Connector', 'Architecture term'],
  ['components/hub-connections.tsx', 'text', 'Hub', 'Architecture term'],
  ['components/hub-connections.tsx', 'placeholder', 'https://my-connector.example.com', 'Example URL'],
  ['components/hub-connections.tsx', 'placeholder', 'prod', 'Example environment ID'],
  ['components/hub-connections.tsx', 'text', 'default', 'Literal protocol profile ID'],
  ['components/hub-connections.tsx', 'text', 'ID:', 'Identifier label'],
  ['components/hub-connections.tsx', 'text', 'U', 'Single-letter avatar fallback'],
  ['components/hub-connections.tsx', 'text', 'C', 'Single-letter avatar fallback'],
  ['main.tsx', 'text', 'C', 'Brand mark'],
  ['main.tsx', 'text', 'OpenClaw Gateway:', 'Product name'],
];

function collectExpressionLiterals(expr, out = []) {
  if (!expr) return out;
  if (ts.isParenthesizedExpression(expr)) return collectExpressionLiterals(expr.expression, out);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    out.push({ text: expr.text, node: expr });
  } else if (ts.isConditionalExpression(expr)) {
    collectExpressionLiterals(expr.whenTrue, out);
    collectExpressionLiterals(expr.whenFalse, out);
  } else if (ts.isBinaryExpression(expr) && [
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
  ].includes(expr.operatorToken.kind)) {
    collectExpressionLiterals(expr.right, out);
  }
  return out;
}

export function staticCopy(source, filename = 'fixture.tsx') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const pushText = (kind, text, node) => {
    if (text && /\p{L}/u.test(text)) {
      found.push({ kind, text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    }
  };
  const visit = node => {
    if (ts.isJsxText(node)) {
      pushText('text', node.text.replace(/\s+/g, ' ').trim(), node);
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
      for (const item of collectExpressionLiterals(node.expression)) {
        pushText('text', item.text, item.node);
      }
    }
    if (ts.isJsxAttribute(node) && ['title', 'placeholder', 'aria-label', 'alt'].includes(node.name.getText(file))) {
      const kind = node.name.getText(file);
      const value = node.initializer;
      if (value && ts.isStringLiteral(value)) {
        pushText(kind, value.text, value);
      } else if (value && ts.isJsxExpression(value) && value.expression) {
        for (const item of collectExpressionLiterals(value.expression)) {
          pushText(kind, item.text, item.node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export async function checkWebI18n(root) {
  const used = new Set(), failures = [];
  let files = 0;
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('i18n discovery refuses symbolic links');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        files++;
        const name = relative(root, path).split('\\').join('/');
        for (const copy of staticCopy(await readFile(path, 'utf8'), name)) {
          const index = exceptions.findIndex(([file, kind, text]) => file === name && kind === copy.kind && text === copy.text);
          if (index < 0) failures.push(`${name}:${copy.line} untranslated ${copy.kind}: ${JSON.stringify(copy.text)}`);
          else used.add(index);
        }
      }
    }
  };
  await walk(root);
  exceptions.forEach(([file, , text], index) => {
    if (!used.has(index)) failures.push(`Remove stale i18n exception: ${file} ${JSON.stringify(text)}`);
  });
  return { files, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkWebI18n(resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/src'));
  if (result.failures.length) { console.error(result.failures.join('\n')); process.exitCode = 1; }
  else console.log(`i18n static JSX guard passed (${result.files} files; dynamic copy requires separate review)`);
}
