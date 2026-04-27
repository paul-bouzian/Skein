/* ── Enums (match Rust serde output) ── */

export type EnvironmentKind =
  | "local"
  | "managedWorktree"
  | "permanentWorktree"
  | "chat";
export type ThreadStatus = "active" | "archived";
export type RuntimeState = "running" | "stopped" | "exited";
export type PullRequestState = "open" | "merged" | "closed";
export type ChecksRollupState = "success" | "failure" | "pending" | "neutral";
export type ChecksItemState =
  | "success"
  | "failure"
  | "pending"
  | "skipped"
  | "neutral";
export type WorktreeScriptTrigger = "setup" | "teardown";
export type WorkspaceEventKind =
  | "environmentRenamed"
  | "environmentPullRequestChanged"
  | "runtimeStatusChanged"
  | "threadAutoRenamed";
export type GitReviewScope = "uncommitted" | "branch";
export type GitChangeSection = "staged" | "unstaged" | "untracked" | "branch";
export type GitAction =
  | "commit"
  | "push"
  | "pull"
  | "commitPush"
  | "createPr"
  | "commitPushCreatePr"
  | "viewPr";
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
export type ProviderKind = "codex" | "claude";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CollaborationMode = "build" | "plan";
export type ApprovalPolicy = "askToEdit" | "fullAccess";
export type OpenTargetKind = "app" | "fileManager";
export type ServiceTier = "fast" | "flex";
export type InputModality = "text" | "image";
export type ProjectActionIcon =
  | "play"
  | "test"
  | "lint"
  | "configure"
  | "build"
  | "debug";
export type ProjectActionRunState = "running" | "idle" | "exited";
export type NotificationSoundId = "glass" | "chord" | "polite";
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
  provider?: ProviderKind;
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

export type ThreadHandoffBootstrapStatus = "pending" | "completed";

export type ThreadHandoffImportedMessage = {
  id: string;
  role: ConversationRole;
  text: string;
  images?: ConversationImageAttachment[] | null;
  createdAt: string;
};

export type ThreadHandoffState = {
  sourceThreadId: string;
  sourceProvider: ProviderKind;
  sourceThreadTitle?: string | null;
  environmentName?: string | null;
  branchName?: string | null;
  worktreePath?: string | null;
  importedAt: string;
  bootstrapStatus: ThreadHandoffBootstrapStatus;
  importedMessages: ThreadHandoffImportedMessage[];
};

export type ThreadRecord = {
  id: string;
  environmentId: string;
  title: string;
  status: ThreadStatus;
  provider: ProviderKind;
  providerThreadId?: string | null;
  codexThreadId?: string | null;
  overrides: ThreadOverrides;
  handoff?: ThreadHandoffState | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type PullRequestCheckItem = {
  name: string;
  state: ChecksItemState;
  url?: string;
};

export type PullRequestChecksSnapshot = {
  rollup: ChecksRollupState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  items: PullRequestCheckItem[];
};

export type EnvironmentPullRequestSnapshot = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  checks?: PullRequestChecksSnapshot;
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
  manualActions?: ProjectManualAction[];
};

