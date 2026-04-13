import { APP_NAME } from "../../lib/app-identity";
import type { GitFileDiff } from "../../lib/types";

type Props = {
  diff: GitFileDiff | null;
  loading: boolean;
};

export function GitDiffViewer({ diff, loading }: Props) {
  if (loading) {
    return <p className="git-diff-viewer__empty">Loading diff…</p>;
  }

  if (!diff) {
    return <p className="git-diff-viewer__empty">Select a file to inspect its diff.</p>;
  }

  if (diff.isBinary) {
    return (
      <div className="git-diff-viewer__empty">
        <h4>Binary file</h4>
        <p>{diff.emptyMessage ?? `${APP_NAME} cannot render this diff inline.`}</p>
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div className="git-diff-viewer__empty">
        <h4>No textual diff</h4>
        <p>{diff.emptyMessage ?? "Nothing to render for this file."}</p>
      </div>
    );
  }

  return (
    <div className="git-diff-viewer">
      {diff.hunks.map((hunk) => (
        <section key={`${diff.path}:${hunk.header}`} className="git-diff-viewer__hunk">
          <header className="git-diff-viewer__hunk-header">{hunk.header}</header>
          <div className="git-diff-viewer__lines">
            {hunk.lines.map((line, index) => (
              <div
                key={`${hunk.header}:${index}`}
                className={`git-diff-viewer__line git-diff-viewer__line--${line.kind}`}
              >
                <span className="git-diff-viewer__line-number">
                  {line.oldLineNumber ?? ""}
                </span>
                <span className="git-diff-viewer__line-number">
                  {line.newLineNumber ?? ""}
                </span>
                <code className="git-diff-viewer__line-text">{line.text}</code>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
