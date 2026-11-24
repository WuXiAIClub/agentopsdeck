// Production component, isolated native-counter fixtures; no provider calls or production data.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { createHash } from 'node:crypto';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-token-usage-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/token-usage.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true, serviceWorkers: 'block', timezoneId: 'Asia/Shanghai' });
  await context.addInitScript(() => {
    if (!localStorage.getItem('agentopsdeck.locale')) localStorage.setItem('agentopsdeck.locale', 'en');
  });
  const page = await context.newPage(), requests = [], errors = [], denied = [];
  let mode = 'normal', delayNext = false, coverageMode = 'tracked';
  let exportMode = 'normal', exportDelay = 0;
  const exports = [], downloads = [];
  const snapshots = new Map(), snapshotPosts = [], snapshotQueries = [];
  page.on('download', download => downloads.push(download));
  const trackedSince = Date.now() - 40 * 86_400_000;
  const coverage = { trackedSince, initialBaseline: { observedAt: trackedSince, inputTokens: 900000, outputTokens: 80000 },
    lastRegressionAt: trackedSince + 1000, lastCacheGapAt: trackedSince + 2000 };
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const snapshotRoute = /\/token-usage\/snapshots(?:\/([a-f0-9-]+))?$/.exec(url.pathname);
    if (url.origin === origin && snapshotRoute && ['POST', 'GET'].includes(req.method())) {
      if (req.method() === 'POST' && !snapshotRoute[1]) {
        const selection = req.postDataJSON(); snapshotPosts.push(selection);
        const usage = { version: 1, runtime: 'codex', attribution: 'root-agent', timeBasis: 'observed-at', coverage: 'partial', inputAccounting: 'includes-cache',
          from: selection.from, to: selection.to, bucketMs: selection.bucketMs, observedSince: null, buckets: [] };
        const snapshot = { version: 1, kind: 'local-ledger-snapshot', requestId: selection.requestId, createdAt: Date.now(),
          memberDigest: createHash('sha256').update(JSON.stringify([])).digest('hex'), modelsByKnowledge: [], data: { version: 1, usage, observations: [] } };
        snapshots.set(selection.requestId, snapshot);
        // Storage succeeded but ACK was lost. Only querying this ID may recover.
        return route.abort('connectionfailed');
      }
      if (req.method() === 'GET' && snapshotRoute[1]) {
        snapshotQueries.push(snapshotRoute[1]); const saved = snapshots.get(snapshotRoute[1]);
        return route.fulfill({ status: saved ? 200 : 404, json: saved ?? { error: 'Not found' } });
      }
    }
    if (url.origin !== origin || req.method() !== 'GET') { denied.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const exporting = url.pathname.endsWith('/token-usage/export');
    if (!exporting && !url.pathname.endsWith('/token-usage')) { denied.push(url.pathname); return route.abort(); }
    const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to')), bucketMs = Number(url.searchParams.get('bucketMs'));
    if (exporting) {
      exports.push({ from, to, bucketMs });
      if (exportDelay) await new Promise(resolve => setTimeout(resolve, exportDelay));
      if (exportMode !== 'normal') return route.fulfill({ status: Number(exportMode), json: { error: 'Synthetic export failure' } });
    } else requests.push({ from, to, bucketMs });
    if (delayNext) { delayNext = false; await new Promise(resolve => setTimeout(resolve, 650)); }
    if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable' } });
    const rows = [
      { model: 'model-alpha', samples: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 0 },
      { model: 'all', samples: 1, inputTokens: 300, outputTokens: 60, cacheReadTokens: 180, cacheWriteTokens: 0 },
      { model: null, samples: 1, inputTokens: 600, outputTokens: 120, cacheReadTokens: 100, cacheWriteTokens: null },
    ];
    const start = Math.floor(from / bucketMs) * bucketMs;
    const buckets = mode === 'empty' ? [] : Array.from({ length: Math.ceil((to - start) / bucketMs) }, (_, index) => {
      const row = rows[index % 3];
      return { ...row, at: start + index * bucketMs, models: [row] };
    }).filter((_, index) => mode === 'dense' || [1, 2, 5].includes(index));
    const usage = { version: 1, runtime: 'codex', attribution: 'root-agent', timeBasis: 'observed-at', coverage: 'partial', inputAccounting: 'includes-cache', from, to, bucketMs, observedSince: from, buckets,
      ...(coverageMode === 'legacy' ? {} : { cumulativeCoverage: coverageMode === 'invalid' ? { ...coverage, lastRegressionAt: 'untrusted' }
        : coverageMode === 'migrated' ? { ...coverage, initialBaseline: null } : coverage }) };
    return route.fulfill({ json: exporting ? { version: 1, usage, observations: buckets.map((bucket, index) => {
      const { samples, ...counts } = bucket.models[0];
      return { ...counts, identity: index.toString(16).padStart(64, '0'), observedAt: Math.max(from, bucket.at) };
    }) } : usage });
  });
  await page.goto(`${origin}/tests/fixtures/token-usage.html`);
  assert.equal(requests.length, 0, 'no reads before opening');
  const open = page.getByRole('button', { name: 'Native token usage', exact: true });
  await open.click();
  const panel = page.getByRole('dialog', { name: 'Native token usage', exact: true });
  const ready = () => panel.getByRole('img', { name: 'Token usage trend chart' }).waitFor();
  await ready(); assert.equal(requests.length, 1);
  const snapshotPanel = panel.getByRole('group', { name: 'Immutable local snapshot' });
  await snapshotPanel.getByRole('button', { name: 'Create snapshot', exact: true }).click();
  await snapshotPanel.getByText('Snapshot outcome unknown or unavailable. Query this request; no new creation was sent.', { exact: true }).waitFor();
  const savedRequest = await snapshotPanel.getByLabel('Snapshot request ID', { exact: true }).inputValue();
  assert.equal(snapshotPosts.length, 1); assert.equal(snapshotPosts[0].requestId, savedRequest);
  assert.equal(await snapshotPanel.getByRole('button', { name: 'Create snapshot', exact: true }).isDisabled(), true);
  await snapshotPanel.getByRole('button', { name: 'Query original snapshot', exact: true }).click();
  await snapshotPanel.getByText('Snapshot saved locally (partial coverage)', { exact: false }).waitFor();
  assert.deepEqual(snapshotQueries, [savedRequest]); assert.equal(snapshotPosts.length, 1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(await snapshotPanel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `snapshot controls fit ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  const gaps = panel.getByRole('region', { name: 'Collection gaps', exact: true });
  await gaps.getByText('Initial cumulative baseline · excluded from trends and credits', { exact: true }).waitFor();
  assert.deepEqual(await gaps.locator('dd').allTextContents(), ['900,000', '80,000']);
  assert.equal(await gaps.locator('.session-usage-gap-warning').count(), 2);
  assert.equal(await panel.locator('[data-metric=inputTokens] strong').innerText(), '1,500', 'baseline is not included in overview');
  const credit = panel.getByRole("region", { name: "Estimated credits", exact: true });
  assert.equal(await credit.locator("[data-credit-total]").innerText(), "—");
  await credit.locator("summary").first().click();
  await credit.getByLabel("Non-cached input", { exact: true }).fill("10");
  await credit.getByLabel("Output tokens", { exact: true }).fill("20");
  await credit.getByLabel("Cache read", { exact: true }).fill("1");
  await credit.getByRole("button", { name: "Apply credit rates" }).click();
  assert.equal(await credit.locator(".session-usage-credit-breakdown li").filter({ hasText: "all" }).locator("b").innerText(), "0.00258");
  assert.equal(await credit.locator("[data-credit-total]").innerText(), "—", "unknown model prevents a fabricated billing total");
  assert.equal(requests.length, 1, "tariff changes do not fetch or mutate native usage");
  await credit.getByRole('checkbox').check();
  await credit.getByLabel("Output tokens", { exact: true }).fill("-2");
  assert.equal(await credit.getByRole("button", { name: "Apply credit rates" }).isDisabled(), true);
  await credit.getByLabel("Output tokens", { exact: true }).fill("20");
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  const dateInput = credit.getByLabel('Effective from (local time)', { exact: true });
  const dateValue = async at => page.evaluate(at => {
    const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }, at);
  assert.equal(await credit.getByRole('button', { name: 'Apply credit rates' }).isDisabled(), true, 'overwriting the same date requires confirmation');
  const future = Math.ceil(requests[0].to / 60000) * 60000 + 86400000;
  await dateInput.fill(await dateValue(future));
  await credit.getByLabel('Output tokens', { exact: true }).fill('40');
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  assert.equal(await credit.locator('.session-usage-credit-breakdown li').filter({ hasText: 'all' }).locator('b').innerText(), '0.00258', 'future tariff never reprices old buckets');
  const boundary = Math.floor(requests[0].from / requests[0].bucketMs) * requests[0].bucketMs + requests[0].bucketMs + 60000;
  await dateInput.fill(await dateValue(boundary));
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  await credit.getByText('Rate change inside bucket · estimate unavailable', { exact: true }).waitFor();
  assert.equal(await credit.locator('.session-usage-credit-breakdown li').filter({ hasText: 'all' }).locator('b').innerText(), '—');
  await credit.getByText('Saved rate history', { exact: false }).click();
  assert.equal(await credit.locator('.session-usage-credit-history li').count(), 3);
  assert.equal(requests.length, 1, 'history and boundary inspection add no usage requests');
  const metrics = panel.locator('.session-usage-metric');
  assert.deepEqual(await metrics.locator('strong').allTextContents(), ['1,500', '300', '380', '—', '25.3%', '3']);
  assert.equal(await panel.locator('tbody tr').count(), 2, 'model breakdown is aggregated, not time-by-time');
  assert.equal(await panel.locator('svg polyline').count(), 4, 'two observed segments per enabled series; gaps not interpolated');
  assert.equal(await panel.getByRole('combobox', { name: 'Aggregation' }).locator('option[value="60000"]').evaluate(el => el.disabled), true);
  await panel.getByRole('combobox', { name: 'Aggregation' }).selectOption('900000'); await ready();
  await credit.locator("summary").first().click();
  assert.equal(await credit.getByLabel("Output tokens", { exact: true }).inputValue(), "40", "latest tariff persists across range reloads");
  assert.equal(await credit.locator('.session-usage-credit-history li').count(), 3, 'all dated rates survive reload');
  assert.equal(requests.at(-1).bucketMs, 900000);
  const beforeLocal = requests.length;
  await panel.getByRole('combobox', { name: 'Trend model' }).selectOption('model:all');
  assert.equal(await panel.locator('svg circle').count(), 2, 'literal model named all is not the all-model sentinel');
  assert.deepEqual(await metrics.locator('strong').allTextContents(), ['1,500', '300', '380', '—', '25.3%', '3'], 'trend filter does not relabel global overview');
  const exportButton = panel.getByRole('button', { name: 'Export observations (JSON)', exact: true });
  const downloaded = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'agentopsdeck-token-observations.json');
  const document = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(document.observations.length, 3, 'chart model filter does not silently narrow export');
  assert.equal(document.usage.coverage, 'partial');
  assert.deepEqual(exports.at(-1), requests.at(-1));
  assert.equal(requests.length, beforeLocal, 'export does not reload usage');
  for (const failure of ['413', '404', '503']) {
    exportMode = failure; await exportButton.click();
    await panel.getByText(failure === '413' ? 'Too many observations. Choose a shorter period to export; nothing was truncated.' : 'Export unavailable. Check Connector support or retry explicitly.', { exact: true }).waitFor();
  }
  assert.equal(downloads.length, 1, 'failed exports produce no download');
  exportMode = 'normal'; exportDelay = 650;
  await exportButton.click();
  await panel.getByText('Preparing token export…', { exact: true }).waitFor();
  assert.equal(await exportButton.isDisabled(), true);
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click(); await ready();
  await page.waitForTimeout(800);
  assert.equal(downloads.length, 1, 'range refresh cancels late export');
  exportDelay = 0;
  await panel.getByRole('combobox', { name: 'Trend model' }).selectOption('all');
  await panel.getByRole('button', { name: 'Cache read', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: 'Cache read', exact: true }).getAttribute('aria-pressed'), 'true');
  const scrubber = panel.getByRole('slider', { name: 'Inspect time bucket' });
  await scrubber.focus(); await page.keyboard.press('Home');
  await panel.getByText('No observations in this interval', { exact: true }).waitFor();
  await page.keyboard.press('ArrowRight');
  assert.ok((await panel.locator('.session-usage-inspection').innerText()).includes('300'));
  await page.waitForTimeout(1200); assert.equal(requests.length, beforeLocal + 1, 'only explicit refresh fetched; model, chart toggles, keyboard and idle never fetch');
  if (process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOT}-desktop.png` });
  await panel.getByRole('combobox', { name: 'Usage period' }).selectOption('30'); await ready();
  assert.equal(requests.at(-1).bucketMs, 86_400_000, 'invalid manual granularity falls back to one valid auto request');
  assert.equal(await panel.getByRole('combobox', { name: 'Aggregation' }).inputValue(), '0');
  await panel.getByRole('combobox', { name: 'Usage period' }).selectOption(String(1 / 24)); await ready();
  assert.equal(requests.at(-1).bucketMs, 60_000);
  const beforeRace = requests.length;
  delayNext = true;
  await panel.getByRole('combobox', { name: 'Usage period' }).selectOption('7');
  await page.waitForFunction(() => document.querySelector('[aria-busy=true]'));
  await panel.getByRole('combobox', { name: 'Usage period' }).selectOption('1'); await ready();
  await page.waitForTimeout(800);
  assert.equal(requests.length, beforeRace + 2);
  assert.equal(await panel.getByRole('combobox', { name: 'Usage period' }).inputValue(), '1');
  assert.equal(requests.at(-1).bucketMs, 300_000, 'late aborted range does not replace the latest data');
  assert.equal(await panel.getByRole('slider').getAttribute('max'), '288', 'rendered data is the latest 24h/5m range, not the delayed 7d range');
  for (const width of [390, 320, 240]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(120);
    await credit.locator('details').first().evaluate(el => { el.open = true; });
    await credit.locator('.session-usage-credit-history').evaluate(el => { el.open = true; });
    assert.equal(await credit.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `credit history fits ${width}px`);
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `panel fits ${width}px`);
    assert.equal(await panel.locator('.session-usage-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `only table scrolls at ${width}px`);
    assert.equal(await gaps.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `collection evidence fits ${width}px`);
    assert.ok(await panel.getByRole('combobox', { name: 'Aggregation' }).isVisible());
    if (width === 390) {
      const reads = requests.length;
      await panel.getByRole('button', { name: 'Cache write', exact: true }).tap();
      assert.equal(await panel.getByRole('button', { name: 'Cache write', exact: true }).getAttribute('aria-pressed'), 'true');
      await panel.getByRole('slider').tap();
      assert.equal(requests.length, reads, 'touch inspection is local');
      await panel.locator('.session-usage-body').evaluate(el => { el.scrollTop = 0; });
    }
    if (width === 390 && process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOT}-mobile.png` });
  }
  mode = 'empty'; await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByText('No native observations in this period. This does not mean zero usage.').waitFor();
  assert.deepEqual(await metrics.locator('strong').allTextContents(), ['—', '—', '—', '—', '—', '—']);
  mode = 'error'; await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByText('Token usage unavailable. Retry explicitly; no automatic polling.').waitFor();
  const failed = requests.length; await page.waitForTimeout(1200); assert.equal(requests.length, failed);
  mode = 'dense'; await panel.getByRole('button', { name: 'Refresh', exact: true }).click(); await ready();
  assert.ok(await panel.locator('svg circle').count() <= 1490, 'bounded chart DOM for a dense range');
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  assert.equal(await open.evaluate(el => el === document.activeElement), true, 'focus restored');
  const closed = requests.length; await page.waitForTimeout(1200); assert.equal(requests.length, closed);
  await open.click(); await ready();
  await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
  await panel.waitFor({ state: 'detached' });
  mode = 'normal';
  await page.reload(); await open.click(); await ready();
  await credit.locator('summary').first().click();
  assert.equal(await credit.locator('.session-usage-credit-history li').count(), 3, 'history survives a full page reload');
  const legacy = JSON.stringify({ version: 1, rates: [[JSON.stringify(['codex', 'all']), { inputTokens: '10', outputTokens: '20', cacheReadTokens: '1', cacheWriteTokens: '' }]] });
  await page.evaluate(raw => {
    localStorage.removeItem('agentopsdeck.usage-credit-rates.v2');
    localStorage.setItem('agentopsdeck.usage-credit-rates.v1', raw);
  }, legacy);
  await page.reload(); await open.click(); await ready();
  await credit.locator('summary').first().click();
  await credit.getByText('Saved rate history', { exact: false }).click();
  await credit.getByRole('button', { name: 'Legacy rate · before the first dated rate' }).waitFor();
  assert.equal(await credit.locator('.session-usage-credit-breakdown li').filter({ hasText: 'all' }).locator('b').innerText(), '0.00258');
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  assert.equal(await credit.locator('.session-usage-credit-history li').count(), 2);
  assert.equal(await page.evaluate(() => localStorage.getItem('agentopsdeck.usage-credit-rates.v1')), legacy, 'migration leaves old-client storage intact');
  const beforeFailure = await page.evaluate(() => localStorage.getItem('agentopsdeck.usage-credit-rates.v2'));
  await dateInput.fill(await dateValue(future));
  await page.evaluate(() => { const original = Storage.prototype.setItem; window.restoreCreditStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function () { throw new DOMException('Synthetic storage failure', 'QuotaExceededError'); }; });
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  await credit.getByText('Applied for this panel only; browser storage unavailable.', { exact: true }).waitFor();
  assert.equal(await credit.locator('.session-usage-credit-history li').count(), 3);
  assert.equal(await page.evaluate(() => localStorage.getItem('agentopsdeck.usage-credit-rates.v2')), beforeFailure, 'failed persistence does not erase saved history');
  await dateInput.fill(await dateValue(future + 60000));
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  assert.equal(await credit.locator('.session-usage-credit-history li').count(), 4, 'another failed save retains earlier panel-only tariffs');
  await page.evaluate(() => window.restoreCreditStorage());
  await dateInput.fill(await dateValue(future + 120000));
  await credit.getByRole('button', { name: 'Apply credit rates' }).click();
  await credit.getByText('Credit rates saved in this browser.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('agentopsdeck.usage-credit-rates.v2')).rates[0][1].length), 5, 'storage recovery saves all panel-only dates');
  coverageMode = 'legacy'; await panel.getByRole('button', { name: 'Refresh', exact: true }).click(); await ready();
  await gaps.getByText('Detailed collection evidence is unavailable.', { exact: false }).waitFor();
  assert.equal(await gaps.locator('dd').count(), 0);
  coverageMode = 'migrated'; await panel.getByRole('button', { name: 'Refresh', exact: true }).click(); await ready();
  await gaps.getByText('The original baseline was not preserved', { exact: false }).waitFor();
  assert.equal(await gaps.locator('dd').count(), 0);
  coverageMode = 'invalid'; await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByText('Token usage unavailable. Retry explicitly; no automatic polling.', { exact: true }).waitFor();
  assert.equal(await gaps.count(), 0, 'malformed response cannot keep stale baseline or totals visible');
  coverageMode = 'tracked'; mode = 'empty';
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await gaps.getByText('Initial cumulative baseline · excluded from trends and credits', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-metric=inputTokens] strong').innerText(), '—', 'baseline-only result is not zero usage or a total');
  for (const event of ['close', 'agentopsdeck:auth-required', 'pagehide']) {
    exportDelay = 650;
    await exportButton.click(); await panel.getByText('Preparing token export…', { exact: true }).waitFor();
    if (event === 'close') await panel.getByRole('button', { name: 'Close', exact: true }).click();
    else await page.evaluate(name => window.dispatchEvent(new Event(name)), event);
    await panel.waitFor({ state: 'hidden' }); await page.waitForTimeout(800);
    assert.equal(downloads.length, 1, `${event} cancels late download`);
    await open.click(); await gaps.getByText('Initial cumulative baseline · excluded from trends and credits', { exact: true }).waitFor();
  }
  exportDelay = 0;
  await panel.getByRole('button', { name: 'Close', exact: true }).click(); await open.click();
  await snapshotPanel.getByLabel('Snapshot request ID', { exact: true }).fill(savedRequest);
  await snapshotPanel.getByRole('button', { name: 'Query original snapshot', exact: true }).click();
  await snapshotPanel.getByText('Snapshot saved locally (partial coverage)', { exact: false }).waitFor();
  assert.equal(snapshotPosts.length, 1, 'reopened receipt lookup never creates another snapshot');
  assert.deepEqual(snapshotQueries, [savedRequest, savedRequest]);
  await page.evaluate(() => localStorage.setItem('agentopsdeck.locale', 'zh-CN'));
  await page.reload();
  await page.getByRole('button', { name: '原生 Token 用量', exact: true }).click();
  const chinese = page.getByRole('region', { name: '计量覆盖与缺口', exact: true });
  await chinese.getByText('首次累计基线 · 未计入趋势及 Credit 估算', { exact: true }).waitFor();
  for (const width of [390, 320, 240]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await chinese.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `Chinese collection evidence fits ${width}px`);
  }
  assert.equal(await chinese.locator('.session-usage-gap-warning').count(), 2);
  if (process.env.AOD_TEST_SCREENSHOT) { await page.setViewportSize({ width: 390, height: 844 }); await chinese.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOT}-coverage-zh.png` }); }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ passed: true, nativeFixtureOnly: true, overview: true, weightedCache: true, trendGaps: true, aggregation: true, modelFilter: true, keyboardTouch: true, widths: [1440, 390, 320, 240], datedTariffs: true, migration: true, storageFailure: true, requestLifecycle: true, cumulativeCoverage: ['tracked', 'legacy', 'migrated', 'invalid', 'baseline-only', 'zh-CN'], requests: requests.length }));
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
