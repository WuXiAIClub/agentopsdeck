export type GuidanceConfig = { revision: number; text: string; hash: string; enabled: boolean };
export type GuidanceSnapshot = { guidance: null | { config: GuidanceConfig; state: string }; contextVerification: 'unsupported' };
export type GuidanceReceipt = { requestId: string; revision: number; text: string; hash: string; createdAt: number; expiresAt: number;
  state: 'prepared' | 'unknown' | 'submitted' | 'rejected' | 'cancelled'; queueReceipt: string | null; contextEpoch: string | null };
export type GuidanceResult = { receipt: GuidanceReceipt | null; cancelled?: boolean; requestId?: string };
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export const guidanceRequestId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
export function validGuidanceSnapshot(v: GuidanceSnapshot): boolean {
  if (!v || v.contextVerification !== 'unsupported') return false;
  if (v.guidance === null) return true;
  const c = v.guidance?.config;
  return !!c && integer(c.revision) && c.revision > 0 && typeof c.text === 'string' && c.text.length <= 8000 && hash(c.hash)
    && typeof c.enabled === 'boolean' && ['not_submitted', 'submitted', 'unknown', 'confirmed_present', 'confirmed_absent'].includes(v.guidance!.state);
}
export function validGuidanceResult(v: GuidanceResult, id: string): boolean {
  if (!v || !guidanceRequestId(id)) return false;
  if (v.receipt === null) return v.cancelled === true && v.requestId === id;
  const r = v.receipt;
  return !!r && r.requestId === id && integer(r.revision) && r.revision > 0 && typeof r.text === 'string' && r.text.length <= 16002 && hash(r.hash)
    && integer(r.createdAt) && integer(r.expiresAt) && r.expiresAt > r.createdAt && r.expiresAt - r.createdAt <= 300000
    && ['prepared', 'unknown', 'submitted', 'rejected', 'cancelled'].includes(r.state)
    && (r.state === 'submitted' ? typeof r.queueReceipt === 'string' && !!r.queueReceipt && r.queueReceipt.length <= 512 : r.queueReceipt === null)
    && (r.contextEpoch === null || typeof r.contextEpoch === 'string');
}

export type GuidanceTemplate = {
  id: string;
  label: 'Surgical Bug Fix' | 'Code Review & Security Audit' | 'TDD Implementation' | 'Multi-Agent Coordinator';
  text: string;
};

export const GUIDANCE_TEMPLATES: readonly GuidanceTemplate[] = [
  {
    id: 'surgical-fix',
    label: 'Surgical Bug Fix',
    text: 'Follow surgical precision: identify the root cause first, keep changes minimal and focused, preserve existing public contracts, and run targeted tests before concluding.',
  },
  {
    id: 'code-review',
    label: 'Code Review & Security Audit',
    text: 'Audit changes for correctness, race conditions, resource leaks, and security boundaries. Never print or log private credentials or tokens.',
  },
  {
    id: 'tdd-workflow',
    label: 'TDD Implementation',
    text: 'Write or update unit tests covering edge cases first, implement the minimal code required to pass, and verify no regressions in adjacent modules.',
  },
  {
    id: 'multi-agent-coord',
    label: 'Multi-Agent Coordinator',
    text: 'Coordinate tasks via the shared taskboard and notebook: claim tasks before editing, keep status updated, and record key findings in the shared notebook.',
  },
];

export function formatSafeSecretDirective(name: string, secretOrPath: string, mode: 'secret' | 'path' = 'secret'): string {
  const cleanName = name.trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'SECRET_KEY';
  const cleanValue = secretOrPath.trim();
  if (!cleanValue) return '';
  if (mode === 'path') {
    return `Credential ${cleanName}: read directly from private file ${cleanValue} via stdin/input; never print, echo, or log its contents.`;
  }
  return `Credential ${cleanName}: [[AOD_SECRET:${cleanValue}]]`;
}
