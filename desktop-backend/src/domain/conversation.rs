use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort, ServiceTier};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConversationStatus {
    Idle,
    Running,
    Completed,
    Interrupted,
    Failed,
    WaitingForExternalAction,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConversationItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConversationRole {
    User,
    Assistant,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConversationTone {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationComposerSettings {
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    pub collaboration_mode: CollaborationMode,
    pub approval_policy: ApprovalPolicy,
    pub service_tier: Option<ServiceTier>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComposerPromptArgumentMode {
    None,
    Named,
    Positional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ComposerTarget {
    Thread {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    Environment {
        #[serde(rename = "environmentId")]
        environment_id: String,
    },
    ChatWorkspace {},
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerPromptOption {
    pub name: String,
    pub description: Option<String>,
    pub argument_mode: ComposerPromptArgumentMode,
    pub argument_names: Vec<String>,
    pub positional_count: usize,
    pub argument_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSkillOption {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerAppOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub slug: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComposerCatalog {
    pub prompts: Vec<ComposerPromptOption>,
    pub skills: Vec<ComposerSkillOption>,
    pub apps: Vec<ComposerAppOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerFileSearchResult {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: ReasoningEffort,
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    pub input_modalities: Vec<InputModality>,
    #[serde(default)]
    pub supported_service_tiers: Vec<ServiceTier>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InputModality {
    Text,
    Image,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationModeOption {
    pub id: String,
    pub label: String,
    pub mode: CollaborationMode,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCapabilitiesSnapshot {
    pub environment_id: String,
    pub models: Vec<ModelOption>,
    pub collaboration_modes: Vec<CollaborationModeOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageBreakdown {
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsageSnapshot {
    pub total: TokenUsageBreakdown,
    pub last: TokenUsageBreakdown,
    pub model_context_window: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentThreadSnapshot {
    pub thread_id: String,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub depth: i32,
    pub status: SubagentStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConversationApprovalKind {
    CommandExecution,
    FileChange,
    Permissions,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProposedPlanStatus {
    Streaming,
    Ready,
    Approved,
    Superseded,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProposedPlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConversationTaskStatus {
    Running,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionGrantScope {
    Turn,
    Session,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPolicyRuleAction {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedPlanStep {
    pub step: String,
    pub status: ProposedPlanStepStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedPlanSnapshot {
    pub turn_id: String,
    pub item_id: Option<String>,
    pub explanation: String,
    pub steps: Vec<ProposedPlanStep>,
    pub markdown: String,
    pub status: ProposedPlanStatus,
    pub is_awaiting_decision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTaskSnapshot {
    pub turn_id: String,
    pub item_id: Option<String>,
    pub explanation: String,
    pub steps: Vec<ProposedPlanStep>,
    pub markdown: String,
    pub status: ConversationTaskStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUserInputOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<PendingUserInputOption>,
    pub is_other: bool,
    pub is_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemPermissionSnapshot {
    pub read: Vec<String>,
    pub write: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPermissionSnapshot {
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileSnapshot {
    pub file_system: Option<FileSystemPermissionSnapshot>,
    pub network: Option<NetworkPermissionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyAmendmentSnapshot {
    pub action: NetworkPolicyRuleAction,
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkApprovalContextSnapshot {
    pub host: String,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovalRequest {
    pub id: String,
    pub method: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub approval_kind: ConversationApprovalKind,
    pub title: String,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub grant_root: Option<String>,
    pub permissions: Option<PermissionProfileSnapshot>,
    pub network_context: Option<NetworkApprovalContextSnapshot>,
    pub proposed_execpolicy_amendment: Vec<String>,
    pub proposed_network_policy_amendments: Vec<NetworkPolicyAmendmentSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUserInputRequest {
    pub id: String,
    pub method: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub questions: Vec<PendingUserInputQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedInteractionRequest {
    pub id: String,
    pub method: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConversationInteraction {
    Approval(Box<PendingApprovalRequest>),
    UserInput(Box<PendingUserInputRequest>),
    Unsupported(UnsupportedInteractionRequest),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandApprovalDecisionInput {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
    AcceptWithExecpolicyAmendment,
    ApplyNetworkPolicyAmendment,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeApprovalDecisionInput {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionsApprovalDecisionInput {
    Approve,
    Decline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApprovalResponseInput {
    CommandExecution {
        decision: CommandApprovalDecisionInput,
        execpolicy_amendment: Option<Vec<String>>,
        network_policy_amendment: Option<NetworkPolicyAmendmentSnapshot>,
    },
    FileChange {
        decision: FileChangeApprovalDecisionInput,
    },
    Permissions {
        decision: PermissionsApprovalDecisionInput,
        permissions: Option<PermissionProfileSnapshot>,
        scope: Option<PermissionGrantScope>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RespondToApprovalRequestInput {
    pub thread_id: String,
    pub interaction_id: String,
    pub response: ApprovalResponseInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RespondToUserInputRequestInput {
    pub thread_id: String,
    pub interaction_id: String,
    pub answers: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanDecisionAction {
    Approve,
    Refine,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitPlanDecisionInput {
    pub thread_id: String,
    pub action: PlanDecisionAction,
    pub feedback: Option<String>,
    pub composer: Option<ConversationComposerSettings>,
    pub images: Option<Vec<ConversationImageAttachment>>,
    pub mention_bindings: Option<Vec<ComposerMentionBindingInput>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerMentionBindingInput {
    pub mention: String,
    pub kind: ComposerMentionBindingKind,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDraftMentionBinding {
    pub mention: String,
    pub kind: ComposerMentionBindingKind,
    pub path: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConversationImageAttachment {
    Image { url: String },
    LocalImage { path: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComposerMentionBindingKind {
    Skill,
    App,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationComposerDraft {
    pub text: String,
    pub images: Vec<ConversationImageAttachment>,
    pub mention_bindings: Vec<ComposerDraftMentionBinding>,
    pub is_refining_plan: bool,
}

impl ConversationComposerDraft {
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
            && self.images.is_empty()
            && self.mention_bindings.is_empty()
            && !self.is_refining_plan
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationErrorSnapshot {
    pub message: String,
    pub codex_error_info: Option<String>,
    pub additional_details: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConversationItem {
    Message(ConversationMessageItem),
    Reasoning(ConversationReasoningItem),
    Tool(ConversationToolItem),
    System(ConversationSystemItem),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessageItem {
    pub id: String,
    pub turn_id: Option<String>,
    pub role: ConversationRole,
    pub text: String,
    pub images: Option<Vec<ConversationImageAttachment>>,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationReasoningItem {
    pub id: String,
    pub turn_id: Option<String>,
    pub summary: String,
    pub content: String,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationToolItem {
    pub id: String,
    pub turn_id: Option<String>,
    pub tool_type: String,
    pub title: String,
    pub status: ConversationItemStatus,
    pub summary: Option<String>,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSystemItem {
    pub id: String,
    pub turn_id: Option<String>,
    pub tone: ConversationTone,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadConversationSnapshot {
    pub thread_id: String,
    pub environment_id: String,
    pub codex_thread_id: Option<String>,
    pub status: ConversationStatus,
    pub active_turn_id: Option<String>,
    pub items: Vec<ConversationItem>,
    pub subagents: Vec<SubagentThreadSnapshot>,
    pub token_usage: Option<ThreadTokenUsageSnapshot>,
    pub pending_interactions: Vec<ConversationInteraction>,
    pub proposed_plan: Option<ProposedPlanSnapshot>,
    pub task_plan: Option<ConversationTaskSnapshot>,
    pub error: Option<ConversationErrorSnapshot>,
    pub composer: ConversationComposerSettings,
}

impl ThreadConversationSnapshot {
    pub fn new(
        thread_id: String,
        environment_id: String,
        codex_thread_id: Option<String>,
        composer: ConversationComposerSettings,
    ) -> Self {
        Self {
            thread_id,
            environment_id,
            codex_thread_id,
            status: ConversationStatus::Idle,
            active_turn_id: None,
            items: Vec::new(),
            subagents: Vec::new(),
            token_usage: None,
            pending_interactions: Vec::new(),
            proposed_plan: None,
            task_plan: None,
            error: None,
            composer,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadConversationOpenResponse {
    pub snapshot: ThreadConversationSnapshot,
    pub capabilities: EnvironmentCapabilitiesSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composer_draft: Option<ConversationComposerDraft>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEventPayload {
    pub thread_id: String,
    pub environment_id: String,
    pub snapshot: ThreadConversationSnapshot,
}

#[cfg(test)]
mod tests {
    use super::ComposerTarget;

    #[test]
    fn composer_target_deserializes_camel_case_variant_fields() {
        let thread_target = serde_json::from_value::<ComposerTarget>(serde_json::json!({
            "kind": "thread",
            "threadId": "thread-123",
        }))
        .expect("thread target should deserialize");
        assert_eq!(
            thread_target,
            ComposerTarget::Thread {
                thread_id: "thread-123".to_string(),
            }
        );

        let environment_target = serde_json::from_value::<ComposerTarget>(serde_json::json!({
            "kind": "environment",
            "environmentId": "env-123",
        }))
        .expect("environment target should deserialize");
        assert_eq!(
            environment_target,
            ComposerTarget::Environment {
                environment_id: "env-123".to_string(),
            }
        );

        let chat_workspace_target = serde_json::from_value::<ComposerTarget>(serde_json::json!({
            "kind": "chatWorkspace",
        }))
        .expect("chat workspace target should deserialize");
        assert_eq!(chat_workspace_target, ComposerTarget::ChatWorkspace {});
    }
}
