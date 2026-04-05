use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domain::conversation::{
    CollaborationModeOption, ConversationApprovalKind, ConversationComposerSettings,
    ConversationErrorSnapshot, ConversationInteraction, ConversationItem, ConversationItemStatus,
    ConversationMessageItem, ConversationReasoningItem, ConversationRole, ConversationStatus,
    ConversationSystemItem, ConversationTaskSnapshot, ConversationTaskStatus, ConversationTone,
    ConversationToolItem, FileSystemPermissionSnapshot, ModelOption,
    NetworkApprovalContextSnapshot, NetworkPermissionSnapshot, NetworkPolicyAmendmentSnapshot,
    NetworkPolicyRuleAction, PendingApprovalRequest, PendingUserInputOption,
    PendingUserInputQuestion, PendingUserInputRequest, PermissionProfileSnapshot,
    ProposedPlanSnapshot, ProposedPlanStatus, ProposedPlanStep, ProposedPlanStepStatus,
    SubagentStatus, SubagentThreadSnapshot, ThreadConversationSnapshot, ThreadTokenUsageSnapshot,
    TokenUsageBreakdown, UnsupportedInteractionRequest,
};
use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};
use crate::domain::workspace::CodexRateLimitSnapshot;
use crate::error::{AppError, AppResult};

