const SUPPORTED_CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const REASONING_DISABLED_VALUES = new Set(['off', 'none', 'disabled', 'false', '0', 'minimal']);

export function modelRejectsReasoningEffort(model: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = model?.trim();
  if (!normalized) return false;
  const extra = env.AOD_CODEX_NO_REASONING_MODELS;
  if (extra) {
    for (const entry of extra.split(',')) {
      const candidate = entry.trim();
      if (candidate && candidate.toLowerCase() === normalized.toLowerCase()) return true;
    }
  }
  return false;
}

export type ResolvedCodexReasoning = {
  effort?: string;
  summary?: 'none';
  clearStickyEffort: boolean;
};

export function resolveCodexReasoningParams(params: {
  model: string | null | undefined;
  rawEffort: string | null | undefined;
  hadActiveEffort?: boolean;
  env?: NodeJS.ProcessEnv;
}): ResolvedCodexReasoning {
  const normalized = params.rawEffort?.trim().toLowerCase() || '';
  if (modelRejectsReasoningEffort(params.model, params.env)) {
    return { summary: 'none', clearStickyEffort: true };
  }
  if (normalized && REASONING_DISABLED_VALUES.has(normalized)) {
    return { summary: 'none', clearStickyEffort: true };
  }
  if (normalized && SUPPORTED_CODEX_EFFORTS.has(normalized)) {
    return { effort: normalized, clearStickyEffort: false };
  }
  if (normalized) {
    return { summary: 'none', clearStickyEffort: true };
  }
  return { clearStickyEffort: Boolean(params.hadActiveEffort) };
}
