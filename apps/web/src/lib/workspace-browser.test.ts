import assert from 'node:assert/strict';
import test from 'node:test';
import { browserAddress, browserPoint } from './workspace-browser.js';
import { emptyWorkspace, openResourcePane, restoreWorkspace, paneSessionKey, paneKey, floatWorkspacePane } from './workspace-layout.js';
test('browser address accepts HTTPS only without credential guessing', () => {
  assert.equal(browserAddress('learn.microsoft.com'), 'https://learn.microsoft.com/');
  assert.equal(browserAddress(' https://www.bing.com/search?q=hi '), 'https://www.bing.com/search?q=hi');
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://a:b@bing.com', 'http://bing.com', 'hello world', 'https://bing.com:8080']) assert.equal(browserAddress(value), undefined);
  assert.deepEqual(browserPoint(150, 100, { left: 50, top: 50, width: 512, height: 360 }), { x: 200, y: 100 });
  assert.equal(browserPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }), undefined);
});
test('browser layout persists card identity but no URL, profile, credentials or message subscription', () => {
  const pane = { id: 'browser', kind: 'browser', resourceId: 'ebf34369-80ef-483f-aee5-800af890254f' } as const;
  const opened = openResourcePane(emptyWorkspace(), pane, 1600, 1000);
  assert.equal(opened.panes.length, 1); assert.equal(paneSessionKey(pane), undefined); assert.ok(paneKey(pane).startsWith('\u0000browser:'));
  const floated = floatWorkspacePane(opened, pane.id);
  assert.deepEqual(restoreWorkspace(floated, new Set()), floated);
  const dirty = { ...floated, panes: [{ ...pane, url: 'https://secret.example/', cookies: ['private'] }] };
  assert.deepEqual(restoreWorkspace(dirty, new Set())?.panes, [pane]);
});
