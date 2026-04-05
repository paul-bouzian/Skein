import type { ReactNode } from "react";

import type {
  GitChangeSection,
  GitFileChange,
  GitRepoSummary,
  GitReviewScope,
} from "../../lib/types";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  SparklesIcon,
  MinusIcon,
  PlusIcon,
  UndoIcon,
} from "../../shared/Icons";

const REVIEW_SCOPE_OPTIONS = [
  { id: "uncommitted", label: "Uncommitted" },
  { id: "branch", label: "Branch" },
] as const;

function isPrimaryActionDisabled(
  actionPending: boolean,
  primaryMode: "commit" | "push" | "idle",
  message: string,
) {
  if (actionPending) {
    return true;
  }
  if (primaryMode === "commit") {
    return message.trim().length === 0;
  }
  if (primaryMode === "push") {
    return false;
  }
  return true;
}

export function ReviewSummarySection({
  environmentName,
  loading,
  onSelectScope,
  scope,
  summary,
}: {
  environmentName: string;
  loading: boolean;
  onSelectScope: (scope: GitReviewScope) => void;
  scope: GitReviewScope;
  summary: GitRepoSummary;
}) {
  return (
    <section className="inspector-section">
      <div className="inspector-section__header">
        <h4 className="inspector-section__label">Repository</h4>
        <div className="inspector-scope-switch" role="group" aria-label="Review scope">
          {REVIEW_SCOPE_OPTIONS.map((option) => {
            const disabled = loading || (option.id === "branch" && !summary.baseBranch);
            return (
              <button
                key={option.id}
                type="button"
                className={`inspector-scope-switch__button ${
                  scope === option.id ? "inspector-scope-switch__button--active" : ""
                }`}
                disabled={disabled}
                aria-pressed={scope === option.id}
                onClick={() => onSelectScope(option.id)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="inspector-summary-grid">
        <SummaryItem label="Environment" value={environmentName} />
        <SummaryItem label="Branch" value={summary.branch ?? "detached"} />
        <SummaryItem label="Base" value={summary.baseBranch ?? "auto"} />
        <SummaryItem
          label="Sync"
          value={`${summary.ahead}↑ ${summary.behind}↓`}
        />
      </div>
    </section>
  );
}

export function CommitSection({
  action,
  generating,
  message,
  summary,
  onCommit,
  onFetch,
  onGenerate,
  onMessageChange,
  onPull,
  onPush,
}: {
  action: string | null;
  generating: boolean;
  message: string;
  summary: GitRepoSummary;
  onCommit: () => void;
  onFetch: () => void;
  onGenerate: () => void;
  onMessageChange: (value: string) => void;
  onPull: () => void;
  onPush: () => void;
}) {
  const actionPending = Boolean(action);
  const draftLocked = generating || action === "commit";
  const primaryMode = summary.hasStagedChanges
    ? "commit"
    : summary.ahead > 0
      ? "push"
      : "idle";
  const primaryDisabled = isPrimaryActionDisabled(
    actionPending || generating,
    primaryMode,
    message,
  );

  return (
    <section className="inspector-section">
      <div className="inspector-section__header">
        <h4 className="inspector-section__label">Commit</h4>
        <div className="inspector-inline-actions">
          <button
            type="button"
            className="inspector-inline-action"
            disabled={actionPending || generating}
            onClick={onFetch}
          >
            Fetch
          </button>
          <button
            type="button"
            className="inspector-inline-action"
            disabled={actionPending || generating}
            onClick={onPull}
          >
            {summary.behind > 0 ? (
              <>
                Pull <ArrowDownIcon size={12} /> {summary.behind}
              </>
            ) : (
              "Pull"
            )}
          </button>
        </div>
      </div>

      <div className="inspector-commit">
        <div className="inspector-commit__editor">
          <textarea
            className="inspector-commit__textarea"
            aria-label="Commit message"
            readOnly={draftLocked}
            placeholder="Write a commit message"
            rows={3}
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
          />
          <button
            type="button"
            className="inspector-commit__generate"
            aria-label="Generate a commit message"
            disabled={actionPending || generating}
            title="Generate a commit message"
            onClick={onGenerate}
          >
            {generating ? <span className="inspector-spinner" aria-hidden="true" /> : <SparklesIcon size={14} />}
          </button>
        </div>

        <button
          type="button"
          className="tx-button inspector-commit__primary"
          disabled={primaryDisabled}
          onClick={primaryMode === "push" ? onPush : onCommit}
        >
          {primaryMode === "push" ? (
            <>
              <span>Push</span>
              <span className="inspector-commit__primary-meta">
                <ArrowUpIcon size={12} />
                {summary.ahead}
              </span>
            </>
          ) : (
            <span>Commit</span>
          )}
        </button>
      </div>
    </section>
  );
}

export function ChangesSection({
  action,
  loading,
  sections,
  selectedFileKey,
  scope,
  onSelectFile,
  onStageAll,
  onUnstageAll,
  onRevertAll,
  onStageFile,
  onUnstageFile,
  onRevertFile,
}: {
  action: string | null;
  loading: boolean;
  sections: Array<{ id: GitChangeSection; label: string; files: GitFileChange[] }>;
  selectedFileKey: string | null;
  scope: GitReviewScope;
  onSelectFile: (section: GitChangeSection, path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onRevertAll: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onRevertFile: (section: GitChangeSection, path: string) => void;
}) {
  const actionPending = Boolean(action);
  const isUncommitted = scope === "uncommitted";

  return (
    <section className="inspector-section inspector-section--changes">
      <div className="inspector-section__header">
        <h4 className="inspector-section__label">Changes</h4>
      </div>
      {isUncommitted ? (
        <div className="inspector-change-toolbar">
          <button
            type="button"
            className="inspector-inline-action"
            disabled={actionPending}
            onClick={onStageAll}
          >
            Stage all
          </button>
          <button
            type="button"
            className="inspector-inline-action"
            disabled={actionPending}
            onClick={onUnstageAll}
          >
            Unstage all
          </button>
          <button
            type="button"
            className="inspector-inline-action inspector-inline-action--danger"
            disabled={actionPending}
            onClick={onRevertAll}
          >
            Revert all
          </button>
        </div>
      ) : null}
      {loading ? <p className="inspector__empty">Loading changes…</p> : null}
      {!loading && sections.length === 0 ? (
        <p className="inspector__empty">No changes to review for this scope.</p>
      ) : null}
      <div className="inspector-change-groups">
        {sections.map((section) => (
          <div key={section.id} className="inspector-change-group">
            <div className="inspector-change-group__header">
              <span>{section.label}</span>
              <span>{section.files.length}</span>
            </div>
            <div className="inspector-change-group__list">
              {section.files.map((file) => {
                const fileKey = `${file.section}:${file.path}`;
                return (
                  <div
                    key={fileKey}
                    className={`inspector-file-row ${
                      selectedFileKey === fileKey ? "inspector-file-row--selected" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="inspector-file-row__select"
                      onClick={() => onSelectFile(file.section, file.path)}
                    >
                      <span className="inspector-file-row__path">{file.path}</span>
                      <span
                        className={`inspector-file-row__status inspector-file-row__status--${file.kind}`}
                      >
                        {labelForChangeKind(file.kind)}
                      </span>
                    </button>
                    <div className="inspector-file-row__actions">
                      {file.canStage ? (
                        <button
                          type="button"
                          className="inspector-file-action"
                          aria-label={`Stage ${file.path}`}
                          disabled={actionPending}
                          title="Stage file"
                          onClick={() => onStageFile(file.path)}
                        >
                          <PlusIcon size={12} />
                        </button>
                      ) : null}
                      {file.canUnstage ? (
                        <button
                          type="button"
                          className="inspector-file-action"
                          aria-label={`Unstage ${file.path}`}
                          disabled={actionPending}
                          title="Unstage file"
                          onClick={() => onUnstageFile(file.path)}
                        >
                          <MinusIcon size={12} />
                        </button>
                      ) : null}
                      {file.canRevert ? (
                        <button
                          type="button"
                          className="inspector-file-action inspector-file-action--danger"
                          aria-label={`Revert ${file.path}`}
                          disabled={actionPending}
                          title="Revert file"
                          onClick={() => onRevertFile(file.section, file.path)}
                        >
                          <UndoIcon size={12} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="inspector-summary-item">
      <span className="inspector-summary-item__label">{label}</span>
      <span className="inspector-summary-item__value">{value}</span>
    </div>
  );
}

function labelForChangeKind(kind: GitFileChange["kind"]) {
  switch (kind) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "typeChanged":
      return "Type";
    case "unmerged":
      return "Conflict";
    default:
      return "Changed";
  }
}
