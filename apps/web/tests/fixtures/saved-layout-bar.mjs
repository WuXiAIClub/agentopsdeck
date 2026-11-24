import assert from 'node:assert/strict';

/** Real production UI plus the caller's isolated Hub. Never sends session messages. */
export async function checkSavedLayoutBar(page, hub, keys) {
  const strip = page.getByRole('navigation', { name: 'Switch saved layout', exact: true });
  const layouts = () => JSON.parse(hub.layouts.get('default', 'saved').content);
  const storageKey = `agentopsdeck.saved-layouts.v2:${hub.identities.recoveryScope({ userId: 'default', admin: true })}`;
  const wait = async predicate => {
    const until = Date.now() + 12000;
    while (!predicate()) { if (Date.now() > until) throw Error('Layout account sync timed out'); await page.waitForTimeout(100); }
  };
  const stored = () => page.evaluate(key => {
    return JSON.parse(localStorage.getItem(key));
  }, storageKey);
  const menu = page.locator('.workspace-context-menu:popover-open');
  async function openMenu(name) {
    await strip.getByRole('button', { name, exact: true }).click({ button: 'right' });
    await menu.waitFor();
  }
  async function nameDialog(name) {
    const dialog = page.getByRole('dialog', { name: 'Layout name', exact: true });
    await dialog.getByRole('textbox').fill(name);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
  async function dismissNotice() { const notice = page.locator('.saved-layout-feedback'); if (await notice.count()) await notice.getByRole('button', { name: 'Dismiss', exact: true }).click(); }
  await page.waitForFunction(() => document.querySelector('.saved-layout-name[aria-current="true"]')?.textContent === 'Sessions');
  const checkGeometry = async () => {
    const geometry = await strip.evaluate(node => {
      const main = node.closest('main'), rail = document.querySelector('.desktop-session-rail');
      const box = node.getBoundingClientRect(), bounds = main.getBoundingClientRect();
      return { height: box.height, top: box.top - bounds.top, left: box.left - bounds.left, right: bounds.right - box.right,
        background: getComputedStyle(node).backgroundColor, sidebar: getComputedStyle(rail).backgroundColor,
        opacity: getComputedStyle(node).opacity };
    });
    assert.equal(geometry.height, 32, 'layout strip is 32px tall');
    assert.equal(geometry.top, 0); assert.equal(geometry.left, 0); assert.equal(geometry.right, 0);
    assert.equal(geometry.background, geometry.sidebar, 'same sidebar color and alpha');
    assert.equal(geometry.opacity, '1', 'strip alpha comes from the shared background, not sidebar reveal animation');
  };
  for (const width of [1500, 1100, 800]) {
    await page.setViewportSize({ width, height: 1000 }); await checkGeometry();
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  const workspaceSurface = page.locator('.session-workspace-surface');
  const beforeRestore = await workspaceSurface.boundingBox();
  await checkGeometry();
  const notice = page.locator('.workspace-layout-notice');
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await notice.waitFor();
  assert.equal(await notice.evaluate(node => getComputedStyle(node).position), 'absolute');
  assert.deepEqual(await workspaceSurface.boundingBox(), beforeRestore, 'toast never consumes workspace height');
  await page.waitForTimeout(2800);
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.waitForTimeout(4500);
  assert.equal(await notice.count(), 1, 'repeated identical restore restarts the five-second timer');
  await notice.waitFor({ state: 'detached', timeout: 1800 });
  assert.deepEqual(await workspaceSurface.boundingBox(), beforeRestore, 'auto-dismiss never shifts panes');
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await notice.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await notice.count(), 0, 'manual dismissal remains available');
  assert.equal(await strip.getByRole('button', { name: 'Update this layout', exact: true }).count(), 0);
  const initial = layouts();
  await page.evaluate(() => { window.layoutBarHosts = [...document.querySelectorAll('[data-workspace-pane]')]; });
  // Focus must not dirty the named snapshot.
  const pane = page.locator('[data-workspace-pane]').nth(1), box = await pane.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]')[1]?.dataset.active === 'true');
  assert.equal(await strip.locator('.saved-layout-dirty').count(), 0);
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Add session card', exact: true }).selectOption(keys[2]);
  await strip.getByRole('button', { name: 'Update this layout', exact: true }).waitFor();
  assert.deepEqual(layouts(), initial, 'automatic workspace changes do not overwrite named snapshots');
  await strip.getByRole('button', { name: 'Update this layout', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0, 'current update never prompts');
  await wait(() => layouts()[0].workspace.panes.length === 3);
  assert.equal(await strip.locator('.saved-layout-dirty').count(), 0);
  await page.locator('.saved-layout-feedback').getByRole('button', { name: 'Undo', exact: true }).click();
  await wait(() => layouts()[0].workspace.panes.length === 2);
  assert.equal(await page.locator('[data-workspace-pane]').count(), 3, 'undo changes the template, not the workspace');
  assert.equal(await page.evaluate(() => window.layoutBarHosts.every(node => node.isConnected)), true, 'update/undo retains controllers');
  assert.deepEqual(layouts()[1], initial[1], 'unrelated template untouched');
  await dismissNotice();
  // Restore last workspace + association on reload, without silently updating the template.
  await wait(() => JSON.parse(hub.layouts.get('default', 'current').content).workspace.panes.length === 3);
  await page.reload();
  await strip.getByRole('button', { name: 'Update this layout', exact: true }).waitFor();
  assert.equal(await strip.getByRole('button', { name: 'Sessions', exact: true }).getAttribute('aria-current'), 'true');
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 3);
  assert.equal(layouts()[0].workspace.panes.length, 2);
  // Duplicate copies the stored template, not the current dirty workspace.
  await openMenu('Sessions');
  await menu.getByRole('button', { name: 'Duplicate layout', exact: true }).click();
  await nameDialog('Copy');
  await wait(() => layouts().some(item => item.name === 'Copy'));
  assert.equal(layouts().find(item => item.name === 'Copy').workspace.panes.length, 2);
  assert.equal(await strip.getByRole('button', { name: 'Sessions', exact: true }).getAttribute('aria-current'), 'true');
  await openMenu('Copy');
  await menu.getByRole('button', { name: 'Rename', exact: true }).click();
  await nameDialog('Renamed');
  await strip.getByRole('button', { name: 'Renamed', exact: true }).waitFor();
  // Menu keyboard + collision clamping.
  await strip.getByRole('button', { name: 'Renamed', exact: true }).focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await menu.waitFor();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Delete');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Layout actions · Renamed', 'Escape returns keyboard focus');
  await openMenu('Renamed'); await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok((await stored()).some(item => item.name === 'Renamed'), 'delete requires confirmation');
  await openMenu('Renamed'); await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await wait(() => !layouts().some(item => item.name === 'Renamed'));
  await strip.getByRole('button', { name: 'Save as new layout', exact: true }).click();
  await nameDialog('New workspace');
  await wait(() => layouts().some(item => item.name === 'New workspace'));
  assert.equal(layouts().find(item => item.name === 'New workspace').workspace.panes.length, 3);
  assert.equal(await strip.getByRole('button', { name: 'New workspace', exact: true }).getAttribute('aria-current'), 'true');
  // A stale undo must not erase a concurrent same-template update.
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Add session card', exact: true }).selectOption(keys[2]);
  await strip.getByRole('button', { name: 'Update this layout', exact: true }).click();
  await wait(() => layouts()[0].workspace.panes.length === 3);
  await page.evaluate(key => {
    const rows = JSON.parse(localStorage.getItem(key)); rows[0].workspace.floating[0].x = .35;
    const oldValue = localStorage.getItem(key), newValue = JSON.stringify(rows);
    localStorage.setItem(key, newValue); window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue }));
  }, storageKey);
  await page.locator('.saved-layout-feedback').getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('alert').getByText('Layout changed elsewhere. Undo was not applied.', { exact: true }).waitFor();
  assert.equal((await stored())[0].workspace.floating[0].x, .35);
  await dismissNotice();
  // Remove selected template -> temporary; do not close any live pane.
  await strip.getByRole('button', { name: 'New workspace', exact: true }).click();
  await openMenu('New workspace'); await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await strip.getByText('Temporary layout', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-workspace-pane]').count(), 3);
  assert.equal(await strip.getByRole('button', { name: 'Update this layout', exact: true }).count(), 0);
  await wait(() => !layouts().some(item => item.name === 'New workspace'));
  const replaceTemplates = rows => page.evaluate(({ rows, key }) => {
      const oldValue = localStorage.getItem(key), newValue = JSON.stringify(rows);
      localStorage.setItem(key, newValue); window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue }));
    }, { rows, key: storageKey });
  // Full list stays one row and the top-layer menu cannot be clipped by its scroller.
  const many = Array.from({ length: 50 }, (_, i) => ({ ...initial[0], id: `layout-${i}`, name: `${i} · Long layout name for overflow` }));
  await replaceTemplates(many); await wait(() => layouts().length === 50);
  assert.equal(await strip.getByRole('button', { name: 'Save as new layout', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 1000, height: 800 });
  await openMenu(many[49].name);
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 1000);
  await checkGeometry();
  await page.keyboard.press('Escape');
  await replaceTemplates([]); await wait(() => layouts().length === 0);
  await strip.getByText('Temporary layout', { exact: true }).waitFor();
  await strip.getByRole('button', { name: 'Save as new layout', exact: true }).click();
  await nameDialog('First layout'); await wait(() => layouts().length === 1);
  assert.equal(layouts()[0].name, 'First layout', 'empty list still offers Save as new');
  const unavailable = { ...initial[0], id: 'unavailable', name: 'Unavailable', workspace: { ...initial[0].workspace,
    panes: initial[0].workspace.panes.map(pane => ({ ...pane, sessionKey: `unavailable-${pane.id}` })) } };
  await replaceTemplates([...initial, unavailable]);
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await notice.waitFor();
  await strip.getByRole('button', { name: 'Unavailable', exact: true }).click();
  await page.waitForTimeout(5200);
  assert.match(await notice.textContent(), /No sessions in this layout are currently available/, 'failure warning survives the prior success timer');
  await notice.getByRole('button', { name: 'Close', exact: true }).click();
  // Restore the isolated fixture's initial templates for its subsequent regressions.
  await strip.getByRole('button', { name: 'New blank canvas', exact: true }).click();
  await nameDialog('Blank canvas');
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 0);
  await wait(() => layouts().some(item => item.name === 'Blank canvas' && item.workspace.panes.length === 0));
  assert.equal(await strip.getByRole('button', { name: 'Blank canvas', exact: true }).getAttribute('aria-current'), 'true');
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  await strip.getByRole('button', { name: 'Blank canvas', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 0);
  assert.equal(layouts().find(item => item.name === 'Sessions').workspace.panes.length, 2, 'blank does not overwrite the existing canvas');
  await wait(() => JSON.parse(hub.layouts.get('default', 'current').content).workspace.panes.length === 0);
  await page.reload();
  await strip.getByRole('button', { name: 'Blank canvas', exact: true }).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('[data-workspace-pane]').count(), 0, 'blank canvas survives refresh without reopening the previous session');
  await replaceTemplates(initial); await page.setViewportSize({ width: 1500, height: 1000 });
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  await wait(() => layouts()[0].workspace.panes.length === 2);
  assert.equal(await strip.locator('.saved-layout-dirty').count(), 0);
  await checkGeometry();
  await openMenu('Sessions');
  await page.screenshot({ path: '/tmp/agentopsdeck-layout-bar.png' });
  await page.keyboard.press('Escape');
  console.log(JSON.stringify({ savedLayoutBar: true, blankCanvas: true, blankRefresh: true, flush32px: true, sidebarBackground: true, floatingRestore5s: true, repeatedRestoreResetsTimer: true, warningsPersist: true, noPaneShift: true, dirtyUpdateUndo: true, separateAutoRestore: true, contextMenuCRUD: true, guardedUndo: true, stableHosts: true }));
}
