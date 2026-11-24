import assert from 'node:assert/strict';

/** Called on a running, unselected pane in the built application. */
export async function verifyRunningBorder(page, pane) {
  const trail = pane.locator('.session-running-trail');
  const read = () => trail.evaluate(node => {
    const css = getComputedStyle(node);
    return { offset: css.strokeDashoffset, animation: css.animationName, duration: css.animationDuration, pointer: css.pointerEvents };
  });
  const first = await read();
  await page.waitForTimeout(180);
  const second = await read();
  assert.equal(first.animation, 'session-running-border');
  assert.equal(first.duration, '2.8s');
  assert.equal(first.pointer, 'none');
  assert.notEqual(first.offset, second.offset, 'native stroke advances without a JS animation loop');
  const style = await pane.getAttribute('style');
  for (const width of [320, 390, 900]) {
    await pane.evaluate((node, width) => { node.style.width = `${width}px`; node.style.height = '600px'; node.style.left = '0px'; node.style.zIndex = '100'; }, width);
    const box = await pane.boundingBox();
    const rect = await trail.evaluate(node => node.getBoundingClientRect().toJSON());
    assert.ok(Math.abs(rect.width - (box.width - 4)) < 1 && Math.abs(rect.height - (box.height - 4)) < 1, `runner follows the actual rectangular pane: ${JSON.stringify({ rect, box })}`);
    const shots = [];
    for (const time of [0, 700]) {
      await pane.evaluate((node, time) => {
        for (const animation of node.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = animation.animationName === 'session-running-border' ? time : 0; }
      }, time);
      // A bitmap assertion catches invisible/occluded SVGs that a computed-style test misses.
      shots.push((await page.screenshot({ clip: box })).toString('base64'));
    }
    const changed = await page.evaluate(async shots => {
      const images = await Promise.all(shots.map(async data => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, image.width, image.height);
      }));
      const [a, b] = images; let edge = 0, center = 0;
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        if (Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i + c] - b.data[i + c]))) < 30) continue;
        if (x < 5 || x >= a.width - 5 || y < 5 || y >= a.height - 5) edge++;
        else if (x > 24 && x < a.width - 24 && y > 24 && y < a.height - 24) center++;
      }
      return { edge, center };
    }, shots);
    assert.ok(changed.edge > 80, `${width}px visible perimeter pixels move: ${JSON.stringify(changed)}`);
    assert.equal(changed.center, 0, 'runner never paints over content');
    console.log(`PASS running border ${width}px: ${changed.edge} changed perimeter pixels; content unchanged`);
  }
  await pane.evaluate((node, style) => { node.setAttribute('style', style); for (const animation of node.getAnimations({ subtree: true })) animation.play(); }, style);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await read()).animation, 'none');
  assert.equal(await trail.evaluate(node => getComputedStyle(node).strokeDasharray), 'none', 'reduced motion retains a static full border');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal((await read()).animation, 'session-running-border');
}
