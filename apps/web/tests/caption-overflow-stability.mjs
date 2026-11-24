import assert from 'node:assert/strict';

// Visibility alone misses the regression where opening More moves every icon
// into its popup. Check actual geometry and the original DOM identities.
export async function assertOverflowStable(caption, trigger) {
  await caption.evaluate(el => {
    const items = parent => [...parent.children].flatMap(child =>
      child.matches('.caption-popover') ? [] : child.matches('.session-pane-status-actions, .session-pane-custom-actions, .resource-card-tools') ? items(child) : [child]);
    el.__overflowBefore = items(el.querySelector('.caption-overflow-content')).map(element => ({
      element, hidden: element.hasAttribute('data-caption-hidden'), rect: element.getBoundingClientRect().toJSON(),
    }));
    el.__triggerBefore = el.querySelector('.caption-overflow > button').getBoundingClientRect().toJSON();
    el.__layoutTrace = [];
    el.__layoutListener ??= event => {
      el.__layoutTrace.push({ state: event.newState, rects: [el, ...el.children].map(child => child.getBoundingClientRect().toJSON()) });
    };
    el.querySelector('.caption-overflow-content').removeEventListener('beforetoggle', el.__layoutListener);
    el.querySelector('.caption-overflow-content').addEventListener('beforetoggle', el.__layoutListener);
  });
  await trigger.click();
  await caption.page().waitForTimeout(100);
  const check = async open => {
    const failures = await caption.evaluate((el, open) => {
      const failures = [], popup = el.querySelector('.caption-overflow-content').getBoundingClientRect();
      if (el.querySelector('.caption-overflow-content').matches(':popover-open') !== open) failures.push('wrong popup state');
      const same = (actual, expected) => ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key] - expected[key]) <= 1);
      for (const { element, hidden, rect } of el.__overflowBefore) {
        const current = element.getBoundingClientRect();
        if (!element.isConnected) failures.push('controller detached');
        if (element.hasAttribute('data-caption-hidden') !== hidden) failures.push('selection changed');
        if (!hidden && !same(current, rect)) failures.push(`inline moved: ${element.getAttribute('aria-label') ?? element.textContent}: ${JSON.stringify({ before: rect, after: current.toJSON() })}`);
        if (open && !hidden && current.width > 0 && current.height > 0) {
          const hit = document.elementFromPoint(current.x + current.width / 2, current.y + current.height / 2);
          if (!element.contains(hit)) failures.push('inline control not clickable at original position');
        }
        if (open && hidden && (current.left < popup.left || current.right > popup.right || current.top < popup.top || current.bottom > popup.bottom)) failures.push('overflow outside popup');
        if (!open && hidden && !element.inert) failures.push('closed overflow not inert');
      }
      if (!same(el.querySelector('.caption-overflow > button').getBoundingClientRect(), el.__triggerBefore)) failures.push('More trigger moved');
      return failures;
    }, open);
    if (failures.length) console.error('Overflow layout trace', JSON.stringify(await caption.evaluate(el => el.__layoutTrace)));
    assert.deepEqual(failures, [], `More ${open ? 'open' : 'closed'} keeps inline controls in place`);
  };
  await check(true);
  await trigger.click();
  await caption.page().waitForTimeout(100);
  await check(false);
}
