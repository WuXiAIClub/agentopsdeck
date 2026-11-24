import { homedir } from 'node:os';
import path from 'node:path';

export function browserStreamConfig(environment = process.env, home = homedir()) {
  const dataDirectory = environment.AOD_DATA_DIR || path.join(environment.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'agentopsdeck');
  const commandFile = environment.AOD_BROWSER_STREAM_CMD || environment.AOD_BROWSER_STREAM_CMD_FILE
    || path.join(dataDirectory, 'browser-stream', 'cmd.json');
  const outputs = environment.AOD_BROWSER_STREAM_OUTPUT_DIRS
    ? JSON.parse(environment.AOD_BROWSER_STREAM_OUTPUT_DIRS) : [path.dirname(commandFile)];
  const executable = environment.AOD_CHROMIUM_EXECUTABLE || undefined;
  const language = environment.AOD_BROWSER_STREAM_LANGUAGE || 'en';
  if (!Array.isArray(outputs) || !outputs.length || !['en', 'zh-CN'].includes(language)) throw new Error('Invalid browser stream configuration');
  for (const value of [dataDirectory, commandFile, ...outputs, ...(executable ? [executable] : [])]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root
      || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Browser stream paths must be absolute non-root paths');
  }
  return { chromiumExecutable: executable, commandFiles: [commandFile], outputDirectories: [...new Set(outputs)], language };
}
