import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudioWelcome } from "./StudioWelcome";
import { useProjectImport } from "./useProjectImport";

vi.mock("./useProjectImport", () => ({
  useProjectImport: vi.fn(),
}));

const mockedUseProjectImport = vi.mocked(useProjectImport);

describe("StudioWelcome", () => {
  beforeEach(() => {
    mockedUseProjectImport.mockReset();
    mockedUseProjectImport.mockReturnValue({
      error: null,
      clearError: vi.fn(),
      importProject: vi.fn(async () => null),
      isImporting: false,
    });
  });

  it("renders the Skein app icon instead of the legacy TX badge", () => {
    const { container } = render(<StudioWelcome />);

    expect(screen.getByRole("heading", { name: "Welcome to Skein" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add your first project to start managing Codex environments and threads.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(screen.queryByText("TX")).toBeNull();

    const logo = container.querySelector(".studio-welcome__logo");
    expect(logo).toBeInstanceOf(HTMLImageElement);
  });

  it("shows the importing label while the project picker flow is active", () => {
    mockedUseProjectImport.mockReturnValue({
      error: null,
      clearError: vi.fn(),
      importProject: vi.fn(async () => null),
      isImporting: true,
    });

    render(<StudioWelcome />);

    expect(screen.getByRole("button", { name: "Importing..." })).toBeDisabled();
  });
});
