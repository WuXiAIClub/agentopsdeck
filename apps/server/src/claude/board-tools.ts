import { createRequire } from 'node:module';
import { BOARD_STATUSES } from '@agentopsdeck/shared';
import { BOARD_READ_TOOL, boardToolNames, boardToolDescriptions, type WorkerBoardTools } from '../tools/workspace-board-worker.js';

// Structural SDK contract; the verified, pinned SDK supplies its own Zod peer.
// This module never imports the SDK (or its credentials) in the Hub process.
type Schema = { int(): Schema; min(n: number): Schema; max(n: number): Schema; uuid(): Schema; optional(): Schema; strict(): Schema };
type Zod = { number(): Schema; string(): Schema; boolean(): Schema; enum(values: readonly string[]): Schema; array(value: Schema): Schema; object(shape: Record<string, Schema>): Schema };
export type BoardMcpSdk = { createSdkMcpServer(options: { name: string; version: string; tools: {
  name: string; description: string; inputSchema: Record<string, Schema>;
  handler(input: unknown, extra?: { signal?: AbortSignal }): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }>;
}[] }): unknown };
export const claudeBoardToolName = (name: string) => `mcp__agentopsdeck_board__${name}`;
export function claudeBoardServer(entry: string, sdk: BoardMcpSdk, board: WorkerBoardTools) {
  if (typeof sdk.createSdkMcpServer !== 'function') throw new Error('Task tool SDK unavailable');
  const z = createRequire(entry)('zod') as Zod;
  const read = {
    status: z.enum(BOARD_STATUSES).optional(), taskIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    includeDetail: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).max(200).optional(),
    revision: z.number().int().min(1).optional(), ifRevision: z.number().int().min(1).optional(),
  }, update = {
    revision: z.number().int().min(1), mutationId: z.string().uuid(),
    tasks: z.array(z.object({ id: z.string().uuid(), status: z.enum(BOARD_STATUSES).optional(), detail: z.string().max(4000).optional() }).strict()).min(1).max(200),
  };
  return sdk.createSdkMcpServer({ name: 'agentopsdeck_board', version: '1.0.0', tools: boardToolNames.map(name => ({
    name, description: boardToolDescriptions[name]!, inputSchema: name === BOARD_READ_TOOL ? read : update,
    async handler(input, extra) {
      const result = await board.invoke(name, input, extra?.signal);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: 'error' in result };
    },
  })) });
}
