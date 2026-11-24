import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionRailPreference, sessionRailWidth, navigationRailWidth, maxSessionRailWidth } from './session-rail.js';

test('rail preference accepts only versioned finite geometry and explicit booleans', () => {
  for (const raw of [null, '{', 'null', '[]', '{"version":2,"width":300}', '{"width":300}']) assert.deepEqual(parseSessionRailPreference(raw), { version: 1 });
  assert.deepEqual(parseSessionRailPreference('{"version":1,"width":"300","collapsed":"false"}'), { version: 1 });
  assert.deepEqual(parseSessionRailPreference('{"version":1,"width":327.8,"collapsed":false,"text":"discard"}'), { version: 1, width: 328, collapsed: false });
  assert.equal(parseSessionRailPreference('{"version":1,"width":1e999}').width, undefined);
  assert.equal(parseSessionRailPreference('{"version":1,"width":-1}').width, 160);
  assert.equal(parseSessionRailPreference('{"version":1,"width":50000}').width, 480);
  assert.equal(parseSessionRailPreference('{"version":1,"navigationCollapsed":true}').navigationCollapsed, true);
  assert.equal(parseSessionRailPreference('{"version":1,"navigationCollapsed":"true"}').navigationCollapsed, undefined);
});
test('rail clamps to viewport without changing stored preferred width', () => {
  const preferred = parseSessionRailPreference('{"version":1,"width":480,"collapsed":true}');
  assert.equal(sessionRailWidth(preferred.width, 800), 384);
  assert.equal(sessionRailWidth(preferred.width, 1440), 480);
  assert.equal(preferred.width, 480);
  for (const viewport of [700, 800, 1100, 1440, 1920]) {
    assert.ok(viewport - navigationRailWidth(viewport) - maxSessionRailWidth(viewport) >= 360);
    assert.ok(sessionRailWidth(-10, viewport) >= 160);
    assert.ok(sessionRailWidth(Infinity, viewport) <= maxSessionRailWidth(viewport));
  }
  assert.equal(sessionRailWidth(undefined, 1600), 290);
  assert.equal(sessionRailWidth(undefined, 1100), 201);
});