export type ProjectManualAction = {
  id: string;
  label: string;
  icon: ProjectActionIcon;
  script: string;
  shortcut?: string | null;
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
  splitActiveThread?: string | null;
  closeFocusedPane?: string | null;
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
  splitActiveThread?: string | null;
  closeFocusedPane?: string | null;
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

export type ChatWorkspaceSnapshot = {
  projectId: string;
  title: string;
  rootPath: string;
  environments: EnvironmentRecord[];
};

export type NotificationSoundChannelSettings = {
  enabled: boolean;
  sound: NotificationSoundId;
};

export type NotificationSoundSettings = {
  attention: NotificationSoundChannelSettings;
  completion: NotificationSoundChannelSettings;
};

export type NotificationSoundChannelSettingsPatch = {
  enabled?: boolean;
  sound?: NotificationSoundId;
};

export type NotificationSoundSettingsPatch = {
  attention?: NotificationSoundChannelSettingsPatch;
  completion?: NotificationSoundChannelSettingsPatch;
};

export type GlobalSettings = {
  defaultProvider: ProviderKind;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultCollaborationMode: CollaborationMode;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultServiceTier?: ServiceTier | null;
  desktopNotificationsEnabled: boolean;
  streamAssistantResponses: boolean;
  multiAgentNudgeEnabled: boolean;
  multiAgentNudgeMaxSubagents: number;
  notificationSounds: NotificationSoundSettings;
  shortcuts: ShortcutSettings;
  openTargets: OpenTarget[];
  defaultOpenTargetId: string;
  codexBinaryPath?: string;
  claudeBinaryPath?: string;
};

export type OpenTarget = {
  id: string;
  label: string;
  kind: OpenTargetKind;
  appName?: string | null;
};

export type WorkspaceSnapshot = {
  settings: GlobalSettings;
  chat: ChatWorkspaceSnapshot;
  projects: ProjectRecord[];
};

export type DraftThreadTarget =
  | { kind: "project"; projectId: string }
  | { kind: "chat" };

export type DraftProjectSelection =
  | { kind: "local" }
  | { kind: "existing"; environmentId: string }
  | { kind: "new"; baseBranch: string; name: string };

export type ManagedWorktreeCreateResult = {
  environment: EnvironmentRecord;
  thread: ThreadRecord;
};

export type ChatThreadCreateResult = {
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

export type ProviderRateLimitStatus = "ok" | "error" | "unavailable";

export type ProviderRateLimitWindow = {
  resetsAt?: number | null;
  usedPercent: number;
  windowDurationMins?: number | null;
};

export type ProviderRateLimitSnapshot = {
  provider: ProviderKind;
  primary?: ProviderRateLimitWindow | null;
  secondary?: ProviderRateLimitWindow | null;
  updatedAt: number;
  error?: string | null;
  status: ProviderRateLimitStatus;
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

export type GitActionCommitResult = {
  sha: string;
  subject: string;
};

export type GitActionPushResult = {
  branch: string;
  upstreamBranch?: string | null;
};

export type GitActionPullResult = {
  branch: string;
  upstreamBranch?: string | null;
};

export type GitActionPullRequestResult = {
  number: number;
  title: string;
  url: string;
  baseBranch?: string | null;
  headBranch?: string | null;
};

export type GitActionResult = {
  environmentId: string;
  action: GitAction;
  snapshot: GitReviewSnapshot;
  commit?: GitActionCommitResult | null;
  push?: GitActionPushResult | null;
  pull?: GitActionPullResult | null;
  pr?: GitActionPullRequestResult | null;
  error?: string | null;
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
  | "downloading"
  | "downloaded"
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
  provider: ProviderKind;
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

export type ComposerTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "environment"; environmentId: string; provider?: ProviderKind }
  | { kind: "chatWorkspace" };

export type ThreadComposerCatalog = {
  prompts: ComposerPromptOption[];
  skills: ComposerSkillOption[];
  apps: ComposerAppOption[];
};

export type ComposerFileSearchResult = {
  path: string;
};

export type ModelOption = {
  provider?: ProviderKind;
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
  inputModalities: InputModality[];
  supportedServiceTiers?: ServiceTier[];
  supportsThinking?: boolean;
  isDefault: boolean;
};

export type ProviderOption = {
  id: ProviderKind;
  displayName: string;
  icon: string;
  isDefault: boolean;
  models: ModelOption[];
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
  providers?: ProviderOption[];
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

export type SavedDraftThreadState = {
  composerDraft: ConversationComposerDraft;
  composer: ConversationComposerSettings;
  projectSelection?: DraftProjectSelection | null;
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
  provider: ProviderKind;
  providerThreadId?: string | null;
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
  manualActions?: ProjectManualAction[] | null;
};

export type UpdateProjectSettingsRequest = {
  projectId: string;
  patch: ProjectSettingsPatch;
};

export type RunProjectActionRequest = {
  environmentId: string;
  actionId: string;
};

export type RunProjectActionResult = {
  ptyId: string;
  cwd: string;
  actionId: string;
  actionLabel: string;
  actionIcon: ProjectActionIcon;
};

export type ProjectActionStateEventPayload = {
  ptyId: string;
  actionId: string;
  state: ProjectActionRunState;
  exitCode?: number | null;
};

export type CreateThreadRequest = {
  environmentId: string;
  title?: string;
  overrides?: ThreadOverrides;
};

export type CreateThreadHandoffRequest = {
  sourceThreadId: string;
  targetProvider: ProviderKind;
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

export type RunGitActionInput = {
  environmentId: string;
  scope: GitReviewScope;
  action: GitAction;
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

export type SaveDraftThreadStateInput = {
  target: DraftThreadTarget;
  state?: SavedDraftThreadState | null;
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
  defaultProvider?: ProviderKind;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultCollaborationMode?: CollaborationMode;
  defaultApprovalPolicy?: ApprovalPolicy;
  defaultServiceTier?: ServiceTier | null;
  desktopNotificationsEnabled?: boolean;
  streamAssistantResponses?: boolean;
  multiAgentNudgeEnabled?: boolean;
  multiAgentNudgeMaxSubagents?: number;
  notificationSounds?: NotificationSoundSettingsPatch;
  shortcuts?: ShortcutSettingsPatch;
  openTargets?: OpenTarget[];
  defaultOpenTargetId?: string;
  codexBinaryPath?: string | null;
  claudeBinaryPath?: string | null;
};

export type OpenEnvironmentInput = {
  environmentId: string;
  targetId?: string | null;
};

export type ReorderProjectsRequest = {
  projectIds: string[];
};

export type SetProjectSidebarCollapsedRequest = {
  projectId: string;
  collapsed: boolean;
};
