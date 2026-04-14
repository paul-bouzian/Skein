import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeProject } from "../../test/fixtures/conversation";
import { ProjectActionCreateDialog } from "./ProjectActionCreateDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn(),
}));

describe("ProjectActionCreateDialog", () => {
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
});
