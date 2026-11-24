import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { verifyWeb } from './observe-local-maintenance.mjs';

test('web observation verifies HTML pins and exact bytes, allows proxy RUM, and fails closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-observer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/web/dist'), { recursive: true });
  const html = '<script src="/assets/index-abc.js"></script><link href="/assets/index-def.css">';
  await writeFile(join(root, 'apps/web/dist/index.html'), html);
  const files = Object.entries({ 'index-abc.js': 'js', 'index-def.css': 'css' }).map(([name, body]) => ({
    path: `apps/web/dist/assets/${name}`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'),
  }));
  await writeFile(join(root, 'candidate-manifest.json'), JSON.stringify({ files }));
  const mock = (index = html, js = 'js', status = 200) => async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined, 'no bearer forwarded to web');
    return new Response(url.pathname === '/' ? index : url.pathname.endsWith('.js') ? js : 'css', { status });
  };
  assert.equal((await verifyWeb('https://example.test', root, mock(html + '<script src="/cdn-cgi/rum"></script>'))).verified, true);
  await assert.rejects(verifyWeb('https://example.test', root, mock(html.replace('abc', 'old'))));
  await assert.rejects(verifyWeb('https://example.test', root, mock(html, 'xx')), /digest/);
  await assert.rejects(verifyWeb('https://example.test', root, mock(html, 'js', 503)), /request/);
  await assert.rejects(verifyWeb('https://user:secret@example.test', root, mock()));
});
