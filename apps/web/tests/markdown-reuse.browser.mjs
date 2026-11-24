// Instrument the installed parser only in this isolated browser fixture.
// Optional baseline is a snapshot of messages.tsx, not a different parser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const baseline = process.env.AOD_MESSAGES_BASELINE
  ? await readFile(process.env.AOD_MESSAGES_BASELINE, 'utf8') : undefined;
const expectReuse = process.env.AOD_MARKDOWN_EXPECT_REUSE !== '0';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  optimizeDeps: { exclude: ['react-markdown'], include: [
    'react-markdown > hast-util-to-jsx-runtime', 'react-markdown > unified',
    'react-markdown > remark-parse', 'react-markdown > remark-rehype',
  ] },
  plugins: [{ name: 'markdown-reuse-probe', enforce: 'pre', transform(source, id) {
    id = id.split('?')[0];
    if (id.endsWith('/src/components/messages.tsx')) {
      return (baseline ?? source) + '\nexport const markdownReuseSubject = MarkdownTextContent;';
    }
    if (!id.endsWith('/react-markdown/lib/index.js')) return;
    const original = `  const processor = createProcessor(options)
  const file = createFile(options)
  return post(processor.runSync(processor.parse(file), file), options)`;
    assert.ok(source.includes(original), 'installed synchronous Markdown implementation changed');
    return source.replace(original, `
  const stats = window.__markdownStats;
  const measure = (name, fn) => { const start = performance.now(); try { return fn(); }
    finally { stats[name] = (stats[name] || 0) + performance.now() - start; } };
  stats.calls++;
  const processor = measure('setupMs', () => createProcessor(options));
  // parse() normally freezes lazily: account plugin initialization separately.
  measure('freezeMs', () => processor.freeze());
  const file = measure('fileMs', () => createFile(options));
  const parsed = measure('parseMs', () => processor.parse(file));
  const tree = measure('runMs', () => processor.runSync(parsed, file));
  return measure('postMs', () => post(tree, options));`);
  }, configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__markdown-reuse') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/tests/markdown-reuse.fixture.tsx"></script></body></html>'));
    });
  } }, react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });

