type TimestampedMessage = { createdAt: number };
type ToolStateMessage = { status?: string };

// Same matching rule as the timeline, with a result index rather than a nested
// scan per call. Do not treat result-before-call ordering as still executing.
export function hasUnmatchedToolCall(messages: readonly { toolPhase?: string | undefined; toolCallId?: string | undefined }[]) {
  const results = new Set(messages.filter(message => message.toolPhase === 'result').map(message => message.toolCallId));
  return messages.some(message => message.toolPhase === 'call' && Boolean(message.toolCallId) && !results.has(message.toolCallId));
}

export function isToolExecuting(call?: ToolStateMessage, result?: ToolStateMessage) {
  return Boolean(call && !result && call.status === 'sending');
}

export type ToolOutputVariant = 'exec' | 'process' | 'file' | 'media' | 'git' | 'http' | 'server' | 'subagent' | 'agent-call' | 'generic';

const FULL_TOOL_ENTRY_LIMIT = 6;

export function compactToolEntryCount(entryCount: number) {
  return Math.max(0, entryCount - FULL_TOOL_ENTRY_LIMIT);
}

export function groupedToolElapsedMs(call?: TimestampedMessage, result?: TimestampedMessage, next?: TimestampedMessage) {
  if (call && result) return Math.max(0, result.createdAt - call.createdAt);
  const current = result ?? call;
  return current && next ? Math.max(0, next.createdAt - current.createdAt) : undefined;
}

export function splitToolNameAndTarget(rawName: string): { name: string; target?: string } {
  const trimmed = rawName.trim();
  const match = /^(read_file|edit_file|write_file|delete_file|move_file|search_files|commandExecution|git):(.+)$/i.exec(trimmed);
  if (match && match[1] && match[2]) {
    return { name: match[1], target: match[2] };
  }
  return { name: trimmed };
}

export function toolVariantFromLabel(label: string): ToolOutputVariant | undefined {
  const names = label
    .replace(/^Tool:\s*/i, '')
    .split(/\s+\+\s+/)
    .map((name) => splitToolNameAndTarget(name).name.trim().toLowerCase().replace(/^functions\./, '').replace(/^.*__/, ''));
  if (names.some((name) => ['git'].includes(name))) return 'git';
  if (names.some((name) => ['commandexecution', 'exec', 'exec_command', 'run_command', 'execute', 'terminal', 'bash', 'shell'].includes(name))) return 'exec';
  if (names.some((name) => ['process', 'wait', 'write_stdin'].includes(name))) return 'process';
  if (names.some((name) => ['read', 'write', 'edit', 'delete', 'move', 'search', 'apply_patch', 'filechange', 'read_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'search_files', 'view_file', 'grep', 'patch'].includes(name))) return 'file';
  if (names.some((name) => ['image', 'image_generate', 'imagegeneration', 'imageview', 'music_generate', 'video_generate', 'view_image'].includes(name))) return 'media';
  if (names.some((name) => ['fetch', 'web_fetch', 'web_search', 'websearch'].includes(name))) return 'http';
  if (names.some((name) => ['sessions_spawn', 'subagents', 'spawn_agent', 'wait_agent', 'close_agent', 'resume_agent', 'collabagenttoolcall', 'invoke_subagent', 'define_subagent', 'manage_subagents'].includes(name))) return 'subagent';
  if (names.some((name) => ['sessions_send', 'send_message', 'send_input', 'followup_task'].includes(name))) return 'agent-call';
  if (names.some((name) => name.startsWith('sessions_') || ['cron', 'create_goal', 'get_goal', 'request_user_input', 'session_status', 'update_goal', 'update_plan', 'switch_mode', 'think', 'agentopsdeck_board_read', 'agentopsdeck_board_update'].includes(name))) return 'server';
  return undefined;
}
