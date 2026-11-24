import type { NativeTokenUsage } from "@agentopsdeck/shared";
import type { UsageModel } from "./token-usage-view.js";

export const creditFields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
export type CreditRates = Record<typeof creditFields[number], string>;
export type CreditTariff = { effectiveFrom: number | null; rates: CreditRates };
export type CreditSettings = Record<string, CreditTariff[]>;
export const emptyCreditRates = (): CreditRates => ({ inputTokens: "", outputTokens: "", cacheReadTokens: "", cacheWriteTokens: "" });
export const creditRateKey = (runtime: NativeTokenUsage["runtime"], model: string) => JSON.stringify([runtime, model]);
export function parseCreditRate(value: string): number | null {
  if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(value.trim())) return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1e9 ? rate : null;
}
/** Local tariff configuration only. Never alter the native observations. */
export function readCreditSettings(raw: string | null): CreditSettings {
  try { return decodeCreditSettings(raw); } catch { return {}; }
}
function decodeCreditSettings(raw: string | null): CreditSettings {
  const invalid = () => { throw new Error("Invalid credit history or storage limit exceeded"); };
  try {
    if (!raw || raw.length > 128_000) return invalid();
    const parsed = JSON.parse(raw);
    if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.rates) || parsed.rates.length > 256) return invalid();
    const result: CreditSettings = {};
    let count = 0;
    for (const entry of parsed.rates) {
      if (!Array.isArray(entry) || entry.length !== 2) return invalid();
      const [key, value] = entry;
      if (typeof key !== "string" || key.length > 512 || Object.hasOwn(result, key)) return invalid();
      const identity = JSON.parse(key);
      if (!Array.isArray(identity) || identity.length !== 2 || !["codex", "claude-code", "ghcp"].includes(identity[0]) || typeof identity[1] !== "string" || JSON.stringify(identity) !== key) return invalid();
      const history = parsed.version === 1 ? [{ effectiveFrom: null, rates: value }] : value;
      if (!Array.isArray(history) || history.length < 1 || history.length > 32 || (count += history.length) > 1024) return invalid();
      let previous = -Infinity;
      result[key] = history.map((tariff: CreditTariff, index: number) => {
        if (!tariff || typeof tariff !== "object") return invalid();
        const { effectiveFrom, rates } = tariff;
        if (effectiveFrom === null ? index !== 0 : !validCreditDate(effectiveFrom) || effectiveFrom <= previous) return invalid();
        previous = effectiveFrom ?? -Infinity;
        if (!rates || typeof rates !== "object" || creditFields.some(field => typeof rates[field] !== "string" || rates[field] !== "" && parseCreditRate(rates[field]) === null)) return invalid();
        return { effectiveFrom, rates: Object.fromEntries(creditFields.map(field => [field, rates[field]])) as CreditRates };
      });
    }
    return result;
  } catch { return invalid(); }
}
export function serializeCreditSettings(settings: CreditSettings): string {
  const raw = JSON.stringify({ version: 2, rates: Object.entries(settings) });
  decodeCreditSettings(raw); // Never silently evict a model or old tariff to fit storage.
  return raw;
}
export function validCreditDate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}
export function addCreditTariff(settings: CreditSettings, key: string, effectiveFrom: number, rates: CreditRates, replace = false): CreditSettings {
  if (!validCreditDate(effectiveFrom)) throw new Error("Invalid effective time");
  const history = settings[key] ?? [];
  if (!replace && history.some(tariff => tariff.effectiveFrom === effectiveFrom)) throw new Error("Explicit replacement required");
  const next = { ...settings, [key]: [...history.filter(tariff => tariff.effectiveFrom !== effectiveFrom), { effectiveFrom, rates }]
    .sort((a, b) => (a.effectiveFrom ?? -Infinity) - (b.effectiveFrom ?? -Infinity)) };
  serializeCreditSettings(next);
  return next;
}

/** The includes-cache tariff charges all non-read input at its input rate.
 * Cache creation is priced separately only for excludes-cache accounting.
 * Unknown counters/accounting/model/rates must not silently become free usage. */
