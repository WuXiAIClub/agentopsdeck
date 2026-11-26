export type AntigravityQuotaWindow = {
  id: string;
  window: string;
  remainingFraction: number;
  resetAt: number | null;
};

export type AntigravityUsage = {
  sampledAt: number;
  groups: { name: string; windows: AntigravityQuotaWindow[] }[];
};
