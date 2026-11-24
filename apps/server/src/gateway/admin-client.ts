export type AdminRpcClientOptions = {
  url: string | undefined;
  ownerToken: string | undefined;
};

const P0_ALLOWED_METHODS = new Set([
  'gateway.status',
  'gateway.health',
  'gateway.restart',
  'agents.list',
  'channels.status',
  'cron.status',
]);

export class AdminRpcClient {
  constructor(private readonly options: AdminRpcClientOptions) {}

  status() {
    return {
      configured: Boolean(this.options.url),
      url: this.options.url,
    };
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!P0_ALLOWED_METHODS.has(method)) {
      throw new Error(`Admin RPC method is not exposed in AgentOpsDeck P0: ${method}`);
    }
    if (!this.options.url) {
      throw new Error('Admin RPC URL is not configured');
    }

    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.ownerToken ? { authorization: `Bearer ${this.options.ownerToken}` } : {}),
      },
      body: JSON.stringify({ method, params }),
    }).catch(() => { throw new Error('Admin RPC transport unavailable'); });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error('Admin RPC request failed');
    }
    return (body.result ?? body.data ?? body) as T;
  }
}
