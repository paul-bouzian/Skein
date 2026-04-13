/* ── Enums (match Rust serde output) ── */

export type EnvironmentKind = "local" | "managedWorktree" | "permanentWorktree";
export type ThreadStatus = "active" | "archived";
export type RuntimeState = "running" | "stopped" | "exited";
export type PullRequestState = "open" | "merged";
export type WorktreeScriptTrigger = "setup" | "teardown";
export type WorkspaceEventKind =
  | "environmentRenamed"
  | "environmentPullRequestChanged"
  | "runtimeStatusChanged"
  | "threadAutoRenamed";
export type GitReviewScope = "uncommitted" | "branch";
export type GitChangeSection = "staged" | "unstaged" | "untracked" | "branch";
export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "unmerged"
  | "unknown";
export type GitDiffLineKind = "hunk" | "context" | "added" | "removed";
export type SubagentStatus = "running" | "completed" | "failed";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type CollaborationMode = "build" | "plan";
export type ApprovalPolicy = "askToEdit" | "fullAccess";
export type OpenTargetKind = "app" | "fileManager";
export type ServiceTier = "fast" | "flex";
export type InputModality = "text" | "image";
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
export type ConversationTaskStatus =
  | "running"
  | "completed"
  | "interrupted"
  | "failed";
export type PermissionGrantScope = "turn" | "session";
export type NetworkPolicyRuleAction = "allow" | "deny";

/* ── Domain records ── */

export type ThreadOverrides = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  collaborationMode?: CollaborationMode;
  approvalPolicy?: ApprovalPolicy;
  serviceTier?: ServiceTier | null;
  serviceTierOverridden?: boolean;
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

export type EnvironmentPullRequestSnapshot = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
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
  pullRequest?: EnvironmentPullRequestSnapshot;
  createdAt: string;
  updatedAt: string;
  threads: ThreadRecord[];
  runtime: RuntimeStatusSnapshot;
};

export type ProjectSettings = {
  worktreeSetupScript?: string;
  worktreeTeardownScript?: string;
};

export type ShortcutSettings = {
  openSettings?: string | null;
  focusComposer?: string | null;
  toggleProjectsSidebar?: string | null;
  toggleReviewPanel?: string | null;
  toggleTerminal?: string | null;
  newThread?: string | null;
  archiveCurrentThread?: string | null;
  nextThread?: string | null;
  previousThread?: string | null;
  newWorktree?: string | null;
  nextEnvironment?: string | null;
  previousEnvironment?: string | null;
  cycleCollaborationMode?: string | null;
  cycleModel?: string | null;
  cycleReasoningEffort?: string | null;
  cycleApprovalPolicy?: string | null;
  interruptThread?: string | null;
  approveOrSubmit?: string | null;
};

export type ShortcutSettingsPatch = {
  openSettings?: string | null;
  focusComposer?: string | null;
  toggleProjectsSidebar?: string | null;
  toggleReviewPanel?: string | null;
  toggleTerminal?: string | null;
  newThread?: string | null;
  archiveCurrentThread?: string | null;
  nextThread?: string | null;
  previousThread?: string | null;
  newWorktree?: string | null;
  nextEnvironment?: string | null;
  previousEnvironment?: string | null;
  cycleCollaborationMode?: string | null;
  cycleModel?: string | null;
  cycleReasoningEffort?: string | null;
  cycleApprovalPolicy?: string | null;
  interruptThread?: string | null;
  approveOrSubmit?: string | null;
};

export type ProjectRecord = {
  id: string;
  name: string;
  rootPath: string;
  settings: ProjectSettings;
  sidebarCollapsed: boolean;
  createdAt: string;
  updatedAt: string;
  environments: EnvironmentRecord[];
};

export type GlobalSettings = {
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultCollaborationMode: CollaborationMode;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultServiceTier?: ServiceTier | null;
  collapseWorkActivity: boolean;
  desktopNotificationsEnabled: boolean;
  shortcuts: ShortcutSettings;
  openTargets: OpenTarget[];
  defaultOpenTargetId: string;
  codexBinaryPath?: string;
};

export type OpenTarget = {
  id: string;
  label: string;
  kind: OpenTargetKind;
  appName?: string | null;
};

export type WorkspaceSnapshot = {
  settings: GlobalSettings;
  projects: ProjectRecord[];
};

export type ManagedWorktreeCreateResult = {
  environment: EnvironmentRecord;
  thread: ThreadRecord;
};

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

