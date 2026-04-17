import type {
  ConversationTaskSnapshot,
  PendingApprovalRequest,
  PendingUserInputRequest,
  ProposedPlanSnapshot,
  SubagentThreadSnapshot,
  ConversationComposerSettings,
  EnvironmentCapabilitiesSnapshot,
  EnvironmentRecord,
  GitChangeSectionSnapshot,
  GitFileDiff,
  GitReviewSnapshot,
  GlobalSettings,
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
  serviceTier: null,
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
      inputModalities: ["text", "image"],
      supportedServiceTiers: ["fast"],
      isDefault: true,
    },
  ],
  collaborationModes: [
    { id: "build", label: "Build", mode: "build" },
    { id: "plan", label: "Plan", mode: "plan", reasoningEffort: "high" },
  ],
};

export function makeGlobalSettings(
  overrides: Partial<GlobalSettings> = {},
): GlobalSettings {
  return {
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "high",
    defaultCollaborationMode: "build",
    defaultApprovalPolicy: "askToEdit",
    defaultServiceTier: null,
    collapseWorkActivity: true,
    desktopNotificationsEnabled: false,
    streamAssistantResponses: true,
    multiAgentNudgeEnabled: false,
    multiAgentNudgeMaxSubagents: 4,
    notificationSounds: {
      attention: {
        enabled: false,
        sound: "glass",
      },
      completion: {
        enabled: false,
        sound: "polite",
      },
    },
    shortcuts: {
      openSettings: "mod+comma",
      focusComposer: "mod+l",
      toggleProjectsSidebar: "mod+b",
      toggleReviewPanel: "mod+g",
      toggleTerminal: "mod+j",
      newThread: "mod+t",
      archiveCurrentThread: "mod+w",
      nextThread: "mod+shift+]",
      previousThread: "mod+shift+[",
      newWorktree: "mod+n",
      nextEnvironment: "mod+alt+arrowdown",
      previousEnvironment: "mod+alt+arrowup",
      cycleCollaborationMode: "shift+tab",
      cycleModel: "mod+shift+m",
      cycleReasoningEffort: "mod+shift+r",
      cycleApprovalPolicy: "mod+shift+a",
      interruptThread: "ctrl+c",
      approveOrSubmit: "mod+enter",
    },
    openTargets: [
      {
        id: "cursor",
        label: "Cursor",
        kind: "app",
        appName: "Cursor",
      },
      {
        id: "zed",
        label: "Zed",
        kind: "app",
        appName: "Zed",
      },
      {
        id: "file-manager",
        label: "Finder",
        kind: "fileManager",
        appName: null,
      },
    ],
    defaultOpenTargetId: "file-manager",
    codexBinaryPath: undefined,
    ...overrides,
  };
}

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
    path: "/tmp/skein",
    gitBranch: "main",
    baseBranch: undefined,
    isDefault: true,
    pullRequest: undefined,
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
    name: "Skein",
    rootPath: "/tmp/skein",
    settings: {
      worktreeSetupScript: undefined,
      worktreeTeardownScript: undefined,
      manualActions: [],
    },
    sidebarCollapsed: false,
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
    settings: makeGlobalSettings(),
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
        turnId: "turn-1",
        role: "user",
        text: "Inspect the repository",
        images: null,
        isStreaming: false,
      },
      {
        kind: "reasoning",
        id: "reason-1",
        turnId: "turn-1",
        summary: "Inspecting the workspace",
        content: "Looking through package.json and the runtime service.",
        isStreaming: false,
      },
      {
        kind: "tool",
        id: "tool-1",
        turnId: "turn-1",
        toolType: "commandExecution",
        title: "Command",
        status: "completed",
        summary: "bun run test",
        output: "3 tests passed",
      },
      {
        kind: "message",
        id: "assistant-1",
        turnId: "turn-1",
        role: "assistant",
        text: "The workspace looks healthy.",
        images: null,
        isStreaming: false,
      },
    ],
    subagents: [],
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
    pendingInteractions: [],
    proposedPlan: null,
    taskPlan: null,
    error: null,
    composer: baseComposer,
    ...overrides,
  };
}

export function makeSubagent(
  overrides: Partial<SubagentThreadSnapshot> = {},
): SubagentThreadSnapshot {
  return {
    threadId: "subagent-1",
    nickname: "Scout",
    role: "explorer",
    depth: 1,
    status: "running",
    ...overrides,
  };
}

