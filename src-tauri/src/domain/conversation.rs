use serde::{Deserialize, Serialize};

use super::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};

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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: ReasoningEffort,
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    pub is_default: bool,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockedInteractionSnapshot {
    pub method: String,
    pub title: String,
    pub message: String,
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
    pub role: ConversationRole,
    pub text: String,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationReasoningItem {
    pub id: String,
    pub summary: String,
    pub content: String,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationToolItem {
    pub id: String,
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
    pub token_usage: Option<ThreadTokenUsageSnapshot>,
    pub blocked_interaction: Option<BlockedInteractionSnapshot>,
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
            token_usage: None,
            blocked_interaction: None,
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEventPayload {
    pub thread_id: String,
    pub environment_id: String,
    pub snapshot: ThreadConversationSnapshot,
}