export type CodexCreditsSnapshot = {
  balance?: string | null;
  hasCredits: boolean;
  unlimited: boolean;
};

export type CodexRateLimitWindow = {
  resetsAt?: number | null;
  usedPercent: number;
  windowDurationMins?: number | null;
};

export type CodexRateLimitSnapshot = {
  credits?: CodexCreditsSnapshot | null;
  limitId?: string | null;
  limitName?: string | null;
  planType?: CodexPlanType | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
};

export type CodexUsageEventPayload = {
  environmentId: string;
  rateLimits: CodexRateLimitSnapshot;
};

export type VoiceAuthMode = "apiKey" | "chatgpt" | "chatgptAuthTokens";
export type EnvironmentVoiceUnavailableReason =
  | "chatgptRequired"
  | "tokenMissing"
  | "runtimeUnavailable"
  | "unsupportedRuntime"
  | "platformUnsupported"
  | "unknown";

export type EnvironmentVoiceStatusSnapshot = {
  environmentId: string;
  available: boolean;
  authMode: VoiceAuthMode | null;
  unavailableReason: EnvironmentVoiceUnavailableReason | null;
  message: string | null;
};

export type TranscribeEnvironmentVoiceInput = {
  environmentId: string;
  mimeType: "audio/wav";
  sampleRateHz: number;
  durationMs: number;
  audioBase64: string;
};

export type VoiceTranscriptionResult = {
  text: string;
};

export type WorktreeScriptFailureEventPayload = {
  trigger: WorktreeScriptTrigger;
  projectId: string;
  projectName: string;
  worktreeId: string;
  worktreeName: string;
  worktreeBranch: string;
  worktreePath: string;
  message: string;
  logPath: string;
  exitCode?: number | null;
};

export type FirstPromptRenameFailureEventPayload = {
  projectId: string;
  environmentId: string;
  threadId: string;
  environmentName: string;
  branchName: string;
  message: string;
};

export type WorkspaceEventPayload = {
  kind: WorkspaceEventKind;
  projectId?: string | null;
  environmentId?: string | null;
  threadId?: string | null;
};

/* ── Git review ── */

export type GitRepoSummary = {
  environmentId: string;
  repoPath: string;
  branch?: string | null;
  baseBranch?: string | null;
  upstreamBranch?: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedChanges: boolean;
};

export type GitFileChange = {
  path: string;
  oldPath?: string | null;
  section: GitChangeSection;
  kind: GitChangeKind;
  additions?: number | null;
  deletions?: number | null;
  canStage: boolean;
  canUnstage: boolean;
  canRevert: boolean;
};

export type GitChangeSectionSnapshot = {
  id: GitChangeSection;
  label: string;
  files: GitFileChange[];
};

export type GitReviewSnapshot = {
  environmentId: string;
  scope: GitReviewScope;
  summary: GitRepoSummary;
  sections: GitChangeSectionSnapshot[];
};

export type GitDiffLine = {
  kind: GitDiffLineKind;
  text: string;
  oldLineNumber?: number | null;
  newLineNumber?: number | null;
};

export type GitDiffHunk = {
  header: string;
  lines: GitDiffLine[];
};

