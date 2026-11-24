import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionTone } from './session-tone.js';

test('custom colors are constrained and keep white labels readable', () => {
  for (const color of ['#ffffff', '#000000', '#ffff00', '#bbffaa', '#123456']) {
    const rgb = sessionTone('key', color).accent.match(/\d+/g)!.map(Number);
    const linear = rgb.map(c => c / 255 <= .04045 ? c / 255 / 12.92 : ((c / 255 + .055) / 1.055) ** 2.4);
    assert.ok(1.05 / (linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722 + .05) >= 7);
  }
  assert.deepEqual(sessionTone('key', 'red;display:none'), sessionTone('key'));
});

test('session tones use full identity, not a shared agent or local thread suffix', () => {
  const keys = ['local:codex:thread-1', 'local:codex:thread-2', 'local:codex:thread-3', 'remote:codex:thread-1'];
  const tones = keys.map(key => sessionTone(key).accent);
  assert.equal(new Set(tones).size, keys.length);
  assert.deepEqual([...keys].reverse().map(key => sessionTone(key).accent).reverse(), tones);
  assert.deepEqual(sessionTone(keys[0]!), sessionTone(keys[0]!));
});

test('all generated hues keep white selected-card text readable', () => {
  const luminance = (rgb: number[]) => rgb.map(c => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
  const hues = new Set<string>();
  for (let n = 0; n < 10000; n++) {
    const tone = sessionTone(`connector:codex:thread-${n}`);
    hues.add(tone.soft.split(' ')[0]!);
    const rgb = tone.accent.match(/\d+/g)!.map(Number);
    assert.ok(1.05 / (luminance(rgb) + 0.05) >= 7, tone.accent);
    // The quietest selected-card metadata uses 82% white on the accent.
    const muted = rgb.map(c => 255 * 0.82 + c * 0.18);
    assert.ok((luminance(muted) + 0.05) / (luminance(rgb) + 0.05) >= 4.5, tone.accent);
    const badgeBackground = rgb.map(c => 255 * 0.15 + c * 0.85);
    assert.ok(1.05 / (luminance(badgeBackground) + 0.05) >= 4.5, tone.accent);
  }
  assert.equal(hues.size, 360);
});

test('Unicode and unusual keys remain deterministic CSS values', () => {
  for (const key of ['', '环境:会话-🦀', 'node:thread\";color:red', 'a'.repeat(4096)]) {
    assert.match(sessionTone(key).accent, /^rgb\(\d+, \d+, \d+\)$/);
    assert.deepEqual(sessionTone(key), sessionTone(key));
  }
});
