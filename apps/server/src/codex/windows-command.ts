import { win32 } from 'node:path';
import { windowsPowerShell } from '../connector/windows-private-worker.js';

/** cmd shims need an interpreter; native executables do not. Never use
 * ComSpec or interpolate unquoted tokens into an interpreter command. */
export function windowsCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (!command.trim() || [command, ...args].some(value => /[\x00-\x1f]/.test(value))) throw new Error('Invalid Windows native command');
  if (/\.exe$/i.test(command)) return { command, args, windowsVerbatimArguments: false };
  if ([command, ...args].some(value => /["%!^&|<>]/.test(value))) throw new Error('Invalid Windows shim command');
  const interpreter = win32.resolve(windowsPowerShell(env), '..', '..', '..', 'cmd.exe');
  const line = [command, ...args].map(value => `"${value}"`).join(' ');
  return { command: interpreter, args: ['/d', '/s', '/v:off', '/c', `"${line}"`], windowsVerbatimArguments: true };
}
