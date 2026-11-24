import { BOARD_READ_TOOL, boardReadSchema, boardUpdateSchema, boardToolNames, boardToolDescriptions, type WorkerBoardTools } from '../tools/workspace-board-worker.js';

export function copilotBoardTools(board: WorkerBoardTools, sessionId: string) {
  return boardToolNames.map(name => ({
    name, description: boardToolDescriptions[name]!, parameters: name === BOARD_READ_TOOL ? boardReadSchema : boardUpdateSchema,
    skipPermission: false, overridesBuiltInTool: false, defer: 'never' as const,
    async handler(input: unknown, invocation: { sessionId: string; toolName: string; signal?: AbortSignal }) {
      const result = invocation?.sessionId === sessionId && invocation.toolName === name && !invocation.signal?.aborted
        ? await board.invoke(name, input, invocation.signal) : { error: 'Task tool invocation denied' };
      return { textResultForLlm: JSON.stringify(result), resultType: 'error' in result ? 'denied' as const : 'success' as const };
    },
  }));
}
