import React, { lazy, Suspense, useState } from "react";
import { BookOpen, Sparkles } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { CaptionIconButton } from "./CaptionIconButton";

const SkillsPanel = lazy(() => import("./SessionSkillsPanel"));

export function SessionSkills({ sessionKey, caption = false }: { sessionKey: string; caption?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <>{caption ? <CaptionIconButton className="session-skills-trigger" label={t("Session skills")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><BookOpen size={14} aria-hidden="true" /></CaptionIconButton>
    : <button type="button" className="session-insights-trigger session-skills-trigger desktop-chat-toolbar-control" title={t("Session skills")} aria-label={t("Session skills")}
    aria-haspopup="dialog" onClick={() => setOpen(true)}><Sparkles size={15} /><span>{t("Skills")}</span></button>}
    {open ? <Suspense fallback={<span role="status">{t("Loading…")}</span>}><SkillsPanel key={sessionKey} sessionKey={sessionKey} close={() => setOpen(false)} /></Suspense> : null}</>;
}
