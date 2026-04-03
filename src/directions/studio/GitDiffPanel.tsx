import {
  selectSelectedEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import {
  selectGitReviewDiffCollection,
  selectGitReviewDiffError,
  selectGitReviewScope,
  selectGitReviewSelectedFile,
  selectGitReviewSnapshot,
  useGitReviewStore,
} from "../../stores/git-review-store";
import { CloseIcon } from "../../shared/Icons";
import { GitDiffViewer } from "./GitDiffViewer";
import "./GitDiffPanel.css";

export function GitDiffPanel() {
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedEnvironmentId = selectedEnvironment?.id ?? null;
  const scope = useGitReviewStore(selectGitReviewScope(selectedEnvironmentId));
  const snapshot = useGitReviewStore(
    selectGitReviewSnapshot(selectedEnvironmentId, scope),
  );
  const selectedFileKey = useGitReviewStore(
    selectGitReviewSelectedFile(selectedEnvironmentId, scope),
  );
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
  const closeDiff = useGitReviewStore((state) => state.closeDiff);

  const files = snapshot?.sections.flatMap((section) => section.files) ?? [];

  if (!selectedEnvironmentId || !selectedFileKey) {
    return null;
  }

  const orderedFiles = orderSelectedFileFirst(files, selectedFileKey);
  if (orderedFiles.length === 0) {
    return null;
  }

  const selectedFile = orderedFiles[0];

  return (
    <aside className="git-diff-panel">
      <div className="git-diff-panel__header">
        <div className="git-diff-panel__title-wrap">
          <span className="git-diff-panel__eyebrow">Diff</span>
          <span className="git-diff-panel__title">{selectedFile.path}</span>
        </div>
        <button
          type="button"
          className="git-diff-panel__close"
          aria-label="Hide diff"
          title="Hide diff"
          onClick={() => closeDiff(selectedEnvironmentId, scope)}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="git-diff-panel__content">
        {diffError ? <p className="git-diff-panel__error">{diffError}</p> : null}
        {orderedFiles.map((file, index) => {
          const fileKey = `${file.section}:${file.path}`;
          return (
            <section
              key={fileKey}
              className={`git-diff-panel__file ${index === 0 ? "git-diff-panel__file--selected" : ""}`}
            >
              <div className="git-diff-panel__file-header">
                <span className="git-diff-panel__file-path">{file.path}</span>
                <span className="git-diff-panel__file-status">{labelForDiffKind(file.kind)}</span>
              </div>
              <GitDiffViewer diff={diffCollection[fileKey] ?? null} loading={diffLoading && !diffCollection[fileKey]} />
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function orderSelectedFileFirst<T extends { section: string; path: string }>(
  files: T[],
  selectedFileKey: string,
) {
  const selected = files.find(
    (file) => `${file.section}:${file.path}` === selectedFileKey,
  );
  const rest = files.filter(
    (file) => `${file.section}:${file.path}` !== selectedFileKey,
  );
  return selected ? [selected, ...rest] : files;
}

function labelForDiffKind(kind: string) {
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
