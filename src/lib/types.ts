/* ── Enums (match Rust serde output) ── */

export type EnvironmentKind = "local" | "managedWorktree" | "permanentWorktree";
export type ThreadStatus = "active" | "archived";
export type RuntimeState = "running" | "stopped" | "exited";
export type SubagentStatus = "running" | "completed" | "failed";
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
export type ConversationApprovalKind =
  | "commandExecution"
  | "fileChange"
  | "permissions";
export type ConversationItemStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined";
export type ConversationRole = "user" | "assistant";
export type ConversationTone = "info" | "warning" | "error";
export type ProposedPlanStatus =
  | "streaming"
  | "ready"
  | "approved"
  | "superseded";
export type ProposedPlanStepStatus = "pending" | "inProgress" | "completed";
export type PermissionGrantScope = "turn" | "session";
export type NetworkPolicyRuleAction = "allow" | "deny";

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

export type SubagentThreadSnapshot = {
  threadId: string;
  nickname?: string | null;
  role?: string | null;
  depth: number;
  status: SubagentStatus;
};

export type ProposedPlanStep = {
  step: string;
  status: ProposedPlanStepStatus;
};

export type ProposedPlanSnapshot = {
  turnId: string;
  itemId?: string | null;
  explanation: string;
  steps: ProposedPlanStep[];
  markdown: string;
  status: ProposedPlanStatus;
  isAwaitingDecision: boolean;
};

export type PendingUserInputOption = {
  label: string;
  description: string;
};

export type PendingUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: PendingUserInputOption[];
  isOther: boolean;
  isSecret: boolean;
};

export type FileSystemPermissionSnapshot = {
  read: string[];
  write: string[];
};

export type NetworkPermissionSnapshot = {
  enabled?: boolean | null;
};

export type PermissionProfileSnapshot = {
  fileSystem?: FileSystemPermissionSnapshot | null;
  network?: NetworkPermissionSnapshot | null;
};

export type NetworkPolicyAmendmentSnapshot = {
  action: NetworkPolicyRuleAction;
  host: string;
};

export type NetworkApprovalContextSnapshot = {
  host: string;
  protocol: string;
};

export type PendingApprovalRequest = {
  kind: "approval";
  id: string;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalKind: ConversationApprovalKind;
  title: string;
  summary?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  grantRoot?: string | null;
  permissions?: PermissionProfileSnapshot | null;
  networkContext?: NetworkApprovalContextSnapshot | null;
  proposedExecpolicyAmendment: string[];
  proposedNetworkPolicyAmendments: NetworkPolicyAmendmentSnapshot[];
};

export type PendingUserInputRequest = {
  kind: "userInput";
  id: string;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: PendingUserInputQuestion[];
};

export type UnsupportedInteractionRequest = {
  kind: "unsupported";
  id: string;
  method: string;
  threadId: string;
  turnId?: string | null;
  itemId?: string | null;
  title: string;
  message: string;
};

export type ConversationInteraction =
  | PendingApprovalRequest
  | PendingUserInputRequest
  | UnsupportedInteractionRequest;

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
  subagents: SubagentThreadSnapshot[];
  tokenUsage?: ThreadTokenUsageSnapshot | null;
  pendingInteractions: ConversationInteraction[];
  proposedPlan?: ProposedPlanSnapshot | null;
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
  composer?: ConversationComposerSettings | null;
};

export type ApprovalResponseInput =
  | {
      kind: "commandExecution";
      decision:
        | "accept"
        | "acceptForSession"
        | "decline"
        | "cancel"
        | "acceptWithExecpolicyAmendment";
      execpolicyAmendment?: string[];
    }
  | {
      kind: "commandExecution";
      decision: "applyNetworkPolicyAmendment";
      networkPolicyAmendment: NetworkPolicyAmendmentSnapshot;
    }
  | {
      kind: "fileChange";
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      kind: "permissions";
      decision: "approve" | "decline";
      permissions?: PermissionProfileSnapshot | null;
      scope?: PermissionGrantScope;
    };

export type RespondToApprovalRequestInput = {
  threadId: string;
  interactionId: string;
  response: ApprovalResponseInput;
};

export type RespondToUserInputRequestInput = {
  threadId: string;
  interactionId: string;
  answers: Record<string, string[]>;
};

export type SubmitPlanDecisionInput = {
  threadId: string;
  action: "approve" | "refine";
  feedback?: string;
  composer?: ConversationComposerSettings | null;
};

export type GlobalSettingsPatch = {
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultCollaborationMode?: CollaborationMode;
  defaultApprovalPolicy?: ApprovalPolicy;
  codexBinaryPath?: string | null;
};
