import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');

export function readCatalog(text) {
  const source = ts.createSourceFile('translations.ts', text, ts.ScriptTarget.Latest, true);
  const catalog = new Map(), errors = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'chinese') {
      let value = node.initializer;
      if (value && ts.isAsExpression(value)) value = value.expression;
      if (!value || !ts.isObjectLiteralExpression(value)) { errors.push('Chinese catalog must be a static object'); return; }
      for (const property of value.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isStringLiteral(property.initializer)) {
          errors.push('Catalog entry must have a literal key and value'); continue;
        }
        const key = property.name.text, translation = property.initializer.text;
        if (catalog.has(key)) errors.push(`Duplicate translation key: ${key}`);
        if (!translation.trim()) errors.push(`Empty translation: ${key}`);
        if (placeholders(key) !== placeholders(translation)) errors.push(`Placeholder mismatch: ${key}`);
        catalog.set(key, translation);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!catalog.size) errors.push('Empty Chinese catalog');
  return { catalog, errors };
}

export function translationCalls(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = [], dynamic = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'translate', 'translateMessage'].includes(node.expression.text)) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) keys.push(argument.text);
      else dynamic.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { keys, dynamic };
}

export function checkI18nCatalog(root = join(repository, 'apps/web/src')) {
  const { catalog, errors } = readCatalog(readFileSync(join(root, 'lib/translations.ts'), 'utf8'));
  let files = 0, calls = 0, dynamicCalls = 0;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files++;
        const result = translationCalls(readFileSync(path, 'utf8'), entry.name);
        calls += result.keys.length; dynamicCalls += result.dynamic.length;
        for (const key of result.keys) if (!catalog.has(key)) errors.push(`${relative(root, path)}: Missing Chinese translation: ${key}`);
      }
    }
  }
  walk(root);
  return { passed: errors.length === 0, files, entries: catalog.size, calls, dynamicCalls, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkI18nCatalog();
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
