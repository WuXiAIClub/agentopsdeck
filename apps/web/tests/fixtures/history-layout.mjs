import assert from 'node:assert/strict';

export async function checkHistoryPaneActivation({ page, pane }) {
  // A non-hovered desktop composer can be display:none. Use the real session
  // selection controls, not programmatic focus on a hidden textarea.
  await page.locator('[data-session-card="remote:one"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-session-pane="remote:one"] [data-history-layout="auto"]').length > 1400);
  const before = await pane.evaluate(el => ({ invalidations: el.__historyInvalidations ?? 0, rows: el.querySelectorAll('[data-message-search-id]').length }));
  const retained = await pane.locator('[data-message-search-id="chat-100"]').elementHandle();
  for (let i = 0; i < 6; i++) {
    await page.locator('[data-session-card="remote:two"]').click();
    await page.waitForFunction(() => document.querySelector('[data-workspace-pane][data-active="true"] [data-session-pane="remote:two"]'));
    await page.locator('[data-session-card="remote:one"]').click();
    await page.waitForFunction(() => document.querySelector('[data-workspace-pane][data-active="true"] [data-session-pane="remote:one"]'));
  }
  const after = await pane.evaluate(el => ({ invalidations: el.__historyInvalidations ?? 0, rows: el.querySelectorAll('[data-message-search-id]').length }));
  assert.equal(after.rows, before.rows);
  assert.equal(after.invalidations - before.invalidations, 0, 'real pane activation must not discard history measurements');
  assert.equal(await retained.evaluate(el => el.isConnected && !!el.querySelector('[data-history-layout="auto"]')), true, 'same historical node remains mounted and measured');
  await retained.dispose();
  console.log(JSON.stringify({ historyPaneActivation: { switches: 12, rows: after.rows, invalidations: after.invalidations - before.invalidations, retainedDOM: true } }));
}