const corpus = [
  '', '普通中文与 emoji 🙂', 'plain paragraph', 'line one\nline two', 'hard break  \nnext',
  '# Heading\n\n## Second\n\n### Third', '**bold** and *italic* and ~~deleted~~',
  '- one\n  - nested\n- two\n\n1. first\n2. second', '> quote\n\n---',
  '- [x] checked\n- [ ] unchecked', '| A | B |\n| :- | -: |\n| cell | value |',
  '```js\nconst x = "<script>literal</script>";\n```\n\n`inline code`',
  '[external](https://example.invalid/docs) and https://example.invalid and a@example.invalid',
  '[unsafe](javascript:alert%281%29) [data](data:text/html,test) [mail](mailto:a@example.invalid)',
  '<script>window.__unsafe = true</script>\n\n<img src=x onerror="window.__unsafe=true">',
  '&amp; &lt;entity&gt; &#65; \\*escaped\\*', '[reference][id]\n\n[id]: https://example.invalid',
  'footnote[^1]\n\n[^1]: content', '    indented code\n    second line',
  '![image](/__image.svg "image title")',
];
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [], denied = [], sourceRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') { denied.push(url.href); return route.abort(); }
      if (url.pathname === '/__image.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>' });
      if (url.pathname.startsWith('/api/hub/v1/sessions/probe/messages/')) {
        sourceRequests.push(url.pathname);
        return route.fulfill({ json: { path: '/project/probe.ts', line: 1, startLine: 1, totalLines: 1, modifiedAt: 1,
          text: url.pathname.includes('/new/') ? 'const freshSource = 2;' : 'const oldSource = 1;' } });
      }
      if (url.pathname.startsWith('/api/')) { denied.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(() => { window.__markdownStats = { calls: 0 }; });
    await page.goto(`${origin}/__markdown-reuse`);
    await page.waitForFunction(() => window.markdownReady).catch(error => {
      throw new Error(`${error.message}\npage errors: ${JSON.stringify(errors)}\ndenied: ${JSON.stringify(denied)}`);
    });
    const render = rows => page.evaluate(rows => window.renderMarkdown(rows), rows);
    const reset = () => page.evaluate(() => { window.__markdownStats = { calls: 0 }; });
    const stats = () => page.evaluate(() => ({ ...window.__markdownStats }));
    const rows = corpus.map((text, id) => ({ id: String(id), text }));
    await render(rows);
    assert.equal((await stats()).calls, rows.length, 'instrumentation must observe every initial parse');
    const html = await page.locator('#root').innerHTML();
    const hash = createHash('sha256').update(html).digest('hex');
    assert.equal(await page.locator('#root script, #root img[onerror]').count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"], a[href^="data:"]').count(), 0);
    assert.equal(await page.locator('table').count(), 1);
    assert.equal(await page.locator('input[type="checkbox"]').count(), 2);
    assert.equal(await page.locator('del').textContent(), 'deleted');
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    // Preserve the actual DOM node and native selection through metadata refresh.
    await page.evaluate(() => {
      window.__retainedParagraph = document.querySelector('[data-probe="2"] p');
      const range = document.createRange(); range.selectNodeContents(window.__retainedParagraph);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await reset();
    for (let i = 0; i < 3; i++) await render(rows.map(row => ({ ...row, media: [], className: `revision-${i}` })));
    const metadata = await stats();
    assert.equal(metadata.calls, expectReuse ? 0 : rows.length * 3);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'plain paragraph');
    assert.ok(await page.evaluate(() => window.__retainedParagraph === document.querySelector('[data-probe="2"] p')));
    assert.ok(await page.evaluate(() => window.find('普通中文与 emoji', false, false, true)));
    // Text and tone are real inputs, unlike surrounding wrapper style/metadata.
    await reset();
    await render(rows.map((row, i) => ({ ...row, text: i === 2 ? 'streamed **new**' : row.text, media: [] })));
    assert.equal((await stats()).calls, expectReuse ? 1 : rows.length);
    assert.equal(await page.locator('[data-probe="2"] strong').textContent(), 'new');
    await reset();
    await render(rows.map(row => ({ ...row, tone: 'user' })));
    assert.equal((await stats()).calls, rows.length);
    assert.ok((await page.locator('[data-probe="0"] .markdown-body').getAttribute('class')).includes('text-white'));
    // Incomplete streaming syntax must recover at every intermediate character.
    for (const text of ['`', '`a', '`a`', '[link](', '[link](https://example.invalid)', '```js\nconst a =', '```js\nconst a = 1;\n```']) {
      await reset(); await render([{ id: 'stream', text }]); assert.equal((await stats()).calls, 1);
    }
    // Context consumers must see new metadata even when the parser is skipped.
    const source = { id: 'source', text: '[Source](/project/probe.ts:1)' };
    const media = revision => [{ type: 'file', name: 'probe.ts', url: `/api/hub/v1/sessions/probe/messages/${revision}/media/${'a'.repeat(64)}`,
      sourceReference: { href: '/project/probe.ts:1', path: '/project/probe.ts', line: 1 } }];
    await render([{ ...source, media: media('old') }]);
    await page.waitForFunction(() => document.body.textContent.includes('oldSource'));
    await reset(); await render([{ ...source, media: media('new') }]);
    await page.waitForFunction(() => document.body.textContent.includes('freshSource'));
    assert.equal((await stats()).calls, expectReuse ? 0 : 1);
    assert.equal(sourceRequests.length, 2);
    // 2,400 distinct mounted messages; this is a fixture phase profile, not LCP.
    await reset();
    const profileRows = Array.from({ length: 2400 }, (_, i) => ({ id: `profile-${i}`,
      text: `History ${i}\n\nRetained **searchable** text.\n\n- First item\n- Second item\n\n\`inline code\`` }));
    await render(profileRows);
    const initial = await stats();
    assert.equal(initial.calls, 2400);
    await reset();
    await render(profileRows.map(row => ({ ...row, media: [] })));
    const refresh = await stats();
    assert.equal(refresh.calls, expectReuse ? 0 : 2400);
    await render([]); await reset(); await render([profileRows[0]]);
    assert.equal((await stats()).calls, 1, 'unmount must not retain a global text/AST cache');
    await page.evaluate(() => window.unmountMarkdown());
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    console.log(JSON.stringify({ kind: 'markdown-reuse', width, baseline: !!baseline, hash, metadata, initial, refresh }));
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }
