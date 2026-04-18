import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { EnvironmentRecord, ProjectRecord } from "../../../lib/types";
import { ChevronRightIcon, GitBranchIcon, PlusIcon } from "../../../shared/Icons";

export type EnvSelection =
  | { kind: "local" }
  | { kind: "existing"; environmentId: string }
  | { kind: "new"; baseBranch: string; name: string };

export type DraftLocationSelection =
  | { kind: "chat" }
  | { kind: "project"; projectId: string; target: EnvSelection };

type Props = {
  projects: ProjectRecord[];
  localEnvironment: EnvironmentRecord | null;
  worktreeEnvironments: EnvironmentRecord[];
  availableBranches: string[];
  branchesLoading: boolean;
  defaultBaseBranch: string | null;
  value: DraftLocationSelection;
  onChange: (next: DraftLocationSelection) => void;
  disabled?: boolean;
};

export function EnvironmentSelector({
  projects,
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

  const projectTarget = value.kind === "project" ? value.target : null;
  const envLabel = describeLocation(value, localEnvironment, worktreeEnvironments);

  function updateProjectTarget(next: EnvSelection) {
    if (value.kind !== "project") return;
    onChange({ ...value, target: next });
  }

  function pickProject(projectId: string) {
    onChange({
      kind: "project",
      projectId,
      target: { kind: "local" },
    });
    setEnvMenuOpen(false);
  }

  function pickChat() {
    onChange({ kind: "chat" });
    setEnvMenuOpen(false);
    setBranchMenuOpen(false);
  }

  function pickLocal() {
    updateProjectTarget({ kind: "local" });
    setEnvMenuOpen(false);
    setBranchMenuOpen(false);
  }

  function pickExisting(environmentId: string) {
    updateProjectTarget({ kind: "existing", environmentId });
    setEnvMenuOpen(false);
    setBranchMenuOpen(false);
  }

  function pickNewWorktree() {
    const branch =
      projectTarget?.kind === "new"
        ? projectTarget.baseBranch
        : defaultBaseBranch ?? availableBranches[0] ?? "";
    const name = projectTarget?.kind === "new" ? projectTarget.name : "";
    updateProjectTarget({ kind: "new", baseBranch: branch, name });
    setEnvMenuOpen(false);
  }

  function pickBaseBranch(branch: string) {
    if (projectTarget?.kind !== "new") return;
    updateProjectTarget({ ...projectTarget, baseBranch: branch });
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
      {projectTarget?.kind === "new" ? (
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
              {projectTarget.baseBranch || (branchesLoading ? "loading…" : "(default)")}
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
            value={projectTarget.name}
            disabled={disabled}
            onChange={(event) =>
              updateProjectTarget({
                ...projectTarget,
                name: event.target.value,
              })
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
              {value.kind === "chat" ? (
                <>
                  {projects.length === 0 ? (
                    <div className="thread-draft-env__empty">
                      Add a project to work in one.
                    </div>
                  ) : null}
                  {projects.map((project) => (
                    <MenuOption
                      key={project.id}
                      active={false}
                      icon={<span className="thread-draft-env__dot" />}
                      label={project.name}
                      sub={project.rootPath}
                      onSelect={() => pickProject(project.id)}
                    />
                  ))}
                </>
              ) : (
                <>
                  {localEnvironment ? (
                    <MenuOption
                      active={projectTarget?.kind === "local"}
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
                  {worktreeEnvironments.map((environment) => {
                    const threadCount = environment.threads.filter(
                      (thread) => thread.status === "active",
                    ).length;
                    return (
                      <MenuOption
                        key={environment.id}
                        active={
                          projectTarget?.kind === "existing" &&
                          projectTarget.environmentId === environment.id
                        }
                        icon={<GitBranchIcon size={11} />}
                        label={environment.gitBranch ?? environment.name}
                        sub={`${threadCount} thread${threadCount === 1 ? "" : "s"}`}
                        onSelect={() => pickExisting(environment.id)}
                      />
                    );
                  })}
                  <div className="thread-draft-env__separator-line" />
                  <MenuOption
                    active={projectTarget?.kind === "new"}
                    icon={<PlusIcon size={11} />}
                    label="New worktree…"
                    sub="Create a fresh worktree from a base branch"
                    onSelect={pickNewWorktree}
                  />
                  <div className="thread-draft-env__separator-line" />
                  <MenuOption
                    active={false}
                    icon={<span className="thread-draft-env__dot" />}
                    label="Don't work in a project"
                    sub="Create a standalone chat"
                    onSelect={pickChat}
                  />
                </>
              )}
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
                active={projectTarget?.kind === "new" && projectTarget.baseBranch.length === 0}
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
                  {branchesLoading ? "Loading branches…" : "No additional local branches."}
                </div>
              ) : (
                availableBranches.map((branch) => (
                  <MenuOption
                    key={branch}
                    active={projectTarget?.kind === "new" && projectTarget.baseBranch === branch}
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

function describeLocation(
  selection: DraftLocationSelection,
  localEnvironment: EnvironmentRecord | null,
  worktreeEnvironments: EnvironmentRecord[],
) {
  if (selection.kind === "chat") {
    return {
      icon: <PlusIcon size={11} />,
      text: "Work in a project",
    };
  }
  return describeSelection(selection.target, localEnvironment, worktreeEnvironments);
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
    const environment = worktreeEnvironments.find(
      (candidate) => candidate.id === selection.environmentId,
    );
    return {
      icon: <GitBranchIcon size={11} />,
      text: environment?.gitBranch ?? environment?.name ?? "Worktree",
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
  const menuWidth = Math.max(rect.width, 260);
  const margin = 8;
  const gap = 6;
  const minHeight = 120;
  const left = Math.min(
    rect.left,
    Math.max(margin, window.innerWidth - menuWidth - margin),
  );
  const spaceAbove = rect.top - gap - margin;
  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  // Flip direction when the preferred side lacks room for a usable menu.
  const opensUp = direction === "up" ? spaceAbove >= minHeight || spaceAbove >= spaceBelow : spaceBelow < minHeight && spaceAbove > spaceBelow;
  if (opensUp) {
    const bottom = window.innerHeight - rect.top + gap;
    return { left, bottom, minWidth: `${menuWidth}px`, maxHeight: Math.max(0, spaceAbove) };
  }
  const top = rect.bottom + gap;
  return { left, top, minWidth: `${menuWidth}px`, maxHeight: Math.max(0, spaceBelow) };
}
