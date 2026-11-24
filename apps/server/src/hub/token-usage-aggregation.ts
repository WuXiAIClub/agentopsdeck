import { createHash } from 'node:crypto';
import { validateNativeTokenSnapshot, type NativeTokenSnapshot } from '@agentopsdeck/shared';

export type UsageMember = { target: string; authorityEpoch: number; groups: string[]; snapshot: NativeTokenSnapshot };
export type UsageMetric = { knownSubtotal: number; knownSampleCount: number; unknownSampleCount: number };
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
type Totals = { events: number; metrics: Record<typeof fields[number], UsageMetric> };
export const USAGE_AGGREGATION_LIMITS = { members: 128, observations: 100_000, bytes: 16 * 1024 * 1024 };
export class UsageAggregationError extends Error {}
const text = (v: string) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const empty = (): Totals => ({ events: 0, metrics: Object.fromEntries(fields.map(f => [f, { knownSubtotal: 0, knownSampleCount: 0, unknownSampleCount: 0 }])) as Totals['metrics'] });

/** A1 normalized computation, not a provider bill. Directory membership is
 * server-frozen by the caller. Every member must still be authorized; a revoked
 * member rejects the whole selection rather than silently rewriting totals.
 * Native snapshot observations are root-only and observed-time/partial. */
export function aggregateTokenSnapshots(input: { owner: string; directoryRevision: string; complete: boolean; members: UsageMember[] },
  authority: (owner: string, target: string) => number | undefined) {
  if (!text(input.owner) || !text(input.directoryRevision) || input.complete !== true || !Array.isArray(input.members)
    || input.members.length > USAGE_AGGREGATION_LIMITS.members) throw new UsageAggregationError('selection');
  const targets = new Set<string>(), normalized: UsageMember[] = [];
  let count = 0, bytes = 0, range: string | undefined;
  for (const member of input.members) {
    if (!text(member.target) || targets.has(member.target) || !Number.isSafeInteger(member.authorityEpoch) || member.authorityEpoch < 0
      || !Array.isArray(member.groups) || member.groups.length > 16 || member.groups.some(g => !text(g) || g.length > 2048)
      || new Set(member.groups).size !== member.groups.length) throw new UsageAggregationError('member');
    if (authority(input.owner, member.target) !== member.authorityEpoch) throw new UsageAggregationError('authority-changed');
    targets.add(member.target);
    const snapshot = validateNativeTokenSnapshot(member.snapshot), usage = snapshot.data.usage;
    if (snapshot.memberDigest !== digest(snapshot.data.observations.map(r => r.identity).sort())) throw new UsageAggregationError('digest');
    const key = JSON.stringify([usage.from, usage.to, usage.bucketMs]);
    if (range !== undefined && range !== key || usage.to - usage.from > 31 * 86400000) throw new UsageAggregationError('range');
    range = key;
    count += snapshot.data.observations.length; bytes += Buffer.byteLength(JSON.stringify(snapshot));
    if (count > USAGE_AGGREGATION_LIMITS.observations || bytes > USAGE_AGGREGATION_LIMITS.bytes) throw new UsageAggregationError('capacity-no-truncation');
    normalized.push({ target: member.target, authorityEpoch: member.authorityEpoch, groups: [...member.groups].sort(), snapshot });
  }
  normalized.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
  const total = empty(), groups = new Map<string, Totals>(), union = new Map<string, string>();
  const groupEvents = new Map<string, Set<string>>();
  const add = (totals: Totals, row: NativeTokenSnapshot['data']['observations'][number]) => {
    totals.events++;
    for (const field of fields) {
      const metric = totals.metrics[field], value = row[field];
      if (value === null) metric.unknownSampleCount++;
      else {
        metric.knownSampleCount++; metric.knownSubtotal += value;
        if (!Number.isSafeInteger(metric.knownSubtotal)) throw new UsageAggregationError('precision');
      }
    }
  };
  for (const member of normalized) {
    for (const group of member.groups) { if (!groups.has(group)) { groups.set(group, empty()); groupEvents.set(group, new Set()); } }
    for (const row of member.snapshot.data.observations) {
      const id = JSON.stringify([member.target, row.identity]), fingerprint = JSON.stringify(row), previous = union.get(id);
      if (previous !== undefined && previous !== fingerprint) throw new UsageAggregationError('event-conflict');
      if (!union.has(id)) { union.set(id, fingerprint); add(total, row); }
      for (const group of member.groups) {
        const seen = groupEvents.get(group)!;
        if (!seen.has(id)) { seen.add(id); add(groups.get(group)!, row); }
      }
    }
  }
  // Recheck before releasing values, including changes during synchronous adapters.
  for (const member of normalized) if (authority(input.owner, member.target) !== member.authorityEpoch) throw new UsageAggregationError('authority-changed');
  const manifest = normalized.map(m => ({ target: m.target, authorityEpoch: m.authorityEpoch, groups: m.groups,
    requestId: m.snapshot.requestId, memberDigest: m.snapshot.memberDigest }));
  return { version: 1 as const, membership: 'query-time' as const, directoryRevision: input.directoryRevision,
    memberCount: normalized.length, manifest, manifestDigest: digest([input.owner, input.directoryRevision, manifest]), total,
    groups: [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, totals]) => ({ name, ...totals })),
    overlappingGroups: true, coverageReasons: ['partial-native-coverage', 'root-agent-only', 'observed-time-not-native-time'],
    creditEstimate: { status: 'unavailable' as const, reason: 'no-verified-versioned-billing-rule' as const } };
}
