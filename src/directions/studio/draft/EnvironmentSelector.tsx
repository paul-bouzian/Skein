import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, GitBranchIcon, PlusIcon } from "../../../shared/Icons";
import type { EnvironmentRecord } from "../../../lib/types";

export type EnvSelection =
  | { kind: "local" }
  | { kind: "existing"; environmentId: string }
  | { kind: "new"; baseBranch: string; name: string };

type Props = {
  localEnvironment: EnvironmentRecord | null;
  worktreeEnvironments: EnvironmentRecord[];
  availableBranches: string[];
  branchesLoading: boolean;
  defaultBaseBranch: string | null;
  value: EnvSelection;
  onChange: (next: EnvSelection) => void;
  disabled?: boolean;
};

export function EnvironmentSelector({
  localEnvironment,
  worktreeEnvironments,
  availableBranches,
  branchesLoading,
  defaultBaseBranch,
  value,
  onChange,
  disabled,
}: Props) {
  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const envButtonRef = useRef<HTMLButtonElement | null>(null);
  const branchButtonRef = useRef<HTMLButtonElement | null>(null);
  const envMenuRef = useRef<HTMLDivElement | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!envMenuOpen && !branchMenuOpen) return undefined;

    function handlePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        envMenuOpen &&
        !envMenuRef.current?.contains(target) &&
        !envButtonRef.current?.contains(target)
      ) {
        setEnvMenuOpen(false);
      }
      if (
        branchMenuOpen &&
        !branchMenuRef.current?.contains(target) &&
        !branchButtonRef.current?.contains(target)
      ) {
        setBranchMenuOpen(false);
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setEnvMenuOpen(false);
        setBranchMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [envMenuOpen, branchMenuOpen]);

  const envLabel = describeSelection(
    value,
    localEnvironment,
    worktreeEnvironments,
  );

  function pickLocal() {
    onChange({ kind: "local" });
    setEnvMenuOpen(false);
    setBranchMenuOpen(false);
  }

  function pickExisting(environmentId: string) {
    onChange({ kind: "existing", environmentId });
    setEnvMenuOpen(false);
    setBranchMenuOpen(false);
  }

  function pickNewWorktree() {
    const branch =
      value.kind === "new"
        ? value.baseBranch
        : defaultBaseBranch ?? availableBranches[0] ?? "";
    const name = value.kind === "new" ? value.name : "";
    onChange({ kind: "new", baseBranch: branch, name });
    setEnvMenuOpen(false);
  }

  function pickBaseBranch(branch: string) {
    if (value.kind !== "new") return;
    onChange({ ...value, baseBranch: branch });
    setBranchMenuOpen(false);
  }


  return (
    <div className="thread-draft-env" data-disabled={disabled ? "true" : undefined}>
      <button
        ref={envButtonRef}
        type="button"
        className="thread-draft-env__chip"
        disabled={disabled}
        onClick={() => setEnvMenuOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={envMenuOpen}
      >
        <span className="thread-draft-env__chip-icon">{envLabel.icon}</span>
        <span className="thread-draft-env__chip-label">{envLabel.text}</span>
        <ChevronRightIcon
          size={10}
          className={`thread-draft-env__chip-caret ${envMenuOpen ? "thread-draft-env__chip-caret--open" : ""}`}
        />
      </button>
      {value.kind === "new" ? (
        <>
          <span className="thread-draft-env__separator">from</span>
          <button
            ref={branchButtonRef}
            type="button"
            className="thread-draft-env__chip thread-draft-env__chip--branch"
            disabled={disabled || (branchesLoading && availableBranches.length === 0)}
            onClick={() => setBranchMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={branchMenuOpen}
          >
            <span className="thread-draft-env__chip-icon">
              <GitBranchIcon size={11} />
            </span>
            <span className="thread-draft-env__chip-label">
              {value.baseBranch || (branchesLoading ? "loading…" : "(default)")}
            </span>
            <ChevronRightIcon
              size={10}
              className={`thread-draft-env__chip-caret ${branchMenuOpen ? "thread-draft-env__chip-caret--open" : ""}`}
            />
          </button>
          <input
            type="text"
            className="thread-draft-env__name"
            placeholder="name (optional)"
            value={value.name}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, name: event.target.value })
            }
            autoComplete="off"
            spellCheck={false}
          />
        </>
      ) : null}
      {envMenuOpen
        ? createPortal(
            <div
              ref={envMenuRef}
              className="tx-dropdown-menu thread-draft-env__menu"
              style={resolveMenuStyle(envButtonRef.current, "up")}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {localEnvironment ? (
                <MenuOption
                  active={value.kind === "local"}
                  icon={<span className="thread-draft-env__dot" />}
                  label="Local"
                  sub={
                    localEnvironment.gitBranch
                      ? `${localEnvironment.gitBranch} — no new worktree`
                      : "no new worktree"
                  }
                  onSelect={pickLocal}
                />
              ) : null}
              {worktreeEnvironments.length > 0 ? (
                <div className="thread-draft-env__group-label">
                  Existing worktrees
                </div>
              ) : null}
              {worktreeEnvironments.map((env) => {
                const threadCount = env.threads.filter(
                  (thread) => thread.status === "active",
                ).length;
                return (
                  <MenuOption
                    key={env.id}
                    active={
                      value.kind === "existing" &&
                      value.environmentId === env.id
                    }
                    icon={<GitBranchIcon size={11} />}
                    label={env.gitBranch ?? env.name}
                    sub={`${threadCount} thread${threadCount === 1 ? "" : "s"}`}
                    onSelect={() => pickExisting(env.id)}
                  />
                );
              })}
              <div className="thread-draft-env__separator-line" />
              <MenuOption
                active={value.kind === "new"}
                icon={<PlusIcon size={11} />}
                label="New worktree…"
                sub="Create a fresh worktree from a base branch"
                onSelect={pickNewWorktree}
              />
            </div>,
            document.body,
          )
        : null}
      {branchMenuOpen
        ? createPortal(
            <div
              ref={branchMenuRef}
              className="tx-dropdown-menu thread-draft-env__menu"
              style={resolveMenuStyle(branchButtonRef.current, "up")}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <MenuOption
                active={value.kind === "new" && value.baseBranch.length === 0}
                icon={<span className="thread-draft-env__dot" />}
                label="Default"
                sub="Let the repository decide (upstream or current branch)"
                onSelect={() => pickBaseBranch("")}
              />
              {availableBranches.length > 0 ? (
                <div className="thread-draft-env__separator-line" />
              ) : null}
              {availableBranches.length === 0 ? (
                <div className="thread-draft-env__empty">
                  {branchesLoading
                    ? "Loading branches…"
                    : "No additional local branches."}
                </div>
              ) : (
                availableBranches.map((branch) => (
                  <MenuOption
                    key={branch}
                    active={value.kind === "new" && value.baseBranch === branch}
                    icon={<GitBranchIcon size={11} />}
                    label={branch}
                    onSelect={() => pickBaseBranch(branch)}
                  />
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MenuOption({
  active,
  icon,
  label,
  sub,
  disabled = false,
  onSelect,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  sub?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`tx-dropdown-option thread-draft-env__option ${active ? "thread-draft-env__option--active" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="thread-draft-env__option-icon">{icon}</span>
      <span className="thread-draft-env__option-text">
        <span className="thread-draft-env__option-label">{label}</span>
        {sub ? <span className="thread-draft-env__option-sub">{sub}</span> : null}
      </span>
    </button>
  );
}

function describeSelection(
  selection: EnvSelection,
  localEnvironment: EnvironmentRecord | null,
  worktreeEnvironments: EnvironmentRecord[],
) {
  if (selection.kind === "local") {
    return {
      icon: <span className="thread-draft-env__dot" />,
      text:
        localEnvironment?.gitBranch
          ? `Local · ${localEnvironment.gitBranch}`
          : "Local",
    };
  }
  if (selection.kind === "existing") {
    const env = worktreeEnvironments.find(
      (candidate) => candidate.id === selection.environmentId,
    );
    return {
      icon: <GitBranchIcon size={11} />,
      text: env?.gitBranch ?? env?.name ?? "Worktree",
    };
  }
  return {
    icon: <PlusIcon size={11} />,
    text: "New worktree",
  };
}

function resolveMenuStyle(
  anchor: HTMLButtonElement | null,
  direction: "up" | "down" = "down",
): React.CSSProperties {
  if (!anchor) return { left: 0, top: 0 };
  const rect = anchor.getBoundingClientRect();
  const MENU_WIDTH = Math.max(rect.width, 260);
  const margin = 8;
  const left = Math.min(
    rect.left,
    Math.max(margin, window.innerWidth - MENU_WIDTH - margin),
  );
  const estimatedHeight = 220;
  const top =
    direction === "up"
      ? Math.max(margin, rect.top - estimatedHeight - 6)
      : Math.min(rect.bottom + 6, window.innerHeight - margin - 40);
  return { left, top, minWidth: `${MENU_WIDTH}px` };
}
