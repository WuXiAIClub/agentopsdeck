// Built application; synthetic HTTP only, no native Agent or business messages.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const sessionKey = 'local:Y29kZXg6dGhyZWFk', scope = 'a'.repeat(64), errors = [], writes = [], receipts = new Map();
    const receiptReads = [], unavailableReceipts = new Set();
    let goal = null, generation = 1, mode = 'normal', reads = 0;
    const revision = () => generation.toString(16).padStart(64, '0');
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      if (req.method() === 'PATCH') {
        assert.equal(url.pathname, `/api/sessions/${encodeURIComponent(sessionKey)}`);
        const body = req.postDataJSON(); assert.deepEqual(Object.keys(body), ['goal']);
        const input = body.goal, key = req.headers()['idempotency-key'];
        assert.equal(req.headers()['x-agentopsdeck-recovery-scope'], scope);
        writes.push(input); assert.ok(!receipts.has(key));
        const rejected = input.expectedRevision !== revision();
        if (!rejected) {
          if (input.action === 'clear') goal = null;
          else goal = { status: 'active', objective: '', objectiveTruncated: false, tokenBudget: 0,
            tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1, ...goal,
            ...(input.objective !== undefined ? { objective: input.objective } : {}),
            ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
            ...(input.action === 'pause' ? { status: 'paused' } : ['create', 'resume'].includes(input.action) ? { status: 'active' } : {}) };
          generation++;
        }
        const command = { id: key, key, state: rejected ? 'rejected' : 'accepted', createdAt: 1, updatedAt: 2,
          result: { status: rejected ? 409 : 200, body: rejected ? { error: 'stale' } : { sessionKey, settings: { goalControl: input.action } } } };
        receipts.set(key, command);
        return mode === 'unknown' ? json({}, 202) : json({ ...command.result.body, command }, command.result.status);
      }
      if (req.method() !== 'GET') { errors.push(`unexpected ${req.method()}`); return route.abort(); }
      if (url.pathname.endsWith('/goal')) { reads++; return ['unavailable', 'read-failure'].includes(mode) ? json({}, 409) : json({ revision: revision(), goal }); }
      if (url.pathname.includes('/settings-commands/')) {
        const key = decodeURIComponent(url.pathname.split('/').at(-1));
        receiptReads.push(key);
        const command = receipts.get(key); assert.ok(command);
        return mode === 'unknown' || unavailableReceipts.has(key) ? json({}, 503) : json({ command });
      }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: String(generation), groups: [{ agentId: 'codex', sessions: [{ sessionKey,
        envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Goal control fixture', status: 'idle', hasActiveRun: false,
        codexGoal: goal, runtime: { turnId: 't', phase: 'completed', sync: 'current', connection: 'connected', threadActivity: 'idle', lastEventAt: 20 } }] }] });
      if (url.pathname.endsWith('/messages')) return json({ revision: '1', totalCount: 1, hiddenCount: 0, messages: [
        { id: 'reply', sessionKey, role: 'assistant', status: 'sent', phase: 'final_answer', turnId: 't', text: 'Scoped reply', createdAt: 19 }] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return json({}, 404);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.getByText('Scoped reply', { exact: true }).waitFor();
    const dialog = page.getByRole('dialog', { name: 'Manage Codex Goal' });
    const open = async () => {
      const button = page.getByRole('button', { name: 'Manage Codex Goal', exact: true });
      if (!await button.isVisible()) await page.getByRole('button', { name: /More session actions/ }).click();
      await button.click(); await dialog.waitFor();
    };
    const confirm = () => dialog.getByRole('checkbox').check();
    const accepted = () => dialog.getByText('Goal command acknowledged. Current state is read separately.', { exact: true }).waitFor();
    await open(); await dialog.getByText('No native Goal is set.', { exact: true }).waitFor();
    await dialog.getByLabel('Goal objective', { exact: true }).fill('Private synthetic objective');
    const budget = dialog.getByLabel('Goal token budget', { exact: true });
    await budget.fill('-1'); await confirm();
    assert.equal(await dialog.getByRole('button', { name: 'Create Goal', exact: true }).isEnabled(), false);
    await budget.fill('0'); assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
    await confirm();
    assert.equal(await dialog.getByRole('button', { name: 'Create Goal', exact: true }).isEnabled(), false, 'native rejects zero-budget writes');
    assert.equal(writes.length, 0);
    await budget.fill('1'); await confirm();
    // Both events enter the same render, before React can disable the button.
    await dialog.getByRole('button', { name: 'Create Goal', exact: true }).evaluate(button => { button.click(); button.click(); });
    await accepted();
    assert.equal(writes.length, 1); assert.equal(writes[0].tokenBudget, 1);
    await confirm(); await dialog.getByRole('button', { name: 'Pause Goal', exact: true }).click(); await accepted();
    await budget.fill('50');
    await dialog.getByText('Unsaved objective or budget edits apply only with Save Goal changes. Pause, Resume and Clear use the current native Goal.', { exact: true }).waitFor();
    await confirm(); await dialog.getByRole('button', { name: 'Save Goal changes', exact: true }).click(); await accepted();
    assert.equal(goal.status, 'paused'); assert.deepEqual(Object.keys(writes.at(-1)).sort(), ['action', 'expectedRevision', 'tokenBudget']);
    await confirm(); await dialog.getByRole('button', { name: 'Resume Goal', exact: true }).click(); await accepted();
    assert.equal(goal.status, 'active');
    // A stale preflight becomes a known rejection, never an implicit retry.
    generation++; await confirm(); await dialog.getByRole('button', { name: 'Pause Goal', exact: true }).click();
    await dialog.getByText('Goal change rejected. Reload the current goal before a new change.', { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('Goal objective', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Reload current Goal', exact: true }).click();
    await dialog.getByLabel('Goal objective', { exact: true }).waitFor();
    mode = 'unknown'; await confirm(); await dialog.getByRole('button', { name: 'Pause Goal', exact: true }).click();
    await dialog.getByText('Goal change unconfirmed. Check the original receipt; do not repeat the change.', { exact: true }).waitFor();
    const count = writes.length;
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await open();
    await dialog.getByText('An unresolved settings change or deletion blocks new Goal changes.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Resume Goal', exact: true }).isEnabled(), false);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('Private synthetic objective')), false);
    mode = 'normal'; await dialog.getByRole('button', { name: 'Check original settings receipt', exact: true }).click();
    await dialog.getByRole('checkbox').waitFor();
    assert.equal(writes.length, count, 'receipt recovery is GET-only');
    const savedRows = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1') ?? '[]'));
    const checkReceipt = () => dialog.getByRole('button', { name: 'Check original settings receipt', exact: true }).click();
    const unknownNotice = 'Goal change unconfirmed. Check the original receipt; do not repeat the change.';
    // An audited release changes only the start fence, never the original
    // outcome or identity. Its unavailable GET must not strand a newer change.
    mode = 'unknown'; await confirm(); await dialog.getByRole('button', { name: 'Resume Goal', exact: true }).click();
    await dialog.getByText(unknownNotice, { exact: true }).waitFor();
    const releasedKey = [...receipts.keys()].at(-1);
    const originalReleasedRow = (await savedRows()).find(row => row.key === releasedKey);
    assert.equal(originalReleasedRow.state, 'outcome_unknown');
    receipts.set(releasedKey, { id: releasedKey, key: releasedKey, state: 'outcome_unknown',
      createdAt: 1, updatedAt: 2, settingsStartReleased: true });
    mode = 'normal'; const beforeRelease = writes.length; await checkReceipt();
    await dialog.getByText('Original outcome remains unknown; starts were released by an audited recovery. Reload before a new change.', { exact: true }).waitFor();
    assert.deepEqual((await savedRows()).find(row => row.key === releasedKey), { ...originalReleasedRow, settingsStartReleased: true });
    assert.equal(writes.length, beforeRelease, 'audited release recovery never replays PATCH');
    unavailableReceipts.add(releasedKey);
    await dialog.getByRole('button', { name: 'Reload current Goal', exact: true }).click();
    mode = 'unknown'; await confirm(); await dialog.getByRole('button', { name: 'Pause Goal', exact: true }).click();
    await dialog.getByText(unknownNotice, { exact: true }).waitFor();
    const newerKey = [...receipts.keys()].at(-1), beforeNewRecovery = writes.length, readOffset = receiptReads.length;
    assert.notEqual(newerKey, releasedKey, 'new explicit intent has a fresh identity');
    mode = 'normal'; await checkReceipt(); await accepted();
    assert.ok(receiptReads.slice(readOffset).includes(newerKey), 'manual recovery reads the newer original receipt');
    assert.equal(receiptReads.slice(readOffset).includes(releasedKey), false, 'released history is excluded from recovery');
    assert.equal((await savedRows()).find(row => row.key === newerKey)?.state, 'accepted');
    assert.deepEqual((await savedRows()).find(row => row.key === releasedKey), { ...originalReleasedRow, settingsStartReleased: true });
    assert.equal(writes.length, beforeNewRecovery, 'new receipt recovery is GET-only');
    // Older journals/imported tabs can contain several unresolved receipts.
    // One failed/unknown GET must neither hide nor prevent checking another ACK.
    for (const failure of ['unavailable', 'pending']) {
      const unresolvedKey = `settings.audit-${failure}`, acceptedKey = `settings.audit-accepted-${failure}`;
      receipts.set(unresolvedKey, { id: unresolvedKey, key: unresolvedKey, state: 'outcome_unknown', createdAt: 1, updatedAt: 2 });
      const ack = key => ({ id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
        result: { status: 200, body: { sessionKey, settings: { goalControl: 'pause' } } } });
      receipts.set(acceptedKey, ack(acceptedKey));
      if (failure === 'unavailable') unavailableReceipts.add(unresolvedKey);
      await page.evaluate(({ template, keys }) => {
        const key = 'agentopsdeck.command-recovery.v1', rows = JSON.parse(sessionStorage.getItem(key) ?? '[]');
        rows.push(...keys.map(key => ({ ...template, key })));
        sessionStorage.setItem(key, JSON.stringify(rows));
        window.dispatchEvent(new Event('agentopsdeck:commands-changed'));
      }, { template: originalReleasedRow, keys: [unresolvedKey, acceptedKey] });
      const before = writes.length, offset = receiptReads.length;
      await checkReceipt();
      await dialog.getByText(unknownNotice, { exact: true }).waitFor();
      assert.ok(receiptReads.slice(offset).includes(acceptedKey), 'a failed receipt does not starve the other original receipts');
      assert.equal((await savedRows()).find(row => row.key === acceptedKey)?.state, 'accepted');
      assert.equal((await savedRows()).find(row => row.key === unresolvedKey)?.state, 'outcome_unknown');
      unavailableReceipts.delete(unresolvedKey); receipts.set(unresolvedKey, ack(unresolvedKey));
      await checkReceipt(); await accepted();
      assert.equal(writes.length, before, 'batch recovery never replays an intent');
    }
    // A confirmed ACK survives failure to save that observation locally.
    // Retain the durable unknown row, warn separately, and never resend it.
    mode = 'unknown'; await confirm(); await dialog.getByRole('button', { name: 'Resume Goal', exact: true }).click();
    await dialog.getByText(unknownNotice, { exact: true }).waitFor();
    const storageFailureKey = [...receipts.keys()].at(-1), beforeStorageRecovery = writes.length;
    const storageFailureRow = (await savedRows()).find(row => row.key === storageFailureKey);
    assert.equal(storageFailureRow.state, 'outcome_unknown');
    await page.evaluate(() => {
      window.goalTestOriginalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === sessionStorage && key === 'agentopsdeck.command-recovery.v1') throw new DOMException('Synthetic journal failure', 'QuotaExceededError');
        return window.goalTestOriginalSetItem.call(this, key, value);
      };
    });
    try {
      mode = 'normal'; await checkReceipt(); await accepted();
      await dialog.getByText('Receipt checked, but browser recovery storage could not be updated. Nothing was resent; check again before refreshing.', { exact: true }).waitFor();
      assert.equal(await dialog.getByText(unknownNotice, { exact: true }).count(), 0, 'storage failure must not downgrade a confirmed ACK');
      assert.deepEqual((await savedRows()).find(row => row.key === storageFailureKey), storageFailureRow);
      assert.equal(writes.length, beforeStorageRecovery, 'storage failure never triggers PATCH replay');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const recovery = page.getByRole('region', { name: 'Command delivery recovery', exact: true });
      const recoveryRow = recovery.locator(`span[title="${storageFailureKey}"]`).locator('..');
      while (!await recoveryRow.count()) await recovery.getByRole('button', { name: 'Next', exact: true }).click();
      await recoveryRow.getByRole('button', { name: 'Check receipt', exact: true }).click();
      await recoveryRow.getByText('Server confirmed acceptance, but browser recovery storage could not be updated. Nothing was resent.', { exact: true }).waitFor();
      assert.match(await recoveryRow.innerText(), /Accepted — execution may still be queued or running\./);
      assert.doesNotMatch(await recoveryRow.innerText(), /outcome unknown|Delivery unknown/);
      assert.equal(await recoveryRow.getByRole('button', { name: 'Dismiss', exact: true }).count(), 0, 'presentation does not enable forgetting an unresolved settings fence');
      assert.deepEqual((await savedRows()).find(row => row.key === storageFailureKey), storageFailureRow);
      assert.equal(writes.length, beforeStorageRecovery, 'global receipt recovery is also GET-only');
      await open();
      await dialog.getByText('An unresolved settings change or deletion blocks new Goal changes.', { exact: true }).waitFor();
    } finally {
      await page.evaluate(() => { Storage.prototype.setItem = window.goalTestOriginalSetItem; delete window.goalTestOriginalSetItem; });
    }
    await checkReceipt(); await accepted();
    await page.waitForFunction(key => JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1') ?? '[]')
      .some(row => row.key === key && row.state === 'accepted'), storageFailureKey);
    assert.equal((await savedRows()).find(row => row.key === storageFailureKey)?.state, 'accepted');
    assert.equal(writes.length, beforeStorageRecovery, 'retrying receipt persistence remains GET-only');
    // Native objectives may exceed the editable preview. Editing the budget
    // alone must not send the blank replacement or overwrite the full text.
    goal = { ...goal, objective: 'Native preview '.repeat(100), objectiveTruncated: true }; generation++;
    await dialog.getByRole('button', { name: 'Reload current Goal', exact: true }).click();
    await dialog.getByText('The current objective is a preview. Leave the replacement blank to preserve the full objective.', { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('Goal objective', { exact: true }).inputValue(), '');
    await budget.fill('75'); await confirm();
    await dialog.getByRole('button', { name: 'Save Goal changes', exact: true }).click(); await accepted();
    assert.deepEqual(Object.keys(writes.at(-1)).sort(), ['action', 'expectedRevision', 'tokenBudget']);
    assert.equal(goal.objectiveTruncated, true); assert.equal(goal.tokenBudget, 75);
    mode = 'read-failure'; await confirm();
    await dialog.getByRole('button', { name: 'Clear Goal', exact: true }).click(); await accepted();
    const unavailable = 'Current Goal state is unavailable. Reload explicitly; reading does not submit a change.';
    await dialog.getByText(unavailable, { exact: true }).waitFor();
    const afterClear = writes.length;
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    mode = 'normal'; await dialog.getByRole('button', { name: 'Reload current Goal', exact: true }).click();
    await dialog.getByText('No native Goal is set.', { exact: true }).waitFor();
    assert.equal(writes.length, afterClear, 'acknowledged write is never repeated after a failed observation');
    const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    mode = 'unavailable'; await open();
    await dialog.getByText(unavailable, { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []); console.log(`Goal controls ${width}: PASS ${writes.length} explicit writes, ${reads} observations`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
