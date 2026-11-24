// Constructed only for a matching negative RPC response, never a transport
// failure. A rejection still does not generally prove that no work ran.
export class GatewayRpcError extends Error {
  constructor(readonly method: string, readonly code: string, message: string) {
    super(message);
    this.name = 'GatewayRpcError';
  }
}
