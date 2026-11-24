import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export function discoverApiRoutes(root = repository) {
  const routes = [], unresolved = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((first, second) => first.name.localeCompare(second.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.ts') || /\.test\.ts$|\.d\.ts$/.test(entry.name)) continue;
      const text = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      function literal(node, constants) {
        if (!node) return undefined;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (ts.isIdentifier(node)) return constants.get(node.text);
        if (ts.isArrayLiteralExpression(node)) {
          const values = node.elements.map(element => literal(element, constants));
          return values.some(value => value === undefined) ? undefined : values;
        }
        if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, constants);
        if (ts.isConditionalExpression(node)) {
          const condition = literal(node.condition, constants);
          return typeof condition === 'boolean' ? literal(condition ? node.whenTrue : node.whenFalse, constants) : undefined;
        }
        if (ts.isTemplateExpression(node)) {
          let value = node.head.text;
          for (const span of node.templateSpans) {
            const part = literal(span.expression, constants);
            if (typeof part !== 'string') return undefined;
            value += part + span.literal.text;
          }
          return value;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          const left = literal(node.left, constants), right = literal(node.right, constants);
          return typeof left === 'string' && typeof right === 'string' ? left + right : undefined;
        }
        return undefined;
      }
      function visit(node, constants) {
        if (ts.isBlock(node) || ts.isFunctionLike(node) || ts.isForOfStatement(node)
          || ts.isForInStatement(node) || ts.isForStatement(node) || ts.isCatchClause(node)) constants = new Map(constants);
        if (ts.isParameter(node) && ts.isIdentifier(node.name)) constants.delete(node.name.text);
        if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
          const declaration = node.initializer.declarations[0];
          const values = literal(node.expression, constants);
          if (declaration && ts.isIdentifier(declaration.name) && Array.isArray(values)) {
            for (const value of values) {
              const iteration = new Map(constants);
              iteration.set(declaration.name.text, value);
              visit(node.statement, iteration);
            }
            return;
          }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const value = literal(node.initializer, constants);
          constants.delete(node.name.text);
          if (value !== undefined && ts.isVariableDeclarationList(node.parent)
            && (node.parent.flags & ts.NodeFlags.Const)) constants.set(node.name.text, value);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && /^(?:app|router|target|original)$/.test(node.expression.expression.getText(source))
          && methods.has(node.expression.name.text)) {
          const location = { file: relative(root, path).split('\\').join('/'), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 };
          const route = literal(node.arguments[0], constants);
          if (typeof route === 'string' && route.startsWith('/api/')) routes.push({ method: node.expression.name.text, path: route, ...location });
          else if (route === undefined) unresolved.push({ method: node.expression.name.text, ...location });
        }
        ts.forEachChild(node, child => visit(child, constants));
      }
      visit(source, new Map());
    }
  }
  walk(join(root, 'apps/server/src'));
  return { routes, unresolved };
}

export function generateApiDocument(root = repository) {
  const { routes, unresolved } = discoverApiRoutes(root);
  const paths = {};
  const canonicalPaths = new Map();
  for (const route of routes) {
    const candidate = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*/g, '{wildcard}');
    const shape = candidate.replace(/\{\w+\}/g, '{}');
    const path = canonicalPaths.get(shape) ?? candidate;
    canonicalPaths.set(shape, path);
    const item = paths[path] ??= {};
    if (item[route.method]) {
      const operation = item[route.method];
      operation['x-aod-sources'].push({ file: route.file, line: route.line });
      if (route.path !== operation['x-aod-raw-path']) {
        operation['x-aod-alternate-raw-paths'] = [...new Set([...(operation['x-aod-alternate-raw-paths'] ?? []), route.path])];
      }
      continue;
    }
    const tag = route.path.startsWith('/api/hub/') ? 'Hub' : route.path.startsWith('/api/connector/') ? 'Connector' : route.path.startsWith('/api/auth/') ? 'Authentication' : 'Application';
    item[route.method] = {
      operationId: 'route_' + createHash('sha256').update(route.method + ' ' + path).digest('hex').slice(0, 16),
      summary: `${route.method.toUpperCase()} ${route.path}`,
      tags: [tag],
      description: 'Source route inventory, not a complete request/response or authorization contract. Read x-aod-sources and the bilingual API guide before calling. Role-specific and internal registrations can share this path.',
      parameters: [...new Set([...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      responses: { default: { description: 'Implementation-defined status, payload and streaming behavior; inspect the linked source and route tests.' } },
      'x-aod-sources': [{ file: route.file, line: route.line }],
      'x-aod-raw-path': route.path,
      'x-aod-authorization': 'Unspecified in inventory; route-specific authentication and grants are required where enforced by the implementation.',
    };
  }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  return {
    openapi: '3.1.0',
    info: { title: 'AgentOpsDeck API route inventory', version, description: 'Generated from static HTTP registrations. Not a normative SDK contract or authorization specification. No private runtime data, server origin or credentials are included.', contact: { name: 'AgentOpsDeck', email: 'AOD@wuxiaiclub.com' }, license: { name: 'Apache-2.0' } },
    paths: Object.fromEntries(Object.entries(paths).sort(([first], [second]) => first.localeCompare(second, 'en'))),
    'x-aod-static-registrations': routes.length,
    'x-aod-unresolved-registrations': unresolved,
    'x-aod-limitations': ['Dynamic route factories and mounted prefixes require manual review.', 'WebSocket, SSE, worker IPC and stream frame schemas are not described.', 'Duplicate role-specific routes share source references, not a fabricated unified payload schema.', 'No servers, credentials, automatic live endpoint or Try it out configuration is supplied.'],
  };
}

export function apiDocumentText(root = repository) {
  return JSON.stringify(generateApiDocument(root), null, 2) + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check') {
    if (readFileSync(join(repository, 'docs/api/openapi.json'), 'utf8') !== apiDocumentText()) {
      console.error('API documentation is stale: regenerate the reviewed route inventory.');
      process.exitCode = 1;
    } else console.log('API source inventory matches implementation.');
  } else if (process.argv.length === 2) process.stdout.write(apiDocumentText());
  else { console.error('Usage: node scripts/api-docs.mjs [--check]'); process.exitCode = 1; }
}
