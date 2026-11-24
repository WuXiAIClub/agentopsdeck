import test from "node:test";
import assert from "node:assert/strict";
import { addCreditTariff, creditRateKey, defaultGhcpCreditRates, emptyCreditRates, estimateModelCredits, estimateUsageCredits, estimateUsageCreditsWithDefaults, parseCreditRate, readCreditSettings, serializeCreditSettings } from "./usage-credits.js";
import type { NativeTokenUsage } from "@agentopsdeck/shared";
const row = { model: "example", samples: 1, inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 400_000, cacheWriteTokens: null };
const rates = { inputTokens: "10", outputTokens: "20", cacheReadTokens: "1", cacheWriteTokens: "15" };
test("inclusive input is not charged twice for cached tokens; unknown creation is not a separate tariff", () => {
  assert.equal(estimateModelCredits("includes-cache", row, rates), 10.4);
});
test("exclusive input charges separately observed cache creation", () => {
  assert.equal(estimateModelCredits("excludes-cache", { ...row, cacheWriteTokens: 100_000 }, rates), 15.9);
  assert.equal(estimateModelCredits("excludes-cache", row, rates), null);
});
test("missing observations, model, rates and invalid accounting never silently become free", () => {
  for (const item of [{ ...row, model: null }, { ...row, cacheReadTokens: null }, { ...row, inputTokens: 1 }, { ...row, outputTokens: null }]) assert.equal(estimateModelCredits("includes-cache", item, rates), null);
  assert.equal(estimateModelCredits("provider-defined", row, rates), null);
  assert.equal(estimateModelCredits("includes-cache", row), null);
  assert.equal(estimateModelCredits("includes-cache", row, emptyCreditRates()), null);
  assert.equal(estimateModelCredits("includes-cache", row, { ...rates, outputTokens: "0" }), 6.4);
  assert.equal(estimateModelCredits("includes-cache", { ...row, outputTokens: 0 }, { ...rates, outputTokens: "" }), 6.4);
});
test("invalid and excessive rates are rejected; zero and fractional credits are explicit", () => {
  for (const value of ["", " ", "-1", "Infinity", "NaN", "1e4", "0x10", "1000000001"]) assert.equal(parseCreditRate(value), null);
  assert.equal(parseCreditRate("0"), 0); assert.equal(parseCreditRate(" 0.0001 "), .0001);
  assert.equal(estimateModelCredits("includes-cache", { ...row, inputTokens: Number.MAX_SAFE_INTEGER + 1 }, rates), null);
});
test("runtime/model settings roundtrip with bounded validated storage", () => {
  const key = creditRateKey("codex", "example"), settings = { [key]: [{ effectiveFrom: null, rates }] };
  assert.deepEqual(readCreditSettings(serializeCreditSettings(settings)), settings);
  assert.deepEqual(readCreditSettings(JSON.stringify({ version: 1, rates: [[key, rates]] })), settings);
  for (const raw of [null, "invalid", "{}", JSON.stringify({ version: 1, rates: [["__proto__", rates]] }), JSON.stringify({ version: 1, rates: [[key, { ...rates, inputTokens: "-1" }]] })]) assert.deepEqual(readCreditSettings(raw), {});
  assert.notEqual(key, creditRateKey("claude-code", "example"));
});
test("aggregate stays unknown for partial coverage; model prices do not leak across runtimes", () => {
  const data = fixture();
  const settings = { [creditRateKey("codex", "example")]: [{ effectiveFrom: null, rates }] };
  assert.equal(estimateUsageCredits(data, [row], settings).total, 10.4);
  assert.equal(estimateUsageCredits(data, [row, { ...row, model: "missing" }], settings).total, null);
  assert.equal(estimateUsageCredits(data, [], settings).total, null);
  assert.equal(estimateUsageCredits({ ...data, runtime: "ghcp" }, [row], settings).total, null);
});
function fixture(): NativeTokenUsage {
  return { version: 1, runtime: "codex", inputAccounting: "includes-cache", attribution: "root-agent", timeBasis: "observed-at", coverage: "partial", from: 60_000, to: 120_000, bucketMs: 60_000, observedSince: 60_000, buckets: [{ ...row, at: 60_000, models: [row] }] };
}
test("dated tariffs preserve old estimates and select exact bucket boundaries", () => {
  const key = creditRateKey("codex", "example");
  const old = addCreditTariff({}, key, 60_000, rates);
  const next = addCreditTariff(old, key, 120_000, { ...rates, outputTokens: "40" });
  assert.equal(old[key]!.length, 1, "immutable history");
  assert.equal(estimateUsageCredits(fixture(), [row], next).total, 10.4);
  const data = { ...fixture(), to: 180_000, buckets: [...fixture().buckets, { ...row, at: 120_000, models: [row] }] };
  assert.equal(estimateUsageCredits(data, [row], next).total, 24.8);
  assert.deepEqual(readCreditSettings(serializeCreditSettings(next)), next);
});
test("an intra-bucket tariff boundary is unknown, never prorated", () => {
  const key = creditRateKey("codex", "example");
  const settings = addCreditTariff(addCreditTariff({}, key, 0, rates), key, 90_000, rates);
  assert.equal(estimateUsageCredits(fixture(), [row], settings).total, null);
  assert.equal(estimateUsageCredits(fixture(), [row], settings).rows[0]!.reason, "tariff-boundary");
  const clipped = { ...fixture(), from: 90_000 };
  assert.equal(estimateUsageCredits(clipped, [row], settings).total, 10.4);
  assert.equal(estimateUsageCredits({ ...fixture(), to: 90_000 }, [row], settings).total, 10.4);
});
test("no prior tariff stays unknown; legacy baseline remains available before dated rates", () => {
  const key = creditRateKey("codex", "example"), data = fixture();
  assert.equal(estimateUsageCredits(data, [row], addCreditTariff({}, key, 120_000, rates)).total, null);
  const migrated = readCreditSettings(JSON.stringify({ version: 1, rates: [[key, rates]] }));
  assert.equal(estimateUsageCredits(data, [row], addCreditTariff(migrated, key, 120_000, rates)).total, 10.4);
});
test("history cannot be silently overwritten, truncated or loaded with ambiguous dates", () => {
  const key = creditRateKey("codex", "example"), settings = addCreditTariff({}, key, 60_000, rates);
  assert.throws(() => addCreditTariff(settings, key, 60_000, rates));
  assert.equal(addCreditTariff(settings, key, 60_000, { ...rates, outputTokens: "40" }, true)[key]![0]!.rates.outputTokens, "40");
  for (const date of [-1, NaN, Infinity, 1.5, 8.64e15 + 1]) assert.throws(() => addCreditTariff({}, key, date, rates));
  for (const history of [[{ effectiveFrom: -1, rates }], [{ effectiveFrom: 0, rates }, { effectiveFrom: 0, rates }], [{ effectiveFrom: 1, rates }, { effectiveFrom: null, rates }]]) {
    assert.deepEqual(readCreditSettings(JSON.stringify({ version: 2, rates: [[key, history]] })), {});
  }
  const full = { [key]: Array.from({ length: 32 }, (_, effectiveFrom) => ({ effectiveFrom, rates })) };
  assert.throws(() => addCreditTariff(full, key, 33, rates));
  assert.equal(full[key]!.length, 32);
  assert.throws(() => serializeCreditSettings(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [creditRateKey("codex", String(i)), settings[key]!]))));
});
test("missing counters in any bucket keep the full model estimate unknown", () => {
  const settings = addCreditTariff({}, creditRateKey("codex", "example"), 0, rates);
  const unknown = { ...row, cacheReadTokens: null };
  const data = { ...fixture(), to: 240_000, buckets: [...fixture().buckets, { ...unknown, at: 120_000, models: [unknown] }, { ...row, at: 180_000, models: [row] }] };
  assert.equal(estimateUsageCredits(data, [row], settings).total, null);
  assert.equal(estimateUsageCredits({ ...fixture(), inputAccounting: "provider-defined" }, [row], settings).total, null);
  const zero = { ...row, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  assert.equal(estimateUsageCredits({ ...fixture(), buckets: [{ ...zero, at: 60_000, models: [zero] }] }, [zero], addCreditTariff({}, creditRateKey("codex", "example"), 0, emptyCreditRates())).total, 0);
});
test("global history and serialized text budgets reject growth instead of trimming", () => {
  const history = Array.from({ length: 32 }, (_, effectiveFrom) => ({ effectiveFrom, rates }));
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [creditRateKey("codex", String(i)), history]));
  assert.throws(() => serializeCreditSettings(tooMany));
  assert.deepEqual(readCreditSettings(JSON.stringify({ version: 2, rates: Object.entries(tooMany) })), {});
  const tooLarge = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [creditRateKey("codex", 'x'.repeat(450) + i), [{ effectiveFrom: 0, rates }]]));
  assert.throws(() => serializeCreditSettings(tooLarge));
});

test("GHCP built-in defaults estimate credits without manual rate input while preserving explicit overrides", () => {
  const ghcpRow = { ...row, model: "gpt-4o" };
  const ghcpData: NativeTokenUsage = {
    ...fixture(),
    runtime: "ghcp",
    inputAccounting: "provider-defined",
    buckets: [{ ...ghcpRow, at: 60_000, models: [ghcpRow] }],
  };
  const autoEstimate = estimateUsageCreditsWithDefaults(ghcpData, [ghcpRow], {});
  assert.ok(autoEstimate.total !== null && autoEstimate.total > 0);
  assert.equal(autoEstimate.covered, 1);
  assert.equal(defaultGhcpCreditRates("gpt-4o-mini")?.inputTokens, "0.3");
});
