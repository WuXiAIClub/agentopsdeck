export type WeixinStatus = {
  available: boolean;
  personalKey: boolean;
  /** Optional for older Hubs; personalKey retains its original meaning. */
  administratorKey?: boolean;
  binding: null | { id: string; state: 'creating' | 'qr' | 'bound'; expiresAt: number; qrUrl?: string;
    contextReady: boolean; subscriptions: number; receipt?: { state: 'accepted' | 'unknown'; at: number } };
};
