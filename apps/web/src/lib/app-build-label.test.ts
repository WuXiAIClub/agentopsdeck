import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENTOPSDECK_BUILD, AGENTOPSDECK_VERSION } from '@agentopsdeck/shared';
import { AppBuildLabel } from '../components/AppBuildLabel.js';
import { translateMessage } from './translations.js';

test('layout build label displays fixed shared release metadata with an accessible description', () => {
  const labels = { versionLabel: 'Version', buildLabel: 'Build number' };
  const before = renderToStaticMarkup(createElement(AppBuildLabel, labels));
  assert.ok(before.includes(`v${AGENTOPSDECK_VERSION}`));
  assert.ok(before.includes(`class="app-build-number">${AGENTOPSDECK_BUILD.buildNumber}</span>`));
  assert.ok(before.includes(`aria-label="Version ${AGENTOPSDECK_VERSION} · Build number ${AGENTOPSDECK_BUILD.buildNumber}"`));
  assert.equal(renderToStaticMarkup(createElement(AppBuildLabel, labels)), before);
  assert.equal(translateMessage('Build number', 'zh-CN'), '构建号');
  const chinese = renderToStaticMarkup(createElement(AppBuildLabel, { versionLabel: '版本', buildLabel: '构建号' }));
  assert.ok(chinese.includes(`aria-label="版本 ${AGENTOPSDECK_VERSION} · 构建号 ${AGENTOPSDECK_BUILD.buildNumber}"`));
});
