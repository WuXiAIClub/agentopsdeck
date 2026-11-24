import { execFile } from 'node:child_process';
import { windowsCommand } from './windows-command.js';

export const defaultModeQuestionFeature = 'default_mode_request_user_input';

/** Read only the CLI's feature metadata. Unknown/removed flags must never be
 * passed to app-server: an older CLI still runs automatic sessions normally. */
export function supportsDefaultModeQuestions(output: string): boolean {
  if (output.length > 64 * 1024) return false;
  return output.split(/\r?\n/).some(line => {
    const match = /^default_mode_request_user_input\s+(.+?)\s+(true|false)\s*$/.exec(line.trim());
    return !!match && ['under development', 'experimental', 'stable'].includes(match[1]!);
  });
}

export function probeDefaultModeQuestions(command: string, cwd: string, homeDirectory?: string, host: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const invocation = process.platform === 'win32' ? windowsCommand(command, ['features', 'list'], host)
        : { command, args: ['features', 'list'], windowsVerbatimArguments: false };
      execFile(invocation.command, invocation.args, { cwd, timeout: 3000, maxBuffer: 64 * 1024,
        windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: { ...host, ...(homeDirectory === undefined ? {} : { CODEX_HOME: homeDirectory }) },
      }, (error, stdout) => resolve(!error && supportsDefaultModeQuestions(stdout)));
    } catch { resolve(false); }
  });
}
