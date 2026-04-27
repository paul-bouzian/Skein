use crate::app_identity::APP_NAME;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

pub use crate::app_identity::CONVERSATION_EVENT_NAME;
use crate::domain::conversation::{
    CollaborationModeOption, ConversationApprovalKind, ConversationComposerSettings,
    ConversationErrorSnapshot, ConversationImageAttachment, ConversationInteraction,
    ConversationItem, ConversationItemStatus, ConversationMessageItem, ConversationReasoningItem,
    ConversationRole, ConversationStatus, ConversationSystemItem, ConversationTaskSnapshot,
    ConversationTaskStatus, ConversationTone, ConversationToolItem, FileSystemPermissionSnapshot,
    InputModality, ModelOption, NetworkApprovalContextSnapshot, NetworkPermissionSnapshot,
    NetworkPolicyAmendmentSnapshot, NetworkPolicyRuleAction, PendingApprovalRequest,
    PendingUserInputOption, PendingUserInputQuestion, PendingUserInputRequest,
    PermissionProfileSnapshot, ProposedPlanSnapshot, ProposedPlanStatus, ProposedPlanStep,
    ProposedPlanStepStatus, SubagentStatus, SubagentThreadSnapshot, ThreadConversationSnapshot,
    ThreadTokenUsageSnapshot, TokenUsageBreakdown, UnsupportedInteractionRequest,
};
use crate::domain::settings::{
    ApprovalPolicy, CollaborationMode, ProviderKind, ReasoningEffort, ServiceTier,
};
use crate::domain::workspace::CodexRateLimitSnapshot;
use crate::error::{AppError, AppResult};
use crate::runtime::collaboration_mode_templates::developer_instructions_for_mode;

pub const AGENT_MESSAGE_DELTA_METHOD: &str = "item/agentMessage/delta";

#[derive(Debug, Clone)]
pub enum IncomingMessage {
    Response(ResponseEnvelope),
    Request(ServerRequestEnvelope),
    Notification(ServerNotificationEnvelope),
}

#[derive(Debug, Clone)]
pub struct ResponseEnvelope {
    pub id: u64,
    pub result: Value,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ServerRequestEnvelope {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone)]
