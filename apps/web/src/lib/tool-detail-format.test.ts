import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolDetail, unwrapJsonPayload } from './tool-detail-format.js';

test('preserves plain unstructured strings and empty strings verbatim', () => {
  assert.deepEqual(parseToolDetail(''), { kind: 'plain', text: '' });
  assert.deepEqual(parseToolDetail('local:alpha exact full detail'), {
    kind: 'plain',
    text: 'local:alpha exact full detail',
  });
  const longPlain = `First line\nSecond line\n${'unbroken'.repeat(40)}`;
  assert.deepEqual(parseToolDetail(longPlain), { kind: 'plain', text: longPlain });
});

test('unwraps double-encoded wait_agent call + result without backslash escapes', () => {
  const transcript = [
    '[tool wait_agent]',
    'Tool input:',
    '```json',
    '{',
    '  "targets": [',
    '    "01a1f778-4050-7422-ae11-6ca1f714c03a"',
    '  ],',
    '  "timeout_ms": 60000',
    '}',
    '```',
    '',
    '[tool wait_agent]',
    'status: completed',
    'output:',
    JSON.stringify(
      JSON.stringify({
        status: {
          '01a1f778-4050-7422-ae11-6ca1f714c03a': {
            completed: '当前生效版本目录名为 `20261120-release-2.4.9-unified-r11`；`agentopsdeck-local.service` 状态为 `active`。',
          },
        },
        timed_out: false,
      }),
    ),
  ].join('\n');

  const parsed = parseToolDetail(transcript);
  assert.equal(parsed.kind, 'structured');
  assert.equal(parsed.toolName, 'wait_agent');
  assert.equal(parsed.status?.label, 'Completed');
  assert.equal(parsed.status?.tone, 'success');
  assert.equal(parsed.input?.kind, 'params');
  if (parsed.input?.kind === 'params') {
    assert.deepEqual(parsed.input.items, [
      { key: 'targets', value: '01a1f778-4050-7422-ae11-6ca1f714c03a', mono: true },
      { key: 'timeout_ms', value: '1m (60000 ms)', mono: true },
    ]);
  }
  assert.equal(parsed.output?.kind, 'agentStatus');
  if (parsed.output?.kind === 'agentStatus') {
    assert.equal(parsed.output.timedOut, false);
    assert.equal(parsed.output.agents.length, 1);
    assert.equal(parsed.output.agents[0]?.agentId, '01a1f778-4050-7422-ae11-6ca1f714c03a');
    assert.equal(parsed.output.agents[0]?.state, 'Completed');
    assert.ok(parsed.output.agents[0]?.summary?.includes('20261120-release-2.4.9-unified-r11'));
    assert.equal(parsed.output.agents[0]?.summary?.includes('\\"'), false);
  }
});

test('parses exec_command input command and Codex shell output metadata', () => {
  const transcript = [
    '[tool exec_command]',
    'Tool input:',
    '```json',
    '{',
    '  "cmd": "pnpm --filter @agentopsdeck/web build",',
    '  "workdir": "/home/developer/repos/agentopsdeck"',
    '}',
    '```',
    '',
    '[tool exec_command]',
    'status: completed',
    'output:',
    'Chunk ID: 9f41a2',
    'Wall time: 1.42 seconds',
    'Process exited with code 0',
    'Original token count: 128',
    'Output:',
    '✓ built in 1.38s',
  ].join('\n');

  const parsed = parseToolDetail(transcript);
  assert.equal(parsed.kind, 'structured');
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.durationLabel, '1.42s');
  assert.equal(parsed.input?.kind, 'command');
  if (parsed.input?.kind === 'command') {
    assert.equal(parsed.input.command, 'pnpm --filter @agentopsdeck/web build');
    assert.equal(parsed.input.meta[0]?.key, 'workdir');
  }
  assert.equal(parsed.output?.kind, 'terminal');
  if (parsed.output?.kind === 'terminal') {
    assert.equal(parsed.output.output, '✓ built in 1.38s');
    assert.equal(parsed.output.chunkId, '9f41a2');
  }
});

test('parses fileChange JSON output into structured change pills', () => {
  const transcript = [
    '[tool fileChange]',
    'status: completed',
    'output:',
    JSON.stringify({
      status: 'completed',
      changes: [
        { path: 'apps/web/src/components/messages.tsx', kind: 'update' },
        { path: 'apps/web/src/lib/tool-detail-format.ts', kind: 'add' },
      ],
    }),
  ].join('\n');

  const parsed = parseToolDetail(transcript);
  assert.equal(parsed.kind, 'structured');
  assert.equal(parsed.output?.kind, 'fileChanges');
  if (parsed.output?.kind === 'fileChanges') {
    assert.equal(parsed.output.changes.length, 2);
    assert.equal(parsed.output.changes[0]?.kind, 'update');
    assert.equal(parsed.output.changes[1]?.kind, 'add');
  }
});

test('unwrapJsonPayload recursively unwraps nested JSON strings', () => {
  const nested = JSON.stringify(JSON.stringify({ ok: true, detail: JSON.stringify({ count: 3 }) }));
  const result = unwrapJsonPayload(nested);
  assert.equal(result.parsed, true);
  assert.deepEqual(result.value, { ok: true, detail: { count: 3 } });
});
