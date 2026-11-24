// Use the real responsive caption, including its single overflow level. Content
// assertions stay scoped to the original region; never force hidden tools visible.
export async function resourceCaption(region) {
  await region.waitFor();
  const caption = region.locator('xpath=ancestor::*[@data-workspace-pane][1]').locator('.session-pane-caption');
  // Let the ResizeObserver settle before choosing inline vs overflow controls.
  await caption.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const trigger = caption.getByRole('button', { name: 'Pane tools', exact: true });
  if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  return caption;
}
