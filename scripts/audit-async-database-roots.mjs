import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// A fail-closed acceptance aid, NOT proof that every caller awaits correctly.
// Do not count a tested candidate facade as an activated runtime owner.
const targets = new Map([
  ['node:sqlite', new Set(['DatabaseSync'])],
  ['sqlite-store.js', new Set(['openSqliteAuth'])],
  ['hub-store.js', new Set(['HubStore'])],
  ['connector-user-store.js', new Set(['ConnectorUserStore'])],
  ['startup-owner.js', new Set(['startupDatabaseOwners'])],
]);
const workers = new Set([
  'auth/sqlite-owner-worker.ts', 'auth/sqlite-display-worker.ts',
  'connector/connector-owner-worker.ts', 'hub/member-owner-worker.ts',
  'hub/delivery-reader-worker.ts', 'codex/stopped-recovery-worker.ts',
  'lifecycle/maintenance-journal-worker.ts',
  'connector/update-lock-worker.ts',
]);
const storeImplementations = new Set([
  'auth/sqlite-store.ts', 'hub/hub-store.ts', 'connector/connector-user-store.ts',
]);
const experiments = new Set(['storage/history-experiment.ts', 'storage/history-soak.ts']);
export function isFixture(path) {
  return /(?:^|\/)[^/]+(?:\.test|\.test-fixture|-fixture)\.ts$/.test(path);
}
function classification(path, symbol) {
  if (workers.has(path)) return 'worker-owned-boundary';
  if (experiments.has(path)) return 'offline-experiment';
  if (path === 'storage/startup-owner.ts' && symbol === 'DatabaseSync') return 'connection-factory';
  if (storeImplementations.has(path) && symbol === 'startupDatabaseOwners') return 'original-domain-owner-implementation';
  // Volume coordination and maintenance lock handles are deliberately NOT
  // silently exempted: their callers/owner lifetimes need separate review.
  return 'synchronous-root-requires-migration-review';
}
// This newly moved factory is exempt only after the actual runtime parent-port
// guard, not merely because somebody names a main-thread module "worker".
function guardedVolumeWorkerStart(source, path) {
  if (path !== 'storage/volume-admission-worker.ts') return Infinity;
  const imported = source.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:worker_threads'
    && !node.importClause?.isTypeOnly && node.importClause?.namedBindings
    && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(binding => !binding.isTypeOnly
      && (binding.propertyName ?? binding.name).text === 'parentPort' && binding.name.text === 'parentPort'));
  if (!imported) return Infinity;
  const guard = source.statements.find(node => ts.isIfStatement(node) && !node.elseStatement
    && ts.isPrefixUnaryExpression(node.expression) && node.expression.operator === ts.SyntaxKind.ExclamationToken
    && ts.isIdentifier(node.expression.operand) && node.expression.operand.text === 'parentPort'
    && ts.isThrowStatement(node.thenStatement));
  return guard?.end ?? Infinity;
}
function moduleKey(specifier) {
  const leaf = specifier.split('/').at(-1);
  return specifier === 'node:sqlite' ? specifier : targets.has(leaf) ? leaf : undefined;
}
export function inspectDatabaseRoots(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw Error('Cannot audit malformed TypeScript: ' + path);
  const bound = new Map(), namespaces = new Map();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const key = moduleKey(node.moduleSpecifier.text), clause = node.importClause;
    if (!key || !clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const symbol = (binding.propertyName ?? binding.name).text;
        if (!binding.isTypeOnly && targets.get(key).has(symbol)) bound.set(binding.name.text, symbol);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, key);
  }
  const symbolOf = node => {
    if (ts.isIdentifier(node)) return bound.get(node.text);
    if (!ts.isPropertyAccessExpression(node)) return;
    if (ts.isIdentifier(node.expression)) {
      const key = namespaces.get(node.expression.text);
      if (key && targets.get(key).has(node.name.text)) return node.name.text;
      if (bound.get(node.expression.text) === 'startupDatabaseOwners' && node.name.text === 'open') return 'startupDatabaseOwners';
    }
    if (node.name.text === 'open' && symbolOf(node.expression) === 'startupDatabaseOwners') return 'startupDatabaseOwners';
  };
  const findings = [];
  const volumeWorkerStart = guardedVolumeWorkerStart(source, path);
  function visit(node) {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const symbol = symbolOf(node.expression);
      // An imported constructor referenced without invocation is not a root.
      if (symbol && (ts.isNewExpression(node) ? symbol !== 'startupDatabaseOwners' : symbol === 'openSqliteAuth' || symbol === 'startupDatabaseOwners')) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({ path, line: line + 1, column: character + 1, symbol,
          classification: node.getStart(source) >= volumeWorkerStart ? 'worker-owned-boundary' : classification(path, symbol) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}
export async function auditDatabaseRoots(directory) {
  const inputs = [], findings = [], fixtures = [];
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = join(root, entry.name), path = relative(directory, file).split('\\').join('/');
      if (entry.isSymbolicLink()) throw Error('Refusing a symlink in source inventory: ' + path);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && file.endsWith('.ts')) {
        const text = await readFile(file, 'utf8');
        inputs.push({ path, sha256: createHash('sha256').update(text).digest('hex') });
        if (isFixture(path)) fixtures.push(path);
        else findings.push(...inspectDatabaseRoots(text, path));
      }
    }
  }
  await visit(directory);
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  fixtures.sort();
  const pending = findings.filter(f => f.classification === 'synchronous-root-requires-migration-review');
  return { version: 1, scope: 'syntactic SQL construction and original domain owner roots; not a complete runtime call-chain proof',
    sourceSha256: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), inputs, fixtures,
    findings, pending, structuralRootGatePassed: pending.length === 0,
    wholeDatabaseAsyncAcceptance: 'not-established-by-static-audit' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== '--require-no-sync-roots')) throw Error('Unsupported audit argument');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await auditDatabaseRoots(join(repo, 'apps/server/src'));
  console.log(JSON.stringify(result, null, 2));
  if (flags.includes('--require-no-sync-roots') && !result.structuralRootGatePassed) process.exitCode = 1;
}
