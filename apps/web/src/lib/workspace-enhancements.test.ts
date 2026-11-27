import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SessionSummary } from '@agentopsdeck/shared';
import { validPane, openResourcePane, emptyWorkspace } from './workspace-layout.js';
import { fileCardPaneResource } from './workspace-file-card-pane.js';
import { splitToolNameAndTarget, toolVariantFromLabel } from './tool-timeline.js';
import { parseToolDetail } from './tool-detail-format.js';
import { sessionCumulativeTokenMetrics } from './session-token-metrics.js';
import { readAntigravityQuotaFxEnabled, writeAntigravityQuotaFxEnabled } from './antigravity-quota-fx.js';

test('session-hub multi-session switcher pane validates, opens, and skips file-card binding', async () => {
  const pane = { id: 'hub-1', kind: 'session-hub' as const, resourceId: randomUUID() };
  assert.equal(validPane(pane), true);
  assert.equal(validPane({ id: 'hub-bad', kind: 'session-hub', resourceId: 'not-a-uuid' }), false);
  assert.equal(await fileCardPaneResource(pane), undefined);

  const layout = openResourcePane(emptyWorkspace(), pane, 1280, 800);
  assert.equal(layout.panes.some(p => p.kind === 'session-hub' && p.id === 'hub-1'), true);
});

test('splitToolNameAndTarget and toolVariantFromLabel classify Antigravity read/edit/git/command/subagent tools', () => {
  assert.deepEqual(splitToolNameAndTarget('read_file:App.tsx'), { name: 'read_file', target: 'App.tsx' });
  assert.deepEqual(splitToolNameAndTarget('edit_file:sdk-runtime.ts'), { name: 'edit_file', target: 'sdk-runtime.ts' });
  assert.deepEqual(splitToolNameAndTarget('commandExecution'), { name: 'commandExecution' });

  assert.equal(toolVariantFromLabel('read_file:App.tsx'), 'file');
  assert.equal(toolVariantFromLabel('edit_file:sdk-runtime.ts'), 'file');
  assert.equal(toolVariantFromLabel('write_file:new.ts'), 'file');
  assert.equal(toolVariantFromLabel('search_files'), 'file');
  assert.equal(toolVariantFromLabel('git'), 'git');
  assert.equal(toolVariantFromLabel('commandExecution'), 'exec');
  assert.equal(toolVariantFromLabel('web_fetch'), 'http');
  assert.equal(toolVariantFromLabel('spawn_agent'), 'subagent');
});

test('parseToolDetail parses Antigravity structured edit diff output into a diff block', () => {
  const raw = [
    '[tool edit_file]',
    'Tool input:',
    '```json',
    '{"path":"apps/web/src/App.tsx"}',
    '```',
    '',
    '[tool edit_file]',
    'status: completed',
    'output:',
    '--- apps/web/src/App.tsx',
    '+++ apps/web/src/App.tsx',
    '- const oldVal = 1;',
    '+ const newVal = 2;',
  ].join('\n');
  const parsed = parseToolDetail(raw);
  assert.equal(parsed.kind, 'structured');
  assert.equal(parsed.toolName, 'edit_file');
  assert.equal(parsed.status?.tone, 'success');
  assert.equal(parsed.output?.kind, 'diff');
  if (parsed.output?.kind === 'diff') {
    assert.ok(parsed.output.lines.some(line => line.kind === 'remove' && line.text.includes('oldVal')));
    assert.ok(parsed.output.lines.some(line => line.kind === 'add' && line.text.includes('newVal')));
  }
});

test('sessionCumulativeTokenMetrics reports exact Antigravity lifetime usage independently from last-turn usage', () => {
  const session: SessionSummary = {
    sessionKey: 'antigravity:s1',
    agentId: 'antigravity',
    source: 'antigravity',
    title: 'AGY',
    status: 'idle',
    inputTokens: 12000,
    outputTokens: 3400,
    totalTokens: 15400,
    nativeUsage: { scope: 'last-turn', inputTokens: 800, outputTokens: 200 },
  };
  const cumulative = sessionCumulativeTokenMetrics(session);
  assert.equal(cumulative.hasCumulative, true);
  assert.equal(cumulative.totalValue, 15400);
  assert.equal(cumulative.input, (12000).toLocaleString());
  assert.equal(cumulative.output, (3400).toLocaleString());
  assert.equal(cumulative.total, (15400).toLocaleString());
});

test('Antigravity quota flow animation preference toggles cleanly', () => {
  const store = new Map<string, string>();
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  try {
    assert.equal(readAntigravityQuotaFxEnabled(), true);
    writeAntigravityQuotaFxEnabled(false);
    assert.equal(readAntigravityQuotaFxEnabled(), false);
    writeAntigravityQuotaFxEnabled(true);
    assert.equal(readAntigravityQuotaFxEnabled(), true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test('Notebook caption integration, double-click rename, and Git status settings/refresh intervals are wired', () => {
  const baseUrl = `file://${process.cwd()}/`;
  const fileLinksSrc = readFileSync(new URL('src/components/WorkspaceFileLinks.tsx', baseUrl), 'utf8');
  assert.equal(fileLinksSrc.includes('workspace-cobound-bar--caption'), true);
  assert.equal(fileLinksSrc.includes("pane.kind === 'notebook'"), true);

  const notebookSrc = readFileSync(new URL('src/components/SessionNotebook.tsx', baseUrl), 'utf8');
  assert.equal(notebookSrc.includes('notebook-caption-title'), true);
  assert.equal(notebookSrc.includes('onDoubleClick'), true);

  const gitSrc = readFileSync(new URL('src/components/GitRepoStatusPanel.tsx', baseUrl), 'utf8');
  assert.equal(gitSrc.includes('Repository settings'), true);
  assert.equal(gitSrc.includes('GIT_REPO_AUTH_REFRESH_INTERVAL_MS = 5 * 60_000'), true);
  assert.equal(gitSrc.includes('GIT_REPO_PUBLIC_REFRESH_INTERVAL_MS = 10 * 60_000'), true);
});
