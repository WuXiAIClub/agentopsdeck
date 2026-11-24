import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure options builder: importing this module does not load TypeScript into
 * the test orchestrator. Fresh shared declarations never redirect to old dist. */
export function freshCompilerOptions(parsed, outDir, sharedDeclaration) {
  const options = { ...parsed.options, outDir, incremental: false, composite: false,
    noEmit: false, noEmitOnError: true };
  delete options.tsBuildInfoFile;
  if (sharedDeclaration) options.paths = { ...options.paths, '@agentopsdeck/shared': [sharedDeclaration] };
  return options;
}

function validateRequest(request) {
  assert.ok(request && typeof request === 'object', 'Invalid compiler request');
  for (const field of ['workspace', 'output']) {
    assert.ok(typeof request[field] === 'string' && isAbsolute(request[field]), 'Compiler paths must be absolute');
  }
  assert.ok(request.sharedDeclaration === undefined
    || (typeof request.sharedDeclaration === 'string' && isAbsolute(request.sharedDeclaration)), 'Invalid shared declaration');
  assert.equal(typeof request.projectReferences, 'boolean', 'Explicit project reference policy required');
}

/** Synchronous return is intentional: the compiler must physically exit before
 * any test child starts. No retries, shell, heap tuning or fallback compilation. */
export function emitProjectInChild(workspace, output, sharedDeclaration, projectReferences = false) {
  const request = { workspace, output, sharedDeclaration, projectReferences };
  validateRequest(request);
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--emit-project', JSON.stringify(request)],
    { stdio: 'inherit' });
  assert.equal(child.error, undefined, 'Could not start compiler child');
  assert.equal(child.signal, null, 'Compiler child terminated by signal');
  assert.equal(child.status, 0, 'Compiler child failed; tests must not start');
  return { pid: child.pid, code: child.status, signal: child.signal };
}

async function emit(request) {
  validateRequest(request);
  // This import belongs exclusively to the short-lived compiler process.
  const { default: ts } = await import('typescript');
  const { workspace, output, sharedDeclaration, projectReferences } = request;
  const path = join(workspace, 'tsconfig.json');
  const config = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, workspace, undefined, path);
  assert.deepEqual(parsed.errors, [], 'Invalid TypeScript configuration');
  const options = freshCompilerOptions(parsed, output, sharedDeclaration);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options,
    ...(projectReferences ? { projectReferences: parsed.projectReferences } : {}) });
  for (const source of program.getSourceFiles()) if (!source.isDeclarationFile) {
    const file = resolve(source.fileName), root = join(workspace, 'src');
    assert.ok(file.startsWith(root + '/') || file.startsWith(root + '\\'), 'Emit escaped project source root');
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => workspace, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const result = program.emit();
  assert.equal(result.emitSkipped, false); assert.equal(result.diagnostics.length, 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Expected an explicit compiler request');
  assert.equal(process.argv[2], '--emit-project');
  await emit(JSON.parse(process.argv[3]));
}
