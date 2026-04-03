import type {
  ConversationComposerSettings,
  EnvironmentCapabilitiesSnapshot,
  EnvironmentRecord,
  ProjectRecord,
  ThreadConversationSnapshot,
  ThreadRecord,
  WorkspaceSnapshot,
} from "../../lib/types";

export const baseComposer: ConversationComposerSettings = {
  model: "gpt-5.4",
  reasoningEffort: "high",
  collaborationMode: "build",
  approvalPolicy: "askToEdit",
};

export const capabilitiesFixture: EnvironmentCapabilitiesSnapshot = {
  environmentId: "env-1",
  models: [
    {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "Primary Codex model",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      isDefault: true,
    },
  ],
  collaborationModes: [
    { id: "build", label: "Build", mode: "build" },
    { id: "plan", label: "Plan", mode: "plan", reasoningEffort: "high" },
  ],
};

export function makeThread(
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  return {
    id: "thread-1",
    environmentId: "env-1",
    title: "Thread 1",
    status: "active",
    codexThreadId: undefined,
    overrides: {},
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z",
    archivedAt: undefined,
    ...overrides,
  };
}

export function makeEnvironment(
  overrides: Partial<EnvironmentRecord> = {},
): EnvironmentRecord {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Local",
    kind: "local",
    path: "/tmp/threadex",
    gitBranch: "main",
    baseBranch: undefined,
    isDefault: true,
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z",
    threads: [makeThread()],
    runtime: {
      environmentId: "env-1",
      state: "running",
      pid: 123,
      binaryPath: "/opt/homebrew/bin/codex",
      startedAt: "2026-04-03T08:00:00Z",
      lastExitCode: undefined,
    },
    ...overrides,
  };
}

export function makeProject(
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id: "project-1",
    name: "ThreadEx",
    rootPath: "/tmp/threadex",
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z",
    environments: [makeEnvironment()],
    ...overrides,
  };
}

export function makeWorkspaceSnapshot(
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    settings: {
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: "high",
      defaultCollaborationMode: "build",
      defaultApprovalPolicy: "askToEdit",
      codexBinaryPath: "/opt/homebrew/bin/codex",
    },
    projects: [makeProject()],
    ...overrides,
  };
}

export function makeConversationSnapshot(
  overrides: Partial<ThreadConversationSnapshot> = {},
): ThreadConversationSnapshot {
  return {
    threadId: "thread-1",
    environmentId: "env-1",
    codexThreadId: "thr_codex_1",
    status: "completed",
    activeTurnId: null,
    items: [
      {
        kind: "message",
        id: "user-1",
        role: "user",
        text: "Inspect the repository",
        isStreaming: false,
      },
      {
        kind: "reasoning",
        id: "reason-1",
        summary: "Inspecting the workspace",
        content: "Looking through package.json and the runtime service.",
        isStreaming: false,
      },
      {
        kind: "tool",
        id: "tool-1",
        toolType: "commandExecution",
        title: "Command",
        status: "completed",
        summary: "bun run test",
        output: "3 tests passed",
      },
      {
        kind: "message",
        id: "assistant-1",
        role: "assistant",
        text: "The workspace looks healthy.",
        isStreaming: false,
      },
    ],
    tokenUsage: {
      total: {
        totalTokens: 1024,
        inputTokens: 400,
        cachedInputTokens: 64,
        outputTokens: 560,
        reasoningOutputTokens: 180,
      },
      last: {
        totalTokens: 512,
        inputTokens: 200,
        cachedInputTokens: 32,
        outputTokens: 280,
        reasoningOutputTokens: 96,
      },
      modelContextWindow: 200_000,
    },
    blockedInteraction: null,
    error: null,
    composer: baseComposer,
    ...overrides,
  };
}
