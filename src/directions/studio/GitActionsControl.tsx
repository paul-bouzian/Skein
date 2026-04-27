import { useEffect, useMemo, useRef, useState } from "react";

import { openExternalUrl } from "../../lib/shell";
import type { GitAction, GitReviewSnapshot } from "../../lib/types";
import {
  ArrowDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  GitCommitIcon,
  GitHubIcon,
} from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import {
  selectEffectiveNonChatEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import {
  selectGitReviewError,
  selectGitReviewScope,
  selectGitReviewSnapshot,
  useGitReviewStore,
} from "../../stores/git-review-store";
import { isDefaultBranch, resolveQuickGitAction } from "./GitActionsControl.logic";
import "./GitActionsControl.css";

type MenuGitAction = {
  id: "commit" | "push" | "pr";
  label: string;
  action: GitAction;
  disabled: boolean;
  disabledReason: string | null;
};

export function GitActionsControl() {
  const environment = useWorkspaceStore(selectEffectiveNonChatEnvironment);
  const environmentId = environment?.id ?? null;
  const scope = useGitReviewStore(selectGitReviewScope(environmentId));
  const snapshot = useGitReviewStore(selectGitReviewSnapshot(environmentId, scope));
  const error = useGitReviewStore(selectGitReviewError(environmentId, scope));
  const loadReview = useGitReviewStore((state) => state.loadReview);
  const runAction = useGitReviewStore((state) => state.runAction);
  const action = useGitReviewStore(
    (state) => (environmentId ? state.actionByEnvironmentId[environmentId] : null) ?? null,
  );
  const loading = useGitReviewStore(
    (state) =>
      (environmentId ? state.loadingByContext[`${environmentId}:${scope}`] : false) ??
      false,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const busy = Boolean(action) || loading;
  const openPr = environment?.pullRequest?.state === "open" ? environment.pullRequest : null;

  useEffect(() => {
    if (!environmentId) return;
    void loadReview(environmentId);
  }, [environmentId, loadReview]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const quickAction = useMemo(
    () => resolveQuickGitAction(snapshot, Boolean(environment), busy, Boolean(openPr)),
    [busy, environment, openPr, snapshot],
  );
  const menuItems = useMemo(
    () => buildGitActionMenu(snapshot, Boolean(environment), busy, Boolean(openPr)),
    [busy, environment, openPr, snapshot],
  );

  async function executeGitAction(nextAction: GitAction | null) {
    if (!environmentId || !nextAction || busy) return;
    if (nextAction === "viewPr" && openPr?.url) {
      void openExternalUrl(openPr.url);
      return;
    }
    const result = await runAction(environmentId, nextAction);
    const prUrl = result?.pr?.url;
    if (prUrl) {
      void openExternalUrl(prUrl);
    }
  }

  if (!environment) {
    return null;
  }

  return (
    <div className="git-actions-control" ref={rootRef}>
      <Tooltip
        content={
          quickAction.disabledReason ??
          (error ? `Git action failed: ${error}` : quickAction.label)
        }
        side="bottom"
      >
        <button
          type="button"
          className="git-actions-control__primary"
          disabled={quickAction.disabled}
          onClick={() => void executeGitAction(quickAction.action)}
        >
          <GitActionIcon action={quickAction.action} />
          <span>{busy ? "Running..." : quickAction.label}</span>
        </button>
      </Tooltip>
      <button
        type="button"
        aria-label="Git action options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="git-actions-control__chevron"
        disabled={busy}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <ChevronRightIcon
          size={12}
          className={menuOpen ? "git-actions-control__chevron-icon--open" : ""}
        />
      </button>
      {menuOpen ? (
        <div className="git-actions-control__menu tx-dropdown-menu" role="menu">
          <span className="git-actions-control__menu-label">Git actions</span>
          {menuItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="git-actions-control__menu-item"
              disabled={item.disabled}
              title={item.disabledReason ?? item.label}
              onClick={() => {
                setMenuOpen(false);
                void executeGitAction(item.action);
              }}
            >
              <GitActionIcon action={item.action} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildGitActionMenu(
  snapshot: GitReviewSnapshot | null,
  hasEnvironment: boolean,
  busy: boolean,
  hasOpenPr: boolean,
): MenuGitAction[] {
  const unavailable = !hasEnvironment || busy || !snapshot;
  const summary = snapshot?.summary ?? null;
  const hasBranch = Boolean(summary?.branch);
  const dirty = Boolean(summary?.dirty);
  const behind = summary?.behind ?? 0;
  const ahead = summary?.ahead ?? 0;
  const defaultBranch = summary?.branch
    ? isDefaultBranch(summary.branch, summary.baseBranch)
    : false;
  const canCommit = !unavailable && dirty && hasBranch;
  const canPush = !unavailable && hasBranch && !dirty && behind === 0 && ahead > 0;
  const canCreateOrViewPr =
    !unavailable && hasBranch && behind === 0 && (hasOpenPr || !defaultBranch);

  return [
    {
      id: "commit",
      label: "Commit",
      action: "commit",
      disabled: !canCommit,
      disabledReason: resolveCommitDisabledReason({ unavailable, dirty, hasBranch }),
    },
    {
      id: "push",
      label: defaultBranch ? "Commit & push" : "Push",
      action: defaultBranch ? "commitPush" : "push",
      disabled: !canPush,
      disabledReason: resolvePushDisabledReason({
        unavailable,
        dirty,
        hasBranch,
        ahead,
        behind,
      }),
    },
    {
      id: "pr",
      label: hasOpenPr ? "View PR" : "Create PR",
      action: hasOpenPr ? "viewPr" : dirty ? "commitPushCreatePr" : "createPr",
      disabled: !canCreateOrViewPr,
      disabledReason: resolvePrDisabledReason(
        unavailable,
        hasBranch,
        hasOpenPr,
        defaultBranch,
        behind,
      ),
    },
  ];
}

function resolveCommitDisabledReason({
  unavailable,
  dirty,
  hasBranch,
}: {
  unavailable: boolean;
  dirty: boolean;
  hasBranch: boolean;
}) {
  if (unavailable) return "Git status is unavailable.";
  if (!hasBranch) return "Checkout a branch before running Git actions.";
  return dirty ? null : "No changes to commit.";
}

function resolvePushDisabledReason({
  unavailable,
  dirty,
  hasBranch,
  ahead,
  behind,
}: {
  unavailable: boolean;
  dirty: boolean;
  hasBranch: boolean;
  ahead: number;
  behind: number;
}) {
  if (unavailable) return "Git status is unavailable.";
  if (!hasBranch) return "Checkout a branch before running Git actions.";
  if (dirty) return "Commit local changes before pushing.";
  if (behind > 0) return "Pull/rebase before pushing.";
  return ahead > 0 ? null : "No local commits to push.";
}

function resolvePrDisabledReason(
  unavailable: boolean,
  hasBranch: boolean,
  hasOpenPr: boolean,
  defaultBranch: boolean,
  behind: number,
) {
  if (unavailable) return "Git status is unavailable.";
  if (!hasBranch) return "Checkout a branch before running Git actions.";
  if (behind > 0) return hasOpenPr ? "Pull/rebase before opening the PR." : "Pull/rebase before creating a PR.";
  if (defaultBranch && !hasOpenPr) return "Create a feature branch before opening a PR.";
  return null;
}

function GitActionIcon({ action }: { action: GitAction | null }) {
  if (action === "pull") return <ArrowDownIcon size={13} />;
  if (action === "push" || action === "commitPush") return <CloudUploadIcon size={14} />;
  if (action === "createPr" || action === "commitPushCreatePr" || action === "viewPr") {
    return <GitHubIcon size={14} />;
  }
  return <GitCommitIcon size={14} />;
}