pub struct ServerNotificationEnvelope {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct InterAgentCommunicationWire {
    author: String,
    recipient: String,
    #[serde(default)]
    other_recipients: Vec<String>,
    #[serde(rename = "content")]
    _content: String,
    #[serde(rename = "trigger_turn")]
    _trigger_turn: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReference {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResponse {
    pub thread: ThreadReference,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadResponse {
    pub thread: ThreadWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLoadedListResponse {
    pub data: Vec<String>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub data: Vec<ThreadListEntryWire>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataReadResponse {
    pub thread: ThreadListEntryWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWire {
    pub id: String,
    #[serde(default)]
    pub turns: Vec<TurnWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListEntryWire {
    pub id: String,
    #[serde(default)]
    pub agent_nickname: Option<String>,
    #[serde(default)]
    pub agent_role: Option<String>,
    pub source: Value,
    pub status: ThreadStatusWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatusWire {
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatusChangedNotification {
    pub thread_id: String,
    pub status: ThreadStatusWire,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ThreadSpawnSourceWire {
    #[serde(alias = "parentThreadId")]
    pub parent_thread_id: String,
    pub depth: i32,
    #[serde(default)]
    #[serde(alias = "agentNickname")]
    pub agent_nickname: Option<String>,
    #[serde(default)]
    #[serde(alias = "agentRole")]
    pub agent_role: Option<String>,
    #[serde(default)]
    #[serde(alias = "agentPath")]
    pub agent_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SubagentThreadStart {
    pub parent_thread_id: String,
    pub snapshot: SubagentThreadSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnWire {
    pub id: String,
    pub status: String,
    pub error: Option<TurnErrorWire>,
    #[serde(default)]
    pub items: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnErrorWire {
    pub message: String,
    pub codex_error_info: Option<Value>,
    pub additional_details: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResponse {
    pub turn: TurnEnvelope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnvelope {
    pub id: String,
    pub status: String,
    pub error: Option<TurnErrorWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedNotification {
    pub thread_id: String,
    pub turn: TurnEnvelope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedNotification {
    pub thread_id: String,
    pub turn: TurnEnvelope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeltaNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningBoundaryNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageNotification {
    pub thread_id: String,
    #[serde(rename = "turnId")]
    pub _turn_id: String,
    pub token_usage: TokenUsageWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageWire {
    pub total: TokenUsageBreakdown,
    pub last: TokenUsageBreakdown,
    pub model_context_window: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorNotification {
    pub thread_id: Option<String>,
    pub error: TurnErrorWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInterfaceWire {
    #[serde(default)]
    pub short_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadataWire {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub path: String,
    #[serde(default)]
    pub interface: Option<SkillInterfaceWire>,
    #[serde(default)]
    pub short_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListEntryWire {
    pub cwd: String,
    #[serde(default)]
    pub skills: Vec<SkillMetadataWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResponse {
    pub data: Vec<SkillsListEntryWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoWire {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_accessible: Option<bool>,
    #[serde(default)]
    pub is_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsListResponse {
    pub data: Vec<AppInfoWire>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FuzzyFileSearchMatchTypeWire {
    File,
    Directory,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyFileSearchResultWire {
    pub path: String,
    pub match_type: FuzzyFileSearchMatchTypeWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyFileSearchResponse {
    pub files: Vec<FuzzyFileSearchResultWire>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingTextElement {
    pub start: usize,
    pub end: usize,
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingNamedInput {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingUserInputPayload {
    pub text: String,
    pub images: Vec<ConversationImageAttachment>,
    pub text_elements: Vec<OutgoingTextElement>,
    pub skills: Vec<OutgoingNamedInput>,
    pub mentions: Vec<OutgoingNamedInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPlanUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub plan: Vec<TurnPlanStepWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPlanStepWire {
    pub step: String,
    pub status: ProposedPlanStepStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDeltaNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequestUserInputParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    #[serde(default)]
    pub questions: Vec<ToolRequestUserInputQuestionWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequestUserInputQuestionWire {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Option<Vec<ToolRequestUserInputOptionWire>>,
    #[serde(default)]
    pub is_other: bool,
    #[serde(default)]
    pub is_secret: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequestUserInputOptionWire {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionRequestApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub approval_id: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub reason: Option<String>,
    pub network_approval_context: Option<NetworkApprovalContextWire>,
    pub proposed_execpolicy_amendment: Option<Vec<String>>,
    pub proposed_network_policy_amendments: Option<Vec<NetworkPolicyAmendmentWire>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRequestApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub reason: Option<String>,
    pub grant_root: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsRequestApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub permissions: PermissionProfileWire,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileWire {
    pub file_system: Option<FileSystemPermissionsWire>,
    pub network: Option<NetworkPermissionWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemPermissionsWire {
    pub read: Option<Vec<String>>,
    pub write: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPermissionWire {
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkApprovalContextWire {
    pub host: String,
    pub protocol: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyAmendmentWire {
    pub action: NetworkPolicyRuleAction,
    pub host: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub data: Vec<ModelWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelWire {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOptionWire>,
    pub default_reasoning_effort: ReasoningEffort,
    #[serde(default = "default_input_modalities")]
    pub input_modalities: Vec<InputModality>,
    #[serde(default, deserialize_with = "deserialize_additional_speed_tiers")]
    pub additional_speed_tiers: Vec<ServiceTier>,
    pub is_default: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOptionWire {
    pub reasoning_effort: ReasoningEffort,
}

fn default_input_modalities() -> Vec<InputModality> {
    vec![InputModality::Text]
}

fn deserialize_additional_speed_tiers<'de, D>(deserializer: D) -> Result<Vec<ServiceTier>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    Ok(values
        .into_iter()
        .filter_map(|value| match value.as_str() {
            "fast" => Some(ServiceTier::Fast),
            "flex" => Some(ServiceTier::Flex),
            _ => None,
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationModeListResponse {
    pub data: Vec<CollaborationModeWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRateLimitsReadResponse {
    pub rate_limits: CodexRateLimitSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReadResponse {
    pub account: Option<AccountReadAccountWire>,
    #[serde(default)]
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReadAccountWire {
    #[serde(rename = "type")]
    pub auth_type: AccountReadAuthTypeWire,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AccountReadAuthTypeWire {
    ApiKey,
    Chatgpt,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationModeWire {
    pub name: String,
    pub mode: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<Option<ReasoningEffort>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: InitializeCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    pub experimental_api: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opt_out_notification_methods: Option<Vec<String>>,
}

pub fn parse_incoming_message(line: &str) -> AppResult<IncomingMessage> {
    let value = serde_json::from_str::<Value>(line).map_err(|error| {
        AppError::Runtime(format!("Failed to parse app-server message: {error}"))
    })?;

    if value.get("method").is_some() && value.get("id").is_some() {
        let request = serde_json::from_value::<ServerRequestWire>(value).map_err(|error| {
            AppError::Runtime(format!("Failed to decode app-server request: {error}"))
        })?;
        return Ok(IncomingMessage::Request(ServerRequestEnvelope {
            id: request.id,
            method: request.method,
            params: request.params.unwrap_or(Value::Null),
        }));
    }

    if value.get("method").is_some() {
        let notification =
            serde_json::from_value::<ServerNotificationWire>(value).map_err(|error| {
                AppError::Runtime(format!("Failed to decode app-server notification: {error}"))
            })?;
        return Ok(IncomingMessage::Notification(ServerNotificationEnvelope {
            method: notification.method,
            params: notification.params.unwrap_or(Value::Null),
        }));
    }

    let response = serde_json::from_value::<ResponseWire>(value).map_err(|error| {
        AppError::Runtime(format!("Failed to decode app-server response: {error}"))
    })?;
    let id = response
        .id
        .as_u64()
        .ok_or_else(|| AppError::Runtime("App-server response id is not numeric.".to_string()))?;
    let error = response.error.map(|error| {
        error
            .message
            .unwrap_or_else(|| "App-server returned an unknown error.".to_string())
    });

    Ok(IncomingMessage::Response(ResponseEnvelope {
        id,
        result: response.result.unwrap_or(Value::Null),
        error,
    }))
}

pub fn initialize_params(version: &str, stream_assistant_responses: bool) -> Value {
    json!(InitializeParams {
        client_info: ClientInfo {
            name: APP_NAME.to_string(),
            title: APP_NAME.to_string(),
            version: version.to_string(),
        },
        capabilities: InitializeCapabilities {
            experimental_api: true,
            opt_out_notification_methods: (!stream_assistant_responses)
                .then(|| vec![AGENT_MESSAGE_DELTA_METHOD.to_string()]),
        },
    })
}

pub fn initialized_notification() -> Value {
    Value::Null
}

pub fn approval_policy_value(policy: ApprovalPolicy) -> &'static str {
    match policy {
        ApprovalPolicy::AskToEdit => "on-request",
        ApprovalPolicy::FullAccess => "never",
    }
}

pub fn sandbox_policy_value(policy: ApprovalPolicy, workspace_path: &str) -> Value {
    match policy {
        ApprovalPolicy::AskToEdit => json!({
            "type": "workspaceWrite",
            "writableRoots": [workspace_path],
            "networkAccess": true
        }),
        ApprovalPolicy::FullAccess => json!({
            "type": "dangerFullAccess"
        }),
    }
}

pub fn collaboration_mode_payload(composer: &ConversationComposerSettings) -> Value {
    let mode = match composer.collaboration_mode {
        CollaborationMode::Build => "default",
        CollaborationMode::Plan => "plan",
    };

    json!({
        "mode": mode,
        "settings": {
            "model": composer.model,
            "reasoning_effort": composer.reasoning_effort,
            "developer_instructions": developer_instructions_for_mode(composer.collaboration_mode),
        }
    })
}

pub fn user_input_payload(input: &OutgoingUserInputPayload) -> Value {
    let mut payload = Vec::new();
    if !input.text.is_empty() || !input.text_elements.is_empty() {
        payload.push(json!({
            "type": "text",
            "text": input.text,
            "text_elements": input
                .text_elements
                .iter()
                .map(|element| {
                    json!({
                        "byteRange": {
                            "start": element.start,
                            "end": element.end,
                        },
                        "placeholder": element.placeholder,
                    })
                })
                .collect::<Vec<_>>(),
        }));
    }

    payload.extend(input.images.iter().map(|image| match image {
        ConversationImageAttachment::Image { url } => {
            json!({
                "type": "image",
                "url": url,
            })
        }
        ConversationImageAttachment::LocalImage { path } => {
            json!({
                "type": "localImage",
                "path": path,
            })
        }
    }));

    payload.extend(input.skills.iter().map(|skill| {
        json!({
            "type": "skill",
            "name": skill.name,
            "path": skill.path,
        })
    }));
    payload.extend(input.mentions.iter().map(|mention| {
        json!({
            "type": "mention",
            "name": mention.name,
            "path": mention.path,
        })
    }));

    Value::Array(payload)
}

pub fn plan_approval_message() -> &'static str {
    "Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code."
}

pub fn build_history_snapshot(
    thread_id: String,
    environment_id: String,
    codex_thread_id: Option<String>,
    composer: ConversationComposerSettings,
    thread: ThreadWire,
) -> ThreadConversationSnapshot {
    let fallback_mode = composer.collaboration_mode;
    let mut snapshot = ThreadConversationSnapshot::new_for_provider(
        thread_id,
        environment_id,
        ProviderKind::Codex,
        codex_thread_id.clone().or(Some(thread.id.clone())),
        codex_thread_id.or(Some(thread.id)),
        composer,
    );
    let mut last_status = ConversationStatus::Idle;
    let mut last_error = None;
    let last_turn_index = thread.turns.len().saturating_sub(1);

    for (index, turn) in thread.turns.into_iter().enumerate() {
        last_status = conversation_status_from_turn_status(turn.status.as_str());
        if matches!(last_status, ConversationStatus::Running) {
            snapshot.active_turn_id = Some(turn.id.clone());
        }
        if let Some(error) = turn.error {
            last_error = Some(error_snapshot(error));
        }
        let mut latest_turn_plan = None;
        for item in turn.items {
            if item.get("type").and_then(Value::as_str) == Some("plan") {
                if index == last_turn_index {
                    latest_turn_plan = Some(item);
                }
                continue;
            }
            if let Some(normalized) = normalize_item(Some(&turn.id), &item) {
                upsert_item(&mut snapshot.items, normalized);
            }
        }
        if index == last_turn_index {
            if let Some(item) = latest_turn_plan.as_ref() {
                match history_plan_target_from_item(item, fallback_mode) {
                    HistoryPlanTarget::Proposed => {
                        snapshot.proposed_plan =
                            proposed_plan_from_item(&turn.id, item, ProposedPlanStatus::Ready);
                    }
                    HistoryPlanTarget::Task => {
                        snapshot.task_plan = task_plan_from_item(
                            &turn.id,
                            item,
                            task_status_from_turn_status(&turn.status),
                        );
                    }
                }
            }
        }
    }

    snapshot.status = last_status;
    snapshot.error = last_error;
    reconcile_snapshot_status(&mut snapshot);
    snapshot
}

#[derive(Clone, Copy)]
enum HistoryPlanTarget {
    Proposed,
    Task,
}

fn history_plan_target_from_item(
    value: &Value,
    fallback_mode: CollaborationMode,
) -> HistoryPlanTarget {
    match collaboration_mode_from_plan_item_heading(value).unwrap_or(fallback_mode) {
        CollaborationMode::Plan => HistoryPlanTarget::Proposed,
        CollaborationMode::Build => HistoryPlanTarget::Task,
    }
}

pub(crate) fn collaboration_mode_from_plan_item_heading(
    value: &Value,
) -> Option<CollaborationMode> {
    match leading_plan_heading(value) {
        Some("proposed plan") => Some(CollaborationMode::Plan),
        Some("tasks") => Some(CollaborationMode::Build),
        _ => None,
    }
}

fn leading_plan_heading(value: &Value) -> Option<&'static str> {
    let markdown = rich_text_field(value, "text");
    let heading = markdown.lines().find(|line| !line.trim().is_empty())?;
    let normalized = heading
        .trim()
        .trim_start_matches('#')
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "proposed plan" => Some("proposed plan"),
        "tasks" => Some("tasks"),
        _ => None,
    }
}

pub fn model_options_from_response(response: ModelListResponse) -> Vec<ModelOption> {
    let mut options: Vec<ModelOption> = response
        .data
        .into_iter()
        .filter(|model| !model.hidden)
        .map(|model| ModelOption {
            provider: ProviderKind::Codex,
            id: model.id,
            display_name: model.display_name,
            description: model.description,
            default_reasoning_effort: model.default_reasoning_effort,
            supported_reasoning_efforts: model
                .supported_reasoning_efforts
                .into_iter()
                .map(|option| option.reasoning_effort)
                .collect(),
            input_modalities: model.input_modalities,
            supported_service_tiers: model.additional_speed_tiers,
            supports_thinking: false,
            is_default: model.is_default,
        })
        .collect();
    ensure_default_codex_model(&mut options);
    options
}

fn ensure_default_codex_model(options: &mut [ModelOption]) {
    if !options.iter().any(|model| model.is_default) {
        if let Some(default_model) = options.iter_mut().find(|model| model.id == "gpt-5.4") {
            default_model.is_default = true;
        } else if let Some(first) = options.first_mut() {
            first.is_default = true;
        }
    }
}

pub fn collaboration_mode_options_from_response(
    response: CollaborationModeListResponse,
) -> Vec<CollaborationModeOption> {
    response
        .data
        .into_iter()
        .filter_map(|mode| {
            let mode_value = match mode.mode.as_deref().unwrap_or(mode.name.as_str()) {
                "plan" => CollaborationMode::Plan,
                "default" | "build" | "code" => CollaborationMode::Build,
                _ => return None,
            };
            Some(CollaborationModeOption {
                id: match mode_value {
                    CollaborationMode::Build => "build".to_string(),
                    CollaborationMode::Plan => "plan".to_string(),
                },
                label: match mode_value {
                    CollaborationMode::Build => "Build".to_string(),
                    CollaborationMode::Plan => "Plan".to_string(),
                },
                mode: mode_value,
                model: mode.model,
                reasoning_effort: mode.reasoning_effort.flatten(),
            })
        })
        .collect()
}

pub fn conversation_status_from_turn_status(status: &str) -> ConversationStatus {
    match status {
        "inProgress" => ConversationStatus::Running,
        "completed" => ConversationStatus::Completed,
        "interrupted" => ConversationStatus::Interrupted,
        "failed" => ConversationStatus::Failed,
        _ => ConversationStatus::Idle,
    }
}

pub(crate) fn reconcile_snapshot_status(snapshot: &mut ThreadConversationSnapshot) {
    if !snapshot.pending_interactions.is_empty()
        || snapshot
            .proposed_plan
            .as_ref()
            .is_some_and(|plan| plan.is_awaiting_decision)
    {
        snapshot.status = ConversationStatus::WaitingForExternalAction;
        return;
    }

    if snapshot.active_turn_id.is_some() {
        snapshot.status = ConversationStatus::Running;
        return;
    }

    if snapshot.error.is_some() {
        snapshot.status = ConversationStatus::Failed;
        return;
    }

    if matches!(
        snapshot.status,
        ConversationStatus::Interrupted | ConversationStatus::Failed
    ) {
        return;
    }

    snapshot.status = if snapshot_has_visible_content(snapshot) {
        ConversationStatus::Completed
    } else {
        ConversationStatus::Idle
    };
}

fn snapshot_has_visible_content(snapshot: &ThreadConversationSnapshot) -> bool {
    !snapshot.items.is_empty()
        || snapshot
            .proposed_plan
            .as_ref()
            .is_some_and(plan_snapshot_has_visible_content)
        || snapshot
            .task_plan
            .as_ref()
            .is_some_and(task_snapshot_has_visible_content)
}

fn plan_snapshot_has_visible_content(plan: &ProposedPlanSnapshot) -> bool {
    !plan.markdown.trim().is_empty()
        || !plan.steps.is_empty()
        || !plan.explanation.trim().is_empty()
}

fn task_snapshot_has_visible_content(plan: &ConversationTaskSnapshot) -> bool {
    !plan.markdown.trim().is_empty()
        || !plan.steps.is_empty()
        || !plan.explanation.trim().is_empty()
}

pub fn task_status_from_turn_status(status: &str) -> ConversationTaskStatus {
    match status {
        "completed" => ConversationTaskStatus::Completed,
        "interrupted" => ConversationTaskStatus::Interrupted,
        "failed" => ConversationTaskStatus::Failed,
        _ => ConversationTaskStatus::Running,
    }
}

pub fn loaded_subagents_for_primary(
    primary_thread_id: &str,
    loaded_thread_ids: &[String],
    threads: Vec<ThreadListEntryWire>,
) -> Vec<SubagentThreadSnapshot> {
    if primary_thread_id.is_empty() || loaded_thread_ids.is_empty() {
        return Vec::new();
    }

    let loaded_ids = loaded_thread_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let descendants = threads
        .into_iter()
        .filter_map(|thread| {
            let spawn = thread_spawn_source(&thread.source)?;
            let nickname = spawn
                .agent_path
                .as_deref()
                .and_then(last_path_segment)
                .or_else(|| spawn.agent_nickname.clone());
            Some((
                thread,
                spawn.parent_thread_id.clone(),
                spawn.depth,
                nickname,
                spawn.agent_role.clone(),
            ))
        })
        .filter(|(thread, ..)| loaded_ids.contains(thread.id.as_str()))
        .collect::<Vec<_>>();

    let mut queue = vec![primary_thread_id.to_string()];
    let mut visited = std::collections::HashSet::from([primary_thread_id.to_string()]);
    let mut subagents = Vec::new();

    while let Some(parent_thread_id) = queue.pop() {
        for (thread, _, depth, spawn_nickname, spawn_role) in descendants
            .iter()
            .filter(|(_, parent_id, ..)| *parent_id == parent_thread_id)
        {
            if !visited.insert(thread.id.clone()) {
                continue;
            }
            queue.push(thread.id.clone());
            subagents.push(SubagentThreadSnapshot {
                thread_id: thread.id.clone(),
                nickname: spawn_nickname
                    .clone()
                    .or_else(|| thread.agent_nickname.clone()),
                role: thread.agent_role.clone().or_else(|| spawn_role.clone()),
                depth: *depth,
                status: subagent_status_from_thread_status(&thread.status),
            });
        }
    }

    subagents.sort_by(|left, right| {
        left.depth
            .cmp(&right.depth)
            .then_with(|| label_for_subagent(left).cmp(label_for_subagent(right)))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    subagents
}

pub fn subagents_from_collab_item(value: &Value) -> Vec<SubagentThreadSnapshot> {
    match value.get("type").and_then(Value::as_str) {
        Some("collabAgentToolCall") | Some("collabToolCall") => {}
        _ => return Vec::new(),
    }

    let fallback_status =
        subagent_status_from_collab_tool_status(value.get("status").and_then(Value::as_str));
    let mut candidates = Vec::new();

    for key in ["receiverThreadIds", "receiver_thread_ids"] {
        for thread_id in string_array_field(value, key) {
            push_collab_candidate(
                &mut candidates,
                CollabSubagentCandidate::from_thread_id(thread_id),
            );
        }
    }

    push_collab_ref_from_fields(
        &mut candidates,
        value,
        &["receiverThreadId", "receiver_thread_id"],
        &["receiverAgentNickname", "receiver_agent_nickname"],
        &[
            "receiverAgentPath",
            "receiver_agent_path",
            "agentPath",
            "agent_path",
        ],
        &[
            "receiverAgentRole",
            "receiver_agent_role",
            "receiverAgentType",
            "receiver_agent_type",
        ],
    );
    push_collab_ref_from_fields(
        &mut candidates,
        value,
        &["newThreadId", "new_thread_id"],
        &[
            "newAgentNickname",
            "new_agent_nickname",
            "taskName",
            "task_name",
        ],
        &["newAgentPath", "new_agent_path", "agentPath", "agent_path"],
        &[
            "newAgentRole",
            "new_agent_role",
            "newAgentType",
            "new_agent_type",
        ],
    );

    for key in ["receiverAgent", "receiver_agent"] {
        if let Some(candidate) = value.get(key).and_then(collab_candidate_from_record) {
            push_collab_candidate(&mut candidates, candidate);
        }
    }
    for key in ["receiverAgents", "receiver_agents"] {
        for candidate in candidates_from_array_field(value, key) {
            push_collab_candidate(&mut candidates, candidate);
        }
    }
    for key in ["agentStatuses", "agent_statuses"] {
        for candidate in candidates_from_array_field(value, key) {
            push_collab_candidate(&mut candidates, candidate);
        }
    }
    for key in [
        "statuses",
        "agentStatus",
        "agent_status",
        "agentsStates",
        "agents_states",
    ] {
        for candidate in candidates_from_status_map_field(value, key) {
            push_collab_candidate(&mut candidates, candidate);
        }
    }

    candidates
        .into_iter()
        .map(|candidate| SubagentThreadSnapshot {
            thread_id: candidate.thread_id,
            nickname: candidate.nickname,
            role: candidate.role,
            depth: 1,
            status: candidate.status.unwrap_or(fallback_status),
        })
        .collect()
}

#[derive(Debug, Clone)]
struct CollabSubagentCandidate {
    thread_id: String,
    nickname: Option<String>,
    role: Option<String>,
    status: Option<SubagentStatus>,
}

impl CollabSubagentCandidate {
    fn from_thread_id(thread_id: String) -> Self {
        Self {
            thread_id,
            nickname: None,
            role: None,
            status: None,
        }
    }
}

fn push_collab_candidate(
    candidates: &mut Vec<CollabSubagentCandidate>,
    candidate: CollabSubagentCandidate,
) {
    if candidate.thread_id.is_empty() {
        return;
    }
    if let Some(existing) = candidates
        .iter_mut()
        .find(|existing| existing.thread_id == candidate.thread_id)
    {
        if existing.nickname.is_none() {
            existing.nickname = candidate.nickname;
        }
        if existing.role.is_none() {
            existing.role = candidate.role;
        }
        if candidate.status.is_some() {
            existing.status = candidate.status;
        }
        return;
    }
    candidates.push(candidate);
}

fn push_collab_ref_from_fields(
    candidates: &mut Vec<CollabSubagentCandidate>,
    value: &Value,
    thread_id_keys: &[&str],
    nickname_keys: &[&str],
    path_keys: &[&str],
    role_keys: &[&str],
) {
    let Some(thread_id) = first_string_field(value, thread_id_keys) else {
        return;
    };
    push_collab_candidate(
        candidates,
        CollabSubagentCandidate {
            thread_id,
            nickname: first_string_field(value, nickname_keys)
                .or_else(|| agent_path_segment_from_fields(value, path_keys)),
            role: first_string_field(value, role_keys),
            status: None,
        },
    );
}

fn candidates_from_array_field(value: &Value, key: &str) -> Vec<CollabSubagentCandidate> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(collab_candidate_from_record)
        .collect()
}

fn candidates_from_status_map_field(value: &Value, key: &str) -> Vec<CollabSubagentCandidate> {
    value
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(thread_id, state)| {
            let state_record = state.as_object();
            let status = state_record
                .and_then(|record| record.get("status"))
                .and_then(Value::as_str)
                .or_else(|| state.as_str())
                .map(subagent_status_from_collab_state);
            let mut candidate = CollabSubagentCandidate::from_thread_id(thread_id.clone());
            if state_record.is_some() {
                candidate.nickname = first_string_field(
                    state,
                    &[
                        "agentNickname",
                        "agent_nickname",
                        "nickname",
                        "taskName",
                        "task_name",
                    ],
                )
                .or_else(|| agent_path_segment_from_fields(state, &["agentPath", "agent_path"]));
                candidate.role = first_string_field(
                    state,
                    &["agentRole", "agent_role", "agentType", "agent_type", "role"],
                );
            }
            candidate.status = status;
            candidate
        })
        .collect()
}

fn collab_candidate_from_record(value: &Value) -> Option<CollabSubagentCandidate> {
    let thread_id = first_string_field(
        value,
        &[
            "threadId",
            "thread_id",
            "id",
            "newThreadId",
            "new_thread_id",
        ],
    )?;
    let status = first_string_field(value, &["status"])
        .as_deref()
        .map(subagent_status_from_collab_state);
    Some(CollabSubagentCandidate {
        thread_id,
        nickname: first_string_field(
            value,
            &[
                "agentNickname",
                "agent_nickname",
                "nickname",
                "newAgentNickname",
                "new_agent_nickname",
                "taskName",
                "task_name",
            ],
        )
        .or_else(|| agent_path_segment_from_fields(value, &["agentPath", "agent_path"])),
        role: first_string_field(
            value,
            &[
                "agentRole",
                "agent_role",
                "agentType",
                "agent_type",
                "role",
                "newAgentRole",
                "new_agent_role",
                "newAgentType",
                "new_agent_type",
            ],
        ),
        status,
    })
}

fn first_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(text) = value.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn agent_path_segment_from_fields(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(path) = value.get(*key).and_then(Value::as_str) else {
            continue;
        };
        if let Some(segment) = last_path_segment(path) {
            return Some(segment);
        }
    }
    None
}

pub fn subagent_metadata_from_thread(
    value: &Value,
) -> Option<(String, Option<String>, Option<String>)> {
    let thread_id = value.get("id").and_then(Value::as_str)?.to_string();
    let source = value.get("source");
    let sub_agent =
        source.and_then(|source| source.get("subAgent").or_else(|| source.get("sub_agent")));
    let thread_spawn = sub_agent.and_then(|sub_agent| {
        sub_agent
            .get("threadSpawn")
            .or_else(|| sub_agent.get("thread_spawn"))
    });

    let agent_path_segment = first_non_empty_string(&[
        thread_spawn.and_then(|node| node.get("agentPath")),
        thread_spawn.and_then(|node| node.get("agent_path")),
        sub_agent.and_then(|node| node.get("agentPath")),
        sub_agent.and_then(|node| node.get("agent_path")),
    ])
    .and_then(|path| last_path_segment(&path));

    let nickname = agent_path_segment.or_else(|| {
        first_non_empty_string(&[
            value.get("agentNickname"),
            value.get("agent_nickname"),
            value.get("nickname"),
            sub_agent.and_then(|node| node.get("agentNickname")),
            sub_agent.and_then(|node| node.get("agent_nickname")),
            thread_spawn.and_then(|node| node.get("agentNickname")),
            thread_spawn.and_then(|node| node.get("agent_nickname")),
        ])
    });
    let role = first_non_empty_string(&[
        value.get("agentRole"),
        value.get("agent_role"),
        value.get("agentType"),
        value.get("agent_type"),
        value.get("role"),
        sub_agent.and_then(|node| node.get("agentRole")),
        sub_agent.and_then(|node| node.get("agent_role")),
        sub_agent.and_then(|node| node.get("agentType")),
        sub_agent.and_then(|node| node.get("agent_type")),
        thread_spawn.and_then(|node| node.get("agentRole")),
        thread_spawn.and_then(|node| node.get("agent_role")),
        thread_spawn.and_then(|node| node.get("agentType")),
        thread_spawn.and_then(|node| node.get("agent_type")),
    ]);
    Some((thread_id, nickname, role))
}

pub fn subagent_thread_start_from_thread(value: &Value) -> Option<SubagentThreadStart> {
    let thread_id = value.get("id").and_then(Value::as_str)?.to_string();
    let source = value.get("source");
    let sub_agent =
        source.and_then(|source| source.get("subAgent").or_else(|| source.get("sub_agent")));
    let thread_spawn = sub_agent.and_then(|sub_agent| {
        sub_agent
            .get("threadSpawn")
            .or_else(|| sub_agent.get("thread_spawn"))
    })?;

    let spawn = serde_json::from_value::<ThreadSpawnSourceWire>(thread_spawn.clone()).ok()?;
    let (_, nickname, role) = subagent_metadata_from_thread(value)?;
    let status = value
        .get("status")
        .cloned()
        .and_then(|status| serde_json::from_value::<ThreadStatusWire>(status).ok())
        .map(|status| subagent_status_from_thread_status(&status))
        .unwrap_or(SubagentStatus::Running);

    Some(SubagentThreadStart {
        parent_thread_id: spawn.parent_thread_id,
        snapshot: SubagentThreadSnapshot {
            thread_id,
            nickname,
            role,
            depth: spawn.depth,
            status,
        },
    })
}

fn last_path_segment(path: &str) -> Option<String> {
    path.rsplit('/')
        .map(str::trim)
        .find(|segment| !segment.is_empty())
        .map(ToString::to_string)
}

fn first_non_empty_string(candidates: &[Option<&Value>]) -> Option<String> {
    for candidate in candidates {
        let Some(node) = candidate else { continue };
        let Some(text) = node.as_str() else { continue };
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub fn item_status_from_wire(status: Option<&str>) -> ConversationItemStatus {
    match status {
        Some("completed") => ConversationItemStatus::Completed,
        Some("failed") => ConversationItemStatus::Failed,
        Some("declined") => ConversationItemStatus::Declined,
        _ => ConversationItemStatus::InProgress,
    }
}

pub fn normalize_item(turn_id: Option<&str>, value: &Value) -> Option<ConversationItem> {
    let id = value.get("id")?.as_str()?.to_string();
    let item_type = value.get("type")?.as_str()?;
    let turn_id = turn_id.map(ToString::to_string);

    match item_type {
        "userMessage" => {
            let content = value
                .get("content")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let text = content
                .iter()
                .map(user_content_to_visible_text)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("");
            let images = content
                .iter()
                .filter_map(user_content_to_image_attachment)
                .collect::<Vec<_>>();
            let text = if is_hidden_user_control_message(&text) {
                if images.is_empty() {
                    return None;
                }
                String::new()
            } else {
                text
            };
            Some(ConversationItem::Message(ConversationMessageItem {
                id,
                turn_id,
                role: ConversationRole::User,
                text,
                images: (!images.is_empty()).then_some(images),
                is_streaming: false,
            }))
        }
        "agentMessage" => {
            let text = string_field(value, "text");
            if is_hidden_assistant_control_message(&text) {
                return None;
            }
            Some(ConversationItem::Message(ConversationMessageItem {
                id,
                turn_id,
                role: ConversationRole::Assistant,
                text,
                images: None,
                is_streaming: false,
            }))
        }
        "plan" => None,
        "reasoning" => Some(ConversationItem::Reasoning(ConversationReasoningItem {
            id,
            turn_id,
            summary: rich_text_field(value, "summary"),
            content: rich_text_field(value, "content"),
            is_streaming: false,
        })),
        "commandExecution" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
            turn_id,
            tool_type: "commandExecution".to_string(),
            title: "Command".to_string(),
            status: item_status_from_wire(value.get("status").and_then(Value::as_str)),
            summary: value
                .get("command")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            output: rich_text_field(value, "aggregatedOutput"),
        })),
        "fileChange" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
            turn_id,
            tool_type: "fileChange".to_string(),
            title: "File change".to_string(),
            status: item_status_from_wire(value.get("status").and_then(Value::as_str)),
            summary: value
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .filter_map(|change| change.get("path").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|summary| !summary.is_empty()),
            output: value
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| format_file_changes(changes))
                .unwrap_or_default(),
        })),
        "mcpToolCall" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
            turn_id,
            tool_type: "mcpToolCall".to_string(),
            title: "MCP tool".to_string(),
            status: item_status_from_wire(value.get("status").and_then(Value::as_str)),
            summary: Some(format!(
                "{} / {}",
                string_field(value, "server"),
                string_field(value, "tool")
            )),
            output: rich_text_field(value, "result"),
        })),
        "collabToolCall" | "collabAgentToolCall" => None,
        "webSearch" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
            turn_id,
            tool_type: "webSearch".to_string(),
            title: "Web search".to_string(),
            status: ConversationItemStatus::Completed,
            summary: web_search_summary(value),
            output: web_search_output(value),
        })),
        "imageView" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
            turn_id,
            tool_type: "imageView".to_string(),
            title: "Image view".to_string(),
            status: ConversationItemStatus::Completed,
            summary: Some(string_field(value, "path")),
            output: String::new(),
        })),
        "enteredReviewMode" => Some(ConversationItem::System(ConversationSystemItem {
            id,
            turn_id,
            tone: ConversationTone::Info,
            title: "Review mode".to_string(),
            body: format!("Entered review mode for {}", string_field(value, "review")),
        })),
        "exitedReviewMode" => Some(ConversationItem::System(ConversationSystemItem {
            id,
            turn_id,
            tone: ConversationTone::Info,
            title: "Review complete".to_string(),
            body: string_field(value, "review"),
        })),
        "contextCompaction" => Some(ConversationItem::System(ConversationSystemItem {
            id,
            turn_id,
            tone: ConversationTone::Info,
            title: "Context compacted".to_string(),
            body: "Codex compacted the conversation history.".to_string(),
        })),
        other => Some(ConversationItem::System(ConversationSystemItem {
            id,
            turn_id,
            tone: ConversationTone::Info,
            title: "Unsupported item".to_string(),
            body: format!("{APP_NAME} recorded the `{other}` item without a dedicated renderer."),
        })),
    }
}

pub fn normalize_server_interaction(
    interaction_id: &str,
    request: &ServerRequestEnvelope,
) -> Option<ConversationInteraction> {
    match request.method.as_str() {
        "item/tool/requestUserInput" => {
            let params =
                serde_json::from_value::<ToolRequestUserInputParams>(request.params.clone())
                    .ok()?;
            Some(ConversationInteraction::UserInput(Box::new(
                PendingUserInputRequest {
                    id: interaction_id.to_string(),
                    method: request.method.clone(),
                    thread_id: params.thread_id,
                    turn_id: params.turn_id,
                    item_id: params.item_id,
                    questions: params
                        .questions
                        .into_iter()
                        .map(|question| PendingUserInputQuestion {
                            id: question.id,
                            header: question.header,
                            question: question.question,
                            options: question
                                .options
                                .unwrap_or_default()
                                .into_iter()
                                .map(|option| PendingUserInputOption {
                                    label: option.label,
                                    description: option.description,
                                })
                                .collect(),
                            is_other: question.is_other,
                            is_secret: question.is_secret,
                        })
                        .collect(),
                },
            )))
        }
        "item/commandExecution/requestApproval" => {
            let params = serde_json::from_value::<CommandExecutionRequestApprovalParams>(
                request.params.clone(),
            )
            .ok()?;
            Some(ConversationInteraction::Approval(Box::new(
                PendingApprovalRequest {
                    id: interaction_id.to_string(),
                    method: request.method.clone(),
                    thread_id: params.thread_id,
                    turn_id: params.turn_id,
                    item_id: params
                        .approval_id
                        .filter(|approval_id| !approval_id.is_empty())
                        .unwrap_or(params.item_id),
                    approval_kind: ConversationApprovalKind::CommandExecution,
                    title: "Command approval".to_string(),
                    summary: params.command.clone().filter(|command| !command.is_empty()),
                    reason: params.reason,
                    command: params.command,
                    cwd: params.cwd,
                    grant_root: None,
                    permissions: None,
                    network_context: params.network_approval_context.map(|context| {
                        NetworkApprovalContextSnapshot {
                            host: context.host,
                            protocol: context.protocol,
                        }
                    }),
                    proposed_execpolicy_amendment: params
                        .proposed_execpolicy_amendment
                        .unwrap_or_default(),
                    proposed_network_policy_amendments: params
                        .proposed_network_policy_amendments
                        .unwrap_or_default()
                        .into_iter()
                        .map(|amendment| NetworkPolicyAmendmentSnapshot {
                            action: amendment.action,
                            host: amendment.host,
                        })
                        .collect(),
                },
            )))
        }
        "item/fileChange/requestApproval" => {
            let params =
                serde_json::from_value::<FileChangeRequestApprovalParams>(request.params.clone())
                    .ok()?;
            Some(ConversationInteraction::Approval(Box::new(
                PendingApprovalRequest {
                    id: interaction_id.to_string(),
                    method: request.method.clone(),
                    thread_id: params.thread_id,
                    turn_id: params.turn_id,
                    item_id: params.item_id,
                    approval_kind: ConversationApprovalKind::FileChange,
                    title: "File change approval".to_string(),
                    summary: params.grant_root.clone(),
                    reason: params.reason,
                    command: None,
                    cwd: None,
                    grant_root: params.grant_root,
                    permissions: None,
                    network_context: None,
                    proposed_execpolicy_amendment: Vec::new(),
                    proposed_network_policy_amendments: Vec::new(),
                },
            )))
        }
        "item/permissions/requestApproval" => {
            let params =
                serde_json::from_value::<PermissionsRequestApprovalParams>(request.params.clone())
                    .ok()?;
            Some(ConversationInteraction::Approval(Box::new(
                PendingApprovalRequest {
                    id: interaction_id.to_string(),
                    method: request.method.clone(),
                    thread_id: params.thread_id,
                    turn_id: params.turn_id,
                    item_id: params.item_id,
                    approval_kind: ConversationApprovalKind::Permissions,
                    title: "Permission approval".to_string(),
                    summary: permission_profile_summary(&params.permissions),
                    reason: params.reason,
                    command: None,
                    cwd: None,
                    grant_root: None,
                    permissions: Some(permission_profile_snapshot(params.permissions)),
                    network_context: None,
                    proposed_execpolicy_amendment: Vec::new(),
                    proposed_network_policy_amendments: Vec::new(),
                },
            )))
        }
        "mcpServer/elicitation/request"
        | "item/tool/call"
        | "account/chatgptAuthTokens/refresh"
        | "applyPatchApproval"
        | "execCommandApproval" => {
            let thread_id = request
                .params
                .get("threadId")
                .and_then(Value::as_str)?
                .to_string();
            let turn_id = request
                .params
                .get("turnId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let item_id = request
                .params
                .get("itemId")
                .and_then(Value::as_str)
                .map(ToString::to_string);

            Some(ConversationInteraction::Unsupported(
                UnsupportedInteractionRequest {
                    id: interaction_id.to_string(),
                    method: request.method.clone(),
                    thread_id,
                    turn_id,
                    item_id,
                    title: "Interactive request not supported yet".to_string(),
                    message: format!(
                        "`{}` is visible in {}, but responding to it is part of the next milestone.",
                        request.method,
                        APP_NAME
                    ),
                },
            ))
        }
        _ => None,
    }
}

pub fn proposed_plan_from_turn_update(
    event: TurnPlanUpdatedNotification,
    existing: Option<&ProposedPlanSnapshot>,
) -> ProposedPlanSnapshot {
    let mut plan = existing
        .cloned()
        .filter(|candidate| candidate.turn_id == event.turn_id)
        .unwrap_or(ProposedPlanSnapshot {
            turn_id: event.turn_id,
            item_id: None,
            explanation: String::new(),
            steps: Vec::new(),
            markdown: String::new(),
            status: ProposedPlanStatus::Streaming,
            is_awaiting_decision: false,
        });
    plan.explanation = event.explanation.unwrap_or_default();
    plan.steps = event
        .plan
        .into_iter()
        .map(|step| ProposedPlanStep {
            step: step.step,
            status: step.status,
        })
        .collect();
    if !plan.is_awaiting_decision {
        plan.status = ProposedPlanStatus::Streaming;
    }
    plan
}

pub fn task_plan_from_turn_update(
    event: TurnPlanUpdatedNotification,
    existing: Option<&ConversationTaskSnapshot>,
) -> ConversationTaskSnapshot {
    let mut plan = existing
        .cloned()
        .filter(|candidate| candidate.turn_id == event.turn_id)
        .unwrap_or(ConversationTaskSnapshot {
            turn_id: event.turn_id,
            item_id: None,
            explanation: String::new(),
            steps: Vec::new(),
            markdown: String::new(),
            status: ConversationTaskStatus::Running,
        });
    plan.explanation = event.explanation.unwrap_or_default();
    plan.steps = event
        .plan
        .into_iter()
        .map(|step| ProposedPlanStep {
            step: step.step,
            status: step.status,
        })
        .collect();
    plan.status = ConversationTaskStatus::Running;
    plan
}

pub fn append_plan_delta(plan: &mut ProposedPlanSnapshot, item_id: &str, delta: &str) {
    plan.item_id = Some(item_id.to_string());
    plan.markdown.push_str(delta);
    if !plan.is_awaiting_decision {
        plan.status = ProposedPlanStatus::Streaming;
    }
}

pub fn append_task_plan_delta(plan: &mut ConversationTaskSnapshot, item_id: &str, delta: &str) {
    plan.item_id = Some(item_id.to_string());
    plan.markdown.push_str(delta);
    plan.status = ConversationTaskStatus::Running;
}

pub fn complete_proposed_plan(
    plan: &mut ProposedPlanSnapshot,
    item_id: &str,
    value: Option<&Value>,
) {
    let mut markdown = plan.markdown.clone();
    if let Some(value) = value {
        let next_markdown = rich_text_field(value, "text");
        if !next_markdown.is_empty() {
            markdown = next_markdown;
        }
    }
    if markdown.trim().is_empty() && plan.steps.is_empty() {
        return;
    }
    plan.item_id = Some(item_id.to_string());
    plan.markdown = markdown;
    plan.status = ProposedPlanStatus::Ready;
    plan.is_awaiting_decision = true;
}

pub fn complete_task_plan(
    plan: &mut ConversationTaskSnapshot,
    item_id: &str,
    value: Option<&Value>,
    status: ConversationTaskStatus,
) {
    let mut markdown = plan.markdown.clone();
    if let Some(value) = value {
        let next_markdown = rich_text_field(value, "text");
        if !next_markdown.is_empty() {
            markdown = next_markdown;
        }
    }
    if markdown.trim().is_empty() && plan.steps.is_empty() && plan.explanation.trim().is_empty() {
        return;
    }
    plan.item_id = Some(item_id.to_string());
    plan.markdown = markdown;
    plan.status = status;
}

pub fn mark_plan_superseded(plan: &mut ProposedPlanSnapshot) {
    plan.status = ProposedPlanStatus::Superseded;
    plan.is_awaiting_decision = false;
}

pub fn mark_plan_approved(plan: &mut ProposedPlanSnapshot) {
    plan.status = ProposedPlanStatus::Approved;
    plan.is_awaiting_decision = false;
}

pub fn upsert_item(items: &mut Vec<ConversationItem>, item: ConversationItem) {
    let target_id = item_id(&item);
    if let Some(index) = items
        .iter()
        .position(|candidate| item_id(candidate) == target_id)
    {
        items[index] = merge_conversation_items(items[index].clone(), item);
        return;
    }

    if let Some(index) = optimistic_user_message_index(items, &item) {
        items[index] = item;
        return;
    }

    items.push(item);
}

pub fn append_agent_delta(
    items: &mut Vec<ConversationItem>,
    turn_id: &str,
    item_id: &str,
    delta: &str,
) {
    if let Some(index) = find_message_index(items, item_id, ConversationRole::Assistant) {
        let should_remove = {
            let ConversationItem::Message(item) = &mut items[index] else {
                return;
            };
            item.turn_id.get_or_insert_with(|| turn_id.to_string());
            item.text.push_str(delta);
            if is_hidden_assistant_control_message(&item.text) {
                true
            } else {
                item.is_streaming = true;
                false
            }
        };
        if should_remove {
            items.remove(index);
        }
        return;
    }

    if is_hidden_assistant_control_message(delta) {
        return;
    }

    items.push(ConversationItem::Message(ConversationMessageItem {
        id: item_id.to_string(),
        turn_id: Some(turn_id.to_string()),
        role: ConversationRole::Assistant,
        text: delta.to_string(),
        images: None,
        is_streaming: true,
    }));
}

pub fn append_reasoning_summary(
    items: &mut Vec<ConversationItem>,
    turn_id: &str,
    item_id: &str,
    delta: &str,
) {
    match find_reasoning_mut(items, item_id) {
        Some(item) => {
            item.turn_id.get_or_insert_with(|| turn_id.to_string());
            item.summary.push_str(delta);
            item.is_streaming = true;
        }
        None => items.push(ConversationItem::Reasoning(ConversationReasoningItem {
            id: item_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            summary: delta.to_string(),
            content: String::new(),
            is_streaming: true,
        })),
    }
}

pub fn append_reasoning_boundary(items: &mut [ConversationItem], turn_id: &str, item_id: &str) {
    if let Some(item) = find_reasoning_mut(items, item_id) {
        item.turn_id.get_or_insert_with(|| turn_id.to_string());
        if !item.summary.is_empty() && !item.summary.ends_with("\n\n") {
            item.summary.push_str("\n\n");
        }
        item.is_streaming = true;
    }
}

pub fn append_reasoning_content(
    items: &mut Vec<ConversationItem>,
    turn_id: &str,
    item_id: &str,
    delta: &str,
) {
    match find_reasoning_mut(items, item_id) {
        Some(item) => {
            item.turn_id.get_or_insert_with(|| turn_id.to_string());
            item.content.push_str(delta);
            item.is_streaming = true;
        }
        None => items.push(ConversationItem::Reasoning(ConversationReasoningItem {
            id: item_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            summary: String::new(),
            content: delta.to_string(),
            is_streaming: true,
        })),
    }
}

pub fn append_tool_output(
    items: &mut [ConversationItem],
    turn_id: &str,
    item_id: &str,
    delta: &str,
) {
    if let Some(item) = find_tool_mut(items, item_id) {
        item.turn_id.get_or_insert_with(|| turn_id.to_string());
        item.output.push_str(delta);
    }
}

pub fn clear_streaming_flags(items: &mut [ConversationItem]) {
    for item in items {
        match item {
            ConversationItem::Message(message) => message.is_streaming = false,
            ConversationItem::Reasoning(reasoning) => reasoning.is_streaming = false,
            ConversationItem::Tool(_) | ConversationItem::System(_) => {}
        }
    }
}

pub fn error_snapshot(error: TurnErrorWire) -> ConversationErrorSnapshot {
    ConversationErrorSnapshot {
        message: error.message,
        codex_error_info: error.codex_error_info.map(|value| compact_json(&value)),
        additional_details: error.additional_details,
    }
}

pub fn token_usage_snapshot(wire: TokenUsageWire) -> ThreadTokenUsageSnapshot {
    ThreadTokenUsageSnapshot {
        total: wire.total,
        last: wire.last,
        model_context_window: wire.model_context_window,
    }
}

fn string_field(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(field) => rich_text_value(field),
        None => String::new(),
    }
}

fn rich_text_field(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(field) => rich_text_value(field),
        None => String::new(),
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn rich_text_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(array_item_to_text)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(map) => map
            .get("text")
            .map(rich_text_value)
            .unwrap_or_else(|| compact_json(value)),
        other => compact_json(other),
    }
}

fn array_item_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(map) => map
            .get("text")
            .map(rich_text_value)
            .or_else(|| map.get("title").map(rich_text_value))
            .unwrap_or_else(|| compact_json(value)),
        other => rich_text_value(other),
    }
}

fn merge_conversation_items(
    existing: ConversationItem,
    incoming: ConversationItem,
) -> ConversationItem {
    match (existing, incoming) {
        (
            ConversationItem::Reasoning(existing_reasoning),
            ConversationItem::Reasoning(incoming_reasoning),
        ) => ConversationItem::Reasoning(ConversationReasoningItem {
            id: incoming_reasoning.id,
            turn_id: incoming_reasoning.turn_id.or(existing_reasoning.turn_id),
            summary: if incoming_reasoning.summary.is_empty() {
                existing_reasoning.summary
            } else {
                incoming_reasoning.summary
            },
            content: if incoming_reasoning.content.is_empty() {
                existing_reasoning.content
            } else {
                incoming_reasoning.content
            },
            is_streaming: incoming_reasoning.is_streaming,
        }),
        (
            ConversationItem::Message(existing_message),
            ConversationItem::Message(incoming_message),
        ) => ConversationItem::Message(ConversationMessageItem {
            id: incoming_message.id,
            turn_id: incoming_message.turn_id.or(existing_message.turn_id),
            role: incoming_message.role,
            text: if incoming_message.text.is_empty() {
                existing_message.text
            } else {
                incoming_message.text
            },
            images: incoming_message.images.or(existing_message.images),
            is_streaming: incoming_message.is_streaming,
        }),
        (ConversationItem::Tool(existing_tool), ConversationItem::Tool(incoming_tool)) => {
            ConversationItem::Tool(ConversationToolItem {
                id: incoming_tool.id,
                turn_id: incoming_tool.turn_id.or(existing_tool.turn_id),
                tool_type: incoming_tool.tool_type,
                title: incoming_tool.title,
                status: incoming_tool.status,
                summary: incoming_tool.summary.or(existing_tool.summary),
                output: if incoming_tool.output.is_empty() {
                    existing_tool.output
                } else {
                    incoming_tool.output
                },
            })
        }
        (_, incoming) => incoming,
    }
}

fn web_search_summary(value: &Value) -> Option<String> {
    let action = value.get("action");
    action
        .and_then(|candidate| candidate.get("query"))
        .map(rich_text_value)
        .filter(|summary| !summary.is_empty())
        .or_else(|| {
            action
                .and_then(|candidate| candidate.get("queries"))
                .and_then(Value::as_array)
                .and_then(|queries| queries.first())
                .map(rich_text_value)
                .filter(|summary| !summary.is_empty())
        })
        .or_else(|| {
            value
                .get("query")
                .map(rich_text_value)
                .filter(|summary| !summary.is_empty())
        })
}

fn web_search_output(value: &Value) -> String {
    let mut lines = Vec::new();
    if let Some(action) = value.get("action") {
        if let Some(action_type) = action.get("type").and_then(Value::as_str) {
            lines.push(format!("Action: {action_type}"));
        }
        if let Some(url) = action
            .get("url")
            .or_else(|| action.get("ref"))
            .map(rich_text_value)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("Target: {url}"));
        }
        if let Some(pattern) = action
            .get("pattern")
            .map(rich_text_value)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("Pattern: {pattern}"));
        }
        if let Some(queries) = action.get("queries").and_then(Value::as_array) {
            let formatted = queries
                .iter()
                .map(rich_text_value)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if !formatted.is_empty() {
                lines.push(format!("Queries:\n{}", formatted.join("\n")));
            }
        }
    }
    lines.join("\n")
}

pub fn proposed_plan_from_item(
    turn_id: &str,
    value: &Value,
    status: ProposedPlanStatus,
) -> Option<ProposedPlanSnapshot> {
    let (markdown, steps, explanation) = plan_content_from_item(value);

    if markdown.trim().is_empty() && steps.is_empty() && explanation.trim().is_empty() {
        return None;
    }

    Some(ProposedPlanSnapshot {
        turn_id: turn_id.to_string(),
        item_id: value
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        explanation,
        steps,
        markdown,
        status,
        is_awaiting_decision: matches!(status, ProposedPlanStatus::Ready),
    })
}

pub fn task_plan_from_item(
    turn_id: &str,
    value: &Value,
    status: ConversationTaskStatus,
) -> Option<ConversationTaskSnapshot> {
    let (markdown, steps, explanation) = plan_content_from_item(value);

    if markdown.trim().is_empty() && steps.is_empty() && explanation.trim().is_empty() {
        return None;
    }

    Some(ConversationTaskSnapshot {
        turn_id: turn_id.to_string(),
        item_id: value
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        explanation,
        steps,
        markdown,
        status,
    })
}

fn plan_content_from_item(value: &Value) -> (String, Vec<ProposedPlanStep>, String) {
    let markdown = rich_text_field(value, "text");
    let steps = value
        .get("plan")
        .and_then(Value::as_array)
        .map(|plan| {
            plan.iter()
                .filter_map(|step| {
                    Some(ProposedPlanStep {
                        step: step.get("step")?.as_str()?.to_string(),
                        status: serde_json::from_value::<ProposedPlanStepStatus>(
                            step.get("status")?.clone(),
                        )
                        .ok()?,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let explanation = value
        .get("explanation")
        .map(rich_text_value)
        .unwrap_or_default();
    (markdown, steps, explanation)
}

fn permission_profile_snapshot(profile: PermissionProfileWire) -> PermissionProfileSnapshot {
    PermissionProfileSnapshot {
        file_system: profile
            .file_system
            .map(|file_system| FileSystemPermissionSnapshot {
                read: file_system.read.unwrap_or_default(),
                write: file_system.write.unwrap_or_default(),
            }),
        network: profile.network.map(|network| NetworkPermissionSnapshot {
            enabled: network.enabled,
        }),
    }
}

fn permission_profile_summary(profile: &PermissionProfileWire) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(file_system) = profile.file_system.as_ref() {
        if let Some(read) = file_system.read.as_ref().filter(|paths| !paths.is_empty()) {
            parts.push(format!("Read: {}", read.join(", ")));
        }
        if let Some(write) = file_system.write.as_ref().filter(|paths| !paths.is_empty()) {
            parts.push(format!("Write: {}", write.join(", ")));
        }
    }
    if let Some(network) = profile.network.as_ref().and_then(|network| network.enabled) {
        parts.push(format!(
            "Network: {}",
            if network { "enabled" } else { "disabled" }
        ));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

fn format_file_changes(changes: &[Value]) -> String {
    changes
        .iter()
        .map(|change| {
            let path = change
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("Unknown file");
            let diff = change
                .get("diff")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if diff.is_empty() {
                path.to_string()
            } else {
                format!("{path}\n{diff}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn user_content_to_visible_text(value: &Value) -> String {
    match value.get("type").and_then(Value::as_str) {
        Some("text") => apply_text_element_placeholders(
            &string_field(value, "text"),
            value
                .get("text_elements")
                .or_else(|| value.get("textElements"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        ),
        Some("mention") | Some("skill") => String::new(),
        _ => String::new(),
    }
}

fn user_content_to_image_attachment(value: &Value) -> Option<ConversationImageAttachment> {
    match value.get("type").and_then(Value::as_str) {
        Some("image") => value
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(|url| ConversationImageAttachment::Image {
                url: url.to_string(),
            }),
        Some("localImage") => value
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .map(|path| ConversationImageAttachment::LocalImage {
                path: path.to_string(),
            }),
        _ => None,
    }
}

fn apply_text_element_placeholders<'a>(
    text: &str,
    elements: impl Iterator<Item = &'a Value>,
) -> String {
    let mut rendered = String::new();
    let mut last_index = 0usize;
    let mut parsed = elements
        .filter_map(|value| {
            let range = value.get("byteRange").or_else(|| value.get("byte_range"))?;
            let start = range.get("start")?.as_u64()? as usize;
            let end = range.get("end")?.as_u64()? as usize;
            Some((
                start,
                end,
                value
                    .get("placeholder")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            ))
        })
        .collect::<Vec<_>>();
    parsed.sort_by_key(|element| element.0);

    for (start, end, placeholder) in parsed {
        if start > text.len() || end > text.len() || start < last_index || start > end {
            continue;
        }
        rendered.push_str(&text[last_index..start]);
        match placeholder {
            Some(placeholder) => rendered.push_str(&placeholder),
            None => rendered.push_str(&text[start..end]),
        }
        last_index = end;
    }
    rendered.push_str(&text[last_index..]);
    rendered
}

fn is_hidden_user_control_message(text: &str) -> bool {
    text == plan_approval_message() || is_subagent_notification_message(text)
}

pub(crate) fn is_hidden_assistant_control_message(text: &str) -> bool {
    is_subagent_notification_message(text) || is_inter_agent_communication_message(text)
}

pub(crate) fn is_hidden_assistant_control_message_prefix(text: &str) -> bool {
    let trimmed = text.trim_start();
    !trimmed.is_empty()
        && !is_hidden_assistant_control_message(trimmed)
        && (is_subagent_notification_message_prefix(trimmed)
            || is_inter_agent_communication_message_prefix(trimmed))
}

pub(crate) fn is_hidden_assistant_control_item(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("agentMessage")
        && is_hidden_assistant_control_message(&string_field(value, "text"))
}

fn is_subagent_notification_message(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("<subagent_notification>") && trimmed.ends_with("</subagent_notification>")
}

fn is_subagent_notification_message_prefix(text: &str) -> bool {
    const OPEN_TAG: &str = "<subagent_notification>";
    OPEN_TAG.starts_with(text)
        || (text.starts_with(OPEN_TAG) && !text.contains("</subagent_notification>"))
}

fn is_inter_agent_communication_message(text: &str) -> bool {
    let Ok(communication) = serde_json::from_str::<InterAgentCommunicationWire>(text.trim()) else {
        return false;
    };

    is_agent_path(&communication.author)
        && is_agent_path(&communication.recipient)
        && communication
            .other_recipients
            .iter()
            .all(|recipient| is_agent_path(recipient))
}

fn is_inter_agent_communication_message_prefix(text: &str) -> bool {
    let Some(after_brace) = text.strip_prefix('{') else {
        return false;
    };

    json_object_key_prefix_matches(after_brace, "author")
}

fn json_object_key_prefix_matches(text: &str, key: &str) -> bool {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return true;
    }

    let expected_key = format!("\"{key}\"");
    if expected_key.starts_with(trimmed) {
        return true;
    }

    let Some(after_key) = trimmed.strip_prefix(&expected_key) else {
        return false;
    };
    let after_key = after_key.trim_start();

    after_key.is_empty() || ":".starts_with(after_key) || after_key.starts_with(':')
}

fn is_agent_path(value: &str) -> bool {
    value.starts_with('/') && value.len() > 1
}

fn thread_spawn_source(source: &Value) -> Option<ThreadSpawnSourceWire> {
    let subagent = source.get("subAgent").or_else(|| source.get("sub_agent"))?;
    let thread_spawn = subagent
        .get("thread_spawn")
        .or_else(|| subagent.get("threadSpawn"))?;

    serde_json::from_value::<ThreadSpawnSourceWire>(thread_spawn.clone()).ok()
}

pub(crate) fn subagent_status_from_thread_status(status: &ThreadStatusWire) -> SubagentStatus {
    match status.kind.as_str() {
        "active" => SubagentStatus::Running,
        "systemError" => SubagentStatus::Failed,
        _ => SubagentStatus::Completed,
    }
}

fn subagent_status_from_collab_state(status: &str) -> SubagentStatus {
    match status {
        "pendingInit" | "running" => SubagentStatus::Running,
        "error" | "errored" | "failed" | "failure" | "notFound" => SubagentStatus::Failed,
        "interrupted" | "shutdown" | "completed" => SubagentStatus::Completed,
        _ => SubagentStatus::Completed,
    }
}

fn subagent_status_from_collab_tool_status(status: Option<&str>) -> SubagentStatus {
    match status {
        Some("inProgress") => SubagentStatus::Running,
        Some("failed") => SubagentStatus::Failed,
        _ => SubagentStatus::Completed,
    }
}

fn label_for_subagent(subagent: &SubagentThreadSnapshot) -> &str {
    subagent
        .nickname
        .as_deref()
        .or(subagent.role.as_deref())
        .unwrap_or(subagent.thread_id.as_str())
}

fn item_id(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::Message(message) => &message.id,
        ConversationItem::Reasoning(reasoning) => &reasoning.id,
        ConversationItem::Tool(tool) => &tool.id,
        ConversationItem::System(system) => &system.id,
    }
}

fn item_turn_id(item: &ConversationItem) -> Option<&str> {
    match item {
        ConversationItem::Message(message) => message.turn_id.as_deref(),
        ConversationItem::Reasoning(reasoning) => reasoning.turn_id.as_deref(),
        ConversationItem::Tool(tool) => tool.turn_id.as_deref(),
        ConversationItem::System(system) => system.turn_id.as_deref(),
    }
}

/// Merge persisted items back into a freshly-built snapshot. Persisted items
/// arrive in their original insertion order (load is `ORDER BY rowid`); we
/// walk the list and place each entry next to whichever item we last placed
/// or matched, so:
///
/// * already-present IDs (round-tripped through provider history) keep their
///   server-side position and act as anchors for nearby turnless items;
/// * turn-attached items slot in right after the last sibling of the same
///   `turn_id`;
/// * turnless items (e.g., locally-pushed system banners) follow the last
///   placed item, preserving their relative chronology with neighboring
///   persisted activity instead of bunching up at the end of the transcript.
pub fn merge_persisted_items(items: &mut Vec<ConversationItem>, persisted: Vec<ConversationItem>) {
    let mut cursor: Option<usize> = None;
    for item in persisted {
        let target_id = item_id(&item).to_string();
        if let Some(index) = items
            .iter()
            .position(|candidate| item_id(candidate) == target_id)
        {
            items[index] = merge_existing_with_persisted_item(items[index].clone(), item);
            cursor = Some(index);
            continue;
        }
        let insert_at = if let Some(turn_id) = item_turn_id(&item) {
            items
                .iter()
                .rposition(|candidate| item_turn_id(candidate) == Some(turn_id))
                .map(|index| index + 1)
                .unwrap_or_else(|| cursor.map(|i| i + 1).unwrap_or(items.len()))
        } else {
            cursor.map(|i| i + 1).unwrap_or(items.len())
        };
        items.insert(insert_at, item);
        cursor = Some(insert_at);
    }
}

fn merge_existing_with_persisted_item(
    existing: ConversationItem,
    persisted: ConversationItem,
) -> ConversationItem {
    match (existing, persisted) {
        (
            ConversationItem::Message(existing_message),
            ConversationItem::Message(persisted_message),
        ) => ConversationItem::Message(ConversationMessageItem {
            id: existing_message.id,
            turn_id: existing_message.turn_id.or(persisted_message.turn_id),
            role: existing_message.role,
            text: existing_message.text,
            images: existing_message.images.or(persisted_message.images),
            is_streaming: existing_message.is_streaming,
        }),
        (
            ConversationItem::Reasoning(existing_reasoning),
            ConversationItem::Reasoning(persisted_reasoning),
        ) => ConversationItem::Reasoning(ConversationReasoningItem {
            id: existing_reasoning.id,
            turn_id: existing_reasoning.turn_id.or(persisted_reasoning.turn_id),
            summary: if existing_reasoning.summary.is_empty() {
                persisted_reasoning.summary
            } else {
                existing_reasoning.summary
            },
            content: if existing_reasoning.content.is_empty() {
                persisted_reasoning.content
            } else {
                existing_reasoning.content
            },
            is_streaming: existing_reasoning.is_streaming,
        }),
        (existing, _) => existing,
    }
}

fn optimistic_user_message_index(
    items: &[ConversationItem],
    incoming: &ConversationItem,
) -> Option<usize> {
    let ConversationItem::Message(incoming_message) = incoming else {
        return None;
    };
    if incoming_message.role != ConversationRole::User
        || incoming_message.id.starts_with("local-user-")
    {
        return None;
    }

    items.iter().position(|candidate| {
        matches!(
            candidate,
            ConversationItem::Message(message)
                if message.role == ConversationRole::User
                    && message.id.starts_with("local-user-")
                    && message.text == incoming_message.text
                    && same_message_images(
                        message.images.as_deref(),
                        incoming_message.images.as_deref(),
                    )
        )
    })
}

fn same_message_images(
    left: Option<&[ConversationImageAttachment]>,
    right: Option<&[ConversationImageAttachment]>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right || left.len() == right.len(),
        _ => false,
    }
}

fn find_message_index(
    items: &[ConversationItem],
    item_id: &str,
    role: ConversationRole,
) -> Option<usize> {
    items.iter().position(|item| {
        matches!(
            item,
            ConversationItem::Message(message)
                if message.id == item_id && message.role == role
        )
    })
}

fn find_reasoning_mut<'a>(
    items: &'a mut [ConversationItem],
    item_id: &str,
) -> Option<&'a mut ConversationReasoningItem> {
    items.iter_mut().find_map(|item| match item {
        ConversationItem::Reasoning(reasoning) if reasoning.id == item_id => Some(reasoning),
        _ => None,
    })
}

fn find_tool_mut<'a>(
    items: &'a mut [ConversationItem],
    item_id: &str,
) -> Option<&'a mut ConversationToolItem> {
    items.iter_mut().find_map(|item| match item {
        ConversationItem::Tool(tool) if tool.id == item_id => Some(tool),
        _ => None,
    })
}

#[derive(Debug, Clone, Deserialize)]
struct ResponseWire {
    id: Value,
    result: Option<Value>,
    error: Option<ResponseErrorWire>,
}

#[derive(Debug, Clone, Deserialize)]
struct ResponseErrorWire {
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ServerRequestWire {
    id: Value,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ServerNotificationWire {
    method: String,
    params: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};

    fn inter_agent_control_message(agent_path: &str) -> String {
        format!(
            "{{\"author\":\"{agent_path}\",\"recipient\":\"/root\",\"other_recipients\":[],\"content\":\"<subagent_notification>\\n{{\\\"agent_path\\\":\\\"{agent_path}\\\",\\\"status\\\":{{\\\"completed\\\":\\\"Done\\\"}}}}\\n</subagent_notification>\",\"trigger_turn\":false}}"
        )
    }

    #[test]
    fn normalize_user_message_joins_visible_content() {
        let item = normalize_item(
            Some("turn-1"),
            &json!({
                "id": "user-1",
                "type": "userMessage",
                "content": [
                    { "type": "text", "text": "Hello" },
                    { "type": "image", "url": "https://example.com" }
                ]
            }),
        )
        .expect("item should normalize");

        match item {
            ConversationItem::Message(message) => {
                assert_eq!(message.turn_id.as_deref(), Some("turn-1"));
                assert_eq!(message.role, ConversationRole::User);
                assert_eq!(message.text, "Hello");
                assert_eq!(
                    message.images,
                    Some(vec![ConversationImageAttachment::Image {
                        url: "https://example.com".to_string(),
                    }])
                );
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn normalize_user_message_replaces_text_elements_and_hides_structured_mentions() {
        let item = normalize_item(
            Some("turn-2"),
            &json!({
                "id": "user-2",
                "type": "userMessage",
                "content": [
                    {
                        "type": "text",
                        "text": "Expanded prompt",
                        "text_elements": [{
                            "byteRange": { "start": 0, "end": 15 },
                            "placeholder": "/prompts:debug(\"boom\")"
                        }]
                    },
                    { "type": "skill", "name": "skein-standards", "path": "/tmp/skill" },
                    { "type": "mention", "name": "github", "path": "app://github" }
                ]
            }),
        )
        .expect("item should normalize");

        match item {
            ConversationItem::Message(message) => {
                assert_eq!(message.text, "/prompts:debug(\"boom\")");
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn normalize_user_message_hides_control_text_but_keeps_images() {
        let item = normalize_item(
            Some("turn-3"),
            &json!({
                "id": "user-approval-image",
                "type": "userMessage",
                "content": [
                    { "type": "text", "text": plan_approval_message() },
                    { "type": "localImage", "path": "/tmp/approval.png" }
                ]
            }),
        )
        .expect("item should normalize");

        match item {
            ConversationItem::Message(message) => {
                assert_eq!(message.text, "");
                assert_eq!(
                    message.images,
                    Some(vec![ConversationImageAttachment::LocalImage {
                        path: "/tmp/approval.png".to_string(),
                    }])
                );
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn normalize_user_message_hides_subagent_notification_fragments() {
        let item = normalize_item(
            Some("turn-3"),
            &json!({
                "id": "user-subagent-notification",
                "type": "userMessage",
                "content": [{
                    "type": "text",
                    "text": "<subagent_notification>\n{\"agent_path\":\"/root/helper\",\"status\":{\"completed\":\"Done\"}}\n</subagent_notification>"
                }]
            }),
        );

        assert!(item.is_none());
    }

    #[test]
    fn normalize_user_message_hides_appended_multi_agent_nudge_ranges() {
        let visible_text = "Parallelize this";
        let hidden_text = "\n\nAdditional instruction: use sub-agents.";
        let combined = format!("{visible_text}{hidden_text}");
        let item = normalize_item(
            Some("turn-4"),
            &json!({
                "id": "user-hidden-nudge",
                "type": "userMessage",
                "content": [{
                    "type": "text",
                    "text": combined,
                    "text_elements": [{
                        "byteRange": { "start": visible_text.len(), "end": visible_text.len() + hidden_text.len() },
                        "placeholder": ""
                    }]
                }]
            }),
        )
        .expect("item should normalize");

        match item {
            ConversationItem::Message(message) => {
                assert_eq!(message.text, visible_text);
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn local_image_paths_preserve_leading_and_trailing_spaces() {
        let image = user_content_to_image_attachment(&json!({
            "type": "localImage",
            "path": " /tmp/image with spaces.png "
        }));

        assert_eq!(
            image,
            Some(ConversationImageAttachment::LocalImage {
                path: " /tmp/image with spaces.png ".to_string(),
            })
        );
    }

    #[test]
    fn collaboration_mode_payload_maps_build_to_default_mode() {
        let payload = collaboration_mode_payload(&ConversationComposerSettings {
            provider: ProviderKind::Codex,
            model: "gpt-5.4".to_string(),
            reasoning_effort: ReasoningEffort::High,
            collaboration_mode: CollaborationMode::Build,
            approval_policy: ApprovalPolicy::AskToEdit,
            service_tier: None,
        });

        assert_eq!(payload["mode"], "default");
        assert_eq!(payload["settings"]["reasoning_effort"], "high");
        assert!(payload["settings"]["developer_instructions"].is_null());
    }

    #[test]
    fn collaboration_mode_payload_includes_plan_instructions() {
        let payload = collaboration_mode_payload(&ConversationComposerSettings {
            provider: ProviderKind::Codex,
            model: "gpt-5.4".to_string(),
            reasoning_effort: ReasoningEffort::High,
            collaboration_mode: CollaborationMode::Plan,
            approval_policy: ApprovalPolicy::AskToEdit,
            service_tier: None,
        });

        assert_eq!(payload["mode"], "plan");
        assert!(payload["settings"]["developer_instructions"]
            .as_str()
            .is_some_and(
                |instructions| instructions.contains("must use the `request_user_input` tool")
            ));
    }

    #[test]
    fn initialize_params_omit_opt_out_notification_methods_when_streaming_enabled() {
        let payload = initialize_params("1.2.3", true);

        assert_eq!(payload["clientInfo"]["title"], APP_NAME);
        assert_eq!(payload["capabilities"]["experimentalApi"], true);
        assert!(payload["capabilities"]
            .as_object()
            .and_then(|capabilities| capabilities.get("optOutNotificationMethods"))
            .is_none());
    }

    #[test]
    fn initialize_params_include_assistant_delta_opt_out_when_streaming_disabled() {
        let payload = initialize_params("1.2.3", false);

        assert_eq!(
            payload["capabilities"]["optOutNotificationMethods"],
            json!([AGENT_MESSAGE_DELTA_METHOD])
        );
    }

    #[test]
    fn append_reasoning_boundary_inserts_visual_gap() {
        let mut items = vec![ConversationItem::Reasoning(ConversationReasoningItem {
            id: "reasoning-1".to_string(),
            turn_id: None,
            summary: "Exploring files".to_string(),
            content: String::new(),
            is_streaming: true,
        })];
        append_reasoning_boundary(&mut items, "turn-1", "reasoning-1");
        append_reasoning_summary(&mut items, "turn-1", "reasoning-1", "Searching routes");

        match &items[0] {
            ConversationItem::Reasoning(reasoning) => {
                assert_eq!(reasoning.turn_id.as_deref(), Some("turn-1"));
                assert_eq!(reasoning.summary, "Exploring files\n\nSearching routes");
            }
            _ => panic!("expected reasoning item"),
        }
    }

    #[test]
    fn canonical_user_message_replaces_matching_optimistic_entry() {
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "local-user-1".to_string(),
            turn_id: None,
            role: ConversationRole::User,
            text: "Salut".to_string(),
            images: None,
            is_streaming: false,
        })];

        upsert_item(
            &mut items,
            ConversationItem::Message(ConversationMessageItem {
                id: "user-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: ConversationRole::User,
                text: "Salut".to_string(),
                images: None,
                is_streaming: false,
            }),
        );

        assert_eq!(items.len(), 1);
        match &items[0] {
            ConversationItem::Message(message) => assert_eq!(message.id, "user-1"),
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn canonical_user_message_replaces_optimistic_entry_when_images_are_rewritten() {
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "local-user-1".to_string(),
            turn_id: None,
            role: ConversationRole::User,
            text: "".to_string(),
            images: Some(vec![ConversationImageAttachment::LocalImage {
                path: "/tmp/capture.png".to_string(),
            }]),
            is_streaming: false,
        })];

        upsert_item(
            &mut items,
            ConversationItem::Message(ConversationMessageItem {
                id: "user-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: ConversationRole::User,
                text: "".to_string(),
                images: Some(vec![ConversationImageAttachment::Image {
                    url: "https://example.com/capture.png".to_string(),
                }]),
                is_streaming: false,
            }),
        );

        assert_eq!(items.len(), 1);
        match &items[0] {
            ConversationItem::Message(message) => {
                assert_eq!(message.id, "user-1");
                assert_eq!(
                    message.images,
                    Some(vec![ConversationImageAttachment::Image {
                        url: "https://example.com/capture.png".to_string(),
                    }])
                );
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn canonical_user_message_with_hidden_suffix_replaces_matching_optimistic_entry() {
        let visible_text = "Parallelize this";
        let hidden_text = "\n\nAdditional instruction: use sub-agents.";
        let combined = format!("{visible_text}{hidden_text}");
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "local-user-1".to_string(),
            turn_id: None,
            role: ConversationRole::User,
            text: visible_text.to_string(),
            images: None,
            is_streaming: false,
        })];

        let canonical = normalize_item(
            Some("turn-1"),
            &json!({
                "id": "user-1",
                "type": "userMessage",
                "content": [{
                    "type": "text",
                    "text": combined,
                    "text_elements": [{
                        "byteRange": { "start": visible_text.len(), "end": visible_text.len() + hidden_text.len() },
                        "placeholder": ""
                    }]
                }]
            }),
        )
        .expect("item should normalize");

        upsert_item(&mut items, canonical);

        assert_eq!(items.len(), 1);
        match &items[0] {
            ConversationItem::Message(message) => {
                assert_eq!(message.id, "user-1");
                assert_eq!(message.text, visible_text);
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn canonical_user_message_with_hidden_handoff_prefix_replaces_matching_optimistic_entry() {
        let hidden_prefix = "<handoff_context>\nsource_provider: Anthropic\nrecent:\nassistant: Météo à Bordeaux\n</handoff_context>";
        let visible_text = "Merci, et pour Paris ?";
        let combined = format!("{hidden_prefix}\n\n{visible_text}");
        let hidden_end = hidden_prefix.len() + 2;
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "local-user-1".to_string(),
            turn_id: None,
            role: ConversationRole::User,
            text: visible_text.to_string(),
            images: None,
            is_streaming: false,
        })];

        let canonical = normalize_item(
            Some("turn-1"),
            &json!({
                "id": "user-1",
                "type": "userMessage",
                "content": [{
                    "type": "text",
                    "text": combined,
                    "text_elements": [{
                        "byteRange": { "start": 0, "end": hidden_end },
                        "placeholder": ""
                    }]
                }]
            }),
        )
        .expect("item should normalize");

        upsert_item(&mut items, canonical);

        assert_eq!(items.len(), 1);
        match &items[0] {
            ConversationItem::Message(message) => {
                assert_eq!(message.id, "user-1");
                assert_eq!(message.text, visible_text);
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn merge_persisted_items_restores_turn_id_on_provider_message() {
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "claude-assistant-progress".to_string(),
            turn_id: None,
            role: ConversationRole::Assistant,
            text: "Je cherche la météo pour demain à Bordeaux.".to_string(),
            images: None,
            is_streaming: false,
        })];

        merge_persisted_items(
            &mut items,
            vec![ConversationItem::Message(ConversationMessageItem {
                id: "claude-assistant-progress".to_string(),
                turn_id: Some("turn-bordeaux".to_string()),
                role: ConversationRole::Assistant,
                text: "Old local projection".to_string(),
                images: None,
                is_streaming: false,
            })],
        );

        match &items[0] {
            ConversationItem::Message(message) => {
                assert_eq!(message.turn_id.as_deref(), Some("turn-bordeaux"));
                assert_eq!(message.text, "Je cherche la météo pour demain à Bordeaux.");
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn merge_persisted_items_restores_missing_provider_images() {
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "claude-assistant-progress".to_string(),
            turn_id: None,
            role: ConversationRole::Assistant,
            text: "Image context".to_string(),
            images: None,
            is_streaming: false,
        })];

        merge_persisted_items(
            &mut items,
            vec![ConversationItem::Message(ConversationMessageItem {
                id: "claude-assistant-progress".to_string(),
                turn_id: Some("turn-image".to_string()),
                role: ConversationRole::Assistant,
                text: "Persisted copy".to_string(),
                images: Some(vec![ConversationImageAttachment::Image {
                    url: "https://example.com/screenshot.png".to_string(),
                }]),
                is_streaming: false,
            })],
        );

        match &items[0] {
            ConversationItem::Message(message) => {
                assert_eq!(message.turn_id.as_deref(), Some("turn-image"));
                assert_eq!(
                    message.images,
                    Some(vec![ConversationImageAttachment::Image {
                        url: "https://example.com/screenshot.png".to_string(),
                    }])
                );
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn rich_text_fields_join_string_arrays_and_drop_empty_arrays() {
        let item = normalize_item(
            Some("turn-4"),
            &json!({
                "id": "reasoning-1",
                "type": "reasoning",
                "summary": ["First thought", "Second thought"],
                "content": []
            }),
        )
        .expect("reasoning should normalize");

        match item {
            ConversationItem::Reasoning(reasoning) => {
                assert_eq!(reasoning.turn_id.as_deref(), Some("turn-4"));
                assert_eq!(reasoning.summary, "First thought\n\nSecond thought");
                assert!(reasoning.content.is_empty());
            }
            _ => panic!("expected a reasoning item"),
        }
    }

    #[test]
    fn normalize_agent_message_hides_inter_agent_envelopes() {
        let item = normalize_item(
            Some("turn-5"),
            &json!({
                "id": "assistant-inter-agent",
                "type": "agentMessage",
                "text": inter_agent_control_message("/root/proofplan_investigator")
            }),
        );

        assert!(item.is_none());
    }

    #[test]
    fn normalize_agent_message_hides_subagent_notification_fragments() {
        let item = normalize_item(
            Some("turn-5"),
            &json!({
                "id": "assistant-subagent-notification",
                "type": "agentMessage",
                "text": "<subagent_notification>\n{\"agent_path\":\"/root/helper\",\"status\":{\"completed\":\"Done\"}}\n</subagent_notification>"
            }),
        );

        assert!(item.is_none());
    }

    #[test]
    fn hidden_assistant_control_prefix_detection_tolerates_whitespace() {
        assert!(is_hidden_assistant_control_message_prefix("{"));
        assert!(is_hidden_assistant_control_message_prefix("{   "));
        assert!(is_hidden_assistant_control_message_prefix("{   \"auth"));
        assert!(is_hidden_assistant_control_message_prefix(
            "{\n  \"author\" :"
        ));
        assert!(!is_hidden_assistant_control_message_prefix(
            "{\"assistant\":"
        ));
    }

    #[test]
    fn web_search_uses_query_as_summary_and_action_details_as_output() {
        let item = normalize_item(
            Some("turn-5"),
            &json!({
                "id": "search-1",
                "type": "webSearch",
                "query": "",
                "action": {
                    "type": "search",
                    "query": "Le Monde official homepage",
                    "queries": ["Le Monde official homepage", "lemonde.fr"]
                }
            }),
        )
        .expect("web search should normalize");

        match item {
            ConversationItem::Tool(tool) => {
                assert_eq!(tool.turn_id.as_deref(), Some("turn-5"));
                assert_eq!(tool.summary.as_deref(), Some("Le Monde official homepage"));
                assert!(tool.output.contains("Action: search"));
                assert!(tool.output.contains("lemonde.fr"));
            }
            _ => panic!("expected a tool item"),
        }
    }
}
