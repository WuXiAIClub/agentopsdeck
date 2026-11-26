export const GEMINI_QUOTA_GROUP_NAME = 'Gemini Models';
export const LOW_QUOTA_THRESHOLD = 0.2;

export function resolveQuotaSampleGroupIndex(groups: readonly { name: string }[]): number {
  if (!groups.length) return -1;
  const geminiIndex = groups.findIndex(group => group.name === GEMINI_QUOTA_GROUP_NAME);
  return geminiIndex >= 0 ? geminiIndex : 0;
}

export function isLowQuotaFraction(remainingFraction: number): boolean {
  return remainingFraction <= LOW_QUOTA_THRESHOLD;
}

export function isEmptyQuotaFraction(remainingFraction: number): boolean {
  return remainingFraction <= 0;
}