export function estimateModelCredits(accounting: NativeTokenUsage["inputAccounting"], row: UsageModel, rates?: CreditRates): number | null {
  if (row.model === null || !rates || accounting === "provider-defined") return null;
  const fields = accounting === "includes-cache" ? creditFields.slice(0, 3) : creditFields;
  if (fields.some(field => row[field] === null || !Number.isSafeInteger(row[field]) || row[field]! < 0)) return null;
  const input = accounting === "includes-cache" ? row.inputTokens! - row.cacheReadTokens! : row.inputTokens!;
  if (input < 0) return null;
  let total = 0;
  for (const field of fields) {
    const count = field === "inputTokens" ? input : row[field]!;
    if (count === 0) continue;
    const rate = parseCreditRate(rates[field]);
    if (rate === null) return null;
    total += count / 1_000_000 * rate;
  }
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : null;
}
export function estimateUsageCredits(data: NativeTokenUsage, models: UsageModel[], settings: CreditSettings) {
  type Estimate = { model: string | null; credits: number | null; reason: "tariff-boundary" | "unknown" | null };
  const estimates = new Map<string | null, Estimate>();
  for (const bucket of data.buckets) {
    const from = Math.max(data.from, bucket.at), to = Math.min(data.to, bucket.at + data.bucketMs);
    for (const row of bucket.models ?? [{ ...bucket, model: null }]) {
      const history = row.model === null ? [] : settings[creditRateKey(data.runtime, row.model)] ?? [];
      const crosses = history.some(tariff => tariff.effectiveFrom !== null && tariff.effectiveFrom > from && tariff.effectiveFrom < to);
      let tariff: CreditTariff | undefined;
      for (const candidate of history) {
        if (candidate.effectiveFrom !== null && candidate.effectiveFrom > from) break;
        tariff = candidate;
      }
      const credits = crosses || !(to > from) ? null : estimateModelCredits(data.inputAccounting, row, tariff?.rates);
      const previous = estimates.get(row.model);
      const sum = previous?.credits === null || credits === null ? null : (previous?.credits ?? 0) + credits;
      estimates.set(row.model, { model: row.model, credits: sum !== null && sum <= Number.MAX_SAFE_INTEGER ? sum : null,
        reason: crosses || previous?.reason === "tariff-boundary" ? "tariff-boundary" : sum === null || sum > Number.MAX_SAFE_INTEGER ? "unknown" : null });
    }
  }
  const rows = models.map(row => estimates.get(row.model) ?? { model: row.model, credits: null, reason: "unknown" as const });
  const covered = rows.filter(row => row.credits !== null).length;
  const subtotal = rows.reduce((sum, row) => sum + (row.credits ?? 0), 0);
  return { rows, covered, total: rows.length > 0 && covered === rows.length && subtotal <= Number.MAX_SAFE_INTEGER ? subtotal : null };
}

export const BUILTIN_GHCP_RATES: CreditRates = { inputTokens: "2.5", outputTokens: "10", cacheReadTokens: "0.25", cacheWriteTokens: "3.125" };

export const GHCP_DEFAULT_MODEL_KEY = "ghcp-default";

export function defaultGhcpCreditRates(model: string | null): CreditRates {
  if (!model || !model.trim()) return { ...BUILTIN_GHCP_RATES };
  const lower = model.toLocaleLowerCase();
  if (lower.includes("mini") || lower.includes("haiku") || lower.includes("flash")) {
    return { inputTokens: "0.3", outputTokens: "1.2", cacheReadTokens: "0.03", cacheWriteTokens: "0.375" };
  }
  if (lower.includes("opus") || lower.includes("o1") || lower.includes("o3")) {
    return { inputTokens: "15", outputTokens: "60", cacheReadTokens: "1.5", cacheWriteTokens: "18.75" };
  }
  return { ...BUILTIN_GHCP_RATES };
}

/** Built-in zero-config session credit estimation (supports GHCP out-of-the-box and standard model tiers). */
export function estimateSessionBuiltinCredits(inputTokens: number, outputTokens: number, runtime?: string, model?: string | null): number {
  const rates = defaultGhcpCreditRates(model ?? (runtime === "ghcp" ? GHCP_DEFAULT_MODEL_KEY : "standard"));
  const inRate = parseCreditRate(rates.inputTokens) ?? 2.5;
  const outRate = parseCreditRate(rates.outputTokens) ?? 10;
  return (Math.max(0, inputTokens) / 1_000_000) * inRate + (Math.max(0, outputTokens) / 1_000_000) * outRate;
}

export function withBuiltinGhcpSettings(data: NativeTokenUsage, models: UsageModel[], settings: CreditSettings): CreditSettings {
  if (data.runtime !== "ghcp") return settings;
  const next: CreditSettings = { ...settings };
  const names = new Set<string>([GHCP_DEFAULT_MODEL_KEY]);
  for (const row of models) names.add(row.model || GHCP_DEFAULT_MODEL_KEY);
  for (const bucket of data.buckets) for (const row of bucket.models ?? []) names.add(row.model || GHCP_DEFAULT_MODEL_KEY);
  for (const name of names) {
    const key = creditRateKey("ghcp", name);
    if (!next[key]?.length) {
      const rates = defaultGhcpCreditRates(name);
      next[key] = [{ effectiveFrom: null, rates }];
    }
  }
  return next;
}

export function estimateUsageCreditsWithDefaults(data: NativeTokenUsage, models: UsageModel[], settings: CreditSettings) {
  if (data.runtime !== "ghcp") return estimateUsageCredits(data, models, settings);
  const normalizedModels = models.map(row => ({
    ...row,
    model: row.model ?? GHCP_DEFAULT_MODEL_KEY,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
  }));
  const effectiveSettings = withBuiltinGhcpSettings(data, normalizedModels, settings);
  const effectiveData: NativeTokenUsage = {
    ...data,
    inputAccounting: data.inputAccounting === "provider-defined" ? "includes-cache" : data.inputAccounting,
    buckets: data.buckets.map(bucket => ({
      ...bucket,
      cacheReadTokens: bucket.cacheReadTokens ?? 0,
      cacheWriteTokens: bucket.cacheWriteTokens ?? 0,
      models: (bucket.models ?? [{ ...bucket, model: GHCP_DEFAULT_MODEL_KEY }]).map(row => ({
        ...row,
        model: row.model ?? GHCP_DEFAULT_MODEL_KEY,
        cacheReadTokens: row.cacheReadTokens ?? 0,
        cacheWriteTokens: row.cacheWriteTokens ?? 0,
      })),
    })),
  };
  const result = estimateUsageCredits(effectiveData, normalizedModels, effectiveSettings);
  return {
    ...result,
    rows: result.rows.map((row, index) => ({
      ...row,
      model: models[index]?.model ?? row.model,
    })),
  };
}
