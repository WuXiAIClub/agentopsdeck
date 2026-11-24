export class CodexRpcError extends Error {
  readonly diagnosticCode: number;

  constructor(message: string | undefined, code: number | undefined) {
    super(message || 'Codex App Server request failed');
    this.diagnosticCode = code === -32700 ? 1
      : code === -32600 ? 2
      : code === -32601 ? 3
      : code === -32602 ? 4
      : code === -32603 ? 5
      : typeof code === 'number' && Number.isInteger(code) && code >= -32099 && code <= -32000 ? 6 : 0;
  }
}
