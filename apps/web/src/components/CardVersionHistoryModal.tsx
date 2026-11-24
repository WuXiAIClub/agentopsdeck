import { Download, History, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  clearCardVersionSnapshots,
  computeCardVersionDiffSummary,
  formatCardSnapshotPreview,
  listCardVersionSnapshots,
  recordCardVersionSnapshot,
  type CardVersionKind,
  type CardVersionSource,
} from "../lib/card-version-history";
import { useI18n } from "../lib/i18n";

type CompareMode = "previous" | "current" | "full";

export default function CardVersionHistoryModal({
  scope,
  kind,
  resourceId,
  title,
  currentPayload,
  disabled,
  onRestore,
  onClose,
}: {
  scope: string | undefined;
  kind: CardVersionKind;
  resourceId: string;
  title?: string | undefined;
  currentPayload: string;
  disabled?: boolean | undefined;
  onRestore: (payload: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [refreshTick, setRefreshTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [compareMode, setCompareMode] = useState<CompareMode>("previous");
  const [manualLabel, setManualLabel] = useState("");

  const snapshots = useMemo(
    () => listCardVersionSnapshots(scope, kind, resourceId),
    [scope, kind, resourceId, refreshTick],
  );

  const filteredSnapshots = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return snapshots;
    return snapshots.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.payload.toLowerCase().includes(q),
    );
  }, [snapshots, searchQuery]);

  const [selectedId, setSelectedId] = useState<string | undefined>(() => snapshots[0]?.id);
  const selected = useMemo(
    () => filteredSnapshots.find((item) => item.id === selectedId) ?? filteredSnapshots[0],
    [filteredSnapshots, selectedId],
  );

  const selectedIndex = useMemo(
    () => (selected ? snapshots.findIndex((item) => item.id === selected.id) : -1),
    [snapshots, selected],
  );

  const diffSummary = useMemo(() => {
    if (!selected) return { lines: [], addedCount: 0, removedCount: 0, unchangedCount: 0 };
    if (compareMode === "current") {
      return computeCardVersionDiffSummary(currentPayload, selected.payload, kind);
    }
    const olderSnapshot = selectedIndex >= 0 ? snapshots[selectedIndex + 1] : undefined;
    const baseline = olderSnapshot ? olderSnapshot.payload : "";
    return computeCardVersionDiffSummary(baseline, selected.payload, kind);
  }, [selected, selectedIndex, snapshots, currentPayload, kind, compareMode]);

  const formattedFullPreview = useMemo(
    () => (selected ? formatCardSnapshotPreview(selected.payload, kind) : ""),
    [selected, kind],
  );

  const sourceBadgeLabel = (source?: CardVersionSource) => {
    if (source === "manual") return t("Manual save");
    if (source === "pre-restore") return t("Pre-restore backup");
    if (source === "initial") return t("Initial state");
    return t("Auto-saved");
  };

  const handleCreateManualSnapshot = () => {
    if (!currentPayload || !currentPayload.trim()) return;
    const tag = manualLabel.trim() || `v${snapshots.length + 1}`;
    recordCardVersionSnapshot({
      scope,
      kind,
      resourceId,
      payload: currentPayload,
      label: tag,
      summary: `${tag} · ${currentPayload.length} chars`,
      source: "manual",
      force: true,
    });
    setManualLabel("");
    setRefreshTick((n) => n + 1);
  };

  const handleExportJson = () => {
    if (!selected || typeof document === "undefined") return;
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agentopsdeck-${kind}-${resourceId}-${selected.label}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop card-version-history-backdrop" role="dialog" aria-modal="true" aria-label={t("Version history")}>
      <div className="modal-card card-version-history-modal">
        <header className="card-version-history-header">
          <div className="card-version-history-title">
            <History size={16} />
            <strong>{title ? `${title} · ${t("Version history")}` : t("Version history")}</strong>
            <span className="card-version-history-badge">{snapshots.length}</span>
          </div>
          <div className="card-version-history-actions">
            <div className="card-version-manual-create">
              <input
                name="version-snapshot-tag"
                type="text"
                value={manualLabel}
                placeholder={t("Snapshot tag…")}
                aria-label={t("Snapshot tag…")}
                onChange={(e) => setManualLabel(e.target.value)}
              />
              <button
                type="button"
                className="ghost-btn"
                disabled={!currentPayload || !currentPayload.trim()}
                onClick={handleCreateManualSnapshot}
                title={t("Create snapshot now")}
              >
                <Plus size={14} />
                <span>{t("Save snapshot")}</span>
              </button>
            </div>
            {snapshots.length > 0 ? (
              <button
                type="button"
                className="ghost-btn"
                title={t("Clear version history")}
                aria-label={t("Clear version history")}
                onClick={() => {
                  clearCardVersionSnapshots(scope, kind, resourceId);
                  setRefreshTick((n) => n + 1);
                }}
              >
                <Trash2 size={14} />
              </button>
            ) : null}
            <button type="button" className="ghost-btn" aria-label={t("Close")} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>

        {snapshots.length === 0 ? (
          <p className="card-version-history-empty">
            {t("No version snapshots recorded yet. Edits and saves automatically capture restore points.")}
          </p>
        ) : (
          <div className="card-version-history-body">
            <aside className="card-version-history-list" aria-label={t("Saved versions")}>
              <div className="card-version-search-box">
                <Search size={13} />
                <input
                  name="version-history-search"
                  type="search"
                  value={searchQuery}
                  placeholder={t("Filter snapshots…")}
                  aria-label={t("Filter snapshots…")}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              {filteredSnapshots.map((item) => {
                const active = item.id === selected?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`card-version-history-item${active ? " is-active" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div className="card-version-history-item-top">
                      <strong>{item.label}</strong>
                      <span className={`card-version-source-pill is-${item.source ?? "auto"}`}>
                        {sourceBadgeLabel(item.source)}
                      </span>
                    </div>
                    <div className="card-version-history-item-meta">
                      <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                      <span>#{item.hash.slice(0, 6)}</span>
                    </div>
                    <div className="card-version-history-item-summary">{item.summary}</div>
                  </button>
                );
              })}
            </aside>
            <div className="card-version-history-preview">
              {selected ? (
                <>
                  <div className="card-version-history-preview-bar">
                    <div className="card-version-compare-tabs" role="group" aria-label={t("Version diff preview")}>
                      <button
                        type="button"
                        className={compareMode === "previous" ? "is-active" : undefined}
                        onClick={() => setCompareMode("previous")}
                      >
                        {t("Diff vs previous")}
                      </button>
                      <button
                        type="button"
                        className={compareMode === "current" ? "is-active" : undefined}
                        onClick={() => setCompareMode("current")}
                      >
                        {t("Diff vs current")}
                      </button>
                      <button
                        type="button"
                        className={compareMode === "full" ? "is-active" : undefined}
                        onClick={() => setCompareMode("full")}
                      >
                        {t("Full preview")}
                      </button>
                    </div>
                    <div className="card-version-diff-stats">
                      <span className="diff-stat-add">+{diffSummary.addedCount}</span>
                      <span className="diff-stat-remove">-{diffSummary.removedCount}</span>
                    </div>
                    <div className="card-version-restore-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        title={t("Export snapshot JSON")}
                        aria-label={t("Export snapshot JSON")}
                        onClick={handleExportJson}
                      >
                        <Download size={14} />
                      </button>
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={Boolean(disabled) || selected.payload === currentPayload}
                        onClick={() => {
                          if (currentPayload && currentPayload.trim() && currentPayload !== selected.payload) {
                            recordCardVersionSnapshot({
                              scope,
                              kind,
                              resourceId,
                              payload: currentPayload,
                              summary: `${t("Pre-restore backup")} (${currentPayload.length} chars)`,
                              source: "pre-restore",
                              force: true,
                            });
                          }
                          onRestore(selected.payload);
                          onClose();
                        }}
                      >
                        <RotateCcw size={14} />
                        <span>{t("Restore this version")}</span>
                      </button>
                    </div>
                  </div>
                  {compareMode === "full" ? (
                    <pre className="card-version-full-box" aria-label={t("Full preview")}>
                      {formattedFullPreview || t("(Empty snapshot)")}
                    </pre>
                  ) : diffSummary.addedCount === 0 && diffSummary.removedCount === 0 ? (
                    <div className="card-version-identical-banner">
                      {t("Identical to previous snapshot")}
                    </div>
                  ) : (
                    <div className="card-version-diff-box" aria-label={t("Version diff preview")}>
                      {diffSummary.lines.map((line, index) => (
                        <div key={index} className={`card-version-diff-line diff-${line.type}`}>
                          <span className="diff-lineno">{line.newLineNumber ?? line.oldLineNumber ?? ""}</span>
                          <span className="diff-marker">
                            {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                          </span>
                          <code>{line.text || " "}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="card-version-history-empty">{t("Select a snapshot to inspect")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