pub const CONVERSATION_EVENT_NAME: &str = "threadex://conversation-event";
pub const CODEX_USAGE_EVENT_NAME: &str = "threadex://codex-usage-event";

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
    #[serde(rename = "turnId")]
    pub _turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningBoundaryNotification {
    pub thread_id: String,
    #[serde(rename = "turnId")]
    pub _turn_id: String,
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
    pub is_default: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOptionWire {
    pub reasoning_effort: ReasoningEffort,
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
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    pub experimental_api: bool,
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

pub fn initialize_params(version: &str) -> Value {
    json!(InitializeParams {
        client_info: ClientInfo {
            name: "ThreadEx".to_string(),
            version: version.to_string(),
        },
        capabilities: InitializeCapabilities {
            experimental_api: true,
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
            "developer_instructions": Value::Null,
        }
    })
}

pub fn user_input_payload(input: &OutgoingUserInputPayload) -> Value {
    let mut payload = vec![json!({
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
    })];

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
    let mut snapshot = ThreadConversationSnapshot::new(
        thread_id,
        environment_id,
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
            if let Some(normalized) = normalize_item(&item) {
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
    response
        .data
        .into_iter()
        .filter(|model| !model.hidden)
        .map(|model| ModelOption {
            id: model.id,
            display_name: model.display_name,
            description: model.description,
            default_reasoning_effort: model.default_reasoning_effort,
            supported_reasoning_efforts: model
                .supported_reasoning_efforts
                .into_iter()
                .map(|option| option.reasoning_effort)
                .collect(),
            is_default: model.is_default,
        })
        .collect()
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
            let spawn_data = (
                spawn.parent_thread_id.clone(),
                spawn.depth,
                spawn.agent_nickname.clone(),
                spawn.agent_role.clone(),
            );
            Some((
                thread,
                spawn_data.0,
                spawn_data.1,
                spawn_data.2,
                spawn_data.3,
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
                nickname: thread
                    .agent_nickname
                    .clone()
                    .or_else(|| spawn_nickname.clone()),
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
    let receiver_ids = value
        .get("receiverThreadIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let agent_states = value.get("agentsStates").and_then(Value::as_object);

    receiver_ids
        .into_iter()
        .map(|thread_id| {
            let state = agent_states.and_then(|states| states.get(thread_id.as_str()));
            let status = state
                .and_then(|state| state.get("status"))
                .and_then(Value::as_str)
                .map(subagent_status_from_collab_state)
                .unwrap_or(fallback_status);

            SubagentThreadSnapshot {
                thread_id,
                nickname: None,
                role: None,
                depth: 1,
                status,
            }
        })
        .collect()
}

pub fn item_status_from_wire(status: Option<&str>) -> ConversationItemStatus {
    match status {
        Some("completed") => ConversationItemStatus::Completed,
        Some("failed") => ConversationItemStatus::Failed,
        Some("declined") => ConversationItemStatus::Declined,
        _ => ConversationItemStatus::InProgress,
    }
}

pub fn normalize_item(value: &Value) -> Option<ConversationItem> {
    let id = value.get("id")?.as_str()?.to_string();
    let item_type = value.get("type")?.as_str()?;

    match item_type {
        "userMessage" => {
            let text = value
                .get("content")
                .and_then(Value::as_array)
                .map(|content| {
                    content
                        .iter()
                        .map(user_content_to_visible_text)
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if is_hidden_control_message(&text) {
                return None;
            }
            Some(ConversationItem::Message(ConversationMessageItem {
                id,
                role: ConversationRole::User,
                text,
                is_streaming: false,
            }))
        }
        "agentMessage" => Some(ConversationItem::Message(ConversationMessageItem {
            id,
            role: ConversationRole::Assistant,
            text: string_field(value, "text"),
            is_streaming: false,
        })),
        "plan" => None,
        "reasoning" => Some(ConversationItem::Reasoning(ConversationReasoningItem {
            id,
            summary: rich_text_field(value, "summary"),
            content: rich_text_field(value, "content"),
            is_streaming: false,
        })),
        "commandExecution" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
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
            tool_type: "webSearch".to_string(),
            title: "Web search".to_string(),
            status: ConversationItemStatus::Completed,
            summary: web_search_summary(value),
            output: web_search_output(value),
        })),
        "imageView" => Some(ConversationItem::Tool(ConversationToolItem {
            id,
            tool_type: "imageView".to_string(),
            title: "Image view".to_string(),
            status: ConversationItemStatus::Completed,
            summary: Some(string_field(value, "path")),
            output: String::new(),
        })),
        "enteredReviewMode" => Some(ConversationItem::System(ConversationSystemItem {
            id,
            tone: ConversationTone::Info,
            title: "Review mode".to_string(),
            body: format!("Entered review mode for {}", string_field(value, "review")),
        })),
        "exitedReviewMode" => Some(ConversationItem::System(ConversationSystemItem {
            id,
            tone: ConversationTone::Info,
            title: "Review complete".to_string(),
            body: string_field(value, "review"),
        })),
        "contextCompaction" => Some(ConversationItem::System(ConversationSystemItem {
            id,
            tone: ConversationTone::Info,
            title: "Context compacted".to_string(),
            body: "Codex compacted the conversation history.".to_string(),
        })),
        other => Some(ConversationItem::System(ConversationSystemItem {
            id,
            tone: ConversationTone::Info,
            title: "Unsupported item".to_string(),
            body: format!("ThreadEx recorded the `{other}` item without a dedicated renderer."),
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
                        "`{}` is visible in ThreadEx, but responding to it is part of the next milestone.",
                        request.method
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

pub fn append_agent_delta(items: &mut Vec<ConversationItem>, item_id: &str, delta: &str) {
    match find_message_mut(items, item_id, ConversationRole::Assistant) {
        Some(item) => {
            item.text.push_str(delta);
            item.is_streaming = true;
        }
        None => items.push(ConversationItem::Message(ConversationMessageItem {
            id: item_id.to_string(),
            role: ConversationRole::Assistant,
            text: delta.to_string(),
            is_streaming: true,
        })),
    }
}

pub fn append_reasoning_summary(items: &mut Vec<ConversationItem>, item_id: &str, delta: &str) {
    match find_reasoning_mut(items, item_id) {
        Some(item) => {
            item.summary.push_str(delta);
            item.is_streaming = true;
        }
        None => items.push(ConversationItem::Reasoning(ConversationReasoningItem {
            id: item_id.to_string(),
            summary: delta.to_string(),
            content: String::new(),
            is_streaming: true,
        })),
    }
}

pub fn append_reasoning_boundary(items: &mut [ConversationItem], item_id: &str) {
    if let Some(item) = find_reasoning_mut(items, item_id) {
        if !item.summary.is_empty() && !item.summary.ends_with("\n\n") {
            item.summary.push_str("\n\n");
        }
        item.is_streaming = true;
    }
}

pub fn append_reasoning_content(items: &mut Vec<ConversationItem>, item_id: &str, delta: &str) {
    match find_reasoning_mut(items, item_id) {
        Some(item) => {
            item.content.push_str(delta);
            item.is_streaming = true;
        }
        None => items.push(ConversationItem::Reasoning(ConversationReasoningItem {
            id: item_id.to_string(),
            summary: String::new(),
            content: delta.to_string(),
            is_streaming: true,
        })),
    }
}

pub fn append_tool_output(items: &mut [ConversationItem], item_id: &str, delta: &str) {
    if let Some(item) = find_tool_mut(items, item_id) {
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
            role: incoming_message.role,
            text: if incoming_message.text.is_empty() {
                existing_message.text
            } else {
                incoming_message.text
            },
            is_streaming: incoming_message.is_streaming,
        }),
        (ConversationItem::Tool(existing_tool), ConversationItem::Tool(incoming_tool)) => {
            ConversationItem::Tool(ConversationToolItem {
                id: incoming_tool.id,
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
        Some("image") | Some("localImage") => "[Image]".to_string(),
        Some("mention") | Some("skill") => String::new(),
        _ => String::new(),
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

fn is_hidden_control_message(text: &str) -> bool {
    text == plan_approval_message()
}

fn thread_spawn_source(source: &Value) -> Option<ThreadSpawnSourceWire> {
    let subagent = source.get("subAgent")?;
    let thread_spawn = subagent
        .get("thread_spawn")
        .or_else(|| subagent.get("threadSpawn"))?;

    serde_json::from_value::<ThreadSpawnSourceWire>(thread_spawn.clone()).ok()
}

fn subagent_status_from_thread_status(status: &ThreadStatusWire) -> SubagentStatus {
    match status.kind.as_str() {
        "active" => SubagentStatus::Running,
        "systemError" => SubagentStatus::Failed,
        _ => SubagentStatus::Completed,
    }
}

fn subagent_status_from_collab_state(status: &str) -> SubagentStatus {
    match status {
        "pendingInit" | "running" => SubagentStatus::Running,
        "errored" | "interrupted" | "notFound" => SubagentStatus::Failed,
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
        )
    })
}

fn find_message_mut<'a>(
    items: &'a mut [ConversationItem],
    item_id: &str,
    role: ConversationRole,
) -> Option<&'a mut ConversationMessageItem> {
    items.iter_mut().find_map(|item| match item {
        ConversationItem::Message(message) if message.id == item_id && message.role == role => {
            Some(message)
        }
        _ => None,
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

    #[test]
    fn normalize_user_message_joins_visible_content() {
        let item = normalize_item(&json!({
            "id": "user-1",
            "type": "userMessage",
            "content": [
                { "type": "text", "text": "Hello" },
                { "type": "image", "url": "https://example.com" }
            ]
        }))
        .expect("item should normalize");

        match item {
            ConversationItem::Message(message) => {
                assert_eq!(message.role, ConversationRole::User);
                assert_eq!(message.text, "Hello[Image]");
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn normalize_user_message_replaces_text_elements_and_hides_structured_mentions() {
        let item = normalize_item(&json!({
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
                { "type": "skill", "name": "threadex-standards", "path": "/tmp/skill" },
                { "type": "mention", "name": "github", "path": "app://github" }
            ]
        }))
        .expect("item should normalize");

        match item {
            ConversationItem::Message(message) => {
                assert_eq!(message.text, "/prompts:debug(\"boom\")");
            }
            _ => panic!("expected a message item"),
        }
    }

    #[test]
    fn collaboration_mode_payload_maps_build_to_default_mode() {
        let payload = collaboration_mode_payload(&ConversationComposerSettings {
            model: "gpt-5.4".to_string(),
            reasoning_effort: ReasoningEffort::High,
            collaboration_mode: CollaborationMode::Build,
            approval_policy: ApprovalPolicy::AskToEdit,
        });

        assert_eq!(payload["mode"], "default");
        assert_eq!(payload["settings"]["reasoning_effort"], "high");
        assert!(payload["settings"]["developer_instructions"].is_null());
    }

    #[test]
    fn append_reasoning_boundary_inserts_visual_gap() {
        let mut items = vec![ConversationItem::Reasoning(ConversationReasoningItem {
            id: "reasoning-1".to_string(),
            summary: "Exploring files".to_string(),
            content: String::new(),
            is_streaming: true,
        })];
        append_reasoning_boundary(&mut items, "reasoning-1");
        append_reasoning_summary(&mut items, "reasoning-1", "Searching routes");

        match &items[0] {
            ConversationItem::Reasoning(reasoning) => {
                assert_eq!(reasoning.summary, "Exploring files\n\nSearching routes");
            }
            _ => panic!("expected reasoning item"),
        }
    }

    #[test]
    fn canonical_user_message_replaces_matching_optimistic_entry() {
        let mut items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "local-user-1".to_string(),
            role: ConversationRole::User,
            text: "Salut".to_string(),
            is_streaming: false,
        })];

        upsert_item(
            &mut items,
            ConversationItem::Message(ConversationMessageItem {
                id: "user-1".to_string(),
                role: ConversationRole::User,
                text: "Salut".to_string(),
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
    fn rich_text_fields_join_string_arrays_and_drop_empty_arrays() {
        let item = normalize_item(&json!({
            "id": "reasoning-1",
            "type": "reasoning",
            "summary": ["First thought", "Second thought"],
            "content": []
        }))
        .expect("reasoning should normalize");

        match item {
            ConversationItem::Reasoning(reasoning) => {
                assert_eq!(reasoning.summary, "First thought\n\nSecond thought");
                assert!(reasoning.content.is_empty());
            }
            _ => panic!("expected a reasoning item"),
        }
    }

    #[test]
    fn web_search_uses_query_as_summary_and_action_details_as_output() {
        let item = normalize_item(&json!({
            "id": "search-1",
            "type": "webSearch",
            "query": "",
            "action": {
                "type": "search",
                "query": "Le Monde official homepage",
                "queries": ["Le Monde official homepage", "lemonde.fr"]
            }
        }))
        .expect("web search should normalize");

        match item {
            ConversationItem::Tool(tool) => {
                assert_eq!(tool.summary.as_deref(), Some("Le Monde official homepage"));
                assert!(tool.output.contains("Action: search"));
                assert!(tool.output.contains("lemonde.fr"));
            }
            _ => panic!("expected a tool item"),
        }
    }
}
