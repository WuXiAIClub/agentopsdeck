import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteBrowserVisit } from './workspace-website.js';

test('interactive website address rejects Hub/credential/path targets and invalid lifetime', () => {
  const url = `https://${'a'.repeat(48)}.preview.example.net/`, hub = 'https://hub.example.org';
  assert.deepEqual(websiteBrowserVisit({ url, expiresInMs: 1000 }, hub), { url, expiresInMs: 1000 });
  for (const invalid of [null, {}, { url, expiresInMs: 0 }, { url, expiresInMs: 300_001 }, { url, expiresInMs: 1.5 },
    ...[hub, url + '?key=private', url + 'path', url.replace('https:', 'http:'), url.replace('preview.example.net', 'hub.example.org'),
      url.replace('https://', 'https://user:secret@')].map(url => ({ url, expiresInMs: 1000 }))]) {
    assert.throws(() => websiteBrowserVisit(invalid, hub));
  }
  assert.ok(websiteBrowserVisit({ url: `http://${'a'.repeat(48)}.preview.localhost:9898/`, expiresInMs: 1000 }, 'http://127.0.0.1:8791'));
});
