import assert from 'node:assert/strict';
import test from 'node:test';
import { requireInterruptedDispatchSettled } from './interrupted-dispatch.js';

const turn = { id: 'target', status: 'interrupted' };
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });
const start = (id = 'target') => line('event_msg', { type: 'task_started', turn_id: id });
const call = (name = 'exec') => line('response_item', { type: 'custom_tool_call', call_id: 'call', name, input: 'not inspected' });
const output = (value: unknown) => line('response_item', { type: 'custom_tool_call_output', call_id: 'call', output: value });

for (const result of [undefined, 'aborted by user after 0.1s', 'aborted by user']) {
  test(`interrupted dispatch does not certify cancelled wrapper ${String(result)}`, () => {
    const rollout = [start(), call(), ...(result === undefined ? [] : [output(result)])].join('\n');
    assert.throws(() => requireInterruptedDispatchSettled(rollout, turn), /cleanup is unconfirmed/);
    assert.throws(() => requireInterruptedDispatchSettled(rollout.replace('"exec"', '"functions.exec"'), turn), /cleanup is unconfirmed/);
    for (const status of ['completed', 'failed', 'inProgress']) {
      assert.doesNotThrow(() => requireInterruptedDispatchSettled(rollout, { ...turn, status }));
    }
  });
}

test('dispatch guard isolates turns and does not inspect arbitrary command text', () => {
  for (const rollout of [
    '',
    [start(), call(), output('actual native result')].join('\n'),
    [start(), call(), output('')].join('\n'),
    [start('old'), call(), output('aborted by user after 0.1s'), start()].join('\n'),
    [start(), call('exec_command'), output('aborted by user after 0.1s')].join('\n'),
    [start(), call('search'), output('aborted by user after 0.1s')].join('\n'),
  ]) assert.doesNotThrow(() => requireInterruptedDispatchSettled(rollout, turn));
});

test('a different call result or later turn cannot settle an aborted wrapper', () => {
  for (const extra of [output('actual result').replace('"call"', '"other"'), [start('later'), output('actual result')].join('\n')]) {
    assert.throws(() => requireInterruptedDispatchSettled([start(), call(), output('aborted by user'), extra].join('\n'), turn), /cleanup is unconfirmed/);
  }
});
