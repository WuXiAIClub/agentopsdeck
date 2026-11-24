import assert from 'node:assert/strict';
import test from 'node:test';
import { isModuleLoadError } from './module-load-error.js';

test('recognizes browser lazy-module failures without hiding ordinary render or API errors', () => {
  for (const message of ["'text/html' is not a valid JavaScript MIME type.", 'Failed to fetch dynamically imported module: /assets/old.js',
    'error loading dynamically imported module', 'Importing a module script failed.', 'Loading chunk 2 failed.',
    'Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html']) {
    assert.equal(isModuleLoadError(new Error(message)), true, message);
  }
  for (const message of ['Failed to fetch', 'Connector request failed: HTTP 503', "Cannot read properties of undefined (reading '0')", 'Invalid source preview']) {
    assert.equal(isModuleLoadError(new Error(message)), false, message);
  }
});
