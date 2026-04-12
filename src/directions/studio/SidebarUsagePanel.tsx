import { useEffect } from "react";

import { buildCodexUsageRows } from "../../lib/codex-usage";
import type { WorkspaceSnapshot } from "../../lib/types";
import { selectSelectedEnvironment, useWorkspaceStore } from "../../stores/workspace-store";
import { useCodexUsageStore } from "../../stores/codex-usage-store";
import "./SidebarUsagePanel.css";

export function SidebarUsagePanel() {
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const ensureAccountUsage = useCodexUsageStore((state) => state.ensureAccountUsage);
  const snapshot = useCodexUsageStore((state) => state.snapshot);
  const loading = useCodexUsageStore((state) => state.loading);
  const error = useCodexUsageStore((state) => state.error);
  const hasWorkspaceEnvironment =
    workspaceSnapshot?.projects.some(
      (project) => project.environments.length > 0,
    ) ?? false;
  const sourceEnvironmentId = resolveUsageSourceEnvironmentId(
    workspaceSnapshot,
    selectedEnvironment?.id ?? null,
  );

  useEffect(() => {
    void ensureAccountUsage(sourceEnvironmentId);
  }, [ensureAccountUsage, sourceEnvironmentId]);

  const rows = buildCodexUsageRows(snapshot);
  const showLoadingState = loading && snapshot === null;
  const placeholder = resolveUsagePlaceholder(
    hasWorkspaceEnvironment,
    snapshot !== null,
    showLoadingState,
    error,
    rows,
  );

  return (
    <section className="sidebar-usage" aria-label="Codex usage">
      <span className="sidebar-usage__title tx-section-label">Usage</span>

      <div className="sidebar-usage__rows">
        {rows.map((row) => {
          const percentLabel = row.percentUsed === null ? "--" : `${row.percentUsed}%`;
          const fillWidth = showLoadingState ? "100%" : `${row.percentUsed ?? 0}%`;

          return (
            <div key={row.label} className="sidebar-usage__row">
              <div className="sidebar-usage__row-header">
                <span className="sidebar-usage__label">{row.label}</span>
                <span className="sidebar-usage__value">{percentLabel}</span>
              </div>
              <div className="sidebar-usage__bar">
                <span
                  className={`sidebar-usage__fill sidebar-usage__fill--${row.label.toLowerCase()} ${
                    showLoadingState ? "sidebar-usage__fill--loading" : ""
                  }`}
                  style={{ width: fillWidth }}
                />
              </div>
              <span
                className={`sidebar-usage__reset ${
                  row.percentUsed === null ? "sidebar-usage__reset--muted" : ""
                }`}
              >
                {showLoadingState ? "Loading…" : row.resetLabel}
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
  hasWorkspaceEnvironment: boolean,
  hasSnapshot: boolean,
  loading: boolean,
  error: string | null,
  rows: ReturnType<typeof buildCodexUsageRows>,
) {
  if (!hasWorkspaceEnvironment && !hasSnapshot) {
    return "Add a project to inspect Codex usage.";
  }
  if (!loading && error) {
    return error;
  }
  if (!loading && hasSnapshot && rows.every((row) => row.percentUsed === null)) {
    return "Usage unavailable for this account.";
  }
  return null;
}

function resolveUsageSourceEnvironmentId(
  snapshot: WorkspaceSnapshot | null,
  selectedEnvironmentId: string | null,
) {
  if (!snapshot) {
    return null;
  }

  const selectedEnvironment =
    snapshot.projects
      .flatMap((project) => project.environments)
      .find((environment) => environment.id === selectedEnvironmentId) ?? null;

  return selectedEnvironment?.id ?? null;
}
