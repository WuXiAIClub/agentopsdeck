import { SdkCommands, type SdkCommandOptions } from '../connector/sdk-commands.js';
export class ClaudeCommands extends SdkCommands<'claude-code'> {
  constructor(options: Omit<SdkCommandOptions<'claude-code'>, 'runtime' | 'journal'>) {
    super({ ...options, runtime: 'claude-code', journal: options.store.claudeJournal });
  }
}
