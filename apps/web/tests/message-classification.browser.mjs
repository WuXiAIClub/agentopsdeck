// Differential oracle: original eager passes vs shared classification. Local only.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [{ name: 'classification-oracle', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/src/components/messages.tsx')) return;
    for (const name of ['readableText', 'stripThinkingLines']) {
      const marker = new RegExp(`(function ${name}\\([^)]*\\)(?:: [^{]+)? \\{)`);
      assert.ok(marker.test(code));
      code = code.replace(marker, '$1 (window as any).__decodes++;');
    }
    return code + '\nexport const testPredicates = { isHiddenAssistantNoise, displayMessageText, isToolOutputPlaceholder, isInternalOutput, createMessageItemProjector };';
  }, configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__classification') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><body><script type="module">import * as subject from "/src/components/messages.tsx"; window.subject = subject;</script></body></html>'));
    });
  } }, react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], denied = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET') {
      denied.push(url.pathname); return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => { window.__decodes = 0; });
  await page.goto(`${origin}/__classification`);
  await page.waitForFunction(() => !!window.subject);
  const result = await page.evaluate(() => {
    const s = window.subject;
    const { isHiddenAssistantNoise, displayMessageText, isToolOutputPlaceholder, isInternalOutput, createMessageItemProjector } = s.testPredicates;
    // Original count order, deliberately independent of shared kind caching.
    function counts(message) {
      if (!message || isHiddenAssistantNoise(message)) return false;
      if (isToolOutputPlaceholder(displayMessageText(s.readableText(message.text)))) return false;
      return !isInternalOutput(message);
    }
    const count = messages => messages.filter(counts).length;
    function visible(messages, limit) {
      let seen = 0, start = 0;
      for (let i = messages.length - 1; i >= 0; i--) if (counts(messages[i]) && ++seen > limit) { start = i + 1; break; }
      return messages.slice(start);
    }
    function kind(message) {
      if (isToolOutputPlaceholder(displayMessageText(s.readableText(message.text))) || isHiddenAssistantNoise(message)) return 'hidden';
      return isInternalOutput(message) ? 'tool' : 'chat';
    }
    // Original eager grouping, retaining original message objects and indexes.
    function items(messages) {
      const output = []; let tools = [], start = -1;
      messages.forEach((message, index) => {
        const type = kind(message);
        if (type === 'hidden') return;
        if (type === 'tool') { if (start < 0) start = index; tools.push(message); return; }
        output.push({ kind: 'message', message, index, ...(tools.length ? { attachedTools: tools } : {}) });
        tools = []; start = -1;
      });
      if (tools.length) output.push({ kind: 'toolGroup', messages: tools, startIndex: start, endIndex: messages.length - 1 });
      return output;
    }
    let checks = 0;
    function equal(actual, expected, label) {
      checks++;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
    }
    function sameRows(actual, expected) {
      equal(actual.length, expected.length, 'length');
      actual.forEach((row, i) => { if (row !== expected[i]) throw new Error('message identity/order changed'); });
    }
    function sameItems(actual, expected) {
      equal(actual, expected, 'grouping/index mismatch');
      actual.forEach((item, i) => {
        if (item.kind === 'message') {
          if (item.message !== expected[i].message) throw new Error('group copied message');
          sameRows(item.attachedTools ?? [], expected[i].attachedTools ?? []);
        } else sameRows(item.messages, expected[i].messages);
      });
    }
    function check(messages) {
      equal(s.countWindowMessages(messages), count(messages), 'chat count');
      for (const limit of [0, 1, 7, 200, 2000]) {
        const actual = s.visibleMessages(messages, limit), expected = visible(messages, limit);
        sameRows(actual, expected);
        equal(s.hiddenMessageCount(messages, actual), Math.max(0, count(messages) - count(expected)), 'hidden count');
      }
      sameItems(s.desktopMessageItems(messages), items(messages));
      sameItems(s.createDesktopMessageProjector()(messages), items(messages));
    }
    const texts = ['Hello', '**Markdown**\n\n```js\nconst a = 1;\n```', '[source](/tmp/a.ts:3)', '', '  ', '(empty)', 'NO_REPLY',
      '[tool output]', '```\n[tool output]\n```', '[tool exec]\nTool input:\n{}\n[tool output]\ndone',
      'HTTP/1.1 200 OK', 'LISTEN 127.0.0.1', 'Command still running', 'remote: done', '{"ok":true}',
      '{"type":"thinking","text":"secret"}', '{"type":"thinking"', '{"type":"thinking","thinking":"secret"}\nAnswer',
      'Error: request failed', 'Agent failed before reply: timeout', 'Assistant turn failed before producing content',
      '[assistant turn failed before producing content]', '[tool_output]', '```text\n [ TOOL-OUTPUT ] \n```',
      null, undefined, ['Hello', null], { text: 'old' }, 0, false];
    const corpus = [];
    for (const text of texts) for (const role of ['user', 'assistant', 'tool', 'system']) for (const status of [undefined, 'sent', 'failed', 'pending']) {
      const message = { id: 'same-id', sessionKey: `session-${corpus.length % 3}`, text, role, status, createdAt: corpus.length };
      corpus.push(message); check([message]);
    }
    check(corpus);
    // Deterministic mixed histories, append/prepend/remove/immutable streaming.
    let seed = 12345;
    const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
    const oldProject = createMessageItemProjector(kind), newProject = s.createDesktopMessageProjector();
    let history = [];
    for (let i = 0; i < 300; i++) {
      const row = { ...corpus[random(corpus.length)], text: texts[random(20)] };
      switch (i % 5) {
        case 0: history = [...history, row]; break;
        case 1: history = [row, ...history]; break;
        case 2: history = history.map((m, j) => j === history.length - 1 ? { ...m, text: 'stream ' + i } : m); break;
        case 3: history = history.slice(1); break;
        default: history = history.slice();
      }
      check(history);
      sameItems(newProject(history), oldProject(history));
    }
    // Cache invalidation, including nested legacy edits; fresh projectors since
    // incremental projectors already require immutable message updates.
    const mutable = { ...corpus[0] };
    for (const text of texts) for (const role of ['assistant', 'tool']) for (const status of ['sent', 'failed']) {
      Object.assign(mutable, { text, role, status }); check([mutable]);
    }
    mutable.text = [{ text: 'before' }]; check([mutable]); mutable.text[0].text = 'after'; check([mutable]);
    const fixed = Array.from({ length: 100 }, (_, i) => Object.freeze({ id: String(i), sessionKey: 'fixed', role: i % 2 ? 'assistant' : 'tool', text: 'full text ' + i, createdAt: i }));
    s.countWindowMessages(fixed); const start = window.__decodes;
    for (let i = 0; i < 20; i++) { s.countWindowMessages(fixed); s.visibleMessages(fixed); s.hiddenMessageCount(fixed, fixed); s.desktopMessageItems(fixed); s.createDesktopMessageProjector()(fixed); }
    equal(window.__decodes, start, 'unchanged cached passes must not decode again');
    return { corpus: corpus.length, sequenceUpdates: 300, checks, unchangedPassDecodes: window.__decodes - start };
  });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ ...result, errors, denied, passed: true }));
} finally { await browser?.close(); await server.close(); }
