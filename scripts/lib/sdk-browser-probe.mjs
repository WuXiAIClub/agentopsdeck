// Real production UI/auth/Hub routes, real isolated Connector and pinned CLIs.
// The provider is synthetic; no user's account, browser profile or live state.
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifySdkBrowser({ origin, login, playwrightModule, browserExecutable, beginStreaming }) {
  assert.ok(isAbsolute(playwrightModule) && isAbsolute(browserExecutable));
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    const response = await context.request.post(`${origin}/api/auth/login`, { data: { accessKey: login }, headers: { origin } });
    assert.equal(response.status(), 200);
    const page = await context.newPage(), errors = [], observations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      const path = new URL(response.url()).pathname;
      if (/\/sessions\/state$|\/sessions\/[^/]+\/messages$/.test(path)) {
        try { const body = await response.json(); observations.push({ path, method: response.request().method(), status: response.status(),
          cursor: body.sourceCursor, messages: body.messages, error: body.error });
          if (observations.length > 60) observations.shift(); } catch { /* navigation */ }
      }
    });
    await page.goto(origin);
    for (const runtime of ['claude-code', 'ghcp']) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('button', { name: 'New session', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Create new session' });
      await dialog.locator(`#new-session-agent option[value="${runtime}"]`).waitFor({ state: 'attached' });
      await dialog.getByLabel('Agent', { exact: true }).selectOption(runtime);
      const title = `Browser ${runtime}`;
      await dialog.getByLabel('Session name').fill(title);
      const created = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/agents/${runtime}/sessions`));
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      assert.equal((await created).status(), 201);
      await dialog.waitFor({ state: 'hidden' });
      const attach = page.getByRole('button', { name: 'Attach file', exact: true });
      await attach.waitFor();
      assert.equal(await attach.isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Compact session', exact: true }).isDisabled(), true);
      const model = page.getByRole('combobox', { name: 'Session model', exact: true }).first();
      const alternate = runtime === 'ghcp' ? 'gpt-4.1-mini' : 'claude-opus-4-6';
      await model.locator(`option[value="${alternate}"]`).waitFor({ state: 'attached' });
      await model.selectOption(alternate);
      const changed = page.waitForResponse(r => r.request().method() === 'PATCH' && /\/sessions\/[^/]+$/.test(new URL(r.url()).pathname));
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal((await changed).status(), 200);
      await page.getByLabel('More session actions', { exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Delete session…', exact: true }).isDisabled(), false);
      await page.getByRole('button', { name: 'Delete session…', exact: true }).click();
      const deletionDialog = page.getByRole('dialog', { name: 'Delete session?', exact: true });
      await deletionDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await deletionDialog.waitFor({ state: 'hidden' });
      const input = `Browser input ${runtime}`;
      const stream = beginStreaming();
      try {
        await page.locator('textarea:visible').fill(input);
        const sent = page.waitForResponse(r => r.request().method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname));
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const receipt = await sent;
        assert.equal(receipt.status(), 200, await receipt.text());
        await stream.receiving;
        await page.getByText('Isolated fixture reply.', { exact: true }).first().waitFor();
        const state = await (await context.request.get(`${origin}/api/hub/v1/sessions/state`)).json();
        const live = state.groups.flatMap(group => group.sessions).find(session => session.title === title);
        assert.equal(live?.runtime?.phase, 'running', 'Text must be visible before terminal completion');
        assert.equal(await model.inputValue(), alternate);
        // Exercise the real durable queue controls while inference is held.
        // Cancel before releasing it: no additional native turn is permitted.
        const queued = `Browser queued ${runtime}`, edited = `${queued} edited`;
        await page.locator('textarea:visible').fill(queued);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const queue = page.getByLabel('Queued message actions', { exact: true });
        await queue.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill(edited);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByText(edited, { exact: true }).waitFor();
        await queue.getByRole('button', { name: 'Cancel delivery', exact: true }).click();
        await queue.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
        await page.getByText(edited, { exact: true }).waitFor({ state: 'hidden' });
        const pending = await (await context.request.get(`${origin}/api/hub/v1/sessions/${encodeURIComponent(live.sessionKey)}/queue`)).json();
        assert.equal(pending.items.length, 0, 'Cancelled input must not reach native inference');
      }
      catch (error) {
        console.error('Synthetic browser fixture state', runtime, await page.locator('body').innerText());
        console.error('Synthetic browser fixture responses', JSON.stringify(observations));
        throw error;
      } finally { stream.finish(); }
      await page.reload();
      await page.getByText(input, { exact: true }).first().waitFor();
      await page.getByText('Isolated fixture reply.', { exact: true }).first().waitFor();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width < 768) await page.getByRole('region', { name: 'All chats', exact: true })
          .locator('button[data-session-card]').filter({ hasText: title }).click();
        await page.getByText(input, { exact: true }).first().waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${runtime} ${width}px overflow`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      // Reload can show durable text before the native worker has exited.
      // Wait for authoritative terminal state, not an arbitrary sleep.
      await page.waitForFunction(async ({ origin, title }) => {
        const state = await (await fetch(`${origin}/api/hub/v1/sessions/state`)).json();
        const session = state.groups.flatMap(group => group.sessions).find(session => session.title === title);
        return session?.runtime?.phase === 'completed';
      }, { origin, title });
      await page.getByLabel('More session actions', { exact: true }).click();
      await page.getByRole('button', { name: 'Delete session…', exact: true }).click();
      const removed = page.waitForResponse(r => r.request().method() === 'DELETE' && /\/sessions\/[^/]+$/.test(new URL(r.url()).pathname));
      await deletionDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      const deletionResponse = await removed;
      assert.equal(deletionResponse.status(), 200, await deletionResponse.text());
      await page.locator('button[data-session-card]').filter({ hasText: title }).waitFor({ state: 'hidden' });
      console.log(`Browser ${runtime}: create/model/live/queue/reload/desktop/mobile and native delete confirmation/cancel passed`);
    }
    assert.deepEqual(errors, [], 'No browser render exceptions');
  } finally { await browser.close(); }
}
