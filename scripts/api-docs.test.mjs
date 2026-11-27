import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { apiDocumentText, discoverApiRoutes, generateApiDocument } from './api-docs.mjs';

test('checked-in OpenAPI inventory is deterministic and maps to existing source', () => {
  const document = generateApiDocument();
  assert.equal(readFileSync(new URL('../docs/api/openapi.json', import.meta.url), 'utf8'), apiDocumentText());
  assert.ok(document['x-aod-static-registrations'] > 100);
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.servers, undefined);
  assert.equal(document.security, undefined);
  assert.ok(document.paths['/api/auth/status'].get);
  assert.ok(document.paths['/api/auth/login'].post);
  for (const path of ['/api/connector/v1/ahp', '/api/hub/v1/connections/{connectionId}/ahp']) {
    assert.ok(document.paths[path].get);
    assert.ok(document.paths[path].post);
  }
  const shapes = Object.keys(document.paths).map(path => path.replace(/\{\w+\}/g, '{}'));
  assert.equal(new Set(shapes).size, shapes.length);
  const identities = new Set();
  for (const operations of Object.values(document.paths)) for (const operation of Object.values(operations)) {
    assert.ok(!identities.has(operation.operationId)); identities.add(operation.operationId);
    for (const source of operation['x-aod-sources']) {
      assert.ok(existsSync(new URL('../' + source.file, import.meta.url)));
      assert.ok(source.line > 0);
    }
    assert.ok(operation.responses.default);
    assert.equal(operation.security, undefined);
  }
});

test('route parser excludes tests, converts constant paths and records unresolved routes', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-api-docs-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/server/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
  writeFileSync(join(root, 'apps/server/src/routes.ts'), "const prefix = '/api/items'; app.get(prefix + '/:id', handler); app.post(dynamicPath, handler); client.get('/api/not-a-route'); app.get('/api/files/*', handler);");
  writeFileSync(join(root, 'apps/server/src/fake.test.ts'), "app.get('/api/fake', handler);");
  assert.equal(discoverApiRoutes(root).routes.length, 2);
  const document = generateApiDocument(root);
  assert.equal(document['x-aod-unresolved-registrations'].length, 1);
  assert.deepEqual(document.paths['/api/items/{id}'].get.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
  assert.equal(document.paths['/api/files/{wildcard}'].get['x-aod-raw-path'], '/api/files/*');
});

test('route parser respects lexical shadowing and expands literal loops without guessing dynamic paths', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-api-scopes-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/server/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
  writeFileSync(join(root, 'apps/server/src/routes.ts'), `
    const prefix = '/api/outer';
    { const prefix = unknown; app.get(prefix, handler); }
    function register(prefix) { app.get(prefix, handler); }
    for (const prefix of unknownPaths) { app.get(prefix, handler); }
    let mutable = '/api/mutable'; mutable = unknown; app.get(mutable, handler);
    for (const name of ['first', 'second'] as const) { app.get(prefix + '/' + name, handler); }
    app.get(prefix, handler);
    app.get('/api/items/:itemId', handler);
    app.get('/api/items/:resourceId', handler);
    app.post('/api/items/:resourceId', handler);
  `);
  const found = discoverApiRoutes(root);
  assert.equal(found.unresolved.length, 4);
  assert.deepEqual(found.routes.slice(0, 3).map(route => route.path), ['/api/outer/first', '/api/outer/second', '/api/outer']);
  const document = generateApiDocument(root);
  assert.equal(Object.keys(document.paths).length, 4);
  const item = document.paths['/api/items/{itemId}'];
  assert.equal(item.get['x-aod-sources'].length, 2);
  assert.deepEqual(item.get['x-aod-alternate-raw-paths'], ['/api/items/:resourceId']);
  assert.equal(item.post.parameters[0].name, 'itemId');
});
