import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistorySyncIssue } from '../components/HistorySyncIssue.js';
import { translateMessage, type TranslationKey } from './translations.js';

const explanation = 'This history warning alone does not mean the Goal or live updates have stopped.';
function render(label: TranslationKey, detail?: string) {
  let retries = 0;
  const html = renderToStaticMarkup(createElement(HistorySyncIssue, { label, detail,
    onRetry: async () => { retries++; } }));
  assert.equal(retries, 0, 'rendering a warning must not trigger synchronization or send messages');
  return html;
}

test('historical verification warning explains its scope without asserting fresh execution', () => {
  const html = render('History sync interrupted', 'Final turn snapshot is incomplete');
  assert.ok(html.includes(explanation));
  assert.ok(html.includes('Final turn snapshot is incomplete'));
  assert.ok(html.includes('Existing messages are kept. Retrying sync does not resend messages.'));
  assert.ok(html.includes('>Retry</button>'));
  assert.equal(html.includes('Goal is running'), false);
  assert.equal(html.includes('Live updates are connected'), false);
});

test('protection, disconnection and read failures are not misclassified as historical warnings', () => {
  for (const label of ['Execution status unconfirmed', 'Connector disconnected',
    'Latest messages unavailable', 'Latest messages temporarily unavailable', 'Older messages unavailable'] as const) {
    const html = render(label, 'diagnostic detail');
    assert.equal(html.includes(explanation), false, label);
    assert.ok(html.includes('diagnostic detail'));
  }
});

test('historical warning details remain escaped and the scope explanation is translated', () => {
  const html = render('History sync interrupted', '<script>not executable</script>');
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;not executable&lt;/script&gt;'));
  assert.equal(translateMessage(explanation, 'zh-CN'),
    '此历史核验告警本身不表示 Goal 或实时消息已停止。');
});
