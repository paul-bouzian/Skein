import { describe, expect, it } from "vitest";

import { createClaudeEventNormalizer } from "./claude-agent-events.js";

describe("Claude event normalizer", () => {
  it("streams thinking deltas as reasoning activity", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    normalizer.processStreamMessage({ event: { type: "message_start" } });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    });

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Inspecting the tool flow." },
        },
      }),
    ).toEqual([
      {
        kind: "reasoning",
        itemId: "turn-1-message-0-reasoning-0",
        delta: "Inspecting the tool flow.",
      },
    ]);
  });

  it("starts and updates server web search tools in real time", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
          },
        },
      }),
    ).toEqual([
      {
        kind: "toolStarted",
        itemId: "srvtoolu_1",
        toolName: "WebSearch",
        title: "Web",
        summary: "",
      },
    ]);

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: "{\"query\":\"Claude Agent SDK streaming\"}",
          },
        },
      }),
    ).toEqual([
      {
        kind: "toolUpdated",
        itemId: "srvtoolu_1",
        toolName: "WebSearch",
        title: "Web",
        summary: "Claude Agent SDK streaming",
      },
    ]);
  });

  it("completes web search tools from streamed result blocks", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
        },
      },
    });

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                title: "Streaming output",
                url: "https://code.claude.com/docs/en/agent-sdk/streaming-output",
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        kind: "toolOutput",
        itemId: "srvtoolu_1",
        delta: "Streaming output - https://code.claude.com/docs/en/agent-sdk/streaming-output",
        isError: false,
      },
      {
        kind: "toolCompleted",
        itemId: "srvtoolu_1",
        isError: false,
      },
    ]);
  });

  it("completes local tool uses from user tool result messages", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "src/main.ts" },
        },
      },
    });

    expect(
      normalizer.processUserToolResults({
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "file contents" }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "toolOutput",
        itemId: "toolu_1",
        delta: "file contents",
        isError: false,
      },
      {
        kind: "toolCompleted",
        itemId: "toolu_1",
        isError: false,
      },
    ]);
  });

  it("does not duplicate streamed thinking or tool blocks from completed assistant messages", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Planning." },
      },
    });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "README.md" },
        },
      },
    });

    expect(
      normalizer.processAssistantMessage({
        uuid: "assistant-1",
        message: {
          content: [
            { type: "thinking", thinking: "Planning.", signature: "sig" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("allows later assistant messages to recover missing completed thinking blocks", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({ event: { type: "message_start" } });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Planning." },
      },
    });
    expect(
      normalizer.processAssistantMessage({
        uuid: "assistant-1",
        message: {
          content: [{ type: "thinking", thinking: "Planning.", signature: "sig" }],
        },
      }),
    ).toEqual([]);

    normalizer.processStreamMessage({ event: { type: "message_start" } });
    expect(
      normalizer.processAssistantMessage({
        uuid: "assistant-2",
        message: {
          content: [{ type: "thinking", thinking: "Checking results.", signature: "sig" }],
        },
      }),
    ).toEqual([{
      kind: "reasoning",
      itemId: "assistant-2-reasoning-0",
      delta: "Checking results.",
    }]);
  });

  it("recovers unstreamed thinking blocks from the same assistant message", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({ event: { type: "message_start" } });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Streamed block." },
      },
    });

    expect(
      normalizer.processAssistantMessage({
        uuid: "assistant-1",
        message: {
          content: [
            { type: "thinking", thinking: "Streamed block.", signature: "sig" },
            { type: "thinking", thinking: "Final-only block.", signature: "sig" },
          ],
        },
      }),
    ).toEqual([{
      kind: "reasoning",
      itemId: "assistant-1-reasoning-1",
      delta: "Final-only block.",
    }]);
  });

  it("uses unique fallback ids for assistant messages without uuids", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    expect(
      normalizer.processAssistantMessage({
        message: {
          content: [
            { type: "thinking", thinking: "First fallback.", signature: "sig" },
            { type: "tool_use", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "reasoning",
        itemId: "turn-1-assistant-0-reasoning-0",
        delta: "First fallback.",
      },
      {
        kind: "toolStarted",
        itemId: "turn-1-assistant-0-tool-1",
        toolName: "Read",
        title: "Search",
        summary: "README.md",
      },
    ]);

    expect(
      normalizer.processAssistantMessage({
        message: {
          content: [
            { type: "thinking", thinking: "Second fallback.", signature: "sig" },
            { type: "tool_use", name: "Read", input: { file_path: "CHANGELOG.md" } },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "reasoning",
        itemId: "turn-1-assistant-1-reasoning-0",
        delta: "Second fallback.",
      },
      {
        kind: "toolStarted",
        itemId: "turn-1-assistant-1-tool-1",
        toolName: "Read",
        title: "Search",
        summary: "CHANGELOG.md",
      },
    ]);
  });

  it("does not replay streamed tool blocks that lack provider ids", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({ event: { type: "message_start" } });

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            name: "Read",
            input: { file_path: "README.md" },
          },
        },
      }),
    ).toEqual([{
      kind: "toolStarted",
      itemId: "turn-1-message-0-tool-2",
      toolName: "Read",
      title: "Search",
      summary: "README.md",
    }]);

    expect(
      normalizer.processAssistantMessage({
        message: {
          content: [
            { type: "text", text: "I will inspect the file." },
            { type: "text", text: "Now reading." },
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("aliases completed tool ids back to streamed fallback tool ids", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({ event: { type: "message_start" } });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          name: "Read",
          input: { file_path: "README.md" },
        },
      },
    });

    expect(
      normalizer.processAssistantMessage({
        message: {
          content: [
            { type: "text", text: "Reading." },
            {
              type: "tool_use",
              id: "toolu_late",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      }),
    ).toEqual([]);

    expect(
      normalizer.processUserToolResults({
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_late",
            content: [{ type: "text", text: "file contents" }],
          }],
        },
      }),
    ).toEqual([
      {
        kind: "toolOutput",
        itemId: "turn-1-message-0-tool-1",
        delta: "file contents",
        isError: false,
      },
      {
        kind: "toolCompleted",
        itemId: "turn-1-message-0-tool-1",
        isError: false,
      },
    ]);
  });

  it("does not replay ExitPlanMode assistant blocks as tool activity", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_plan",
            name: "ExitPlanMode",
            input: { plan: "1. Inspect\n2. Update" },
          },
        },
      }),
    ).toEqual([{
      kind: "planReady",
      itemId: "toolu_plan",
      markdown: "1. Inspect\n2. Update",
    }]);

    expect(
      normalizer.processAssistantMessage({
        uuid: "assistant-plan",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu_plan",
            name: "ExitPlanMode",
            input: { plan: "1. Inspect\n2. Update" },
          }],
        },
      }),
    ).toEqual([]);
  });

  it("emits taskPlanUpdated for streamed TodoWrite tools and never as toolStarted", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_todo",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Read README", activeForm: "Reading README", status: "pending" },
                { content: "Run tests", activeForm: "Running tests", status: "in_progress" },
              ],
            },
          },
        },
      }),
    ).toEqual([
      {
        kind: "taskPlanUpdated",
        itemId: "toolu_todo",
        steps: [
          { content: "Read README", status: "pending" },
          { content: "Run tests", status: "inProgress" },
        ],
      },
    ]);

    expect(
      normalizer.processUserToolResults({
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_todo",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("re-emits taskPlanUpdated when TodoWrite todos change in subsequent calls", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_todo_1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Step A", status: "pending" },
              { content: "Step B", status: "pending" },
            ],
          },
        },
      },
    });

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_todo_2",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Step A", status: "completed" },
                { content: "Step B", status: "in_progress" },
              ],
            },
          },
        },
      }),
    ).toEqual([
      {
        kind: "taskPlanUpdated",
        itemId: "toolu_todo_2",
        steps: [
          { content: "Step A", status: "completed" },
          { content: "Step B", status: "inProgress" },
        ],
      },
    ]);
  });

  it("emits empty taskPlanUpdated when TodoWrite clears todos", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_todo",
          name: "TodoWrite",
          input: {
            todos: [{ content: "Step A", status: "pending" }],
          },
        },
      },
    });

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_todo_clear",
            name: "TodoWrite",
            input: { todos: [] },
          },
        },
      }),
    ).toEqual([
      {
        kind: "taskPlanUpdated",
        itemId: "toolu_todo_clear",
        steps: [],
      },
    ]);
  });

  it("streams taskPlanUpdated as the TodoWrite input becomes parseable", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    normalizer.processStreamMessage({ event: { type: "message_start" } });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_todo_stream",
          name: "TodoWrite",
        },
      },
    });

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"todos":[{"content":"Build","status":"in_progress"}]}',
          },
        },
      }),
    ).toEqual([
      {
        kind: "taskPlanUpdated",
        itemId: "toolu_todo_stream",
        steps: [{ content: "Build", status: "inProgress" }],
      },
    ]);
  });

  it("emits subagentStarted for Agent tool usage (Claude SDK)", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "Find weather data",
              subagent_type: "websearch",
              prompt: "Search the web for tomorrow's forecast.",
            },
          },
        },
      }),
    ).toEqual([
      {
        kind: "subagentStarted",
        itemId: "toolu_agent",
        description: "Find weather data",
        subagentType: "websearch",
      },
    ]);

    expect(
      normalizer.processUserToolResults({
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_agent",
              content: [{ type: "text", text: "Done" }],
            },
          ],
        },
      }),
    ).toEqual([
      { kind: "subagentCompleted", itemId: "toolu_agent", isError: false },
    ]);
  });

  it("emits subagentStarted then subagentCompleted for Task tool usage", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_task",
            name: "Task",
            input: {
              description: "Audit tests",
              subagent_type: "code-reviewer",
              prompt: "Review the test suite.",
            },
          },
        },
      }),
    ).toEqual([
      {
        kind: "subagentStarted",
        itemId: "toolu_task",
        description: "Audit tests",
        subagentType: "code-reviewer",
      },
    ]);

    expect(
      normalizer.processUserToolResults({
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_task",
              content: [{ type: "text", text: "Done" }],
            },
          ],
        },
      }),
    ).toEqual([
      { kind: "subagentCompleted", itemId: "toolu_task", isError: false },
    ]);
  });

  it("updates streamed subagent labels when the Agent input becomes parseable", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");

    normalizer.processStreamMessage({ event: { type: "message_start" } });
    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_agent_stream",
            name: "Agent",
          },
        },
      }),
    ).toEqual([
      {
        kind: "subagentStarted",
        itemId: "toolu_agent_stream",
        description: "",
        subagentType: "agent",
      },
    ]);

    expect(
      normalizer.processStreamMessage({
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"description":"Find weather data","subagent_type":"websearch"}',
          },
        },
      }),
    ).toEqual([
      {
        kind: "subagentStarted",
        itemId: "toolu_agent_stream",
        description: "Find weather data",
        subagentType: "websearch",
      },
    ]);
  });

  it("does not duplicate TodoWrite or Task events when assistant messages replay them", () => {
    const normalizer = createClaudeEventNormalizer("turn-1");
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_todo_a",
          name: "TodoWrite",
          input: { todos: [{ content: "A", status: "pending" }] },
        },
      },
    });
    normalizer.processStreamMessage({
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_task_a",
          name: "Task",
          input: { description: "Inspect", subagent_type: "explore" },
        },
      },
    });

    expect(
      normalizer.processAssistantMessage({
        uuid: "assistant-replay",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_todo_a",
              name: "TodoWrite",
              input: { todos: [{ content: "A", status: "pending" }] },
            },
            {
              type: "tool_use",
              id: "toolu_task_a",
              name: "Task",
              input: { description: "Inspect", subagent_type: "explore" },
            },
          ],
        },
      }),
    ).toEqual([]);
  });
});
