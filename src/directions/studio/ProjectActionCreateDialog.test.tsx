import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isMacPlatform } from "../../lib/shortcuts";
import { makeGlobalSettings, makeProject } from "../../test/fixtures/conversation";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ProjectActionCreateDialog } from "./ProjectActionCreateDialog";


describe("ProjectActionCreateDialog", () => {
  const primaryModifier = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  });

  it("keeps the draft intact and preserves focus when the backing project refreshes with the same id", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    const initialProject = makeProject({ id: "project-1", name: "Skein" });
    const { rerender } = render(
      <ProjectActionCreateDialog
        open
        project={initialProject}
        shortcutSettings={{}}
        onClose={onClose}
      />,
    );

    const labelInput = screen.getByLabelText("Label");
    await user.type(labelInput, "Dev");
    await user.type(screen.getByLabelText("Script"), "bun run dev");
    await user.click(labelInput);
    expect(labelInput).toHaveFocus();

    const refreshedOnClose = vi.fn();
    rerender(
      <ProjectActionCreateDialog
        open
        project={makeProject({ id: "project-1", name: "Skein" })}
        shortcutSettings={{}}
        onClose={refreshedOnClose}
      />,
    );

    expect(labelInput).toHaveValue("Dev");
    expect(screen.getByLabelText("Script")).toHaveValue("bun run dev");
    await waitFor(() => {
      expect(labelInput).toHaveFocus();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(refreshedOnClose).not.toHaveBeenCalled();
    opener.remove();
  });

  it("cleans up focus and body scroll lock when the backing project disappears", async () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();

    const onClose = vi.fn();
    const { rerender } = render(
      <ProjectActionCreateDialog
        open
        project={makeProject()}
        shortcutSettings={{}}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(document.body.style.overflow).toBe("hidden");
    });

    rerender(
      <ProjectActionCreateDialog
        open
        project={null}
        shortcutSettings={{}}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add Action" })).toBeNull();
      expect(document.body.style.overflow).toBe("");
      expect(opener).toHaveFocus();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    opener.remove();
  });

  it("recovers when saving the action rejects", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const updateProjectSettings = vi.fn().mockRejectedValue(new Error("Save exploded"));
    useWorkspaceStore.setState((state) => ({
      ...state,
      updateProjectSettings,
    }));

    render(
      <ProjectActionCreateDialog
        open
        project={makeProject({ id: "project-1", name: "Skein" })}
        shortcutSettings={{}}
        onClose={onClose}
      />,
    );

    await user.type(screen.getByLabelText("Label"), "Dev");
    await user.type(screen.getByLabelText("Script"), "bun run dev");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("Save exploded")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add Action" })).toBeInTheDocument();
    expect(updateProjectSettings).toHaveBeenCalledTimes(1);
  });

  it("allows project actions to reuse the retired new worktree shortcut", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const updateProjectSettings = vi.fn().mockResolvedValue({
      ok: true,
      warningMessage: null,
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      updateProjectSettings,
    }));

    render(
      <ProjectActionCreateDialog
        open
        project={makeProject({ id: "project-1", name: "Skein" })}
        shortcutSettings={makeGlobalSettings().shortcuts}
        onClose={onClose}
      />,
    );

    await user.type(screen.getByLabelText("Label"), "Dev");
    fireEvent.keyDown(screen.getByLabelText("Dev shortcut"), {
      key: "n",
      ...primaryModifier(),
    });
    await user.type(screen.getByLabelText("Script"), "bun run dev");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(updateProjectSettings).toHaveBeenCalledWith("project-1", {
        manualActions: [
          expect.objectContaining({
            label: "Dev",
            script: "bun run dev",
            shortcut: "mod+n",
          }),
        ],
      });
    });

    expect(
      screen.queryByText(/already uses this shortcut/i),
    ).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
