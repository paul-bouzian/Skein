import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import * as bridge from "../../lib/bridge";
import {
  makeGitFileDiff,
  makeGitReviewSnapshot,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useGitReviewStore } from "../../stores/git-review-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  WorkspaceRightPanel,
  type WorkspaceRightPanelTab,
} from "./WorkspaceRightPanel";

vi.mock("./BrowserPanel", () => ({
  BrowserPanel: ({ collapsed = false }: { collapsed?: boolean }) => (
    <div data-testid="browser-panel" data-collapsed={String(collapsed)} />
  ),
}));

vi.mock("../../lib/bridge", () => ({
  getGitFileDiff: vi.fn(),
  getGitReviewSnapshot: vi.fn(),
  revertAllGitChanges: vi.fn(),
  revertGitFile: vi.fn(),
  runGitAction: vi.fn(),
  stageAllGitChanges: vi.fn(),
  stageGitFile: vi.fn(),
  unstageAllGitChanges: vi.fn(),
  unstageGitFile: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function renderPanel(initialTab: WorkspaceRightPanelTab = "diff") {
  function Harness() {
    const [activeTab, setActiveTab] = useState<WorkspaceRightPanelTab>(initialTab);
    return (
      <WorkspaceRightPanel
        activeTab={activeTab}
        collapsed={false}
        onClose={() => undefined}
        onTabChange={setActiveTab}
      />
    );
  }

  return render(<Harness />);
}

beforeEach(() => {
  const snapshot = makeGitReviewSnapshot();
  mockedBridge.getGitReviewSnapshot.mockResolvedValue(snapshot);
  mockedBridge.getGitFileDiff.mockResolvedValue(makeGitFileDiff());

  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot(),
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
    selectedThreadId: "thread-1",
  }));
  useGitReviewStore.setState((state) => ({
    ...state,
    scopeByEnvironmentId: {},
    snapshotsByContext: {
      "env-1:uncommitted": snapshot,
    },
    selectedFileByContext: {},
    diffsByContext: {},
    diffErrorByContext: {},
    loadingByContext: {},
    reviewRequestIdByContext: {},
    diffLoadingByContext: {},
    diffRequestIdByContext: {},
    actionByEnvironmentId: {},
    generatingCommitMessageByEnvironmentId: {},
    errorByContext: {},
  }));
});

describe("WorkspaceRightPanel", () => {
  it("switches between Review and Browser tabs", async () => {
    renderPanel();

    expect(screen.getByRole("tabpanel", { name: "Review" })).not.toHaveClass(
      "workspace-right-panel__tab-panel--hidden",
    );

    await userEvent.click(screen.getByRole("tab", { name: /Browser/ }));
    expect(screen.getByRole("tabpanel", { name: "Browser" })).not.toHaveClass(
      "workspace-right-panel__tab-panel--hidden",
    );
    expect(screen.getByTestId("browser-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
  });

  it("keeps the browser mounted but collapsed while Review is active", () => {
    renderPanel("diff");

    expect(screen.getByTestId("browser-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("loads expanded file diffs in the Review tab", async () => {
    renderPanel("diff");

    await waitFor(() => {
      expect(screen.getByRole("tabpanel", { name: "Review" })).not.toHaveClass(
        "workspace-right-panel__tab-panel--hidden",
      );
    });
    const fileToggle = screen
      .getAllByRole("button", { name: /src\/lib\.ts/ })
      .find((button) => button.className.includes("workspace-right-panel__file-toggle"));
    expect(fileToggle).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitFor(() => {
      expect(screen.getAllByText("+const answer = 2;").length).toBeGreaterThan(1);
    });
    expect(mockedBridge.getGitFileDiff).toHaveBeenCalledWith({
      environmentId: "env-1",
      scope: "uncommitted",
      section: "unstaged",
      path: "src/lib.ts",
    });
  });

  it("collapses an expanded file on the first click even when another file was selected", async () => {
    renderPanel("diff");

    await waitFor(() => {
      expect(mockedBridge.getGitFileDiff).toHaveBeenCalled();
    });
    const fileToggle = screen
      .getAllByRole("button", { name: /src\/lib\.ts/ })
      .find((button) => button.className.includes("workspace-right-panel__file-toggle"));
    expect(fileToggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(fileToggle!);

    expect(fileToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a direct empty Review state when there are no file changes", async () => {
    const emptySnapshot = makeGitReviewSnapshot({ sections: [] });
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(emptySnapshot);
    useGitReviewStore.setState((state) => ({
      ...state,
      snapshotsByContext: {
        "env-1:uncommitted": emptySnapshot,
      },
    }));

    renderPanel("diff");

    expect(await screen.findByText("No file changes yet")).toBeInTheDocument();
    expect(screen.queryByText("Uncommitted")).toBeNull();
    expect(screen.queryByText("Stage all")).toBeNull();
  });
});
