import { useMemo, useRef, useState } from "react";
import type { NativeTokenUsage } from "@agentopsdeck/shared";
import type { UsageModel } from "../lib/token-usage-view";
import { addCreditTariff, creditFields, creditRateKey, defaultGhcpCreditRates, emptyCreditRates, estimateUsageCreditsWithDefaults, parseCreditRate, readCreditSettings, serializeCreditSettings, validCreditDate, type CreditRates, type CreditSettings } from "../lib/usage-credits";
import { useI18n } from "../lib/i18n";

const storageKey = "agentopsdeck.usage-credit-rates.v2";
const readStored = () => readCreditSettings(localStorage.getItem(storageKey) ?? localStorage.getItem("agentopsdeck.usage-credit-rates.v1"));
const localTime = (at: number) => { const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const format = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const labels = { inputTokens: "Non-cached input", outputTokens: "Output tokens", cacheReadTokens: "Cache read", cacheWriteTokens: "Cache write" } as const;
export function UsageCredits({ data, models }: { data: NativeTokenUsage; models: UsageModel[] }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState(() => { try { return readStored(); } catch { return {}; } });
  const unpersisted = useRef<CreditSettings>({});
  const [model, setModel] = useState(() => models.find(row => row.model !== null)?.model ?? "");
  const key = creditRateKey(data.runtime, model);
  const [draft, setDraft] = useState<CreditRates>(() => settings[key]?.at(-1)?.rates ?? (data.runtime === "ghcp" ? defaultGhcpCreditRates(model) : undefined) ?? emptyCreditRates());
  const [effective, setEffective] = useState(() => localTime(data.from));
  const [replace, setReplace] = useState(false), [saveError, setSaveError] = useState<"" | "A rate already exists at this time. Confirm replacement to change it." | "Credit history limit reached or configuration invalid. Existing rates were kept.">("");
  const effectiveFrom = effective ? new Date(effective).getTime() : NaN;
  const history = settings[key] ?? [];
  const existing = history.some(tariff => tariff.effectiveFrom === effectiveFrom);
  const [saved, setSaved] = useState(false), [storageError, setStorageError] = useState(false);
  const estimate = useMemo(() => estimateUsageCreditsWithDefaults(data, models, settings), [data, models, settings]);
  const fields = data.inputAccounting === "includes-cache" ? creditFields.slice(0, 3) : creditFields;
  const validRates = fields.every(field => draft[field] === "" || parseCreditRate(draft[field]) !== null);
  const valid = validRates && validCreditDate(effectiveFrom) && (!existing || replace);
  const selectModel = (next: string) => { setModel(next); setDraft(settings[creditRateKey(data.runtime, next)]?.at(-1)?.rates ?? (data.runtime === "ghcp" ? defaultGhcpCreditRates(next) : undefined) ?? emptyCreditRates()); setSaved(false); setReplace(false); setSaveError(""); };
  return <section className="session-usage-credits" aria-label={t("Estimated credits")}>
    <div className="session-usage-credit-summary"><div><h3>{t("Estimated credits")}</h3><p>{t(data.runtime === "ghcp" ? "Selected period · built-in GHCP defaults or custom rates · not a bill" : "Selected period · configured rates · not a bill")}</p></div><strong data-credit-total>{format(estimate.total)}</strong></div>
    <p className="session-usage-credit-note">{t("Models estimated: {covered} / {total}", { covered: estimate.covered, total: models.length })} · {t("Missing rates, model or counters are not zero cost.")}</p>
    <details><summary>{t("Credit rates and model estimates")}</summary>
      <p>{t("User-configured credits per 1M tokens · stored in this browser · no official pricing assumed.")}</p>
      <p>{t("Rates follow observed time, not provider billing time. A bucket spanning a rate change cannot be estimated; try finer aggregation.")}</p>
      <p>{t(data.inputAccounting === "includes-cache" ? "Input rate covers all input except cache reads; no separate cache creation charge is assumed." : data.inputAccounting === "excludes-cache" ? "Input, output, cache reads and cache writes are charged separately." : "Provider accounting is unknown; credit estimation is unavailable.")}</p>
      {model && data.inputAccounting !== "provider-defined" ? <form onSubmit={event => {
        event.preventDefault(); if (!valid) return;
        setSaveError("");
        let latest = settings;
        try { latest = { ...settings, ...readStored() }; } catch { /* Panel-only fallback remains available. */ }
        // Keep panel-only edits across subsequent saves, while retaining other saved dates.
        for (const [pendingKey, pending] of Object.entries(unpersisted.current)) {
          latest = { ...latest, [pendingKey]: [...new Map([...(latest[pendingKey] ?? []), ...pending].map(tariff => [tariff.effectiveFrom, tariff])).values()]
            .sort((a, b) => (a.effectiveFrom ?? -Infinity) - (b.effectiveFrom ?? -Infinity)) };
        }
        if (!replace && latest[key]?.some(tariff => tariff.effectiveFrom === effectiveFrom)) {
          setSettings(latest); setSaveError("A rate already exists at this time. Confirm replacement to change it."); return;
        }
        let next;
        try { next = addCreditTariff(latest, key, effectiveFrom, Object.fromEntries(creditFields.map(field => [field, draft[field].trim()])) as CreditRates, replace); }
        catch { setSaveError("Credit history limit reached or configuration invalid. Existing rates were kept."); return; }
        setSettings(next); setSaved(true); setStorageError(false);
        setReplace(false);
        try { localStorage.setItem(storageKey, serializeCreditSettings(next)); unpersisted.current = {}; }
        catch {
          setStorageError(true);
          unpersisted.current = addCreditTariff(unpersisted.current, key, effectiveFrom, next[key]!.find(tariff => tariff.effectiveFrom === effectiveFrom)!.rates, true);
        }
      }}><label className="session-usage-credit-model">{t("Model")}<select name="usagecredits-select-1" value={model} onChange={event => selectModel(event.target.value)}>{models.filter(row => row.model !== null).map(row => <option key={row.model!} value={row.model!}>{row.model}</option>)}</select></label>
        <label className="session-usage-credit-effective">{t("Effective from (local time)")}<input name="usagecredits-input-2" type="datetime-local" step="60" value={effective} required aria-invalid={!validCreditDate(effectiveFrom)} onChange={event => { setEffective(event.target.value); setReplace(false); setSaved(false); setSaveError(""); }} /></label>
        {existing ? <label className="session-usage-credit-replace"><input name="usagecredits-input-3" type="checkbox" checked={replace} onChange={event => { setReplace(event.target.checked); setSaved(false); }} />{t("Replace the saved rate at this time (changes historical estimates).")}</label> : null}
        <div className="session-usage-credit-rates">{fields.map(field => <label key={field}>{t(labels[field])}<input name="usagecredits-input-4" inputMode="decimal" autoComplete="off" value={draft[field]} placeholder="—" maxLength={22} aria-invalid={draft[field] !== "" && parseCreditRate(draft[field]) === null} onChange={event => { setDraft(previous => ({ ...previous, [field]: event.target.value })); setSaved(false); }} /></label>)}</div>
        <div className="session-usage-credit-actions"><button type="submit" disabled={!valid}>{t("Apply credit rates")}</button><span role="status">{saveError ? t(saveError) : !validRates ? t("Enter a non-negative rate, or leave blank for unknown.") : !validCreditDate(effectiveFrom) ? t("Choose a valid effective time.") : saved ? t(storageError ? "Applied for this panel only; browser storage unavailable." : "Credit rates saved in this browser.") : null}</span></div>
      </form> : null}
      {history.length ? <details className="session-usage-credit-history"><summary>{t("Saved rate history")} · {history.length}</summary><ul>{[...history].reverse().map(tariff => <li key={tariff.effectiveFrom ?? "legacy"}>
        <button type="button" onClick={() => { setDraft(tariff.rates); setEffective(localTime(tariff.effectiveFrom ?? data.from)); setReplace(false); setSaved(false); setSaveError(""); }}>{tariff.effectiveFrom === null ? t("Legacy rate · before the first dated rate") : new Date(tariff.effectiveFrom).toLocaleString()}</button>
        <dl>{fields.map(field => <div key={field}><dt>{t(labels[field])}</dt><dd>{tariff.rates[field] || "—"}</dd></div>)}</dl>
      </li>)}</ul></details> : null}
      <ul className="session-usage-credit-breakdown">{estimate.rows.map(row => <li key={row.model ?? ""}><span>{row.model ?? t("Unknown model")}{row.reason === "tariff-boundary" ? <small>{t("Rate change inside bucket · estimate unavailable")}</small> : null}</span><b>{format(row.credits)}</b></li>)}</ul>
    </details>
  </section>;
}
