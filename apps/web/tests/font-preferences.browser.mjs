import assert from 'node:assert/strict';

// Used by the isolated notebook fixture, never contacts a real Hub/Connector.
export async function verifyFontPreferences({ page, context, origin, note, width }) {
  const settingsPage = await context.newPage();
  settingsPage.setDefaultTimeout(10_000);
  await settingsPage.goto(origin);
  const openSettings = async () => {
    await settingsPage.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).click();
    await settingsPage.locator('.font-preferences').waitFor();
  };
  await openSettings();
  const settings = settingsPage.locator('.font-preferences');
  const choose = async (area, value) => {
    await settings.locator(`[data-font-preference="${area}"] label`).filter({ has: settingsPage.locator(`input[value="${value}"]`) }).click();
    await page.waitForFunction(({ area, value }) => document.documentElement.style.getPropertyValue(`--agentopsdeck-${area}-font-scale`) === String(value / 100), { area, value });
  };
  const list = (width < 700 ? settingsPage : page).locator('[data-session-card] strong').first();
  const chat = page.locator('.markdown-body').first();
  const code = chat.locator('code').first();
  const composer = page.locator(width < 700 ? '.mobile-composer-textarea' : '.desktop-composer-textarea');
  const notebook = note.locator('.notebook-rich-content');
  const heading = notebook.locator('h1');
  const font = locator => locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  const targets = { list, chat, code, composer, notebook, heading };
  const baseline = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, locator]) => [name, await font(locator)])));
  const noteRect = await note.boundingBox();
  const assertSize = async (name, ratio) => assert.ok(Math.abs(await font(targets[name]) - baseline[name] * ratio) < .03, `${width}px ${name} must scale exactly once by ${ratio}`);
  for (const area of ['sessions', 'chat', 'notebooks']) {
    for (const size of [80, 90, 100, 110]) {
      await choose(area, size);
      await assertSize('list', area === 'sessions' ? size / 100 : 1);
      for (const name of ['chat', 'code', 'composer']) await assertSize(name, area === 'chat' ? size / 100 : 1);
      const sharedBase = await page.evaluate(() => {
        const element = document.createElement('main'); element.className = 'text-sm';
        document.body.append(element); const baseline = parseFloat(getComputedStyle(element).fontSize);
        element.dataset.fontArea = 'chat'; const size = parseFloat(getComputedStyle(element).fontSize); element.remove(); return { size, baseline };
      });
      assert.ok(Math.abs(sharedBase.size - sharedBase.baseline * (area === 'chat' ? size / 100 : 1)) < .03, 'region fallback must not override existing shared-view text-sm size');
      for (const name of ['notebook', 'heading']) await assertSize(name, area === 'notebooks' ? size / 100 : 1);
      const after = await note.boundingBox();
      assert.equal(after.width, noteRect.width, 'font preferences must not resize panels');
      assert.equal(after.height, noteRect.height);
    }
    await choose(area, 100);
  }
  await choose('sessions', 80); await choose('chat', 90); await choose('notebooks', 110);
  const chatSlider = settings.locator('[data-font-preference="chat"] input[type="range"]');
  await chatSlider.focus(); await chatSlider.press('ArrowRight');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale') === '0.91');
  await settingsPage.reload(); await openSettings();
  assert.equal(await chatSlider.inputValue(), '91', 'continuous non-preset size persists');
  const sliderBox = await chatSlider.boundingBox();
  // Chromium's 16px range thumb leaves 8px of track at either end.
  await settingsPage.mouse.click(sliderBox.x + 8 + (sliderBox.width - 16) * (99 - 75) / 65, sliderBox.y + sliderBox.height / 2);
  assert.equal(await chatSlider.inputValue(), '100', 'pointer movement near a preset gently snaps');
  await settingsPage.mouse.click(sliderBox.x + 8 + (sliderBox.width - 16) * (96 - 75) / 65, sliderBox.y + sliderBox.height / 2);
  assert.equal(await chatSlider.inputValue(), '96', 'pointer can choose non-preset intermediate sizes');
  await choose('chat', 90);
  await settingsPage.screenshot({ path: `/tmp/agentopsdeck-font-preferences-${width}.png` });
  await settingsPage.reload(); await openSettings();
  for (const [area, size] of Object.entries({ sessions: 80, chat: 90, notebooks: 110 })) {
    assert.equal(await settings.locator(`input[name="font-size-${area}"][value="${size}"]`).isChecked(), true, 'refresh must retain independent settings');
  }
  // Keyboard operation and live cross-tab sync; changing UI language keeps values.
  await settings.locator('input[name="font-size-chat"][value="90"]').focus();
  await settingsPage.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale') === '1');
  await settingsPage.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await settingsPage.getByRole('region', { name: '字号', exact: true }).waitFor();
  assert.equal(await settings.locator('input[name="font-size-notebooks"][value="110"]').isChecked(), true);
  await settingsPage.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  for (const area of ['sessions', 'chat', 'notebooks']) await choose(area, 100);
  // Blocked writes: immediate in-memory operation, explicit persistence warning.
  await settingsPage.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreFontStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('agentopsdeck.font-preferences.')) throw Error('Synthetic blocked storage'); return original.call(this, key, value); };
  });
  await settings.locator('input[name="font-size-chat"][value="80"]').check({ force: true });
  await settingsPage.getByRole('status').filter({ hasText: 'Browser storage is unavailable' }).waitFor();
  assert.equal(await settingsPage.evaluate(() => document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale')), '0.8');
  await settingsPage.evaluate(() => window.restoreFontStorage());
  await choose('chat', 100);
  await settingsPage.close();
  await page.bringToFront();
  console.log(`font preferences browser ${width}: continuous scales and four snapping presets, three isolated areas, relative code/headings, geometry, refresh, keyboard, cross-tab, i18n, blocked storage passed`);
}