export function makeUserInputRequest(
  overrides: Partial<PendingUserInputRequest> = {},
): PendingUserInputRequest {
  return {
    kind: "userInput",
    id: "interaction-user-input-1",
    method: "item/tool/requestUserInput",
    threadId: "thr_codex_1",
    turnId: "turn-1",
    itemId: "item-user-input-1",
    questions: [
      {
        id: "question-1",
        header: "Approval",
        question: "Which path should Codex take?",
        options: [
          { label: "Option A", description: "Recommended path" },
          { label: "Option B", description: "Safer but slower" },
          { label: "Option C", description: "Aggressive shortcut" },
        ],
        isOther: true,
        isSecret: false,
      },
    ],
    ...overrides,
  };
}

export function makeApprovalRequest(
  overrides: Partial<PendingApprovalRequest> = {},
): PendingApprovalRequest {
  return {
    kind: "approval",
    id: "interaction-approval-1",
    method: "item/commandExecution/requestApproval",
    threadId: "thr_codex_1",
    turnId: "turn-1",
    itemId: "item-command-1",
    approvalKind: "commandExecution",
    title: "Command approval",
    summary: "bun run test",
    reason: "Codex wants to run the test suite.",
    command: "bun run test",
    cwd: "/tmp/skein",
    grantRoot: null,
    permissions: null,
    networkContext: null,
    proposedExecpolicyAmendment: [],
    proposedNetworkPolicyAmendments: [],
    ...overrides,
  };
}

export function makeProposedPlan(
  overrides: Partial<ProposedPlanSnapshot> = {},
): ProposedPlanSnapshot {
  return {
    turnId: "turn-plan-1",
    itemId: "plan-item-1",
    explanation: "Codex clarified the implementation path.",
    steps: [
      { step: "Inspect the runtime layer", status: "completed" },
      { step: "Implement the plan UI", status: "inProgress" },
      { step: "Validate interactions", status: "pending" },
    ],
    markdown:
      "## Proposed plan\n\n- Inspect the runtime layer\n- Implement the plan UI\n- Validate interactions",
    status: "ready",
    isAwaitingDecision: true,
    ...overrides,
  };
}

export function makeTaskPlan(
  overrides: Partial<ConversationTaskSnapshot> = {},
): ConversationTaskSnapshot {
  return {
    turnId: "turn-task-1",
    itemId: "task-item-1",
    explanation: "Codex is working through the implementation.",
    steps: [
      { step: "Inspect the runtime layer", status: "completed" },
      { step: "Implement the task UI", status: "inProgress" },
      { step: "Validate interactions", status: "pending" },
    ],
    markdown:
      "## Tasks\n\n- Inspect the runtime layer\n- Implement the task UI\n- Validate interactions",
    status: "running",
    ...overrides,
  };
}

export function makeGitReviewSnapshot(
  overrides: Partial<GitReviewSnapshot> = {},
): GitReviewSnapshot {
  return {
    environmentId: "env-1",
    scope: "uncommitted",
    summary: {
      environmentId: "env-1",
      repoPath: "/tmp/skein",
      branch: "main",
      baseBranch: "origin/main",
      upstreamBranch: "origin/main",
      ahead: 1,
      behind: 0,
      dirty: true,
      hasStagedChanges: true,
      hasUnstagedChanges: true,
      hasUntrackedChanges: false,
    },
    sections: [
      {
        id: "staged",
        label: "Staged",
        files: [
          {
            path: "src/app.ts",
            oldPath: null,
            section: "staged",
            kind: "modified",
            additions: null,
            deletions: null,
            canStage: false,
            canUnstage: true,
            canRevert: true,
          },
        ],
      },
      {
        id: "unstaged",
        label: "Unstaged",
        files: [
          {
            path: "src/lib.ts",
            oldPath: null,
            section: "unstaged",
            kind: "added",
            additions: null,
            deletions: null,
            canStage: true,
            canUnstage: false,
            canRevert: true,
          },
        ],
      },
    ] satisfies GitChangeSectionSnapshot[],
    ...overrides,
  };
}

export function makeGitFileDiff(
  overrides: Partial<GitFileDiff> = {},
): GitFileDiff {
  return {
    environmentId: "env-1",
    scope: "uncommitted",
    section: "staged",
    path: "src/app.ts",
    oldPath: null,
    kind: "modified",
    isBinary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [
          {
            kind: "removed",
            text: "-const answer = 1;",
            oldLineNumber: 1,
            newLineNumber: null,
          },
          {
            kind: "added",
            text: "+const answer = 2;",
            oldLineNumber: null,
            newLineNumber: 1,
          },
        ],
      },
    ],
    emptyMessage: null,
    ...overrides,
  };
}
