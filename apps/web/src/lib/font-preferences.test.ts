import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultFontPreferences, fontPreferenceKey, fontScales, fontScaleMinimum, parseFontPreferences, snapFontScale } from './font-preferences.js';
import { scaledFontSize } from './font-scale-css.js';

test('font preferences default safely and validate each independent area', () => {
  for (const raw of [null, '{', 'null', '[]', '{}', '{"version":2,"chat":80}']) assert.deepEqual(parseFontPreferences(raw), defaultFontPreferences());
  assert.deepEqual(parseFontPreferences('{"version":1,"sessions":80,"chat":90,"notebooks":110,"sessionKey":"ignored"}'), { version: 1, sessions: 80, chat: 90, notebooks: 110 });
  assert.deepEqual(parseFontPreferences('{"version":1,"sessions":"80","chat":99,"notebooks":null}'), { ...defaultFontPreferences(), chat: 99 });
  for (const chat of [69, 141, 99.5, '100', null]) assert.equal(parseFontPreferences(JSON.stringify({ version: 1, chat })).chat, 100);
  for (const [raw, expected] of [[79, 80], [81, 80], [83, 83], [99, 100], [102, 102], [150, 140], [60, 70]]) assert.equal(snapFontScale(raw!), expected);
  for (const scale of fontScales) assert.equal(parseFontPreferences(JSON.stringify({ version: 1, chat: scale })).chat, scale);
  assert.notEqual(fontPreferenceKey('alice'), fontPreferenceKey('bob'));
  assert.equal(fontPreferenceKey(''), undefined);
});
test('typography scales absolute CSS and Tailwind without double-scaling relative text', () => {
  for (const size of ['13px', '.8rem', 'clamp(1rem, 2vw, 2rem)', 'var(--text-sm)', 'var(--text-sm, .875rem)']) {
    const result = scaledFontSize(size);
    assert.equal(result, `calc(${size} * var(--agentopsdeck-font-scale, 1))`);
    assert.equal(scaledFontSize(result), result);
  }
  for (const size of ['inherit', 'unset', 'revert', '1.5em', '.9em', '100%', '0']) assert.equal(scaledFontSize(size), size);
});
test('area minima survive persisted settings and pointer snapping', () => {
  for (const area of ['sessions', 'chat', 'notebooks'] as const) {
    const min = area === 'notebooks' ? 70 : 75;
    assert.equal(fontScaleMinimum(area), min);
    assert.equal(snapFontScale(0, area), min);
    assert.equal(snapFontScale(min, area), min);
    assert.equal(parseFontPreferences(JSON.stringify({ version: 1, [area]: 70 }))[area], min);
    assert.equal(parseFontPreferences(JSON.stringify({ version: 1, [area]: min }))[area], min);
    assert.equal(parseFontPreferences(JSON.stringify({ version: 1, [area]: 74 }))[area], Math.max(min, 74));
  }
});