export type GitFileDiff = {
  environmentId: string;
  scope: GitReviewScope;
  section: GitChangeSection;
  path: string;
  oldPath?: string | null;
  kind: GitChangeKind;
  isBinary: boolean;
  hunks: GitDiffHunk[];
  emptyMessage?: string | null;
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

/* ── App updates ── */

export type AppUpdateState =
  | "idle"
  | "checking"
  | "available"
  | "installing"
  | "latest"
  | "error";

export type AppUpdateSnapshot = {
  currentVersion: string;
  availableVersion: string;
  releaseDate?: string | null;
  notes?: string | null;
  releaseUrl: string;
};

/* ── Conversation ── */

export type ConversationComposerSettings = {
  model: string;
  reasoningEffort: ReasoningEffort;
  collaborationMode: CollaborationMode;
  approvalPolicy: ApprovalPolicy;
  serviceTier?: ServiceTier | null;
};

export type ComposerPromptArgumentMode = "none" | "named" | "positional";

export type ComposerPromptOption = {
  name: string;
  description?: string | null;
  argumentMode: ComposerPromptArgumentMode;
  argumentNames: string[];
  positionalCount: number;
  argumentHint?: string | null;
};

export type ComposerSkillOption = {
  name: string;
  description: string;
  path: string;
};

export type ComposerAppOption = {
  id: string;
  name: string;
  description?: string | null;
  slug: string;
  path: string;
};

export type ThreadComposerCatalog = {
  prompts: ComposerPromptOption[];
  skills: ComposerSkillOption[];
  apps: ComposerAppOption[];
};

export type ComposerFileSearchResult = {
  path: string;
};

export type ModelOption = {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
  inputModalities: InputModality[];
  supportedServiceTiers?: ServiceTier[];
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

export type ConversationTaskSnapshot = {
  turnId: string;
  itemId?: string | null;
  explanation: string;
  steps: ProposedPlanStep[];
  markdown: string;
  status: ConversationTaskStatus;
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

export type ConversationImageAttachment =
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

export type ComposerMentionBindingInput = {
  mention: string;
  kind: "skill" | "app";
  path: string;
};

export type ComposerDraftMentionBinding = ComposerMentionBindingInput & {
  start: number;
  end: number;
};

export type ConversationComposerDraft = {
  text: string;
  images: ConversationImageAttachment[];
  mentionBindings: ComposerDraftMentionBinding[];
  isRefiningPlan: boolean;
};

export type ConversationMessageItem = {
  kind: "message";
  id: string;
  turnId?: string | null;
  role: ConversationRole;
  text: string;
  images?: ConversationImageAttachment[] | null;
  isStreaming: boolean;
};

export type ConversationReasoningItem = {
  kind: "reasoning";
  id: string;
  turnId?: string | null;
  summary: string;
  content: string;
  isStreaming: boolean;
};

export type ConversationToolItem = {
  kind: "tool";
  id: string;
  turnId?: string | null;
  toolType: string;
  title: string;
  status: ConversationItemStatus;
  summary?: string | null;
  output: string;
};

export type ConversationSystemItem = {
  kind: "system";
  id: string;
  turnId?: string | null;
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
  taskPlan?: ConversationTaskSnapshot | null;
  error?: ConversationErrorSnapshot | null;
  composer: ConversationComposerSettings;
};

export type ThreadConversationOpenResponse = {
  snapshot: ThreadConversationSnapshot;
  capabilities: EnvironmentCapabilitiesSnapshot;
  composerDraft?: ConversationComposerDraft | null;
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

export type ProjectSettingsPatch = {
  worktreeSetupScript?: string | null;
  worktreeTeardownScript?: string | null;
};

export type UpdateProjectSettingsRequest = {
  projectId: string;
  patch: ProjectSettingsPatch;
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

export type GitScopeInput = {
  environmentId: string;
  scope: GitReviewScope;
};

export type GitFileInput = {
  environmentId: string;
  scope: GitReviewScope;
  path: string;
};

export type GitFileDiffInput = {
  environmentId: string;
  scope: GitReviewScope;
  section: GitChangeSection;
  path: string;
};

export type GitRevertFileInput = {
  environmentId: string;
  scope: GitReviewScope;
  section: GitChangeSection;
  path: string;
};

export type CommitGitInput = {
  environmentId: string;
  scope: GitReviewScope;
  message: string;
};

export type SendThreadMessageInput = {
  threadId: string;
  text: string;
  composer?: ConversationComposerSettings | null;
  images?: ConversationImageAttachment[] | null;
  mentionBindings?: ComposerMentionBindingInput[] | null;
};

export type PersistThreadComposerDraftInput = {
  threadId: string;
  draft?: ConversationComposerDraft | null;
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
  images?: ConversationImageAttachment[] | null;
  mentionBindings?: ComposerMentionBindingInput[] | null;
};

export type GlobalSettingsPatch = {
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultCollaborationMode?: CollaborationMode;
  defaultApprovalPolicy?: ApprovalPolicy;
  defaultServiceTier?: ServiceTier | null;
  collapseWorkActivity?: boolean;
  desktopNotificationsEnabled?: boolean;
  shortcuts?: ShortcutSettingsPatch;
  openTargets?: OpenTarget[];
  defaultOpenTargetId?: string;
  codexBinaryPath?: string | null;
};

export type OpenEnvironmentInput = {
  environmentId: string;
  targetId?: string | null;
};

export type ReorderProjectsRequest = {
  projectIds: string[];
};

export type ReorderWorktreeEnvironmentsRequest = {
  projectId: string;
  environmentIds: string[];
};

export type SetProjectSidebarCollapsedRequest = {
  projectId: string;
  collapsed: boolean;
};
