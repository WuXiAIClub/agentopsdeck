import assert from 'node:assert/strict';

// Check the actual rendered foreground and nearest opaque surface, not CSS literals.
export async function assertPreviewContrast(locator) {
  const samples = await locator.evaluateAll(elements => elements.map(el => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    let surface = el;
    while (surface && (rgba(getComputedStyle(surface).backgroundColor)[3] ?? 1) === 0) surface = surface.parentElement;
    const background = surface ? rgba(getComputedStyle(surface).backgroundColor) : [255, 255, 255, 1];
    return { text: el.textContent.slice(0, 50), foreground: rgba(getComputedStyle(el).color), background };
  }));
  assert.ok(samples.length, 'contrast check must cover rendered text');
  const luminance = rgb => rgb.slice(0, 3).map(value => {
    const s = value / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  for (const sample of samples) {
    assert.equal(sample.background[3] ?? 1, 1, 'preview surface must be opaque');
    assert.equal(sample.foreground[3] ?? 1, 1, 'preview text must be opaque');
    const a = luminance(sample.foreground), b = luminance(sample.background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(ratio >= 4.5, `${sample.text}: contrast ${ratio.toFixed(2)} must be at least 4.5`);
  }
}
