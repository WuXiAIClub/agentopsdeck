import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { browserStreamConfig } from './browser-stream-config.mjs';

test('browser stream defaults stay outside source and use the supplied private home', () => {
  const home = path.resolve('synthetic-home');
  const config = browserStreamConfig({}, home);
  assert.equal(config.chromiumExecutable, undefined);
  assert.equal(config.language, 'en');
  assert.deepEqual(config.commandFiles, [path.join(home, '.local', 'share', 'agentopsdeck', 'browser-stream', 'cmd.json')]);
  assert.deepEqual(config.outputDirectories, [path.dirname(config.commandFiles[0])]);
});

test('explicit browser paths and Chinese language are portable without release fallbacks', () => {
  const directory = path.resolve('synthetic-runtime');
  const output = path.join(directory, 'frames');
  const config = browserStreamConfig({ AOD_DATA_DIR: directory, AOD_CHROMIUM_EXECUTABLE: path.join(directory, 'chromium'),
    AOD_BROWSER_STREAM_CMD_FILE: path.join(directory, 'commands.json'), AOD_BROWSER_STREAM_OUTPUT_DIRS: JSON.stringify([output, output]),
    AOD_BROWSER_STREAM_LANGUAGE: 'zh-CN' });
  assert.deepEqual(config.commandFiles, [path.join(directory, 'commands.json')]);
  assert.deepEqual(config.outputDirectories, [output]);
  assert.equal(config.language, 'zh-CN');
  for (const environment of [{ AOD_DATA_DIR: 'relative' }, { AOD_BROWSER_STREAM_OUTPUT_DIRS: '[]' },
    { AOD_BROWSER_STREAM_OUTPUT_DIRS: 'null' }, { AOD_BROWSER_STREAM_LANGUAGE: 'fr' }, { AOD_CHROMIUM_EXECUTABLE: 'relative' }]) {
    assert.throws(() => browserStreamConfig(environment));
  }
});
