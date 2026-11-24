import { validateSessionSkills, type SessionSkills, type SessionSkill } from '@agentopsdeck/shared';

/** Native skills/list is scoped to the verified thread cwd, never browser input.
 * No rescan, SKILL.md reads, runtime config writes or inference from tool text. */
export function projectSkills(value: unknown, cwd: string, observedAt = Date.now()): SessionSkills {
  const result = value as { data?: Array<{ cwd: string; skills: unknown[]; errors: unknown[] }> };
  if (!Array.isArray(result?.data) || result.data.length !== 1 || result.data[0]?.cwd !== cwd
    || !Array.isArray(result.data[0].skills) || !Array.isArray(result.data[0].errors)) throw new Error('Invalid native skills discovery');
  const entry = result.data[0], skills: SessionSkill[] = [];
  let bytes = 256, limited = entry.skills.length > 200;
  for (const raw of entry.skills.slice(0, 200)) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 256
      || typeof s.description !== 'string' || typeof s.enabled !== 'boolean'
      || !['user', 'repo', 'system', 'admin'].includes(String(s.scope))) throw new Error('Invalid native skill');
    const row: SessionSkill = { name: s.name, description: s.description.slice(0, 512), enabled: s.enabled, scope: s.scope as SessionSkill['scope'] };
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > 95 * 1024) { limited = true; break; }
    skills.push(row);
  }
  return validateSessionSkills({ skills, observedAt, limited, discoveryErrors: Math.min(1000, entry.errors.length), usage: 'unknown' });
}

/** Bounded, coalesced, short-lived discovery. Failures are not cached. */
export class SessionSkillsCache {
  private values = new Map<string, { at: number; value: SessionSkills }>();
  private inflight = new Map<string, Promise<SessionSkills>>();
  private generation = 0;
  constructor(private readonly now = Date.now) {}
  invalidate() { this.generation++; this.values.clear(); }
  read(key: string, load: () => Promise<SessionSkills>) {
    const cached = this.values.get(key);
    if (cached && this.now() - cached.at < 30_000) return Promise.resolve(cached.value);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.inflight.size >= 4) return Promise.reject(new Error('Skills discovery is busy'));
    const generation = this.generation;
    const next = Promise.resolve().then(load).then(value => {
      if (generation !== this.generation) throw new Error('Skills discovery changed; refresh explicitly');
      this.values.delete(key);
      while (this.values.size >= 32) this.values.delete(this.values.keys().next().value!);
      this.values.set(key, { at: this.now(), value });
      return value;
    }).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, next);
    return next;
  }
}
