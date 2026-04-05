import { useEffect } from "react";

import { buildCodexUsageRows } from "../../lib/codex-usage";
import { selectSelectedEnvironment, useWorkspaceStore } from "../../stores/workspace-store";
import { useCodexUsageStore } from "../../stores/codex-usage-store";
import "./SidebarUsagePanel.css";

export function SidebarUsagePanel() {
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const ensureEnvironmentUsage = useCodexUsageStore((state) => state.ensureEnvironmentUsage);
  const snapshot = useCodexUsageStore(
    (state) =>
      (selectedEnvironment ? state.snapshotsByEnvironmentId[selectedEnvironment.id] : null) ?? null,
  );
  const loading = useCodexUsageStore(
    (state) => (selectedEnvironment ? state.loadingByEnvironmentId[selectedEnvironment.id] : false) ?? false,
  );
  const error = useCodexUsageStore(
    (state) => (selectedEnvironment ? state.errorByEnvironmentId[selectedEnvironment.id] : null) ?? null,
  );

  useEffect(() => {
    void ensureEnvironmentUsage(selectedEnvironment?.id ?? null);
  }, [ensureEnvironmentUsage, selectedEnvironment?.id]);

  const rows = buildCodexUsageRows(snapshot);
  const placeholder = resolveUsagePlaceholder(
    selectedEnvironment !== null,
    snapshot !== null,
    loading,
    error,
    rows,
  );

  return (
    <section className="sidebar-usage" aria-label="Codex usage">
      <div className="sidebar-usage__header">
        <span className="sidebar-usage__title">Usage</span>
        <span className="sidebar-usage__subtitle">
          {selectedEnvironment?.name ?? "No environment selected"}
        </span>
      </div>

      <div className="sidebar-usage__rows">
        {rows.map((row) => {
          const percentLabel = row.percentUsed === null ? "--" : `${row.percentUsed}%`;
          const fillWidth = loading ? "42%" : `${row.percentUsed ?? 0}%`;

          return (
            <div key={row.label} className="sidebar-usage__row">
              <div className="sidebar-usage__row-header">
                <span className="sidebar-usage__label">{row.label}</span>
                <span className="sidebar-usage__value">{percentLabel}</span>
              </div>
              <div className="sidebar-usage__bar">
                <span
                  className={`sidebar-usage__fill sidebar-usage__fill--${row.label.toLowerCase()} ${
                    loading ? "sidebar-usage__fill--loading" : ""
                  }`}
                  style={{ width: fillWidth }}
                />
              </div>
              <span
                className={`sidebar-usage__reset ${
                  row.percentUsed === null ? "sidebar-usage__reset--muted" : ""
                }`}
              >
                {loading ? "Loading…" : row.resetLabel}
              </span>
            </div>
          );
        })}
      </div>

      {placeholder ? <p className="sidebar-usage__placeholder">{placeholder}</p> : null}
    </section>
  );
}

function resolveUsagePlaceholder(
  hasEnvironment: boolean,
  hasSnapshot: boolean,
  loading: boolean,
  error: string | null,
  rows: ReturnType<typeof buildCodexUsageRows>,
) {
  if (!hasEnvironment) {
    return "Select an environment to inspect Codex usage.";
  }
  if (!loading && error) {
    return error;
  }
  if (!loading && hasSnapshot && rows.every((row) => row.percentUsed === null)) {
    return "Usage unavailable for this environment.";
  }
  return null;
}