export async function checkHistoryLayout({ page, context, pane, first, baseline, richTools = true }) {
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await first.locator('textarea').first().focus();
  await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const waitCold = async () => {
    await settle();
    if (!baseline) await page.waitForFunction(() => document.querySelectorAll('[data-session-pane="remote:one"] [data-history-layout="auto"]').length > 1400);
    else await page.waitForTimeout(1500);
  };
  await waitCold();
  const state = await pane.evaluate(el => ({ rows: el.querySelectorAll('[data-message-search-id]').length,
    deferred: el.querySelectorAll('[data-history-layout="auto"]').length, dom: el.querySelectorAll('*').length,
    richDeferred: el.querySelectorAll('[data-history-layout="auto"] .desktop-attached-tools').length,
    unsafeDeferred: el.querySelectorAll('[data-history-layout="auto"] .desktop-tool-timeline:not([data-history-tool-layout="stable"]), [data-history-layout="auto"] .desktop-tool-detail').length }));
  assert.equal(state.rows, 2000); assert.equal(state.unsafeDeferred, 0);
  if (richTools && !baseline) assert.ok(state.richDeferred > 100, 'completed closed tracks are eligible');
  else assert.equal(state.richDeferred, 0);
  if (baseline) assert.equal(state.deferred, 0);

  // Compare with full layout at exactly the same width/font/content, not a
  // fixed-height estimate. The test-only override retains all nodes and state.
  async function geometry(label) {
    await settle();
    const value = await pane.evaluate(async el => {
      const before = { height: el.scrollHeight, top: el.scrollTop };
      const rows = [...el.querySelectorAll('[data-history-layout="auto"]')];
      const saved = rows.map(row => row.style.cssText);
      rows.forEach(row => { row.style.contentVisibility = 'visible'; row.style.removeProperty('contain-intrinsic-block-size'); });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const full = { height: el.scrollHeight, top: el.scrollTop };
      rows.forEach((row, i) => { row.style.cssText = saved[i]; });
      return { before, full };
    });
    assert.ok(Math.abs(value.before.height - value.full.height) <= 2, `${label}: scroll extent ${JSON.stringify(value)}`);
    assert.ok(Math.abs(value.before.top - value.full.top) <= 2, `${label}: reading position ${JSON.stringify(value)}`);
    return value;
  }
  const initial = await geometry('initial');
  await waitCold();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const before = await metrics();
  const beforeVisits = await pane.evaluate(el => el.__historyLayoutVisits ?? 0);
  // A local layout microbenchmark, not a server/streaming latency claim.
  await pane.evaluate(async el => {
    const latest = el.querySelector('[data-message-search-id="chat-1999"] article');
    for (let i = 0; i < 40; i++) {
      latest.style.paddingBottom = `${8 + i % 2}px`;
      void el.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    latest.style.removeProperty('padding-bottom');
  });
  const after = await metrics();
  const rowVisits = await pane.evaluate(el => el.__historyLayoutVisits ?? 0) - beforeVisits;
  const performance = Object.fromEntries(['LayoutCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map(key => [key, after[key] - before[key]]));
  console.log(JSON.stringify({ layoutMicrobenchmark: { baseline, ...state, initial, performance, rowVisits } }));
  await cdp.detach();
  await geometry('after live-tail layout');

  const found = await pane.evaluate(el => {
    const row = el.querySelector('[data-message-search-id="chat-1707"]');
    window.retainedHistoryRow = row;
    return window.find('History remote:one 1707', false, false, true);
  });
  assert.equal(found, true, 'native browser find reaches old content');
  await settle();
  const selected = await page.evaluate(() => window.getSelection().toString());
  assert.match(selected, /History remote:one 1707/);
  assert.equal(await pane.evaluate(el => window.retainedHistoryRow === el.querySelector('[data-message-search-id="chat-1707"]')), true);
  assert.equal(await pane.locator('[data-history-layout="auto"]').count(), 0, 'selection protects the entire transcript');
  // Headless Chromium's window.find selects but does not scroll, even on a
  // plain overflow div without this application or the optimization. Exercise
  // reveal separately; this is not automation of the browser's native Find UI.
  await page.evaluate(() => window.getSelection().anchorNode.parentElement.scrollIntoView({ block: 'center' }));
  await settle();
  const findVisible = await pane.evaluate(el => {
    const range = window.getSelection().getRangeAt(0).getBoundingClientRect(), box = el.getBoundingClientRect();
    return { visible: range.bottom > box.top && range.top < box.bottom, range: range.toJSON(), box: box.toJSON(), scrollTop: el.scrollTop };
  });
  assert.equal(findVisible.visible, true, JSON.stringify(findVisible));
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await waitCold();
  await geometry('native find restoration');

  // Width and inherited font changes must discard old measurements.
  await page.setViewportSize({ width: 1400, height: 900 });
  await waitCold(); await geometry('narrow desktop');
  await page.evaluate(() => document.documentElement.style.setProperty('--agentopsdeck-chat-font-scale', '1.3'));
  await waitCold(); await geometry('font scale');
  await page.evaluate(() => document.documentElement.style.removeProperty('--agentopsdeck-chat-font-scale'));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await waitCold(); await geometry('restored width/font');

  // A changed OFFSCREEN subtree must never retain its previous height.
  const mutation = await pane.evaluate(el => {
    const row = el.querySelector('[data-message-search-id="chat-777"] .markdown-body p');
    window.historyMutationOriginal = row.textContent;
    const old = el.scrollHeight;
    row.textContent = 'Changed offscreen text. '.repeat(120);
    return old;
  });
  await waitCold(); await geometry('offscreen text update');
  assert.ok(await pane.evaluate(el => el.scrollHeight) > mutation + 50);
  await pane.evaluate(el => { el.querySelector('[data-message-search-id="chat-777"] .markdown-body p').textContent = window.historyMutationOriginal; });
  await waitCold();

  const copy = pane.locator('[data-message-search-id="chat-10"] button[aria-label="Copy message"]');
  await copy.focus(); await settle();
  await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await waitCold();
  assert.equal(await copy.evaluate(el => el === document.activeElement && !el.closest('[data-history-layout="auto"]')), true, 'focused offscreen action remains fully laid out');
  await first.locator('textarea').first().focus();
  await waitCold();
  console.log(JSON.stringify({ historyLayout: { baseline, ...state, initial, performance, nativeFind: true, resize: true, fontScale: true, offscreenMutation: true, focus: true } }));
}

// Exercise controller ownership independently of React and application polling.
// The entry point is exported to window ONLY by the temporary test build.
export async function checkHistoryLayoutLifecycle({ page, incremental = true, richTools = incremental }) {
  const result = await page.evaluate(async ({ incremental, richTools }) => {
    const observe = window.observeHistoryLayoutForTest;
    const check = (value, label) => { if (!value) throw new Error(label); };
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const settle = async () => { await frame(); await frame(); };
    const until = async (condition, label) => {
      const deadline = performance.now() + 8000;
      while (!condition()) {
        check(performance.now() < deadline, `Timeout: ${label}`);
        await frame();
      }
    };
    const fixtures = [], stops = [];
    const make = (desktop, left, boxSizing = 'border-box') => {
      const wrapper = document.createElement('div');
      if (desktop) wrapper.className = 'desktop-session-frame';
      wrapper.style.cssText = `position:fixed;left:${left}px;top:20px;width:300px;height:300px;z-index:99999;background:white`;
      const root = document.createElement('div');
      root.style.cssText = 'height:100%;overflow:auto';
      const rows = Array.from({ length: 300 }, (_, i) => {
        const row = document.createElement('div');
        row.className = 'desktop-message-with-tools';
        row.style.cssText = `box-sizing:${boxSizing};padding:12px;border:1px solid transparent`;
        const text = document.createElement('p'); text.textContent = `Lifecycle ${i} `.repeat(10 + i % 7);
        const action = document.createElement('button'); action.textContent = 'Copy';
        row.append(text, action); root.append(row); return row;
      });
      wrapper.append(root); document.body.append(wrapper); fixtures.push(wrapper);
      return { root, rows, wrapper };
    };
    const cold = row => row.dataset.historyLayout === 'auto';
    const count = root => root.querySelectorAll('[data-history-layout="auto"]').length;
    try {
      window.getSelection().removeAllRanges();
      const one = make(true, 10), two = make(true, 330, 'content-box'), mobile = make(false, 650);
      const rich = document.createElement('input'); one.rows[60].append(rich);
      // Existing author styles are not owned or removed by this controller.
      one.rows[61].style.contentVisibility = 'visible';
      stops.push(observe(one.root), observe(two.root), observe(mobile.root), observe(null));
      await settle();
      check(count(one.root) === 0, 'idle grace prevents immediate deferral');
      await until(() => count(one.root) > 70 && count(two.root) > 70, 'independent surfaces become idle');
      check(!cold(one.rows[0]), 'near viewport stays warm');
      check(!cold(one.rows[60]) && !cold(one.rows[61]), 'rich and author-styled rows excluded');
      check(count(mobile.root) === 0, 'mobile is untouched');

      // A cross-message selection wakes only its own transcript.
      const range = document.createRange();
      range.setStart(one.rows[20].firstChild.firstChild, 0);
      range.setEnd(one.rows[40].firstChild.firstChild, 8);
      window.getSelection().addRange(range);
      await until(() => count(one.root) === 0, 'selection wakes transcript');
      check(count(two.root) > 70, 'other surface remains deferred');
      check(window.getSelection().toString().includes('Lifecycle 30'), 'cross-row selection retained');
      window.getSelection().removeAllRanges();
      await until(() => count(one.root) > 70, 'selection release');

      one.rows[80].scrollIntoView({ block: 'center' });
      await until(() => !cold(one.rows[80]), 'scrolling back restores row');
      // Class-changing into a rich row must release its containment.
      const subtree = document.createElement('div'); subtree.textContent = 'plain'; one.rows[20].append(subtree);
      await until(() => cold(one.rows[20]), 'mutated plain subtree remeasured');
      subtree.className = 'source-inline-card';
      await until(() => !cold(one.rows[20]), 'rich subtree wakes row');
      await new Promise(resolve => setTimeout(resolve, 1300));
      check(!cold(one.rows[20]), 'rich subtree stays uncontained');

      if (incremental) {
        subtree.className = '';
        await until(() => cold(one.rows[20]), 'plain subtree becomes eligible again');
        subtree.setAttribute('role', 'dialog');
        await until(() => !cold(one.rows[20]), 'dynamic dialog role wakes row');
        await new Promise(resolve => setTimeout(resolve, 1300));
        check(!cold(one.rows[20]), 'dialog remains protected');
        subtree.removeAttribute('role');
        await until(() => cold(one.rows[20]), 'dialog removal remeasures row');
      }

      if (richTools) {
       for (const merged of [false, true]) {
        const row = one.rows[25];
        const tools = document.createElement('div'); tools.className = 'desktop-attached-tools';
        const track = merged ? tools : document.createElement('div'); track.classList.add('desktop-tool-timeline');
        track.dataset.historyToolLayout = 'stable';
        const button = document.createElement('button'); button.textContent = 'Inspect completed tool';
        track.append(button); if (!merged) tools.append(track); row.append(tools);
        await until(() => cold(row), 'closed completed tool track defers');
        const extent = one.root.scrollHeight;
        track.dataset.historyToolLayout = 'active';
        await until(() => !cold(row), 'opening/live transition wakes before reuse');
        check(Math.abs(extent - one.root.scrollHeight) <= 2, 'tool contract has exact measured height');
        await new Promise(resolve => setTimeout(resolve, 1300));
        check(!cold(row), 'active tools stay warm');
        track.dataset.historyToolLayout = 'stable';
        await until(() => cold(row), 'completed tool track remeasured');
        button.focus({ preventScroll: true });
        await until(() => !cold(row), 'focused tool action protected');
        button.blur();
        await until(() => cold(row), 'tool focus release');
        const detail = document.createElement('div'); detail.className = 'desktop-tool-detail'; detail.textContent = 'Open result';
        track.append(detail);
        await until(() => !cold(row), 'open detail protects even a stale stable marker');
        detail.remove();
        await until(() => cold(row), 'detail removal remeasures');
        tools.remove();
       }
      }

      const removed = one.rows[10]; removed.remove();
      await settle();
      check(!removed.style.contentVisibility && !removed.style.containIntrinsicBlockSize, 'removed rows release styles');
      one.root.prepend(removed);
      await until(() => cold(removed), 'reinserted node is registered');
      // Hidden surface measurements cannot become visible-width estimates.
      one.wrapper.style.display = 'none'; await settle();
      check(count(one.root) === 0, 'hidden surface releases stale measurements');
      one.wrapper.style.removeProperty('display');
      await until(() => count(one.root) > 70, 'surface restored');

      const beforeCleanup = one.root.scrollHeight;
      stops[0](); stops[0]();
      await settle();
      check(count(one.root) === 0, 'cleanup removes managed state');
      check(Math.abs(beforeCleanup - one.root.scrollHeight) <= 2,
        `cleanup preserves scroll extent: ${beforeCleanup} -> ${one.root.scrollHeight}`);
      check(one.rows[61].style.contentVisibility === 'visible', 'cleanup retains author styles');
      one.rows[70].firstChild.textContent += 'after cleanup'; one.root.scrollTop = 0;
      await new Promise(resolve => setTimeout(resolve, 1300));
      check(count(one.root) === 0 && count(two.root) > 70, 'cleanup has no delayed effects or cross-surface disposal');
      const beforeOtherCleanup = two.root.scrollHeight;
      stops[1](); await settle();
      check(Math.abs(beforeOtherCleanup - two.root.scrollHeight) <= 2,
        `content-box cleanup preserves scroll extent: ${beforeOtherCleanup} -> ${two.root.scrollHeight}`);

      // Older engines safely keep full layout rather than partially installing.
      const nativeObserver = window.IntersectionObserver;
      try {
        window.IntersectionObserver = undefined;
        const stop = observe(one.root); stop();
        check(count(one.root) === 0, 'unsupported API is a no-op');
      } finally { window.IntersectionObserver = nativeObserver; }
      return { grace: true, independentSurfaces: true, crossRowSelection: true, nearRestore: true,
        dynamicRichContent: true, dynamicRole: incremental, stableTools: richTools, mergedTools: richTools, removalReinsert: true, hiddenRestore: true, cleanup: true, mobileNoop: true, unsupportedNoop: true };
    } finally {
      window.getSelection().removeAllRanges();
      for (const stop of stops) stop();
      for (const fixture of fixtures) fixture.remove();
    }
  }, { incremental, richTools });
  console.log(JSON.stringify({ historyLayoutLifecycle: result }));
}

// Count actual controller row decisions, not wall-time alone. This independent
// surface has no polling/React updates; counters exist only in the test build.
export async function checkHistoryLayoutWork({ page, incremental }) {
  const result = await page.evaluate(async incremental => {
    const results = [];
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    for (const size of [200, 201, 2000]) {
      const wrapper = document.createElement('div');
      wrapper.className = 'desktop-session-frame';
      wrapper.style.cssText = 'position:fixed;left:10px;top:10px;width:300px;height:300px;z-index:99999';
      const root = document.createElement('div');
      root.style.cssText = 'height:100%;overflow:auto';
      const rows = Array.from({ length: size }, (_, i) => {
        const row = document.createElement('div'); row.className = 'desktop-message-with-tools';
        row.style.cssText = 'padding:12px';
        const text = document.createElement('p'); text.textContent = `Work ${i} `.repeat(20);
        const button = document.createElement('button'); button.textContent = 'Copy';
        row.append(text, button); root.append(row); return row;
      });
      wrapper.append(root); document.body.append(wrapper);
      const stop = window.observeHistoryLayoutForTest(root);
      try {
        const until = async condition => {
          const deadline = performance.now() + 8000;
          while (!condition()) {
            if (performance.now() > deadline) throw new Error('Work fixture settle timeout');
            await frame();
          }
        };
        window.getSelection().removeAllRanges();
        if (incremental && size === 200) {
          await frame(); await frame();
          await new Promise(resolve => setTimeout(resolve, 1300));
          const deferred = root.querySelectorAll('[data-history-layout="auto"]').length;
          if (deferred !== 0 || !root.__historyLayoutVisits) throw new Error('Small transcript must stay fully laid out under the active controller');
          results.push({ size, smallTranscript: true, deferred });
          continue;
        }
        await until(() => root.querySelectorAll('[data-history-layout="auto"]').length > size - 30);
        await frame(); await frame();
        let before = root.__historyLayoutVisits;
        for (let i = 0; i < 40; i++) {
          rows[0].firstChild.firstChild.data = `Streaming update ${i} `.repeat(20);
          await frame(); await frame();
        }
        const mutations = root.__historyLayoutVisits - before;
        before = root.__historyLayoutVisits;
        rows[0].lastChild.focus({ preventScroll: true });
        rows[1].lastChild.focus({ preventScroll: true });
        rows[1].lastChild.blur();
        await frame(); await frame();
        const focus = root.__historyLayoutVisits - before;
        // No dirty rows: a parent's unrelated subtree edit must cause no scan.
        before = root.__historyLayoutVisits;
        const extra = document.createElement('span'); root.append(extra); extra.remove();
        await frame(); await frame();
        const unrelated = root.__historyLayoutVisits - before;
        // A stream changing one offscreen row must not postpone a different
        // row's idle deadline. Removed pending rows must not retain a timer.
        rows[80].firstChild.firstChild.data += 'changed';
        for (let i = 0; i < 26; i++) {
          rows[81].firstChild.firstChild.data = `Still streaming ${i}`;
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        if (rows[80].dataset.historyLayout !== 'auto' || rows[81].dataset.historyLayout === 'auto')
          throw new Error('One streaming row starved an independent idle deadline');
        rows[81].remove();
        await new Promise(resolve => setTimeout(resolve, 1300));
        if (rows[81].style.contentVisibility || rows[81].style.containIntrinsicBlockSize)
          throw new Error('Detached pending row retained controller styles');
        root.append(rows[81]);
        await until(() => rows[81].dataset.historyLayout === 'auto');
        results.push({ size, mutations, focus, unrelated, deadlineFairness: true, pendingRemovalReinsert: true });
      } finally { stop(); wrapper.remove(); }
    }
    return results;
  }, incremental);
  if (incremental) for (const value of result) {
    if (value.smallTranscript) { assert.equal(value.deferred, 0); continue; }
    assert.ok(value.mutations > 0 && value.mutations <= 100, JSON.stringify(value));
    assert.ok(value.focus > 0 && value.focus <= 8, JSON.stringify(value));
    assert.equal(value.unrelated, 0, JSON.stringify(value));
  }
  console.log(JSON.stringify({ historyLayoutWork: { incremental, result } }));
}
