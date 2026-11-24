import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { SessionSkills as Skills } from "@agentopsdeck/shared";
import { api, ApiResponseError, subscribeRecoveryScope } from "../api";
import { useI18n } from "../lib/i18n";

export default function SessionSkillsPanel({ sessionKey, close }: { sessionKey: string; close: () => void }) {
  const { t } = useI18n();
  const title = useId(), dialog = useRef<HTMLDialogElement>(null), request = useRef<AbortController | undefined>(undefined);
  const [data, setData] = useState<Skills>(), [loading, setLoading] = useState(true);
  const [error, setError] = useState<"unsupported" | "failed">();
  const [query, setQuery] = useState("");
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(undefined); setData(undefined);
    try {
      const value = await api.sessionSkills(sessionKey, controller.signal);
      if (!controller.signal.aborted) setData(value);
    } catch (issue) {
      if (!controller.signal.aborted) setError(issue instanceof ApiResponseError && [404, 409].includes(issue.status) ? "unsupported" : "failed");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    const finish = () => { request.current?.abort(); closeRef.current(); };
    const unsubscribe = subscribeRecoveryScope(finish);
    element?.showModal();
    window.addEventListener("agentopsdeck:auth-required", finish);
    window.addEventListener("pagehide", finish);
    void load();
    return () => {
      request.current?.abort(); unsubscribe(); element?.close();
      window.removeEventListener("agentopsdeck:auth-required", finish);
      window.removeEventListener("pagehide", finish);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [sessionKey]);
  return createPortal(<dialog ref={dialog} className="session-files-dialog session-skills-dialog" data-font-area="chat" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section><header><div><h2 id={title}>{t("Session skills")}</h2><p>{t("Discovered for this session directory · read-only")}</p></div>
      <button type="button" autoFocus onClick={close} aria-label={t("Close")}><X size={18} /></button></header>
      <div className="session-skills-body">
        <p className="session-files-note">{t("Enabled means available to Codex, not loaded or used in this turn. Actual usage is unknown.")}</p>
        <div className="session-skills-filter"><input name="sessionskills-input-1" type="search" maxLength={256} aria-label={t("Filter skills")} placeholder={t("Filter skills")} value={query} onChange={e => setQuery(e.target.value)} />
          <button type="button" disabled={loading} onClick={() => void load()}>{t("Refresh")}</button></div>
        {loading ? <p role="status">{t("Reading skills…")}</p> : null}
        {error ? <p role="status">{t(error === "unsupported" ? "This Connector does not provide session skills discovery." : "Skill discovery unavailable. Retry when Codex is ready; no automatic retry.")}</p> : null}
        {data ? <>
          <p className="session-files-note">{t("Discovery snapshot")} · {new Date(data.observedAt).toLocaleTimeString()}{data.limited ? ` · ${t("Results limited")}` : ""}
            {data.discoveryErrors ? ` · ${t("Some skills could not be discovered")}: ${data.discoveryErrors}` : ""}</p>
          {!data.skills.length ? <p>{t("No skills reported for this directory.")}</p> : null}
          <ul className="session-skills-list">{data.skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase())).map((s, i) => <li key={`${s.scope}:${s.name}:${i}`}>
            <div><strong>{s.name}</strong><span className={s.enabled ? "skill-enabled" : "skill-disabled"}>{t(s.enabled ? "Enabled" : "Disabled")}</span><small>{t(s.scope === "repo" ? "Project skill" : s.scope === "system" ? "System skill" : s.scope === "admin" ? "Admin skill" : "User skill")}</small></div>
            <p>{s.description}</p>
          </li>)}</ul>
        </> : null}
      </div>
    </section>
  </dialog>, document.body);
}
