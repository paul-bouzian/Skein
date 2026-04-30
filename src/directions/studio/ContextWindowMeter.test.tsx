import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ThreadTokenUsageSnapshot } from "../../lib/types";
import { ContextWindowMeter } from "./ContextWindowMeter";

const usageFixture: ThreadTokenUsageSnapshot = {
  total: {
    totalTokens: 4_096,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: 384,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 128_000,
};

describe("ContextWindowMeter", () => {
  it("renders its tooltip through a portal on hover", async () => {
    const { container } = render(<ContextWindowMeter usage={usageFixture} />);
    const user = userEvent.setup();

    const trigger = screen.getByRole("button", {
      name: "Context window 0% used",
    });

    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(container.querySelector(".tx-context-meter__tooltip")).toBeNull();
    expect(document.body.querySelector(".tx-context-meter__tooltip")).toBe(
      tooltip,
    );
    expect(tooltip).toHaveTextContent("Context window");
    expect(tooltip).toHaveTextContent("0% · 384/128k context used");
  });

  it("uses the selected context window override in the tooltip", async () => {
    render(
      <ContextWindowMeter
        usage={{ ...usageFixture, modelContextWindow: 1_000_000 }}
        contextWindowTokens={200_000}
      />,
    );
    const user = userEvent.setup();

    await user.hover(
      screen.getByRole("button", { name: "Context window 0% used" }),
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "0% · 384/200k context used",
    );
  });

  it("opens on focus and closes on blur", async () => {
    render(<ContextWindowMeter usage={usageFixture} />);
    const user = userEvent.setup();

    await user.tab();

    const trigger = screen.getByRole("button", {
      name: "Context window 0% used",
    });
    const tooltip = await screen.findByRole("tooltip");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);

    await user.tab();

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });

  it("closes when hover ends", async () => {
    render(<ContextWindowMeter usage={usageFixture} />);
    const user = userEvent.setup();

    const trigger = screen.getByRole("button", {
      name: "Context window 0% used",
    });

    await user.hover(trigger);
    await screen.findByRole("tooltip");

    await user.unhover(trigger);

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });
});
