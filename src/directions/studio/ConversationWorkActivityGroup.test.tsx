import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ConversationItem } from "../../lib/types";
import { ConversationWorkActivityGroup } from "./ConversationWorkActivityGroup";
import type {
  ConversationWorkActivityGroup as ConversationWorkActivityGroupData,
  WorkActivityStatus,
} from "./conversation-work-activity";

describe("ConversationWorkActivityGroup", () => {
  it("starts collapsed for completed work and shows the body when expanded", async () => {
    const { container } = render(
      <ConversationWorkActivityGroup
        group={makeGroup({ itemCount: 3, status: "completed" })}
        provider="codex"
      />,
    );

    expect(container.querySelector(".tx-work-activity__body")).toBeNull();

    const toggle = container.querySelector(".tx-work-activity__toggle");
    expect(toggle).not.toBeNull();
    await userEvent.click(toggle as HTMLElement);

    expect(container.querySelector(".tx-work-activity__body")).not.toBeNull();
  });

  it("starts expanded while work is still running and collapses when toggled", async () => {
    const { container } = render(
      <ConversationWorkActivityGroup
        group={makeGroup({ itemCount: 3, status: "running" })}
        provider="codex"
      />,
    );

    expect(container.querySelector(".tx-work-activity__body")).not.toBeNull();

    const toggle = container.querySelector(".tx-work-activity__toggle");
    expect(toggle).not.toBeNull();
    await userEvent.click(toggle as HTMLElement);

    await waitFor(() => {
      expect(container.querySelector(".tx-work-activity__body")).toBeNull();
    });
  });
});

function makeGroup({
  itemCount,
  status,
}: {
  itemCount: number;
  status: WorkActivityStatus;
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
    counts: {
      updateCount: itemCount,
      reasoningCount: 0,
      toolCount: 0,
      systemCount: 0,
    },
    status,
    startedAt: null,
    finishedAt: null,
  };
}
