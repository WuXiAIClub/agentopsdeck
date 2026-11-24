/** Recovery metadata only: never persist credentials, task details or tokens. */
export const bindingReceiptKey = (scope: string, boardId: string) =>
  `agentopsdeck.board-binding.v1:${JSON.stringify([scope, boardId])}`;

export function parseBindingReceipt(raw: string | null): string | undefined {
  return raw?.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : undefined;
}
