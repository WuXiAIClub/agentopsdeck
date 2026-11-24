/** Discovery metadata only. Enabled does not mean loaded or used in a turn. */
export type SessionSkill = {
  name: string;
  description: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  enabled: boolean;
};
export type SessionSkills = {
  skills: SessionSkill[];
  observedAt: number;
  limited: boolean;
  discoveryErrors: number;
  usage: 'unknown';
};

/** Allowlist the wire format on both sides of Hub. No paths, dependencies or bodies. */
export function validateSessionSkills(value: unknown): SessionSkills {
  const v = value as SessionSkills;
  if (!v || !Array.isArray(v.skills) || v.skills.length > 200 || v.usage !== 'unknown'
    || !Number.isSafeInteger(v.observedAt) || v.observedAt < 0 || typeof v.limited !== 'boolean'
    || !Number.isSafeInteger(v.discoveryErrors) || v.discoveryErrors < 0 || v.discoveryErrors > 1000) {
    throw new Error('Invalid skills discovery');
  }
  const skills = v.skills.map(s => {
    if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 256
      || typeof s.description !== 'string' || s.description.length > 512
      || !['user', 'repo', 'system', 'admin'].includes(s.scope) || typeof s.enabled !== 'boolean') {
      throw new Error('Invalid skill metadata');
    }
    return { name: s.name, description: s.description, scope: s.scope, enabled: s.enabled };
  });
  const result = { skills, observedAt: v.observedAt, limited: v.limited, discoveryErrors: v.discoveryErrors, usage: 'unknown' as const };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 96 * 1024) throw new Error('Skills discovery exceeds budget');
  return result;
}
