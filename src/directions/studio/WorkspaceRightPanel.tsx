import { useEffect, useMemo, useRef, useState } from "react";

import {
  useConversationStore,
  selectConversationSnapshot,
} from "../../stores/conversation-store";
import {
  selectGitReviewError,
  selectGitReviewScope,
  selectGitReviewSelectedFile,
  selectGitReviewSnapshot,
  selectGitReviewDiffCollection,
  selectGitReviewDiffError,
  useGitReviewStore,
} from "../../stores/git-review-store";
import {
  selectEffectiveNonChatEnvironment,
  selectSelectedThread,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import type {
  GitChangeSection,
  GitFileChange,
  GitFileDiff,
  GitReviewScope,
  GitReviewSnapshot,
} from "../../lib/types";
import {
  ChevronRightIcon,
  CloseIcon,
  GlobeIcon,
} from "../../shared/Icons";
import { BrowserPanel } from "./BrowserPanel";
import { GitDiffViewer } from "./GitDiffViewer";
import { labelForGitChangeKind } from "./git-change-kind";
import "./WorkspaceRightPanel.css";

export type WorkspaceRightPanelTab = "diff" | "browser";

const RIGHT_PANEL_TABS: Array<{
  id: WorkspaceRightPanelTab;
  label: string;
}> = [
  { id: "diff", label: "Review" },
  { id: "browser", label: "Browser" },
];

export function WorkspaceRightPanel({
  activeTab,
  collapsed = false,
  onTabChange,
  onClose,
}: {
  activeTab: WorkspaceRightPanelTab;
  collapsed?: boolean;
  onTabChange: (tab: WorkspaceRightPanelTab) => void;
  onClose: () => void;
}) {
  const selectedEnvironment = useWorkspaceStore(selectEffectiveNonChatEnvironment);
  const selectedThread = useWorkspaceStore(selectSelectedThread);
  const selectedEnvironmentId = selectedEnvironment?.id ?? null;
  const selectedThreadId = selectedThread?.id ?? null;
  const conversationSnapshot = useConversationStore(
    selectConversationSnapshot(selectedThreadId),
  );

  const scope = useGitReviewStore(selectGitReviewScope(selectedEnvironmentId));
  const snapshot = useGitReviewStore(
    selectGitReviewSnapshot(selectedEnvironmentId, scope),
  );
  const selectedFileKey = useGitReviewStore(
    selectGitReviewSelectedFile(selectedEnvironmentId, scope),
  );
  const error = useGitReviewStore(selectGitReviewError(selectedEnvironmentId, scope));
  const loading = useGitReviewStore(
    (state) =>
      (selectedEnvironment
        ? state.loadingByContext[`${selectedEnvironment.id}:${scope}`]
        : false) ?? false,
  );

  const loadReview = useGitReviewStore((state) => state.loadReview);
  const refreshReview = useGitReviewStore((state) => state.refreshReview);
  const selectFile = useGitReviewStore((state) => state.selectFile);

  const previousTurnRef = useRef<{ threadId: string | null; activeTurnId: string | null }>({
    threadId: null,
    activeTurnId: null,
  });

  useEffect(() => {
    if (collapsed || !selectedEnvironmentId) {
      return;
    }
    void loadReview(selectedEnvironmentId);
  }, [collapsed, loadReview, selectedEnvironmentId]);

  useEffect(() => {
    if (!selectedEnvironmentId || !selectedThreadId) {
      previousTurnRef.current = { threadId: null, activeTurnId: null };
      return;
    }

    const previous = previousTurnRef.current;
    const currentActiveTurnId = conversationSnapshot?.activeTurnId ?? null;
    const shouldRefresh =
      previous.threadId === selectedThreadId &&
      Boolean(previous.activeTurnId) &&
      !currentActiveTurnId;

    previousTurnRef.current = {
      threadId: selectedThreadId,
      activeTurnId: currentActiveTurnId,
    };

    if (shouldRefresh) {
      void refreshReview(selectedEnvironmentId);
    }
  }, [
    conversationSnapshot?.activeTurnId,
    refreshReview,
    selectedEnvironmentId,
    selectedThreadId,
  ]);

  function selectChangedFile(section: GitChangeSection, path: string) {
    if (!selectedEnvironment) return;
    void selectFile(selectedEnvironment.id, scope, section, path);
  }

  return (
    <aside
      className={`workspace-right-panel ${collapsed ? "workspace-right-panel--collapsed" : ""}`}
      data-testid="workspace-right-panel"
      inert={collapsed || undefined}
    >
      <div className="workspace-right-panel__header">
        <div className="workspace-right-panel__tabs" role="tablist" aria-label="Right panel">
          {RIGHT_PANEL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`workspace-right-panel__tab ${
                activeTab === tab.id ? "workspace-right-panel__tab--active" : ""
              }`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.id === "browser" ? <GlobeIcon size={12} /> : null}
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="workspace-right-panel__close"
          aria-label="Close right panel"
          title="Close right panel"
          onClick={onClose}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="workspace-right-panel__body">
        <section
          className={`workspace-right-panel__tab-panel ${
            activeTab === "diff" ? "" : "workspace-right-panel__tab-panel--hidden"
          }`}
          role="tabpanel"
          aria-label="Review"
        >
          {!selectedEnvironment ? (
            <p className="workspace-right-panel__empty">
              Select an environment to inspect its Git state.
            </p>
          ) : snapshot ? (
            <DiffReviewSurface
              error={error}
              loading={loading}
              scope={scope}
              selectedEnvironmentId={selectedEnvironment.id}
              selectedFileKey={selectedFileKey}
              snapshot={snapshot}
              onSelectFile={selectChangedFile}
            />
          ) : error ? (
            <p className="workspace-right-panel__error">{error}</p>
          ) : (
            <p className="workspace-right-panel__empty">
              {loading ? "Loading review..." : "No review data yet."}
            </p>
          )}
        </section>

        <section
          className={`workspace-right-panel__tab-panel workspace-right-panel__browser ${
            activeTab === "browser" ? "" : "workspace-right-panel__tab-panel--hidden"
          }`}
          role="tabpanel"
          aria-label="Browser"
        >
          <BrowserPanel collapsed={collapsed || activeTab !== "browser"} />
        </section>
      </div>
    </aside>
  );
}

function DiffReviewSurface({
  error,
  loading,
  scope,
  selectedEnvironmentId,
  selectedFileKey,
  snapshot,
  onSelectFile,
}: {
  error: string | null;
  loading: boolean;
  scope: GitReviewScope;
  selectedEnvironmentId: string;
  selectedFileKey: string | null;
  snapshot: GitReviewSnapshot;
  onSelectFile: (section: GitChangeSection, path: string) => void;
}) {
  const diffCollection = useGitReviewStore(
    selectGitReviewDiffCollection(selectedEnvironmentId, scope),
  );
  const diffError = useGitReviewStore(
    selectGitReviewDiffError(selectedEnvironmentId, scope),
  );
  const diffLoading = useGitReviewStore(
    (state) =>
      (selectedEnvironmentId
        ? state.diffLoadingByContext[`${selectedEnvironmentId}:${scope}`]
        : false) ?? false,
  );
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const files = useMemo(
    () => snapshot.sections.flatMap((section) => section.files),
    [snapshot.sections],
  );
  const selectedFile = selectedFileKey
    ? files.find((file) => `${file.section}:${file.path}` === selectedFileKey)
    : null;

  useEffect(() => {
    if (loading || files.length === 0 || selectedFile) {
      return;
    }
    const [firstFile] = files;
    onSelectFile(firstFile.section, firstFile.path);
  }, [files, loading, onSelectFile, selectedFile]);

  function toggleFile(file: GitFileChange) {
    const fileKey = `${file.section}:${file.path}`;
    setCollapsedFiles((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });

    if (selectedFileKey !== fileKey) {
      onSelectFile(file.section, file.path);
    }
  }

  return (
    <div className="workspace-right-panel__review">
      {loading ? <p className="workspace-right-panel__empty">Loading changes...</p> : null}
      {error ? <p className="workspace-right-panel__error">{error}</p> : null}

      <div className="workspace-right-panel__diff-scroll" aria-label="Changed files">
        {!loading && files.length === 0 ? (
          <p className="workspace-right-panel__review-empty">No file changes yet</p>
        ) : null}
        {files.length > 0 ? (
          <div className="workspace-right-panel__file-stack">
            {files.map((file) => {
              const fileKey = `${file.section}:${file.path}`;
              const selected = selectedFileKey === fileKey;
              const expanded = !collapsedFiles.has(fileKey);
              return (
                <DiffFileCard
                  key={fileKey}
                  diff={diffCollection[fileKey] ?? null}
                  diffError={selected ? diffError : null}
                  expanded={expanded}
                  file={file}
                  loading={expanded && diffLoading && !diffCollection[fileKey]}
                  onToggle={() => toggleFile(file)}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DiffFileCard({
  diff,
  diffError,
  expanded,
  file,
  loading,
  onToggle,
}: {
  diff: GitFileDiff | null;
  diffError: string | null;
  expanded: boolean;
  file: GitFileChange;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <section
      className={`workspace-right-panel__file-card ${
        expanded ? "workspace-right-panel__file-card--expanded" : ""
      }`}
    >
      <div className="workspace-right-panel__file-card-header">
        <button
          type="button"
          className="workspace-right-panel__file-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronRightIcon
            size={13}
            className={`workspace-right-panel__file-chevron ${
              expanded ? "workspace-right-panel__file-chevron--expanded" : ""
            }`}
          />
          <span className="workspace-right-panel__file-icon" aria-hidden="true" />
          <span className="workspace-right-panel__file-path">{file.path}</span>
          <span
            className={`workspace-right-panel__file-status workspace-right-panel__file-status--${file.kind}`}
          >
            {labelForGitChangeKind(file.kind, "compact")}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="workspace-right-panel__file-diff">
          {diffError ? <p className="workspace-right-panel__error">{diffError}</p> : null}
          <GitDiffViewer diff={diff} loading={loading} />
        </div>
      ) : null}
    </section>
  );
}
