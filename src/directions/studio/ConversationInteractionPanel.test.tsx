import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeUserInputRequest } from "../../test/fixtures/conversation";
import { ConversationInteractionPanel } from "./ConversationInteractionPanel";

describe("ConversationInteractionPanel", () => {
  it("does not replay an old submit shortcut onto the next interaction", async () => {
    const onSubmitAnswers = vi.fn(async () => undefined);
    const onRespondApproval = vi.fn(async () => undefined);
    const firstInteraction = makeUserInputRequest({
      id: "interaction-1",
      questions: [],
    });
    const { rerender } = render(
      <ConversationInteractionPanel
        interaction={firstInteraction}
        queueCount={1}
        submitShortcutKey={0}
        onRespondApproval={onRespondApproval}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    rerender(
      <ConversationInteractionPanel
        interaction={firstInteraction}
        queueCount={1}
        submitShortcutKey={1}
        onRespondApproval={onRespondApproval}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    await waitFor(() => {
      expect(onSubmitAnswers).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ConversationInteractionPanel
        interaction={makeUserInputRequest({
          id: "interaction-2",
          questions: [],
        })}
        queueCount={1}
        submitShortcutKey={1}
        onRespondApproval={onRespondApproval}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubmitAnswers).toHaveBeenCalledTimes(1);
  });
});
