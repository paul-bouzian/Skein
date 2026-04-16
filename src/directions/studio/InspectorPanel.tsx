import { useEffect, useRef } from "react";

import {
  useConversationStore,
  selectConversationSnapshot,
} from "../../stores/conversation-store";
import {
  selectGitReviewError,
  selectGitReviewScope,
  selectGitReviewSelectedFile,
  selectGitReviewSnapshot,
  useGitReviewStore,
} from "../../stores/git-review-store";
import {
  selectEffectiveEnvironment,
  selectSelectedThread,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { ChangesSection, CommitSection, ReviewSummarySection } from "./GitReviewSections";
import { confirmRevertAll, confirmRevertFile } from "./git-review-actions";
import "./InspectorPanel.css";

export function InspectorPanel({ collapsed = false }: { collapsed?: boolean }) {
  const selectedEnvironment = useWorkspaceStore(selectEffectiveEnvironment);
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

  const loadReview = useGitReviewStore((state) => state.loadReview);
  const refreshReview = useGitReviewStore((state) => state.refreshReview);
  const selectScope = useGitReviewStore((state) => state.selectScope);
  const selectFile = useGitReviewStore((state) => state.selectFile);
  const updateCommitMessage = useGitReviewStore((state) => state.updateCommitMessage);
  const generateCommitMessage = useGitReviewStore((state) => state.generateCommitMessage);
  const stageFile = useGitReviewStore((state) => state.stageFile);
  const stageAll = useGitReviewStore((state) => state.stageAll);
  const unstageFile = useGitReviewStore((state) => state.unstageFile);
  const unstageAll = useGitReviewStore((state) => state.unstageAll);
  const revertFile = useGitReviewStore((state) => state.revertFile);
  const revertAll = useGitReviewStore((state) => state.revertAll);
  const commit = useGitReviewStore((state) => state.commit);
  const fetch = useGitReviewStore((state) => state.fetch);
  const pull = useGitReviewStore((state) => state.pull);
  const push = useGitReviewStore((state) => state.push);

  const commitMessage = useGitReviewStore(
    (state) =>
      (selectedEnvironment ? state.commitMessageByEnvironmentId[selectedEnvironment.id] : "") ??
      "",
  );
  const action = useGitReviewStore(
    (state) =>
      (selectedEnvironment ? state.actionByEnvironmentId[selectedEnvironment.id] : null) ??
      null,
  );
  const generatingCommitMessagePending = useGitReviewStore(
    (state) =>
      (selectedEnvironment
        ? state.generatingCommitMessageByEnvironmentId[selectedEnvironment.id]
        : false) ?? false,
  );
  const loading = useGitReviewStore(
    (state) =>
      (selectedEnvironment
        ? state.loadingByContext[`${selectedEnvironment.id}:${scope}`]
        : false) ?? false,
  );

  const previousTurnRef = useRef<{ threadId: string | null; activeTurnId: string | null }>({
    threadId: null,
    activeTurnId: null,
  });

  useEffect(() => {
    if (!selectedEnvironmentId) {
      return;
    }
    void loadReview(selectedEnvironmentId);
  }, [loadReview, selectedEnvironmentId]);

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

  if (!selectedEnvironment) {
    return (
      <aside className={`inspector-panel ${collapsed ? "inspector-panel--collapsed" : ""}`} inert={collapsed || undefined}>
        <div className="inspector__header">
          <div>
            <span className="inspector__title">Review</span>
          </div>
        </div>
        <div className="inspector__content">
          <p className="inspector__empty">
            Select an environment to inspect its Git state.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`inspector-panel ${collapsed ? "inspector-panel--collapsed" : ""}`} inert={collapsed || undefined}>
      <div className="inspector__header">
        <div>
          <span className="inspector__title">Review</span>
          <p className="inspector__subtitle">
            {selectedEnvironment.name}
            {snapshot?.summary.branch ? <> · {snapshot.summary.branch}</> : null}
          </p>
        </div>
      </div>
      <div className="inspector__content">
        {snapshot ? (
          <>
            <ReviewSummarySection
              loading={loading}
              onSelectScope={(nextScope) =>
                void selectScope(selectedEnvironment.id, nextScope)
              }
              scope={scope}
              summary={snapshot.summary}
            />
            <CommitSection
              action={action}
              generating={generatingCommitMessagePending}
              message={commitMessage}
              summary={snapshot.summary}
              onCommit={() => void commit(selectedEnvironment.id, commitMessage)}
              onFetch={() => void fetch(selectedEnvironment.id)}
              onGenerate={() => void generateCommitMessage(selectedEnvironment.id)}
              onMessageChange={(message) =>
                updateCommitMessage(selectedEnvironment.id, message)
              }
              onPull={() => void pull(selectedEnvironment.id)}
              onPush={() => void push(selectedEnvironment.id)}
            />
            <ChangesSection
              action={action}
              loading={loading}
              sections={snapshot.sections}
              selectedFileKey={selectedFileKey}
              scope={scope}
              onSelectFile={(section, path) =>
                void selectFile(selectedEnvironment.id, scope, section, path)
              }
              onStageAll={() => void stageAll(selectedEnvironment.id)}
              onUnstageAll={() => void unstageAll(selectedEnvironment.id)}
              onRevertAll={() =>
                void confirmRevertAll(selectedEnvironment.id, revertAll)
              }
              onStageFile={(path) => void stageFile(selectedEnvironment.id, path)}
              onUnstageFile={(path) => void unstageFile(selectedEnvironment.id, path)}
              onRevertFile={(section, path) =>
                void confirmRevertFile(
                  selectedEnvironment.id,
                  section,
                  path,
                  revertFile,
                )
              }
            />
            {error ? <p className="inspector__error">{error}</p> : null}
          </>
        ) : error ? (
          <p className="inspector__error">{error}</p>
        ) : (
          <p className="inspector__empty">
            {loading ? "Loading review…" : "No review data yet."}
          </p>
        )}
      </div>
    </aside>
  );
}
