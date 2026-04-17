import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationItem } from "../../lib/types";
import { ConversationWorkActivityGroup } from "./ConversationWorkActivityGroup";
import type { ConversationWorkActivityGroup as ConversationWorkActivityGroupData } from "./conversation-work-activity";

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalRaf = globalThis.requestAnimationFrame;

let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoViewSpy = vi.fn();
  Element.prototype.scrollIntoView =
    scrollIntoViewSpy as unknown as typeof Element.prototype.scrollIntoView;
  // Run rAF callbacks synchronously so the scroll effect fires during the test.
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  }) as typeof requestAnimationFrame;
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  globalThis.requestAnimationFrame = originalRaf;
});

describe("ConversationWorkActivityGroup", () => {
  it("hides the body until the toggle is pressed", () => {
    const { container } = render(
      <ConversationWorkActivityGroup group={makeGroup({ itemCount: 3 })} />,
    );

    expect(container.querySelector(".tx-work-activity__body")).toBeNull();
  });

  it("reveals the body and scrolls the section into view on expand", async () => {
    const { container } = render(
      <ConversationWorkActivityGroup group={makeGroup({ itemCount: 3 })} />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );

    expect(container.querySelector(".tx-work-activity__body")).not.toBeNull();
    expect(scrollIntoViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth", block: "nearest" }),
    );
  });

  it("collapses the body when toggled again", async () => {
    const { container } = render(
      <ConversationWorkActivityGroup group={makeGroup({ itemCount: 3 })} />,
    );

    const toggle = screen.getByRole("button", { name: "Show work activity details" });
    await userEvent.click(toggle);
    await userEvent.click(
      screen.getByRole("button", { name: "Hide work activity details" }),
    );

    expect(container.querySelector(".tx-work-activity__body")).toBeNull();
  });
});

function makeGroup({
  itemCount,
}: {
  itemCount: number;
}): ConversationWorkActivityGroupData {
  const items = Array.from({ length: itemCount }, (_, index): ConversationItem => ({
    kind: "message",
    id: `update-${index}`,
    turnId: "turn-work-activity",
    role: "assistant",
    text: `Update ${index + 1}`,
    images: null,
    isStreaming: index === itemCount - 1,
  }));

  return {
    id: "work-turn-work-activity",
    turnId: "turn-work-activity",
    items,
    taskPlan: null,
    subagents: [],
    counts: {
      updateCount: itemCount,
      reasoningCount: 0,
      toolCount: 0,
      systemCount: 0,
      subagentCount: 0,
    },
    status: "running",
  };
}
