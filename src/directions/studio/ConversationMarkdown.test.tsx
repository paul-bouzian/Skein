import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { openExternalMock } from "../../test/desktop-mock";
import { ConversationMarkdown } from "./ConversationMarkdown";

describe("ConversationMarkdown", () => {
  it("renders markdown links as external links and opens them with the desktop opener", async () => {
    render(
      <ConversationMarkdown
        markdown={"See [OpenAI](https://openai.com/docs) for the protocol details."}
      />,
    );

    const link = screen.getByRole("link", { name: "OpenAI" });
    expect(link).toHaveAttribute("href", "https://openai.com/docs");

    await userEvent.click(link);

    expect(openExternalMock).toHaveBeenCalledWith("https://openai.com/docs");
  });

  it("renders local markdown targets as compact file reference tokens", () => {
    const filePath =
      "/Users/tester/.skein/worktrees/skein-019d5b55/lively-dolphin/src/directions/studio/ConversationMarkdown.tsx";
    const { container } = render(
      <ConversationMarkdown
        markdown={`Updated [ConversationMarkdown.tsx](${filePath}) in this pass.`}
      />,
    );

    const token = screen.getByText("ConversationMarkdown.tsx");
    expect(token.tagName).toBe("SPAN");
    expect(token).toHaveClass("tx-markdown__file-ref");
    expect(token).toHaveAttribute("title", filePath);
    expect(token).toHaveAttribute("data-file-path", filePath);
    expect(token).not.toHaveAttribute("data-file-line");
    expect(token).not.toHaveAttribute("data-file-column");
    expect(
      screen.queryByRole("link", { name: "ConversationMarkdown.tsx" }),
    ).toBeNull();
    expect(container.textContent).toBe("Updated ConversationMarkdown.tsx in this pass.");
  });

  it("renders inline markdown inside file reference labels", () => {
    const filePath =
      "/Users/tester/.skein/worktrees/skein-019d5b55/lively-dolphin/src/directions/studio/ThreadConversation.tsx";

    render(
      <ConversationMarkdown
        markdown={`Updated [**ThreadConversation.tsx**](${filePath}) in this pass.`}
      />,
    );

    const token = screen.getByTitle(filePath);
    expect(token).toHaveClass("tx-markdown__file-ref");
    expect(screen.getByText("ThreadConversation.tsx").tagName).toBe("STRONG");
  });

  it.each([
    [
      "colon line reference",
      "src/directions/studio/ConversationMarkdown.tsx:42",
      "src/directions/studio/ConversationMarkdown.tsx",
      "42",
      null,
    ],
    [
      "colon line and column reference",
      "src/directions/studio/ConversationMarkdown.tsx:42:7",
      "src/directions/studio/ConversationMarkdown.tsx",
      "42",
      "7",
    ],
    [
      "hash line reference",
      "src/directions/studio/ConversationMarkdown.tsx#L42",
      "src/directions/studio/ConversationMarkdown.tsx",
      "42",
      null,
    ],
    [
      "hash line and column reference",
      "src/directions/studio/ConversationMarkdown.tsx#L42C7",
      "src/directions/studio/ConversationMarkdown.tsx",
      "42",
      "7",
    ],
    [
      "root-level file reference",
      "README.md#L8",
      "README.md",
      "8",
      null,
    ],
    [
      "non-whitelisted relative folder reference",
      "lib/utils.ts",
      "lib/utils.ts",
      null,
      null,
    ],
    [
      "parenthesized relative path reference",
      "src/app/(auth)/page.tsx:42",
      "src/app/(auth)/page.tsx",
      "42",
      null,
    ],
    [
      "windows absolute path reference",
      "C:\\repo\\src\\App.tsx:42",
      "C:\\repo\\src\\App.tsx",
      "42",
      null,
    ],
    [
      "common extensionless root file reference",
      "Dockerfile",
      "Dockerfile",
      null,
      null,
    ],
    [
      "common extensionless nested file reference",
      "infra/Makefile:9",
      "infra/Makefile",
      "9",
      null,
    ],
    [
      "common extensionless license reference",
      "LICENSE",
      "LICENSE",
      null,
      null,
    ],
  ])(
    "parses %s metadata from file references",
    (_name, rawTarget, expectedPath, expectedLine, expectedColumn) => {
      render(
        <ConversationMarkdown
          markdown={`Inspect [ConversationMarkdown.tsx](${rawTarget}) before shipping.`}
        />,
      );

      const token = screen.getByText("ConversationMarkdown.tsx");
      expect(token).toHaveAttribute("title", rawTarget);
      expect(token).toHaveAttribute("data-file-path", expectedPath);
      if (expectedLine) {
        expect(token).toHaveAttribute("data-file-line", expectedLine);
      } else {
        expect(token).not.toHaveAttribute("data-file-line");
      }
      if (expectedColumn) {
        expect(token).toHaveAttribute("data-file-column", expectedColumn);
      } else {
        expect(token).not.toHaveAttribute("data-file-column");
      }
    },
  );

  it("keeps parenthesized markdown targets intact until the matching closing parenthesis", () => {
    render(
      <ConversationMarkdown
        markdown={"Inspect [page.tsx](src/app/(auth)/page.tsx:42) before shipping."}
      />,
    );

    const token = screen.getByText("page.tsx");
    expect(token).toHaveAttribute("title", "src/app/(auth)/page.tsx:42");
    expect(token).toHaveAttribute("data-file-path", "src/app/(auth)/page.tsx");
    expect(token).toHaveAttribute("data-file-line", "42");
  });

  it("keeps windows paths with parenthesized folders intact while scanning markdown targets", () => {
    render(
      <ConversationMarkdown
        markdown={"Inspect [page.tsx](C:\\repo\\(auth)\\page.tsx:42) before shipping."}
      />,
    );

    const token = screen.getByText("page.tsx");
    expect(token).toHaveAttribute("title", "C:\\repo\\(auth)\\page.tsx:42");
    expect(token).toHaveAttribute("data-file-path", "C:\\repo\\(auth)\\page.tsx");
    expect(token).toHaveAttribute("data-file-line", "42");
  });

  it.each([
    "www.example.com",
    "www.example.com:443",
    "Section 1.2",
    "v1.2.3",
  ])("leaves ambiguous dotted target %s as plain text", (rawTarget) => {
    const { container } = render(
      <ConversationMarkdown markdown={`Inspect [literal](${rawTarget}) before shipping.`} />,
    );

    expect(container.querySelector(".tx-markdown__file-ref")).toBeNull();
    expect(screen.queryByRole("link", { name: "literal" })).toBeNull();
    expect(container.textContent).toBe(`Inspect [literal](${rawTarget}) before shipping.`);
  });

  it("leaves non-http, non-local markdown targets as plain text", () => {
    const { container } = render(
      <ConversationMarkdown markdown={"Ignore [ratio](1/2) and keep it literal."} />,
    );

    expect(screen.queryByRole("link", { name: "ratio" })).toBeNull();
    expect(container.textContent).toBe("Ignore [ratio](1/2) and keep it literal.");
  });
});
