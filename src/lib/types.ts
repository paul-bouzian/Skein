/* ── Enums (match Rust serde output) ── */

export type EnvironmentKind = "local" | "managedWorktree" | "permanentWorktree";
export type ThreadStatus = "active" | "archived";
export type RuntimeState = "running" | "stopped" | "exited";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type CollaborationMode = "build" | "plan";
export type ApprovalPolicy = "askToEdit" | "fullAccess";
export type ConversationStatus =
  | "idle"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "waitingForExternalAction";
export type ConversationItemStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined";
export type ConversationRole = "user" | "assistant";
export type ConversationTone = "info" | "warning" | "error";

/* ── Domain records ── */

export type ThreadOverrides = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  collaborationMode?: CollaborationMode;
  approvalPolicy?: ApprovalPolicy;
};

export type RuntimeStatusSnapshot = {
  environmentId: string;
  state: RuntimeState;
  pid?: number;
  binaryPath?: string;
  startedAt?: string;
  lastExitCode?: number;
};

export type ThreadRecord = {
  id: string;
  environmentId: string;
  title: string;
  status: ThreadStatus;
  codexThreadId?: string;
  overrides: ThreadOverrides;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type EnvironmentRecord = {
  id: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
  path: string;
  gitBranch?: string;
  baseBranch?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  threads: ThreadRecord[];
  runtime: RuntimeStatusSnapshot;
};

export type ProjectRecord = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  environments: EnvironmentRecord[];
};

export type GlobalSettings = {
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultCollaborationMode: CollaborationMode;
  defaultApprovalPolicy: ApprovalPolicy;
  codexBinaryPath?: string;
};

export type WorkspaceSnapshot = {
  settings: GlobalSettings;
  projects: ProjectRecord[];
};

/* ── Bootstrap ── */

export type BootstrapStatus = {
  appName: string;
  appVersion: string;
  backend: string;
  platform: string;
  appDataDir: string;
  databasePath: string;
  projectCount: number;
  environmentCount: number;
  threadCount: number;
};

/* ── Conversation ── */

export type ConversationComposerSettings = {
  model: string;
  reasoningEffort: ReasoningEffort;
  collaborationMode: CollaborationMode;
  approvalPolicy: ApprovalPolicy;
};

export type ModelOption = {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
  isDefault: boolean;
};

export type CollaborationModeOption = {
  id: CollaborationMode;
  label: string;
  mode: CollaborationMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export type EnvironmentCapabilitiesSnapshot = {
  environmentId: string;
  models: ModelOption[];
  collaborationModes: CollaborationModeOption[];
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsageSnapshot = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
};

export type BlockedInteractionSnapshot = {
  method: string;
  title: string;
  message: string;
};

export type ConversationErrorSnapshot = {
  message: string;
  codexErrorInfo?: string | null;
  additionalDetails?: string | null;
};

export type ConversationMessageItem = {
  kind: "message";
  id: string;
  role: ConversationRole;
  text: string;
  isStreaming: boolean;
};

export type ConversationReasoningItem = {
  kind: "reasoning";
  id: string;
  summary: string;
  content: string;
  isStreaming: boolean;
};

export type ConversationToolItem = {
  kind: "tool";
  id: string;
  toolType: string;
  title: string;
  status: ConversationItemStatus;
  summary?: string | null;
  output: string;
};

export type ConversationSystemItem = {
  kind: "system";
  id: string;
  tone: ConversationTone;
  title: string;
  body: string;
};

export type ConversationItem =
  | ConversationMessageItem
  | ConversationReasoningItem
  | ConversationToolItem
  | ConversationSystemItem;

export type ThreadConversationSnapshot = {
  threadId: string;
  environmentId: string;
  codexThreadId?: string | null;
  status: ConversationStatus;
  activeTurnId?: string | null;
  items: ConversationItem[];
  tokenUsage?: ThreadTokenUsageSnapshot | null;
  blockedInteraction?: BlockedInteractionSnapshot | null;
  error?: ConversationErrorSnapshot | null;
  composer: ConversationComposerSettings;
};

export type ThreadConversationOpenResponse = {
  snapshot: ThreadConversationSnapshot;
  capabilities: EnvironmentCapabilitiesSnapshot;
};

export type ConversationEventPayload = {
  threadId: string;
  environmentId: string;
  snapshot: ThreadConversationSnapshot;
};

/* ── Command requests ── */

export type AddProjectRequest = {
  path: string;
  name?: string;
};

export type RenameProjectRequest = {
  projectId: string;
  name: string;
};

export type CreateWorktreeRequest = {
  projectId: string;
  name: string;
  branchName?: string;
  baseBranch?: string;
  permanent: boolean;
};

export type CreateThreadRequest = {
  environmentId: string;
  title?: string;
  overrides?: ThreadOverrides;
};

export type RenameThreadRequest = {
  threadId: string;
  title: string;
};

export type ArchiveThreadRequest = {
  threadId: string;
};

export type SendThreadMessageInput = {
  threadId: string;
  text: string;
  composer?: ConversationComposerSettings;
};

export type GlobalSettingsPatch = {
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultCollaborationMode?: CollaborationMode;
  defaultApprovalPolicy?: ApprovalPolicy;
  codexBinaryPath?: string | null;
};
