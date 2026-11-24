import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { inspectDatabaseRoots, isFixture } from './audit-async-database-roots.mjs';

/** Conservative value-import graph, NOT an interprocedural/effect proof. Keep
 * the whole-source inventory unchanged: unreachable legacy roots still exist.
 * Worker bootstrap strings are not main-thread imports. A worker module reached
 * by a real value import is rejected, not excused by its reviewed filename. */
export async function auditProductionDatabaseRoots(directory, entry = 'index.ts') {
  const root = await realpath(directory), seen = new Set(), inputs = [], edges = [], findings = [];
  const workerImports = [], fixtureImports = [], opaqueImports = [];
  const within = file => { const path = relative(root, file); return path !== '..' && !path.startsWith('../')
    && !path.startsWith('..\\') && !isAbsolute(path); };
  async function visit(file) {
    if (!within(file)) throw Error('Production import escapes server source');
    if (seen.has(file)) return;
    if (await realpath(file) !== file) throw Error('Production import contains a symlink');
    seen.add(file);
    const path = relative(root, file).split('\\').join('/'), text = await readFile(file, 'utf8');
    inputs.push({ path, sha256: createHash('sha256').update(text).digest('hex') });
    const found = inspectDatabaseRoots(text, path); findings.push(...found);
    if (found.some(f => f.classification === 'worker-owned-boundary')) workerImports.push(path);
    if (isFixture(path)) fixtureImports.push(path);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), deps = new Set();
    function add(node) {
      if (!ts.isStringLiteralLike(node)) { opaqueImports.push(path); return; }
      if (!node.text.startsWith('.')) return; // Installed packages are outside this source-graph scope.
      if (!/\.(?:js|ts)$/.test(node.text)) throw Error('Unresolved local production import: ' + path);
      deps.add(resolve(dirname(file), node.text.replace(/\.js$/, '.ts')));
    }
    function walk(node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || node.importClause?.name || bindings.elements.some(b => !b.isTypeOnly)) add(node.moduleSpecifier);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
        && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(b => !b.isTypeOnly))) add(node.moduleSpecifier);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length) add(node.arguments[0]); else opaqueImports.push(path);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    for (const dependency of [...deps].sort()) {
      edges.push({ from: path, to: relative(root, dependency).split('\\').join('/') });
      await visit(dependency);
    }
  }
  await visit(resolve(root, entry));
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const pending = findings.filter(f => f.classification === 'synchronous-root-requires-migration-review');
  return { version: 1, entry, scope: 'local value-import graph; not whole-database async acceptance or external SDK audit',
    sourceSha256: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), inputs, edges, findings, pending,
    workerImports: workerImports.sort(), fixtureImports: fixtureImports.sort(), opaqueImports: [...new Set(opaqueImports)].sort(),
    productionRootGatePassed: pending.length === 0 && workerImports.length === 0 && fixtureImports.length === 0 && opaqueImports.length === 0,
    wholeDatabaseAsyncAcceptance: 'requires-production-chain-and-full-regression' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw Error('Unsupported audit argument');
  const result = await auditProductionDatabaseRoots(resolve(dirname(fileURLToPath(import.meta.url)), '../apps/server/src'));
  console.log(JSON.stringify(result, null, 2));
  if (!result.productionRootGatePassed) process.exitCode = 1;
}
