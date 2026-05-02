use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use tracing::{error, warn};
use uuid::Uuid;

use crate::domain::conversation::{
    ApprovalResponseInput, CommandApprovalDecisionInput, ComposerMentionBindingInput,
    ConversationEventPayload, ConversationImageAttachment, ConversationInteraction,
    ConversationItem, ConversationMessageItem, ConversationRole, ConversationStatus,
    ConversationTaskStatus, EnvironmentCapabilitiesSnapshot, FileChangeApprovalDecisionInput,
    InputModality, PermissionGrantScope, PermissionsApprovalDecisionInput, PlanDecisionAction,
    ProposedPlanSnapshot, ProposedPlanStatus, ProviderOption, RespondToUserInputRequestInput,
    SubagentStatus, SubmitPlanDecisionInput, ThreadComposerCatalog, ThreadConversationOpenResponse,
    ThreadConversationSnapshot,
};
use crate::domain::settings::{CollaborationMode, ProviderKind, ServiceTier};
use crate::domain::voice::VoiceAuthMode;
use crate::domain::workspace::CodexRateLimitSnapshot;
use crate::error::{AppError, AppResult};
use crate::events::EventSink;
use crate::runtime::claude::append_claude_provider;
use crate::runtime::codex_paths::build_codex_process_path;
use crate::runtime::proposed_plan_markup::{
    extract_proposed_plan_text, strip_proposed_plan_blocks,
};
use crate::runtime::protocol::{
    append_agent_delta, append_plan_delta, append_reasoning_boundary, append_reasoning_content,
    append_reasoning_summary, append_task_plan_delta, append_tool_output, approval_policy_value,
    approvals_reviewer_value, build_history_snapshot, clear_streaming_flags,
    collaboration_mode_from_plan_item_heading, collaboration_mode_options_from_response,
    collaboration_mode_payload, complete_proposed_plan, complete_task_plan,
    conversation_status_from_turn_status, error_snapshot, initialize_params,
    initialized_notification, is_hidden_assistant_control_item,
    is_hidden_assistant_control_message, is_hidden_assistant_control_message_prefix,
    loaded_subagents_for_primary, mark_plan_approved, mark_plan_superseded, merge_persisted_items,
    model_options_from_response, normalize_auto_approval_review_notification, normalize_item,
    normalize_server_interaction, parse_incoming_message, plan_approval_message,
    proposed_plan_from_item, proposed_plan_from_turn_update, reconcile_snapshot_status,
    sandbox_policy_value, subagent_thread_start_from_thread, subagents_from_collab_item,
    task_plan_from_item, task_plan_from_turn_update, task_status_from_turn_status,
    token_usage_snapshot, upsert_item, user_input_payload, AccountRateLimitsReadResponse,
    AccountReadResponse, AppInfoWire, AppsListResponse, CollaborationModeListResponse,
    ErrorNotification, FuzzyFileSearchMatchTypeWire, FuzzyFileSearchResponse, IncomingMessage,
    ItemDeltaNotification, ItemNotification, ModelListResponse, OutgoingNamedInput,
    OutgoingTextElement, OutgoingUserInputPayload, PlanDeltaNotification,
    ReasoningBoundaryNotification, SkillsListResponse, ThreadListResponse,
    ThreadLoadedListResponse, ThreadMetadataReadResponse, ThreadReadResponse, ThreadStartResponse,
    ThreadStatusChangedNotification, TokenUsageNotification, TurnCompletedNotification,
    TurnPlanUpdatedNotification, TurnResponse, TurnStartedNotification, AGENT_MESSAGE_DELTA_METHOD,
    CONVERSATION_EVENT_NAME,
};
use crate::runtime::supervisor::RuntimeUsageUpdate;
use crate::runtime::{item_store, snapshot_store};
use crate::services::composer::{
    build_thread_catalog, connector_mention_slug, load_prompt_definitions, resolve_composer_text,
    trim_file_search_results, AppBinding, SkillBinding,
};
use crate::services::workspace::ThreadRuntimeContext;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const INITIALIZE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const SNAPSHOT_EMIT_DEBOUNCE: Duration = Duration::from_millis(120);

pub(crate) fn multi_agent_nudge_text(max_subagents: u8) -> String {
    format!(
        "Additional instruction: if it would improve quality or speed, proactively use sub-agents instead of waiting to be asked. You may spawn up to {max_subagents} sub-agents for parallelizable or well-scoped work, but only when they add clear value."
    )
}

type PendingRequestMap = Arc<Mutex<HashMap<u64, oneshot::Sender<AppResult<serde_json::Value>>>>>;
type SharedWriter = Arc<Mutex<Box<dyn AsyncWrite + Send + Unpin>>>;

struct SessionTransport<R, E>
where
    R: AsyncRead + Unpin + Send + 'static,
    E: AsyncRead + Unpin + Send + 'static,
{
    writer: Box<dyn AsyncWrite + Send + Unpin>,
    reader: R,
    stderr_reader: E,
    child: Option<Arc<Mutex<Child>>>,
}

struct SessionState {
    snapshots_by_thread: HashMap<String, ThreadConversationSnapshot>,
    local_thread_by_codex_id: HashMap<String, String>,
    capabilities: Option<EnvironmentCapabilitiesSnapshot>,
    buffered_assistant_control_deltas: HashMap<String, BufferedAssistantControlDelta>,
    raw_agent_message_text_by_item: HashMap<String, String>,
    pending_server_requests: HashMap<String, PendingServerRequest>,
    turn_modes_by_id: HashMap<String, CollaborationMode>,
    pending_turn_mode_by_thread: HashMap<String, CollaborationMode>,
    subagent_metadata_by_codex_thread_id: HashMap<String, SubagentMetadata>,
    stream_assistant_responses: bool,
}

#[derive(Debug, Clone, Default)]
struct SubagentMetadata {
    parent_thread_id: Option<String>,
    nickname: Option<String>,
    role: Option<String>,
    depth: Option<i32>,
}

#[derive(Debug, Clone)]
struct BufferedAssistantControlDelta {
    text: String,
}

#[derive(Debug, Clone)]
struct PendingServerRequest {
    json_rpc_id: serde_json::Value,
    thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SnapshotEmitSignature {
    status: ConversationStatus,
    active_turn_id: Option<String>,
    item_count: usize,
    last_item_id: Option<String>,
    last_item_is_streaming: bool,
    pending_interaction_count: usize,
    proposed_plan_status: Option<ProposedPlanStatus>,
    proposed_plan_awaiting_decision: bool,
    task_plan_status: Option<ConversationTaskStatus>,
    task_plan_step_count: usize,
    subagent_count: usize,
    running_subagent_count: usize,
    subagent_identity: Vec<SubagentIdentitySignature>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubagentIdentitySignature {
    thread_id: String,
    nickname: Option<String>,
    role: Option<String>,
    status: SubagentStatus,
}

#[derive(Default)]
struct BufferedSnapshotEmit {
    last_emitted_signature: Option<SnapshotEmitSignature>,
    latest_snapshot: Option<ThreadConversationSnapshot>,
    scheduled: bool,
}

enum BufferedSnapshotEmitAction {
    EmitNow,
    ScheduleFlush,
    Buffered,
}

static SNAPSHOT_EMIT_STATE: OnceLock<Mutex<HashMap<String, BufferedSnapshotEmit>>> =
    OnceLock::new();

impl Default for SessionState {
    fn default() -> Self {
        Self {
            snapshots_by_thread: HashMap::new(),
            local_thread_by_codex_id: HashMap::new(),
            capabilities: None,
            buffered_assistant_control_deltas: HashMap::new(),
            raw_agent_message_text_by_item: HashMap::new(),
            pending_server_requests: HashMap::new(),
            turn_modes_by_id: HashMap::new(),
            pending_turn_mode_by_thread: HashMap::new(),
            subagent_metadata_by_codex_thread_id: HashMap::new(),
            stream_assistant_responses: true,
        }
    }
}

impl SnapshotEmitSignature {
    fn from_snapshot(snapshot: &ThreadConversationSnapshot) -> Self {
        let last_item = snapshot.items.last();
        Self {
            status: snapshot.status,
            active_turn_id: snapshot.active_turn_id.clone(),
            item_count: snapshot.items.len(),
            last_item_id: last_item.map(|item| item.id().to_string()),
            last_item_is_streaming: last_item.is_some_and(conversation_item_is_streaming),
            pending_interaction_count: snapshot.pending_interactions.len(),
            proposed_plan_status: snapshot.proposed_plan.as_ref().map(|plan| plan.status),
            proposed_plan_awaiting_decision: snapshot
                .proposed_plan
                .as_ref()
                .is_some_and(|plan| plan.is_awaiting_decision),
            task_plan_status: snapshot.task_plan.as_ref().map(|task| task.status),
            task_plan_step_count: snapshot
                .task_plan
                .as_ref()
                .map_or(0, |task| task.steps.len()),
            subagent_count: snapshot.subagents.len(),
            running_subagent_count: snapshot
                .subagents
                .iter()
                .filter(|subagent| matches!(subagent.status, SubagentStatus::Running))
                .count(),
            subagent_identity: snapshot
                .subagents
                .iter()
                .map(|subagent| SubagentIdentitySignature {
                    thread_id: subagent.thread_id.clone(),
                    nickname: subagent.nickname.clone(),
                    role: subagent.role.clone(),
                    status: subagent.status,
                })
                .collect(),
            error_message: snapshot.error.as_ref().map(|error| error.message.clone()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SendMessageResult {
    pub snapshot: ThreadConversationSnapshot,
    pub new_provider_thread_id: Option<String>,
    pub new_codex_thread_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerAuthStatus {
    pub auth_method: Option<VoiceAuthMode>,
    pub auth_token: Option<String>,
    pub requires_openai_auth: Option<bool>,
}

#[derive(Debug, Clone)]
struct UsageUpdateContext {
    environment_path: String,
    codex_binary_path: Option<String>,
}

pub struct RuntimeSession {
    events: EventSink,
    environment_id: String,
    writer: SharedWriter,
    child: Option<Arc<Mutex<Child>>>,
    pending: PendingRequestMap,
    state: Arc<Mutex<SessionState>>,
    next_request_id: AtomicU64,
    stdout_task: Mutex<Option<JoinHandle<()>>>,
    stderr_task: Mutex<Option<JoinHandle<()>>>,
}

impl RuntimeSession {
    pub async fn spawn(
        events: EventSink,
        environment_id: String,
        environment_path: String,
        binary_path: String,
        app_version: String,
        stream_assistant_responses: bool,
        usage_updates: mpsc::UnboundedSender<RuntimeUsageUpdate>,
    ) -> AppResult<Self> {
        Self::spawn_with_app(
            events,
            environment_id,
            environment_path,
            binary_path,
            app_version,
            stream_assistant_responses,
            Some(usage_updates),
        )
        .await
    }

    pub async fn spawn_headless(
        environment_id: String,
        environment_path: String,
        binary_path: String,
        app_version: String,
        stream_assistant_responses: bool,
    ) -> AppResult<Self> {
        Self::spawn_with_app(
            EventSink::noop(),
            environment_id,
            environment_path,
            binary_path,
            app_version,
            stream_assistant_responses,
            None,
        )
        .await
    }

    async fn spawn_with_app(
        events: EventSink,
        environment_id: String,
        environment_path: String,
        binary_path: String,
        app_version: String,
        stream_assistant_responses: bool,
        usage_updates: Option<mpsc::UnboundedSender<RuntimeUsageUpdate>>,
    ) -> AppResult<Self> {
        let mut command = Command::new(&binary_path);
        command.arg("app-server");
        command
            .current_dir(&environment_path)
            .env("PATH", build_codex_process_path(&binary_path))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = command.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| {
            AppError::Runtime("Codex app-server stdin is unavailable.".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::Runtime("Codex app-server stdout is unavailable.".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::Runtime("Codex app-server stderr is unavailable.".to_string())
        })?;

        Self::from_transport(
            events,
            environment_id,
            UsageUpdateContext {
                environment_path: environment_path.clone(),
                codex_binary_path: Some(binary_path.clone()),
            },
            app_version,
            stream_assistant_responses,
            usage_updates,
            SessionTransport {
                writer: Box::new(stdin),
                reader: stdout,
                stderr_reader: stderr,
                child: Some(Arc::new(Mutex::new(child))),
            },
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn from_test_transport<R, W>(
        environment_id: String,
        environment_path: String,
        app_version: String,
        stream_assistant_responses: bool,
        writer: W,
        reader: R,
    ) -> AppResult<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::from_transport(
            EventSink::noop(),
            environment_id,
            UsageUpdateContext {
                environment_path,
                codex_binary_path: None,
            },
            app_version,
            stream_assistant_responses,
            None,
            SessionTransport {
                writer: Box::new(writer),
                reader,
                stderr_reader: tokio::io::empty(),
                child: None,
            },
        )
        .await
    }

    #[cfg(test)]
    pub(crate) fn from_snapshot_for_test(snapshot: ThreadConversationSnapshot) -> Self {
        Self {
            events: EventSink::noop(),
            environment_id: snapshot.environment_id.clone(),
            writer: Arc::new(Mutex::new(Box::new(tokio::io::sink()))),
            child: None,
            pending: Arc::new(Mutex::new(HashMap::new())),
            state: Arc::new(Mutex::new(SessionState {
                snapshots_by_thread: HashMap::from([(snapshot.thread_id.clone(), snapshot)]),
                local_thread_by_codex_id: HashMap::new(),
                capabilities: None,
                buffered_assistant_control_deltas: HashMap::new(),
                raw_agent_message_text_by_item: HashMap::new(),
                pending_server_requests: HashMap::new(),
                turn_modes_by_id: HashMap::new(),
                pending_turn_mode_by_thread: HashMap::new(),
                subagent_metadata_by_codex_thread_id: HashMap::new(),
                stream_assistant_responses: true,
            })),
            next_request_id: AtomicU64::new(1),
            stdout_task: Mutex::new(None),
            stderr_task: Mutex::new(None),
        }
    }

    async fn from_transport<R, E>(
        events: EventSink,
        environment_id: String,
        usage_update_context: UsageUpdateContext,
        app_version: String,
        stream_assistant_responses: bool,
        usage_updates: Option<mpsc::UnboundedSender<RuntimeUsageUpdate>>,
        transport: SessionTransport<R, E>,
    ) -> AppResult<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        E: AsyncRead + Unpin + Send + 'static,
    {
        let writer = Arc::new(Mutex::new(transport.writer));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let state = Arc::new(Mutex::new(SessionState {
            stream_assistant_responses,
            ..SessionState::default()
        }));

        let stdout_task = spawn_stdout_task(
            events.clone(),
            environment_id.clone(),
            usage_update_context,
            pending.clone(),
            state.clone(),
            usage_updates,
            transport.reader,
        );
        let stderr_task = spawn_stderr_task(environment_id.clone(), transport.stderr_reader);

        let session = Self {
            events,
            environment_id,
            writer,
            child: transport.child,
            pending,
            state,
            next_request_id: AtomicU64::new(1),
            stdout_task: Mutex::new(Some(stdout_task)),
            stderr_task: Mutex::new(Some(stderr_task)),
        };

        if let Err(error) = session
            .send_request(
                "initialize",
                initialize_params(&app_version, stream_assistant_responses),
            )
            .await
        {
            let _ = session.stop().await;
            return Err(error);
        }
        if let Err(error) = session
            .send_notification("initialized", initialized_notification())
            .await
        {
            let _ = session.stop().await;
            return Err(error);
        }
        Ok(session)
    }

    pub async fn open_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationOpenResponse> {
        let capabilities = self.ensure_capabilities().await?;

        let existing_snapshot = {
            let mut state = self.state.lock().await;
            if let Some(snapshot) = state.snapshots_by_thread.get_mut(&context.thread_id) {
                snapshot.composer = context.composer.clone();
                snapshot.codex_thread_id = context.codex_thread_id.clone();
                let active_turn_mode = snapshot.active_turn_id.as_deref().map(|turn_id| {
                    snapshot_mode_for_turn(snapshot, turn_id, context.composer.collaboration_mode)
                });
                let active_turn_id = snapshot.active_turn_id.clone();
                let snapshot_clone = snapshot.clone();
                if let (Some(active_turn_id), Some(active_turn_mode)) =
                    (active_turn_id, active_turn_mode)
                {
                    state
                        .turn_modes_by_id
                        .entry(active_turn_id)
                        .or_insert(active_turn_mode);
                }
                if let Some(codex_thread_id) = context.codex_thread_id.as_ref() {
                    state
                        .local_thread_by_codex_id
                        .insert(codex_thread_id.clone(), context.thread_id.clone());
                }
                Some(snapshot_clone)
            } else {
                None
            }
        };

        if let Some(snapshot) = existing_snapshot {
            let snapshot = self
                .refresh_thread_metadata(context.clone(), Some(snapshot))
                .await?;
            return Ok(ThreadConversationOpenResponse {
                snapshot,
                capabilities,
                composer_draft: None,
            });
        }

        let snapshot = match context.codex_thread_id.clone() {
            Some(codex_thread_id) => {
                let read_response = self
                    .request_typed::<ThreadReadResponse>(
                        "thread/read",
                        serde_json::json!({
                            "threadId": codex_thread_id,
                            "includeTurns": true
                        }),
                    )
                    .await?;
                let mut snapshot = build_history_snapshot(
                    context.thread_id.clone(),
                    context.environment_id.clone(),
                    Some(codex_thread_id.clone()),
                    context.composer.clone(),
                    read_response.thread,
                );
                let persisted = item_store::load(&context.thread_id);
                merge_persisted_items(&mut snapshot.items, persisted);
                self.send_request(
                    "thread/resume",
                    serde_json::json!({
                        "threadId": codex_thread_id,
                        "cwd": context.environment_path
                    }),
                )
                .await?;

                let mut state = self.state.lock().await;
                state
                    .local_thread_by_codex_id
                    .insert(codex_thread_id, context.thread_id.clone());
                if let Some(active_turn_id) = snapshot.active_turn_id.clone() {
                    let active_turn_mode = snapshot_mode_for_turn(
                        &snapshot,
                        &active_turn_id,
                        context.composer.collaboration_mode,
                    );
                    state
                        .turn_modes_by_id
                        .insert(active_turn_id, active_turn_mode);
                }
                state
                    .snapshots_by_thread
                    .insert(context.thread_id.clone(), snapshot.clone());
                snapshot
            }
            None => {
                let mut snapshot = ThreadConversationSnapshot::new(
                    context.thread_id.clone(),
                    context.environment_id.clone(),
                    None,
                    context.composer.clone(),
                );
                snapshot.items = imported_handoff_items(&context);
                self.state
                    .lock()
                    .await
                    .snapshots_by_thread
                    .insert(context.thread_id.clone(), snapshot.clone());
                snapshot
            }
        };

        let snapshot = self
            .refresh_thread_metadata(context, Some(snapshot))
            .await?;

        Ok(ThreadConversationOpenResponse {
            snapshot,
            capabilities,
            composer_draft: None,
        })
    }

    pub async fn cached_thread_snapshot(
        &self,
        context: &ThreadRuntimeContext,
    ) -> Option<ThreadConversationSnapshot> {
        self.state
            .lock()
            .await
            .snapshots_by_thread
            .get(&context.thread_id)
            .cloned()
            .map(|mut snapshot| {
                snapshot.environment_id = context.environment_id.clone();
                snapshot.provider = context.provider;
                snapshot.provider_thread_id = context.provider_thread_id.clone();
                snapshot.codex_thread_id = context.codex_thread_id.clone();
                snapshot.composer = context.composer.clone();
                snapshot
            })
    }

    pub async fn read_capabilities(&self) -> AppResult<EnvironmentCapabilitiesSnapshot> {
        self.load_capabilities(true).await
    }

    pub async fn refresh_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        self.refresh_thread_metadata(context, None).await
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn send_message(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        images: Vec<ConversationImageAttachment>,
    ) -> AppResult<SendMessageResult> {
        self.send_message_with_bindings(context, text, images, Vec::new())
            .await
    }

    pub async fn send_message_with_bindings(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        images: Vec<ConversationImageAttachment>,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        self.send_message_with_visibility(context, text, images, true, mention_bindings)
            .await
    }

    pub async fn respond_to_approval_request(
        &self,
        thread_id: &str,
        interaction_id: &str,
        response: ApprovalResponseInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        let payload = approval_response_payload(response)?;
        let pending = self
            .take_pending_server_request(thread_id, interaction_id)
            .await?;
        if let Err(error) = self
            .send_server_response(pending.json_rpc_id.clone(), payload)
            .await
        {
            self.restore_pending_server_request(interaction_id, pending)
                .await;
            return Err(error);
        }
        self.complete_interaction(thread_id, interaction_id).await
    }

    pub async fn respond_to_user_input_request(
        &self,
        input: RespondToUserInputRequestInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        if input.answers.is_empty() {
            return Err(AppError::Validation(
                "At least one answer is required to continue.".to_string(),
            ));
        }

        let pending = self
            .take_pending_server_request(&input.thread_id, &input.interaction_id)
            .await?;

        let answers = input
            .answers
            .into_iter()
            .map(|(question_id, answers)| {
                (
                    question_id,
                    serde_json::json!({
                        "answers": answers
                    }),
                )
            })
            .collect::<serde_json::Map<String, serde_json::Value>>();
        if let Err(error) = self
            .send_server_response(
                pending.json_rpc_id.clone(),
                serde_json::json!({ "answers": answers }),
            )
            .await
        {
            self.restore_pending_server_request(&input.interaction_id, pending)
                .await;
            return Err(error);
        }
        self.complete_interaction(&input.thread_id, &input.interaction_id)
            .await
    }

    pub async fn submit_plan_decision(
        &self,
        mut context: ThreadRuntimeContext,
        input: SubmitPlanDecisionInput,
    ) -> AppResult<SendMessageResult> {
        if let Some(composer) = input.composer {
            context.composer = composer;
        }

        match input.action {
            PlanDecisionAction::Approve => {
                let thread_id = context.thread_id.clone();
                self.take_pending_plan_decision(&thread_id).await?;
                context.composer.collaboration_mode = CollaborationMode::Build;
                let mut result = match self
                    .send_message_with_visibility(
                        context,
                        plan_approval_message().to_string(),
                        Vec::new(),
                        false,
                        Vec::new(),
                    )
                    .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        self.restore_pending_plan_decision(&thread_id).await;
                        return Err(error);
                    }
                };
                self.mark_plan_state(&result.snapshot.thread_id, mark_plan_approved)
                    .await?;
                result.snapshot = self
                    .push_system_item(
                        &result.snapshot.thread_id,
                        "Plan approved",
                        "Skein approved the current plan and switched the thread to Build mode.",
                    )
                    .await?;
                Ok(result)
            }
            PlanDecisionAction::Refine => {
                let feedback = input.feedback.unwrap_or_default();
                let trimmed = feedback.trim();
                if trimmed.is_empty() {
                    return Err(AppError::Validation(
                        "Add refinement guidance before asking Codex to revise the plan."
                            .to_string(),
                    ));
                }
                let thread_id = context.thread_id.clone();
                self.take_pending_plan_decision(&thread_id).await?;
                let mut result = match self
                    .send_message_with_visibility(
                        context,
                        trimmed.to_string(),
                        input.images.unwrap_or_default(),
                        true,
                        input.mention_bindings.unwrap_or_default(),
                    )
                    .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        self.restore_pending_plan_decision(&thread_id).await;
                        return Err(error);
                    }
                };
                result.snapshot = self
                    .mark_plan_state(&result.snapshot.thread_id, mark_plan_superseded)
                    .await?;
                Ok(result)
            }
        }
    }

    pub async fn interrupt_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        let snapshot = self
            .state
            .lock()
            .await
            .snapshots_by_thread
            .get(&context.thread_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Thread conversation is not open.".to_string()))?;

        let Some(codex_thread_id) = snapshot.codex_thread_id.clone() else {
            return Ok(snapshot);
        };
        let Some(active_turn_id) = snapshot.active_turn_id.clone() else {
            return Ok(snapshot);
        };

        self.send_request(
            "turn/interrupt",
            serde_json::json!({
                "threadId": codex_thread_id,
                "turnId": active_turn_id
            }),
        )
        .await?;

        let updated = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(&context.thread_id)
                .ok_or_else(|| {
                    AppError::Runtime("Conversation snapshot disappeared unexpectedly.".to_string())
                })?;
            snapshot.active_turn_id = None;
            snapshot.subagents.clear();
            snapshot.status = ConversationStatus::Interrupted;
            clear_streaming_flags(&mut snapshot.items);
            snapshot.clone()
        };
        self.emit_snapshot(&updated);
        Ok(updated)
    }

    pub async fn stop(&self) -> AppResult<()> {
        if let Some(child) = self.child.as_ref() {
            let mut child = child.lock().await;
            let _ = child.kill().await;
        }

        if let Some(handle) = self.stdout_task.lock().await.take() {
            handle.abort();
        }
        if let Some(handle) = self.stderr_task.lock().await.take() {
            handle.abort();
        }

        let mut pending = self.pending.lock().await;
        for sender in pending.drain().map(|(_, sender)| sender) {
            let _ = sender.send(Err(AppError::Runtime(
                "Codex runtime stopped before the request completed.".to_string(),
            )));
        }
        let thread_ids = {
            let mut state = self.state.lock().await;
            let thread_ids = state
                .snapshots_by_thread
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            state.pending_server_requests.clear();
            state.turn_modes_by_id.clear();
            state.pending_turn_mode_by_thread.clear();
            thread_ids
        };
        clear_buffered_snapshot_emits(&thread_ids).await;
        Ok(())
    }

    pub async fn try_wait(&self) -> AppResult<Option<i32>> {
        let Some(child) = self.child.as_ref() else {
            return Ok(None);
        };

        let mut child = child.lock().await;
        Ok(child.try_wait()?.and_then(|status| status.code()))
    }

    pub async fn pid(&self) -> Option<u32> {
        let child = self.child.as_ref()?;
        child.lock().await.id()
    }

    pub async fn has_pending_requests(&self) -> bool {
        !self.pending.lock().await.is_empty()
    }

    pub async fn has_keep_alive_work(&self) -> bool {
        let state = self.state.lock().await;
        state
            .snapshots_by_thread
            .values()
            .any(snapshot_has_runtime_work)
    }

    pub async fn read_account_rate_limits(&self) -> AppResult<CodexRateLimitSnapshot> {
        Ok(self
            .request_typed::<AccountRateLimitsReadResponse>(
                "account/rateLimits/read",
                serde_json::json!({}),
            )
            .await?
            .rate_limits)
    }

    pub async fn read_account(&self, refresh_token: bool) -> AppResult<AccountReadResponse> {
        self.request_typed::<AccountReadResponse>(
            "account/read",
            serde_json::json!({
                "refreshToken": refresh_token,
            }),
        )
        .await
    }

    pub async fn read_auth_status(
        &self,
        include_token: bool,
        refresh_token: bool,
    ) -> AppResult<AppServerAuthStatus> {
        self.request_typed::<AppServerAuthStatus>(
            "getAuthStatus",
            serde_json::json!({
                "includeToken": include_token,
                "refreshToken": refresh_token
            }),
        )
        .await
    }

    pub async fn composer_catalog(
        &self,
        environment_path: &str,
        codex_thread_id: Option<&str>,
    ) -> AppResult<ThreadComposerCatalog> {
        let prompts = load_prompt_definitions(environment_path)?;
        let skills = self.load_skill_bindings(environment_path).await?;
        let apps = if codex_thread_id.is_some() {
            self.load_app_bindings(codex_thread_id).await?
        } else {
            Vec::new()
        };
        Ok(build_thread_catalog(&prompts, &skills, &apps))
    }

    pub async fn search_files(
        &self,
        environment_path: &str,
        cancellation_token: &str,
        query: String,
        limit: usize,
    ) -> AppResult<Vec<crate::domain::conversation::ComposerFileSearchResult>> {
        let response = self
            .request_typed::<FuzzyFileSearchResponse>(
                "fuzzyFileSearch",
                serde_json::json!({
                    "query": query,
                    "roots": [environment_path],
                    "cancellationToken": cancellation_token,
                }),
            )
            .await?;
        let paths = response
            .files
            .into_iter()
            .filter(|entry| entry.match_type == FuzzyFileSearchMatchTypeWire::File)
            .map(|entry| entry.path)
            .collect::<Vec<_>>();
        Ok(trim_file_search_results(paths, limit))
    }

    async fn ensure_capabilities(&self) -> AppResult<EnvironmentCapabilitiesSnapshot> {
        self.load_capabilities(false).await
    }

    async fn load_capabilities(
        &self,
        force_refresh: bool,
    ) -> AppResult<EnvironmentCapabilitiesSnapshot> {
        if !force_refresh {
            if let Some(capabilities) = self.state.lock().await.capabilities.clone() {
                return Ok(capabilities);
            }
        }

        let models = self
            .request_typed::<ModelListResponse>("model/list", serde_json::json!({}))
            .await?;
        let collaboration_modes = self
            .request_typed::<CollaborationModeListResponse>(
                "collaborationMode/list",
                serde_json::json!({}),
            )
            .await?;

        let models = model_options_from_response(models);
        let mut capabilities = EnvironmentCapabilitiesSnapshot {
            environment_id: self.environment_id.clone(),
            providers: vec![ProviderOption {
                id: ProviderKind::Codex,
                display_name: "OpenAI".to_string(),
                icon: "codex".to_string(),
                is_default: true,
                models: models.clone(),
            }],
            models,
            collaboration_modes: collaboration_mode_options_from_response(collaboration_modes),
        };
        append_claude_provider(&mut capabilities);
        self.state.lock().await.capabilities = Some(capabilities.clone());
        Ok(capabilities)
    }

    async fn validate_model_selection(
        &self,
        provider: ProviderKind,
        model_id: &str,
    ) -> AppResult<()> {
        let capabilities = self.ensure_capabilities().await?;
        if model_is_available(&capabilities, provider, model_id) {
            return Ok(());
        }

        Err(AppError::Validation(format!(
            "Model `{model_id}` is unavailable for the selected provider."
        )))
    }

    async fn validate_image_input_support(
        &self,
        provider: ProviderKind,
        model_id: &str,
        images: &[ConversationImageAttachment],
    ) -> AppResult<()> {
        if images.is_empty() {
            return Ok(());
        }

        let capabilities = self.ensure_capabilities().await?;
        if model_supports_image_input(&capabilities, provider, model_id) {
            return Ok(());
        }

        Err(AppError::Validation(format!(
            "Image attachments are unavailable for model `{model_id}`."
        )))
    }

    async fn resolve_service_tier(
        &self,
        provider: ProviderKind,
        model_id: &str,
        requested_service_tier: Option<ServiceTier>,
    ) -> AppResult<Option<ServiceTier>> {
        let Some(service_tier) = requested_service_tier else {
            return Ok(None);
        };

        let capabilities = self.ensure_capabilities().await?;
        if model_supports_service_tier(&capabilities, provider, model_id, service_tier) {
            return Ok(Some(service_tier));
        }

        Ok(None)
    }

    async fn resolve_outgoing_user_input(
        &self,
        context: &ThreadRuntimeContext,
        visible_text: &str,
        images: &[ConversationImageAttachment],
        mention_bindings: &[ComposerMentionBindingInput],
    ) -> AppResult<OutgoingUserInputPayload> {
        if !visible_text.contains("/prompts:") && !visible_text.contains('$') {
            return Ok(OutgoingUserInputPayload {
                text: visible_text.to_string(),
                images: images.to_vec(),
                text_elements: Vec::new(),
                skills: Vec::new(),
                mentions: Vec::new(),
            });
        }

        let prompts = load_prompt_definitions(&context.environment_path).unwrap_or_else(|error| {
            warn!("Failed to load prompt definitions for composer resolution: {error}");
            Vec::new()
        });
        let skills = self
            .load_skill_bindings(&context.environment_path)
            .await
            .unwrap_or_else(|error| {
                warn!("Failed to load skills for composer resolution: {error}");
                Vec::new()
            });
        let apps = self
            .load_app_bindings(context.codex_thread_id.as_deref())
            .await
            .unwrap_or_else(|error| {
                warn!("Failed to load apps for composer resolution: {error}");
                Vec::new()
            });
        let resolved =
            resolve_composer_text(visible_text, &prompts, &skills, &apps, mention_bindings)?;

        Ok(OutgoingUserInputPayload {
            text: resolved.text,
            images: images.to_vec(),
            text_elements: resolved
                .text_elements
                .into_iter()
                .map(|element| OutgoingTextElement {
                    start: element.start,
                    end: element.end,
                    placeholder: element.placeholder,
                })
                .collect(),
            skills: resolved
                .skills
                .into_iter()
                .map(|skill| OutgoingNamedInput {
                    name: skill.name,
                    path: skill.path,
                })
                .collect(),
            mentions: resolved
                .mentions
                .into_iter()
                .map(|mention| OutgoingNamedInput {
                    name: mention.slug,
                    path: mention.path,
                })
                .collect(),
        })
    }

    fn maybe_append_multi_agent_nudge(
        input: &mut OutgoingUserInputPayload,
        context: &ThreadRuntimeContext,
        visible_to_user: bool,
    ) {
        if !visible_to_user || !context.multi_agent_nudge_enabled {
            return;
        }

        let hidden_start = input.text.len();
        if !input.text.is_empty() {
            input.text.push_str("\n\n");
        }
        input.text.push_str(&multi_agent_nudge_text(
            context.multi_agent_nudge_max_subagents,
        ));
        input.text_elements.push(OutgoingTextElement {
            start: hidden_start,
            end: input.text.len(),
            placeholder: Some(String::new()),
        });
    }

    fn prepend_hidden_handoff_context(
        input: &mut OutgoingUserInputPayload,
        context: &ThreadRuntimeContext,
    ) {
        let Some(prefix) = context
            .handoff_bootstrap_context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return;
        };
        let separator = if input.text.is_empty() { "" } else { "\n\n" };
        let offset = prefix.len() + separator.len();
        for element in &mut input.text_elements {
            element.start += offset;
            element.end += offset;
        }
        input.text_elements.insert(
            0,
            OutgoingTextElement {
                start: 0,
                end: offset,
                placeholder: Some(String::new()),
            },
        );
        input.text = format!("{prefix}{separator}{}", input.text);
    }

    async fn send_message_with_visibility(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        images: Vec<ConversationImageAttachment>,
        visible_to_user: bool,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        let trimmed = text.trim();
        if trimmed.is_empty() && images.is_empty() {
            return Err(AppError::Validation(
                "Message must include text or at least one image.".to_string(),
            ));
        }
        self.validate_model_selection(context.composer.provider, &context.composer.model)
            .await?;
        self.validate_image_input_support(
            context.composer.provider,
            &context.composer.model,
            &images,
        )
        .await?;
        let requested_service_tier = self
            .resolve_service_tier(
                context.composer.provider,
                &context.composer.model,
                context.composer.service_tier,
            )
            .await?;
        let mut outgoing_input = self
            .resolve_outgoing_user_input(&context, trimmed, &images, &mention_bindings)
            .await?;
        Self::prepend_hidden_handoff_context(&mut outgoing_input, &context);
        Self::maybe_append_multi_agent_nudge(&mut outgoing_input, &context, visible_to_user);

        let mut open = self.open_thread(context.clone()).await?;
        let mut rollback_snapshot = open.snapshot.clone();
        if visible_to_user {
            let user_item = ConversationItem::Message(ConversationMessageItem {
                id: format!("local-user-{}", Uuid::now_v7()),
                turn_id: None,
                role: ConversationRole::User,
                text: trimmed.to_string(),
                images: (!images.is_empty()).then_some(images.clone()),
                is_streaming: false,
            });
            upsert_item(&mut open.snapshot.items, user_item);
        }

        open.snapshot.status = ConversationStatus::Running;
        open.snapshot.error = None;
        open.snapshot.pending_interactions.clear();
        if let Some(plan) = open.snapshot.proposed_plan.as_mut() {
            plan.is_awaiting_decision = false;
            if matches!(context.composer.collaboration_mode, CollaborationMode::Plan) {
                plan.status = crate::domain::conversation::ProposedPlanStatus::Superseded;
            }
        }

        let mut new_codex_thread_id = None;
        let codex_thread_id = match open.snapshot.codex_thread_id.clone() {
            Some(thread_id) => thread_id,
            None => {
                let response = self
                    .request_typed::<ThreadStartResponse>(
                        "thread/start",
                        serde_json::json!({
                            "cwd": context.environment_path,
                            "approvalPolicy": approval_policy_value(context.composer.approval_policy),
                            "approvalsReviewer": approvals_reviewer_value(context.composer.approval_policy),
                            "serviceTier": requested_service_tier,
                        }),
                    )
                .await?;
                let thread_id = response.thread.id;
                new_codex_thread_id = Some(thread_id.clone());
                open.snapshot.codex_thread_id = Some(thread_id.clone());
                rollback_snapshot.codex_thread_id = Some(thread_id.clone());
                thread_id
            }
        };

        self.state.lock().await.pending_turn_mode_by_thread.insert(
            context.thread_id.clone(),
            context.composer.collaboration_mode,
        );

        {
            let mut state = self.state.lock().await;
            state
                .local_thread_by_codex_id
                .insert(codex_thread_id.clone(), context.thread_id.clone());
            state
                .snapshots_by_thread
                .insert(context.thread_id.clone(), open.snapshot.clone());
        }
        self.emit_snapshot(&open.snapshot);

        let turn_response = self
            .request_typed::<TurnResponse>(
                "turn/start",
                serde_json::json!({
                    "threadId": codex_thread_id,
                    "input": user_input_payload(&outgoing_input),
                    "cwd": context.environment_path,
                    "approvalPolicy": approval_policy_value(context.composer.approval_policy),
                    "approvalsReviewer": approvals_reviewer_value(context.composer.approval_policy),
                    "sandboxPolicy": sandbox_policy_value(
                        context.composer.approval_policy,
                        &context.environment_path,
                    ),
                    "serviceTier": requested_service_tier,
                    "collaborationMode": collaboration_mode_payload(&context.composer),
                }),
            )
            .await;

        let turn_response = match turn_response {
            Ok(response) => response,
            Err(error) => {
                let snapshot = {
                    let mut state = self.state.lock().await;
                    state.pending_turn_mode_by_thread.remove(&context.thread_id);
                    let snapshot = state
                        .snapshots_by_thread
                        .get_mut(&context.thread_id)
                        .ok_or_else(|| {
                            AppError::Runtime(
                                "Conversation snapshot disappeared unexpectedly.".to_string(),
                            )
                        })?;
                    rollback_snapshot.error =
                        Some(crate::domain::conversation::ConversationErrorSnapshot {
                            message: error.to_string(),
                            codex_error_info: None,
                            additional_details: None,
                        });
                    clear_streaming_flags(&mut rollback_snapshot.items);
                    reconcile_snapshot_status(&mut rollback_snapshot);
                    *snapshot = rollback_snapshot.clone();
                    snapshot.clone()
                };
                self.emit_snapshot(&snapshot);
                return Err(error);
            }
        };

        let snapshot = {
            let mut state = self.state.lock().await;
            let status = conversation_status_from_turn_status(&turn_response.turn.status);
            update_turn_mode_tracking(
                &mut state,
                &context.thread_id,
                &turn_response.turn.id,
                context.composer.collaboration_mode,
                status,
            );
            let snapshot = state
                .snapshots_by_thread
                .get_mut(&context.thread_id)
                .ok_or_else(|| {
                    AppError::Runtime("Conversation snapshot disappeared unexpectedly.".to_string())
                })?;
            snapshot.composer = context.composer.clone();
            snapshot.task_plan = None;
            snapshot.subagents.clear();
            snapshot.active_turn_id =
                matches!(status, ConversationStatus::Running).then_some(turn_response.turn.id);
            snapshot.status = status;
            snapshot.error = turn_response.turn.error.map(error_snapshot);
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.emit_snapshot(&snapshot);

        Ok(SendMessageResult {
            snapshot,
            new_provider_thread_id: new_codex_thread_id.clone(),
            new_codex_thread_id,
        })
    }

    async fn send_server_response(
        &self,
        id: serde_json::Value,
        result: serde_json::Value,
    ) -> AppResult<()> {
        self.write_message(serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))
        .await
    }

    async fn complete_interaction(
        &self,
        thread_id: &str,
        interaction_id: &str,
    ) -> AppResult<ThreadConversationSnapshot> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(thread_id)
                .ok_or_else(|| {
                    AppError::NotFound("Thread conversation is not open.".to_string())
                })?;
            snapshot
                .pending_interactions
                .retain(|interaction| interaction_id_for(interaction) != interaction_id);
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.emit_snapshot(&snapshot);
        Ok(snapshot)
    }

    async fn take_pending_server_request(
        &self,
        thread_id: &str,
        interaction_id: &str,
    ) -> AppResult<PendingServerRequest> {
        let mut state = self.state.lock().await;
        let Some(pending) = state.pending_server_requests.get(interaction_id).cloned() else {
            return Err(AppError::NotFound(
                "Interactive request not found.".to_string(),
            ));
        };
        if pending.thread_id != thread_id {
            return Err(AppError::Validation(
                "Interactive request does not belong to the selected thread.".to_string(),
            ));
        }
        state.pending_server_requests.remove(interaction_id);
        Ok(pending)
    }

    async fn restore_pending_server_request(
        &self,
        interaction_id: &str,
        request: PendingServerRequest,
    ) {
        self.state
            .lock()
            .await
            .pending_server_requests
            .insert(interaction_id.to_string(), request);
    }

    async fn mark_plan_state<F>(
        &self,
        thread_id: &str,
        mutate: F,
    ) -> AppResult<ThreadConversationSnapshot>
    where
        F: FnOnce(&mut crate::domain::conversation::ProposedPlanSnapshot),
    {
        self.mutate_snapshot(thread_id, |snapshot| {
            let plan = snapshot.proposed_plan.as_mut().ok_or_else(|| {
                AppError::Validation("There is no proposed plan to update.".to_string())
            })?;
            mutate(plan);
            Ok(())
        })
        .await
    }

    async fn take_pending_plan_decision(
        &self,
        thread_id: &str,
    ) -> AppResult<ThreadConversationSnapshot> {
        self.mutate_snapshot(thread_id, |snapshot| {
            let plan = snapshot.proposed_plan.as_mut().ok_or_else(|| {
                AppError::Validation("There is no proposed plan to update.".to_string())
            })?;
            if !matches!(
                plan.status,
                crate::domain::conversation::ProposedPlanStatus::Ready
            ) {
                return Err(AppError::Validation(
                    "There is no proposed plan to update.".to_string(),
                ));
            }
            if !plan.is_awaiting_decision {
                return Err(AppError::Validation(
                    "The current plan is no longer awaiting a decision.".to_string(),
                ));
            }
            plan.is_awaiting_decision = false;
            Ok(())
        })
        .await
    }

    async fn restore_pending_plan_decision(&self, thread_id: &str) {
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(snapshot) = state.snapshots_by_thread.get_mut(thread_id) else {
                return;
            };
            let Some(plan) = snapshot.proposed_plan.as_mut() else {
                return;
            };
            if !matches!(
                plan.status,
                crate::domain::conversation::ProposedPlanStatus::Ready
            ) || plan.is_awaiting_decision
            {
                return;
            }
            plan.is_awaiting_decision = true;
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.emit_snapshot(&snapshot);
    }

    async fn push_system_item(
        &self,
        thread_id: &str,
        title: &str,
        body: &str,
    ) -> AppResult<ThreadConversationSnapshot> {
        let item = ConversationItem::System(crate::domain::conversation::ConversationSystemItem {
            id: format!("system-{}", Uuid::now_v7()),
            turn_id: None,
            tone: crate::domain::conversation::ConversationTone::Info,
            title: title.to_string(),
            body: body.to_string(),
        });
        let item_for_persist = item.clone();
        let snapshot = self
            .mutate_snapshot(thread_id, move |snapshot| {
                upsert_item(&mut snapshot.items, item);
                Ok(())
            })
            .await?;
        item_store::save(thread_id, &item_for_persist);
        Ok(snapshot)
    }

    async fn mutate_snapshot<F>(
        &self,
        thread_id: &str,
        mutate: F,
    ) -> AppResult<ThreadConversationSnapshot>
    where
        F: FnOnce(&mut ThreadConversationSnapshot) -> AppResult<()>,
    {
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(thread_id)
                .ok_or_else(|| {
                    AppError::NotFound("Thread conversation is not open.".to_string())
                })?;
            mutate(snapshot)?;
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.emit_snapshot(&snapshot);
        Ok(snapshot)
    }

    async fn refresh_thread_metadata(
        &self,
        context: ThreadRuntimeContext,
        existing_snapshot: Option<ThreadConversationSnapshot>,
    ) -> AppResult<ThreadConversationSnapshot> {
        let snapshot = match existing_snapshot {
            Some(snapshot) => snapshot,
            None => self
                .state
                .lock()
                .await
                .snapshots_by_thread
                .get(&context.thread_id)
                .cloned()
                .ok_or_else(|| {
                    AppError::NotFound("Thread conversation is not open.".to_string())
                })?,
        };

        let subagents = self
            .load_subagents(
                snapshot.codex_thread_id.as_deref(),
                &context.environment_path,
                snapshot
                    .subagents
                    .iter()
                    .map(|subagent| subagent.thread_id.clone())
                    .collect(),
            )
            .await?;

        self.mutate_snapshot(&context.thread_id, |snapshot| {
            apply_subagent_updates(snapshot, subagents);
            Ok(())
        })
        .await
    }

    async fn request_typed<T>(&self, method: &str, params: serde_json::Value) -> AppResult<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let value = self.send_request(method, params).await?;
        serde_json::from_value::<T>(value).map_err(|error| {
            AppError::Runtime(format!(
                "Failed to decode `{method}` response from Codex app-server: {error}"
            ))
        })
    }

    async fn load_subagents(
        &self,
        codex_thread_id: Option<&str>,
        environment_path: &str,
        known_subagent_thread_ids: Vec<String>,
    ) -> AppResult<Vec<crate::domain::conversation::SubagentThreadSnapshot>> {
        let Some(codex_thread_id) = codex_thread_id else {
            return Ok(Vec::new());
        };

        let known_subagent_thread_ids = Self::unique_nonempty_thread_ids(known_subagent_thread_ids);
        let mut loaded_thread_ids = self.load_all_loaded_thread_ids().await?;
        for thread_id in known_subagent_thread_ids.iter() {
            Self::push_unique_thread_id(&mut loaded_thread_ids, thread_id);
        }
        if loaded_thread_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut subagent_threads = self.load_all_subagent_threads(environment_path).await?;
        let listed_thread_ids = subagent_threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let missing_known_thread_ids = known_subagent_thread_ids
            .iter()
            .filter(|thread_id| thread_id.as_str() != codex_thread_id)
            .filter(|thread_id| !listed_thread_ids.contains(thread_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        subagent_threads.extend(
            self.load_subagent_threads_by_id(missing_known_thread_ids)
                .await?,
        );
        Ok(loaded_subagents_for_primary(
            codex_thread_id,
            &loaded_thread_ids,
            subagent_threads,
        ))
    }

    async fn load_all_loaded_thread_ids(&self) -> AppResult<Vec<String>> {
        let mut cursor = None;
        let mut thread_ids = Vec::new();

        loop {
            let response = self
                .request_typed::<ThreadLoadedListResponse>(
                    "thread/loaded/list",
                    serde_json::json!({
                        "cursor": cursor,
                        "limit": 200
                    }),
                )
                .await?;
            thread_ids.extend(response.data);

            match response.next_cursor {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => return Ok(thread_ids),
            }
        }
    }

    async fn load_all_subagent_threads(
        &self,
        environment_path: &str,
    ) -> AppResult<Vec<crate::runtime::protocol::ThreadListEntryWire>> {
        let mut cursor = None;
        let mut threads = Vec::new();

        loop {
            let response = self
                .request_typed::<ThreadListResponse>(
                    "thread/list",
                    serde_json::json!({
                        "archived": false,
                        "cwd": environment_path,
                        "cursor": cursor,
                        "limit": 200,
                        "sortKey": "updated_at",
                        "sourceKinds": ["subAgentThreadSpawn"]
                    }),
                )
                .await?;
            threads.extend(response.data);

            match response.next_cursor {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => return Ok(threads),
            }
        }
    }

    async fn load_subagent_threads_by_id(
        &self,
        thread_ids: Vec<String>,
    ) -> AppResult<Vec<crate::runtime::protocol::ThreadListEntryWire>> {
        let mut threads = Vec::new();
        for thread_id in thread_ids {
            let response = self
                .request_typed::<ThreadMetadataReadResponse>(
                    "thread/read",
                    serde_json::json!({
                        "threadId": thread_id,
                        "includeTurns": false
                    }),
                )
                .await;
            match response {
                Ok(response) => threads.push(response.thread),
                Err(error) => warn!("failed to read Codex subagent thread metadata: {error}"),
            }
        }
        Ok(threads)
    }

    fn unique_nonempty_thread_ids(thread_ids: Vec<String>) -> Vec<String> {
        let mut unique = Vec::new();
        for thread_id in thread_ids {
            Self::push_unique_thread_id(&mut unique, &thread_id);
        }
        unique
    }

    fn push_unique_thread_id(thread_ids: &mut Vec<String>, thread_id: &str) {
        if thread_id.is_empty() || thread_ids.iter().any(|existing| existing == thread_id) {
            return;
        }
        thread_ids.push(thread_id.to_string());
    }

    async fn load_skill_bindings(&self, environment_path: &str) -> AppResult<Vec<SkillBinding>> {
        let response = self
            .request_typed::<SkillsListResponse>(
                "skills/list",
                serde_json::json!({
                    "cwds": [environment_path],
                    "forceReload": false,
                }),
            )
            .await?;
        let mut bindings = response
            .data
            .into_iter()
            .filter(|entry| entry.cwd == environment_path)
            .flat_map(|entry| entry.skills)
            .filter(|skill| skill.enabled)
            .map(|skill| SkillBinding {
                name: skill.name,
                description: skill
                    .interface
                    .as_ref()
                    .and_then(|interface| interface.short_description.clone())
                    .or(skill.short_description)
                    .unwrap_or(skill.description),
                path: skill.path,
            })
            .collect::<Vec<_>>();
        bindings.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(bindings)
    }

    async fn load_app_bindings(&self, codex_thread_id: Option<&str>) -> AppResult<Vec<AppBinding>> {
        let mut cursor = None;
        let mut apps = Vec::<AppInfoWire>::new();

        loop {
            let response = self
                .request_typed::<AppsListResponse>(
                    "app/list",
                    serde_json::json!({
                        "cursor": cursor,
                        "limit": 100,
                        "threadId": codex_thread_id,
                        "forceRefetch": false,
                    }),
                )
                .await?;
            apps.extend(response.data);
            match response.next_cursor {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }

        let mut bindings = apps
            .into_iter()
            .filter(|app| app.is_accessible.unwrap_or(true) && app.is_enabled.unwrap_or(true))
            .map(|app| AppBinding {
                slug: connector_mention_slug(&app.name),
                path: format!("app://{}", app.id),
                id: app.id,
                name: app.name,
                description: app.description,
            })
            .collect::<Vec<_>>();
        bindings.sort_by(|left, right| {
            left.slug
                .cmp(&right.slug)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(bindings)
    }

    async fn send_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = self.write_message(request).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match timeout(request_timeout_for(method), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::Runtime(format!(
                "The `{method}` request channel was dropped unexpectedly."
            ))),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AppError::Runtime(format!(
                    "Timed out waiting for `{method}` from Codex app-server."
                )))
            }
        }
    }

    async fn send_notification(&self, method: &str, params: serde_json::Value) -> AppResult<()> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.write_message(notification).await
    }

    async fn write_message(&self, payload: serde_json::Value) -> AppResult<()> {
        let mut writer = self.writer.lock().await;
        let encoded = serde_json::to_string(&payload)
            .map_err(|error| AppError::Runtime(format!("Failed to encode request: {error}")))?;
        writer.write_all(encoded.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        Ok(())
    }

    fn emit_snapshot(&self, snapshot: &ThreadConversationSnapshot) {
        queue_snapshot_emit(self.events.clone(), snapshot.clone());
    }
}

fn imported_handoff_items(context: &ThreadRuntimeContext) -> Vec<ConversationItem> {
    context
        .handoff
        .as_ref()
        .map(|handoff| {
            handoff
                .imported_messages
                .iter()
                .map(|message| {
                    ConversationItem::Message(ConversationMessageItem {
                        id: message.id.clone(),
                        turn_id: None,
                        role: message.role,
                        text: message.text.clone(),
                        images: message.images.clone(),
                        is_streaming: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn request_timeout_for(method: &str) -> Duration {
    if method == "initialize" {
        return INITIALIZE_REQUEST_TIMEOUT;
    }

    REQUEST_TIMEOUT
}

fn spawn_stdout_task<R>(
    events: EventSink,
    environment_id: String,
    usage_update_context: UsageUpdateContext,
    pending: PendingRequestMap,
    state: Arc<Mutex<SessionState>>,
    usage_updates: Option<mpsc::UnboundedSender<RuntimeUsageUpdate>>,
    reader: R,
) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match parse_incoming_message(&line) {
                    Ok(IncomingMessage::Response(response)) => {
                        if let Some(sender) = pending.lock().await.remove(&response.id) {
                            let _ = sender.send(match response.error {
                                Some(message) => Err(AppError::Runtime(message)),
                                None => Ok(response.result),
                            });
                        }
                    }
                    Ok(IncomingMessage::Request(request)) => {
                        handle_server_request(&events, &state, request).await;
                    }
                    Ok(IncomingMessage::Notification(notification)) => {
                        handle_notification(
                            &events,
                            &state,
                            &environment_id,
                            &usage_update_context.environment_path,
                            usage_update_context.codex_binary_path.as_deref(),
                            &usage_updates,
                            notification,
                        )
                        .await;
                    }
                    Err(error) => {
                        error!("failed to parse codex notification: {error}");
                    }
                },
                Ok(None) => {
                    mark_runtime_disconnected(&events, &state).await;
                    break;
                }
                Err(error) => {
                    error!("failed reading codex stdout: {error}");
                    mark_runtime_disconnected(&events, &state).await;
                    break;
                }
            }
        }
    })
}

fn spawn_stderr_task<R>(environment_id: String, reader: R) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            warn!(environment_id, "codex stderr: {line}");
        }
    })
}

async fn handle_server_request(
    events: &EventSink,
    state: &Arc<Mutex<SessionState>>,
    request: crate::runtime::protocol::ServerRequestEnvelope,
) {
    let interaction_id = format!("interaction-{}", Uuid::now_v7());
    let Some(interaction) = normalize_server_interaction(&interaction_id, &request) else {
        return;
    };

    let snapshot = {
        let mut state = state.lock().await;
        let codex_thread_id = interaction_thread_id(&interaction);
        let Some(local_thread_id) = state.local_thread_by_codex_id.get(codex_thread_id).cloned()
        else {
            return;
        };
        let should_track_request = matches!(
            interaction,
            ConversationInteraction::Approval(_) | ConversationInteraction::UserInput(_)
        );
        if should_track_request {
            state.pending_server_requests.insert(
                interaction_id.clone(),
                PendingServerRequest {
                    json_rpc_id: request.id,
                    thread_id: local_thread_id.clone(),
                },
            );
        }
        let Some(snapshot) = state.snapshots_by_thread.get_mut(&local_thread_id) else {
            return;
        };
        snapshot.pending_interactions.push(interaction);
        reconcile_snapshot_status(snapshot);
        snapshot.clone()
    };
    emit_snapshot_from_handle(events, snapshot);
}

async fn handle_notification(
    events: &EventSink,
    state: &Arc<Mutex<SessionState>>,
    environment_id: &str,
    environment_path: &str,
    codex_binary_path: Option<&str>,
    usage_updates: &Option<mpsc::UnboundedSender<RuntimeUsageUpdate>>,
    notification: crate::runtime::protocol::ServerNotificationEnvelope,
) {
    match notification.method.as_str() {
        "turn/started" => {
            if let Ok(event) =
                serde_json::from_value::<TurnStartedNotification>(notification.params)
            {
                {
                    let mut session_state = state.lock().await;
                    if let Some(local_thread_id) = session_state
                        .local_thread_by_codex_id
                        .get(&event.thread_id)
                        .cloned()
                    {
                        let mode = session_state
                            .pending_turn_mode_by_thread
                            .remove(&local_thread_id)
                            .or_else(|| {
                                session_state
                                    .snapshots_by_thread
                                    .get(&local_thread_id)
                                    .map(|snapshot| snapshot.composer.collaboration_mode)
                            })
                            .unwrap_or(CollaborationMode::Build);
                        session_state
                            .turn_modes_by_id
                            .insert(event.turn.id.clone(), mode);
                    }
                }
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        snapshot.active_turn_id = Some(event.turn.id.clone());
                        snapshot.status = ConversationStatus::Running;
                        snapshot.error = None;
                        snapshot.pending_interactions.clear();
                        snapshot.subagents.clear();
                        snapshot.task_plan = None;
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
                let mut state = state.lock().await;
                if let Some(local_thread_id) = state
                    .local_thread_by_codex_id
                    .get(&event.thread_id)
                    .cloned()
                {
                    clear_buffered_assistant_control_deltas_for_thread(
                        &mut state,
                        &local_thread_id,
                    );
                    clear_raw_agent_message_texts_for_thread(&mut state, &local_thread_id);
                }
            }
        }
        "turn/completed" => {
            if let Ok(event) =
                serde_json::from_value::<TurnCompletedNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        snapshot.active_turn_id = None;
                        snapshot.subagents.clear();
                        snapshot.status = conversation_status_from_turn_status(&event.turn.status);
                        snapshot.error = event.turn.error.clone().map(error_snapshot);
                        clear_streaming_flags(&mut snapshot.items);
                        if let Some(plan) = snapshot.proposed_plan.as_mut() {
                            if plan.turn_id == event.turn.id
                                && plan.status
                                    == crate::domain::conversation::ProposedPlanStatus::Streaming
                            {
                                complete_proposed_plan(
                                    plan,
                                    plan.item_id.clone().unwrap_or_default().as_str(),
                                    None,
                                );
                            }
                        }
                        if let Some(plan) = snapshot.task_plan.as_mut() {
                            if plan.turn_id == event.turn.id {
                                complete_task_plan(
                                    plan,
                                    plan.item_id.clone().unwrap_or_default().as_str(),
                                    None,
                                    task_status_from_turn_status(&event.turn.status),
                                );
                            }
                        }
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
                let mut state = state.lock().await;
                state.turn_modes_by_id.remove(&event.turn.id);
                if let Some(local_thread_id) = state
                    .local_thread_by_codex_id
                    .get(&event.thread_id)
                    .cloned()
                {
                    clear_raw_agent_message_texts_for_thread(&mut state, &local_thread_id);
                }
            }
        }
        "turn/plan/updated" => {
            if let Ok(event) =
                serde_json::from_value::<TurnPlanUpdatedNotification>(notification.params)
            {
                let plan_target =
                    plan_target_for_turn(state, &event.thread_id, &event.turn_id).await;
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        match plan_target {
                            PlanTarget::Proposed => {
                                snapshot.proposed_plan = Some(proposed_plan_from_turn_update(
                                    event.clone(),
                                    snapshot.proposed_plan.as_ref(),
                                ));
                            }
                            PlanTarget::Task => {
                                snapshot.task_plan = Some(task_plan_from_turn_update(
                                    event.clone(),
                                    snapshot.task_plan.as_ref(),
                                ));
                            }
                        }
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        "item/started" | "item/completed" => {
            if let Ok(event) = serde_json::from_value::<ItemNotification>(notification.params) {
                let is_started = notification.method == "item/started";
                let item_type = event.item.get("type").and_then(serde_json::Value::as_str);
                let plan_target = match item_type {
                    Some("plan") => Some(
                        plan_target_for_item_or_turn(
                            state,
                            &event.thread_id,
                            &event.turn_id,
                            &event.item,
                        )
                        .await,
                    ),
                    Some("agentMessage") => {
                        Some(plan_target_for_turn(state, &event.thread_id, &event.turn_id).await)
                    }
                    _ => None,
                };
                let mut collab_subagents = subagents_from_collab_item(&event.item);
                let mut item_to_persist: Option<(String, ConversationItem)> = None;
                let maybe_snapshot = {
                    let mut state = state.lock().await;
                    let stream_assistant_responses = state.stream_assistant_responses;
                    let Some(local_thread_id) = state
                        .local_thread_by_codex_id
                        .get(&event.thread_id)
                        .cloned()
                    else {
                        return;
                    };
                    let item_id = event.item["id"].as_str().unwrap_or_default();
                    clear_buffered_assistant_control_delta(&mut state, &local_thread_id, item_id);
                    let raw_text_key = agent_message_text_key(&local_thread_id, item_id);
                    let plan_mode_agent_text = if item_type == Some("agentMessage")
                        && matches!(plan_target, Some(PlanTarget::Proposed))
                        && !is_hidden_assistant_control_item(&event.item)
                    {
                        let raw_text = event
                            .item
                            .get("text")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        state
                            .raw_agent_message_text_by_item
                            .insert(raw_text_key.clone(), raw_text.clone());
                        Some(raw_text)
                    } else {
                        None
                    };

                    if !collab_subagents.is_empty() {
                        let subagent_metadata = state.subagent_metadata_by_codex_thread_id.clone();
                        enrich_subagents_with_metadata(&mut collab_subagents, &subagent_metadata);
                    }
                    let Some(snapshot) = state.snapshots_by_thread.get_mut(&local_thread_id) else {
                        return;
                    };

                    if item_type == Some("plan") {
                        match plan_target.unwrap_or(PlanTarget::Task) {
                            PlanTarget::Proposed => {
                                let existing = snapshot
                                    .proposed_plan
                                    .as_ref()
                                    .filter(|plan| plan.turn_id == event.turn_id);
                                snapshot.proposed_plan = proposed_plan_from_item(
                                    &event.turn_id,
                                    &event.item,
                                    if is_started {
                                        crate::domain::conversation::ProposedPlanStatus::Streaming
                                    } else {
                                        crate::domain::conversation::ProposedPlanStatus::Ready
                                    },
                                )
                                .or_else(|| existing.cloned());
                                if let Some(plan) = snapshot.proposed_plan.as_mut() {
                                    if is_started {
                                        plan.status =
                                            crate::domain::conversation::ProposedPlanStatus::Streaming;
                                        plan.is_awaiting_decision = false;
                                    } else {
                                        complete_proposed_plan(
                                            plan,
                                            event.item["id"].as_str().unwrap_or_default(),
                                            Some(&event.item),
                                        );
                                    }
                                }
                            }
                            PlanTarget::Task => {
                                let status = if is_started {
                                    ConversationTaskStatus::Running
                                } else {
                                    task_status_from_snapshot(snapshot)
                                };
                                let existing = snapshot
                                    .task_plan
                                    .as_ref()
                                    .filter(|plan| plan.turn_id == event.turn_id);
                                snapshot.task_plan =
                                    task_plan_from_item(&event.turn_id, &event.item, status)
                                        .or_else(|| existing.cloned());
                                if let Some(plan) = snapshot.task_plan.as_mut() {
                                    if is_started {
                                        plan.status = ConversationTaskStatus::Running;
                                    } else {
                                        complete_task_plan(
                                            plan,
                                            event.item["id"].as_str().unwrap_or_default(),
                                            Some(&event.item),
                                            status,
                                        );
                                    }
                                }
                            }
                        }
                        reconcile_snapshot_status(snapshot);
                        Some(snapshot.clone())
                    } else if let Some(raw_text) = plan_mode_agent_text.as_deref() {
                        sync_plan_mode_agent_message(
                            snapshot,
                            &event.turn_id,
                            item_id,
                            raw_text,
                            is_started,
                        );
                        reconcile_snapshot_status(snapshot);
                        Some(snapshot.clone())
                    } else {
                        if !collab_subagents.is_empty() {
                            apply_collab_subagent_updates(snapshot, collab_subagents);
                            reconcile_snapshot_status(snapshot);
                            Some(snapshot.clone())
                        } else if is_hidden_assistant_control_item(&event.item) {
                            let item_id = event.item["id"].as_str().unwrap_or_default();
                            snapshot.items.retain(|item| match item {
                                ConversationItem::Message(message) => message.id != item_id,
                                _ => true,
                            });
                            reconcile_snapshot_status(snapshot);
                            Some(snapshot.clone())
                        } else if is_started
                            && !stream_assistant_responses
                            && event.item.get("type").and_then(serde_json::Value::as_str)
                                == Some("agentMessage")
                        {
                            reconcile_snapshot_status(snapshot);
                            Some(snapshot.clone())
                        } else {
                            if let Some(item) = normalize_item(Some(&event.turn_id), &event.item)
                                .map(|item| {
                                    if is_started {
                                        mark_item_streaming(item)
                                    } else {
                                        item
                                    }
                                })
                            {
                                let normalized_item_id = conversation_item_id(&item).to_string();
                                upsert_item(&mut snapshot.items, item);
                                // Persist the merged result so prior `summary`/`output`
                                // preserved by `upsert_item` is not truncated to the
                                // partial completion payload on disk.
                                if !is_started {
                                    if let Some(merged) = snapshot
                                        .items
                                        .iter()
                                        .find(|candidate| {
                                            conversation_item_id(candidate) == normalized_item_id
                                        })
                                        .cloned()
                                    {
                                        item_to_persist = Some((local_thread_id.clone(), merged));
                                    }
                                }
                            }
                            reconcile_snapshot_status(snapshot);
                            Some(snapshot.clone())
                        }
                    }
                };

                if let Some((thread_id, item)) = item_to_persist {
                    item_store::save(&thread_id, &item);
                }

                if !is_started && item_type == Some("agentMessage") {
                    let mut state = state.lock().await;
                    if let Some(local_thread_id) = state
                        .local_thread_by_codex_id
                        .get(&event.thread_id)
                        .cloned()
                    {
                        state
                            .raw_agent_message_text_by_item
                            .remove(&agent_message_text_key(
                                &local_thread_id,
                                event.item["id"].as_str().unwrap_or_default(),
                            ));
                    }
                }

                if let Some(snapshot) = maybe_snapshot {
                    emit_snapshot_from_handle(events, snapshot);
                }
            }
        }
        "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" => {
            if let Some(item) = normalize_auto_approval_review_notification(&notification.params) {
                let review_status_completed =
                    notification.method == "item/autoApprovalReview/completed";
                let thread_id = notification
                    .params
                    .get("threadId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let maybe_snapshot = {
                    let mut state = state.lock().await;
                    let Some(local_thread_id) =
                        state.local_thread_by_codex_id.get(&thread_id).cloned()
                    else {
                        return;
                    };
                    let Some(snapshot) = state.snapshots_by_thread.get_mut(&local_thread_id) else {
                        return;
                    };
                    let item_id = conversation_item_id(&item).to_string();
                    upsert_item(&mut snapshot.items, item);
                    reconcile_snapshot_status(snapshot);
                    let item_to_persist = review_status_completed
                        .then(|| {
                            snapshot
                                .items
                                .iter()
                                .find(|candidate| conversation_item_id(candidate) == item_id)
                                .cloned()
                        })
                        .flatten();
                    let snapshot = snapshot.clone();
                    Some((snapshot, local_thread_id, item_to_persist))
                };

                if let Some((snapshot, local_thread_id, item_to_persist)) = maybe_snapshot {
                    if let Some(item) = item_to_persist {
                        item_store::save(&local_thread_id, &item);
                    }
                    emit_snapshot_from_handle(events, snapshot);
                }
            }
        }
        "item/plan/delta" => {
            if let Ok(event) = serde_json::from_value::<PlanDeltaNotification>(notification.params)
            {
                let plan_target =
                    plan_target_for_turn(state, &event.thread_id, &event.turn_id).await;
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        match plan_target {
                            PlanTarget::Proposed => {
                                let plan = snapshot.proposed_plan.get_or_insert_with(|| {
                                    crate::domain::conversation::ProposedPlanSnapshot {
                                        turn_id: event.turn_id.clone(),
                                        item_id: Some(event.item_id.clone()),
                                        explanation: String::new(),
                                        steps: Vec::new(),
                                        markdown: String::new(),
                                        status: crate::domain::conversation::ProposedPlanStatus::Streaming,
                                        is_awaiting_decision: false,
                                    }
                                });
                                append_plan_delta(plan, &event.item_id, &event.delta);
                            }
                            PlanTarget::Task => {
                                let plan = snapshot.task_plan.get_or_insert_with(|| {
                                    crate::domain::conversation::ConversationTaskSnapshot {
                                        turn_id: event.turn_id.clone(),
                                        item_id: Some(event.item_id.clone()),
                                        explanation: String::new(),
                                        steps: Vec::new(),
                                        markdown: String::new(),
                                        status: ConversationTaskStatus::Running,
                                    }
                                });
                                append_task_plan_delta(plan, &event.item_id, &event.delta);
                            }
                        }
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        AGENT_MESSAGE_DELTA_METHOD => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params)
            {
                let plan_target =
                    plan_target_for_turn(state, &event.thread_id, &event.turn_id).await;
                let maybe_snapshot = {
                    let mut state = state.lock().await;
                    let Some(local_thread_id) = state
                        .local_thread_by_codex_id
                        .get(&event.thread_id)
                        .cloned()
                    else {
                        return;
                    };
                    let buffer_key = assistant_control_delta_key(&local_thread_id, &event.item_id);
                    let mut buffered = state.buffered_assistant_control_deltas.remove(&buffer_key);
                    let visible_delta =
                        consume_buffered_agent_message_delta(&event.delta, &mut buffered);
                    let raw_text = if matches!(plan_target, PlanTarget::Proposed) {
                        visible_delta.as_ref().map(|delta| {
                            let key = agent_message_text_key(&local_thread_id, &event.item_id);
                            let entry =
                                state.raw_agent_message_text_by_item.entry(key).or_default();
                            entry.push_str(delta);
                            entry.clone()
                        })
                    } else {
                        None
                    };
                    let snapshot = {
                        let Some(snapshot) = state.snapshots_by_thread.get_mut(&local_thread_id)
                        else {
                            return;
                        };
                        if let Some(raw_text) = raw_text.as_deref() {
                            sync_plan_mode_agent_message(
                                snapshot,
                                &event.turn_id,
                                &event.item_id,
                                raw_text,
                                true,
                            );
                        } else if let Some(delta) = visible_delta.as_deref() {
                            append_agent_delta(
                                &mut snapshot.items,
                                &event.turn_id,
                                &event.item_id,
                                delta,
                            );
                        }
                        reconcile_snapshot_status(snapshot);
                        snapshot.clone()
                    };
                    if let Some(buffered) = buffered {
                        state
                            .buffered_assistant_control_deltas
                            .insert(buffer_key, buffered);
                    }
                    Some(snapshot)
                };

                if let Some(snapshot) = maybe_snapshot {
                    emit_snapshot_from_handle(events, snapshot);
                }
            }
        }
        "item/reasoning/summaryTextDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_reasoning_summary(
                            &mut snapshot.items,
                            &event.turn_id,
                            &event.item_id,
                            &event.delta,
                        );
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        "item/reasoning/summaryPartAdded" => {
            if let Ok(event) =
                serde_json::from_value::<ReasoningBoundaryNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_reasoning_boundary(
                            &mut snapshot.items,
                            &event.turn_id,
                            &event.item_id,
                        );
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        "item/reasoning/textDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_reasoning_content(
                            &mut snapshot.items,
                            &event.turn_id,
                            &event.item_id,
                            &event.delta,
                        );
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_tool_output(
                            &mut snapshot.items,
                            &event.turn_id,
                            &event.item_id,
                            &event.delta,
                        );
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        "thread/tokenUsage/updated" => {
            if let Ok(event) = serde_json::from_value::<TokenUsageNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        snapshot.token_usage =
                            Some(token_usage_snapshot(event.token_usage.clone()));
                        reconcile_snapshot_status(snapshot);
                    },
                    events,
                )
                .await;
            }
        }
        "account/rateLimits/updated" => {
            emit_usage_update_from_params(
                usage_updates,
                environment_id,
                environment_path,
                codex_binary_path,
                &notification.params,
            );
        }
        "error" => {
            if let Ok(event) = serde_json::from_value::<ErrorNotification>(notification.params) {
                if let Some(thread_id) = event.thread_id {
                    update_snapshot_for_codex_thread(
                        state,
                        &thread_id,
                        |snapshot| {
                            snapshot.error = Some(error_snapshot(event.error.clone()));
                            snapshot.subagents.clear();
                            reconcile_snapshot_status(snapshot);
                        },
                        events,
                    )
                    .await;
                }
            }
        }
        "thread/started" => {
            let _ = environment_id;
            if let Some(thread) = notification.params.get("thread") {
                if let Some(subagent_start) = subagent_thread_start_from_thread(thread) {
                    record_subagent_thread_started(state, events, subagent_start).await;
                }
            }
        }
        "thread/status/changed" => {
            if let Ok(event) =
                serde_json::from_value::<ThreadStatusChangedNotification>(notification.params)
            {
                update_subagent_thread_status(state, events, &event.thread_id, &event.status).await;
            }
        }
        "thread/closed" => {
            if let Some(thread_id) = notification
                .params
                .get("threadId")
                .or_else(|| notification.params.get("thread_id"))
                .and_then(serde_json::Value::as_str)
            {
                close_subagent_thread(state, events, thread_id).await;
            }
        }
        other => {
            warn!("unhandled codex notification: {other}");
        }
    }
}

#[derive(Clone, Copy)]
enum PlanTarget {
    Proposed,
    Task,
}

async fn plan_target_for_turn(
    state: &Arc<Mutex<SessionState>>,
    codex_thread_id: &str,
    turn_id: &str,
) -> PlanTarget {
    let state = state.lock().await;
    if let Some(mode) = state.turn_modes_by_id.get(turn_id).copied() {
        return plan_target_from_mode(mode);
    }
    let Some(local_thread_id) = state.local_thread_by_codex_id.get(codex_thread_id) else {
        return PlanTarget::Task;
    };
    if let Some(mode) = state
        .pending_turn_mode_by_thread
        .get(local_thread_id)
        .copied()
    {
        return plan_target_from_mode(mode);
    }
    state
        .snapshots_by_thread
        .get(local_thread_id)
        .map(|snapshot| {
            plan_target_from_mode(snapshot_mode_for_turn(
                snapshot,
                turn_id,
                snapshot.composer.collaboration_mode,
            ))
        })
        .unwrap_or(PlanTarget::Task)
}

async fn plan_target_for_item_or_turn(
    state: &Arc<Mutex<SessionState>>,
    codex_thread_id: &str,
    turn_id: &str,
    item: &Value,
) -> PlanTarget {
    if let Some(mode) = collaboration_mode_from_plan_item_heading(item) {
        state
            .lock()
            .await
            .turn_modes_by_id
            .insert(turn_id.to_string(), mode);
        return plan_target_from_mode(mode);
    }
    plan_target_for_turn(state, codex_thread_id, turn_id).await
}

fn plan_target_from_mode(mode: CollaborationMode) -> PlanTarget {
    match mode {
        CollaborationMode::Plan => PlanTarget::Proposed,
        CollaborationMode::Build => PlanTarget::Task,
    }
}

fn update_turn_mode_tracking(
    state: &mut SessionState,
    thread_id: &str,
    turn_id: &str,
    mode: CollaborationMode,
    status: ConversationStatus,
) {
    state.pending_turn_mode_by_thread.remove(thread_id);
    if matches!(status, ConversationStatus::Running) {
        state.turn_modes_by_id.insert(turn_id.to_string(), mode);
    }
}

fn task_status_from_snapshot(snapshot: &ThreadConversationSnapshot) -> ConversationTaskStatus {
    match snapshot.status {
        ConversationStatus::Completed => ConversationTaskStatus::Completed,
        ConversationStatus::Interrupted => ConversationTaskStatus::Interrupted,
        ConversationStatus::Failed => ConversationTaskStatus::Failed,
        ConversationStatus::Idle
        | ConversationStatus::Running
        | ConversationStatus::WaitingForExternalAction => ConversationTaskStatus::Running,
    }
}

fn assistant_control_delta_key(thread_id: &str, item_id: &str) -> String {
    format!("{thread_id}:{item_id}")
}

fn conversation_item_id(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::Message(message) => message.id.as_str(),
        ConversationItem::Reasoning(reasoning) => reasoning.id.as_str(),
        ConversationItem::Tool(tool) => tool.id.as_str(),
        ConversationItem::AutoApprovalReview(review) => review.id.as_str(),
        ConversationItem::System(system) => system.id.as_str(),
    }
}

fn agent_message_text_key(thread_id: &str, item_id: &str) -> String {
    format!("{thread_id}:{item_id}")
}

fn clear_buffered_assistant_control_delta(
    state: &mut SessionState,
    thread_id: &str,
    item_id: &str,
) {
    state
        .buffered_assistant_control_deltas
        .remove(&assistant_control_delta_key(thread_id, item_id));
}

fn clear_buffered_assistant_control_deltas_for_thread(state: &mut SessionState, thread_id: &str) {
    let prefix = format!("{thread_id}:");
    state
        .buffered_assistant_control_deltas
        .retain(|key, _| !key.starts_with(&prefix));
}

fn clear_raw_agent_message_texts_for_thread(state: &mut SessionState, thread_id: &str) {
    let prefix = format!("{thread_id}:");
    state
        .raw_agent_message_text_by_item
        .retain(|key, _| !key.starts_with(&prefix));
}

fn consume_buffered_agent_message_delta(
    delta: &str,
    buffered: &mut Option<BufferedAssistantControlDelta>,
) -> Option<String> {
    if let Some(prefix) = buffered.as_mut() {
        prefix.text.push_str(delta);
        if is_hidden_assistant_control_message(&prefix.text) {
            buffered.take();
            return None;
        }
        if is_hidden_assistant_control_message_prefix(&prefix.text) {
            return None;
        }

        let visible = prefix.text.clone();
        buffered.take();
        return Some(visible);
    }

    if is_hidden_assistant_control_message(delta) {
        return None;
    }

    if is_hidden_assistant_control_message_prefix(delta) {
        *buffered = Some(BufferedAssistantControlDelta {
            text: delta.to_string(),
        });
        return None;
    }

    Some(delta.to_string())
}

fn set_assistant_message_text(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    text: String,
    is_streaming: bool,
) {
    let existing_index = snapshot.items.iter().position(|item| {
        matches!(
            item,
            ConversationItem::Message(message)
                if message.id == item_id && message.role == ConversationRole::Assistant
        )
    });

    if text.is_empty() {
        if let Some(index) = existing_index {
            snapshot.items.remove(index);
        }
        return;
    }

    let item = ConversationItem::Message(ConversationMessageItem {
        id: item_id.to_string(),
        turn_id: Some(turn_id.to_string()),
        role: ConversationRole::Assistant,
        text,
        images: None,
        is_streaming,
    });
    upsert_item(&mut snapshot.items, item);
}

fn sync_plan_mode_agent_message(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    raw_text: &str,
    is_streaming: bool,
) {
    let visible_text = strip_proposed_plan_blocks(raw_text);
    set_assistant_message_text(snapshot, turn_id, item_id, visible_text, is_streaming);

    let Some(markdown) = extract_proposed_plan_text(raw_text) else {
        return;
    };

    let status = if is_streaming {
        ProposedPlanStatus::Streaming
    } else {
        ProposedPlanStatus::Ready
    };

    if let Some(plan) = snapshot
        .proposed_plan
        .as_mut()
        .filter(|plan| plan.turn_id == turn_id)
    {
        plan.item_id = Some(item_id.to_string());
        plan.markdown = markdown;
        plan.status = status;
        plan.is_awaiting_decision = matches!(status, ProposedPlanStatus::Ready);
        return;
    }

    snapshot.proposed_plan = Some(ProposedPlanSnapshot {
        turn_id: turn_id.to_string(),
        item_id: Some(item_id.to_string()),
        explanation: String::new(),
        steps: Vec::new(),
        markdown,
        status,
        is_awaiting_decision: matches!(status, ProposedPlanStatus::Ready),
    });
}

fn snapshot_mode_for_turn(
    snapshot: &ThreadConversationSnapshot,
    turn_id: &str,
    fallback: CollaborationMode,
) -> CollaborationMode {
    if snapshot
        .proposed_plan
        .as_ref()
        .is_some_and(|plan| plan.turn_id == turn_id)
    {
        return CollaborationMode::Plan;
    }
    if snapshot
        .task_plan
        .as_ref()
        .is_some_and(|plan| plan.turn_id == turn_id)
    {
        return CollaborationMode::Build;
    }
    fallback
}

async fn update_snapshot_for_codex_thread<F>(
    state: &Arc<Mutex<SessionState>>,
    codex_thread_id: &str,
    mutate: F,
    events: &EventSink,
) where
    F: FnOnce(&mut ThreadConversationSnapshot),
{
    let maybe_snapshot = {
        let mut state = state.lock().await;
        let Some(local_thread_id) = state.local_thread_by_codex_id.get(codex_thread_id).cloned()
        else {
            return;
        };
        let Some(snapshot) = state.snapshots_by_thread.get_mut(&local_thread_id) else {
            return;
        };
        mutate(snapshot);
        Some(snapshot.clone())
    };

    if let Some(snapshot) = maybe_snapshot {
        emit_snapshot_from_handle(events, snapshot);
    }
}

fn merge_subagent_snapshots(
    existing: &[crate::domain::conversation::SubagentThreadSnapshot],
    incoming: Vec<crate::domain::conversation::SubagentThreadSnapshot>,
) -> Vec<crate::domain::conversation::SubagentThreadSnapshot> {
    merge_subagent_snapshots_with_mode(existing, incoming, true)
}

fn merge_collab_subagent_snapshots(
    existing: &[crate::domain::conversation::SubagentThreadSnapshot],
    incoming: Vec<crate::domain::conversation::SubagentThreadSnapshot>,
) -> Vec<crate::domain::conversation::SubagentThreadSnapshot> {
    merge_subagent_snapshots_with_mode(existing, incoming, false)
}

fn merge_subagent_snapshots_with_mode(
    existing: &[crate::domain::conversation::SubagentThreadSnapshot],
    incoming: Vec<crate::domain::conversation::SubagentThreadSnapshot>,
    overwrite_terminal_status: bool,
) -> Vec<crate::domain::conversation::SubagentThreadSnapshot> {
    let mut merged = existing
        .iter()
        .cloned()
        .map(|subagent| (subagent.thread_id.clone(), subagent))
        .collect::<HashMap<_, _>>();

    for subagent in incoming {
        merged
            .entry(subagent.thread_id.clone())
            .and_modify(|current| {
                if subagent.nickname.is_some() {
                    current.nickname = subagent.nickname.clone();
                }
                if subagent.role.is_some() {
                    current.role = subagent.role.clone();
                }
                if subagent.depth > 0 {
                    current.depth = subagent.depth;
                }
                let regresses_terminal_status = !overwrite_terminal_status
                    && matches!(
                        current.status,
                        crate::domain::conversation::SubagentStatus::Completed
                            | crate::domain::conversation::SubagentStatus::Failed
                    )
                    && matches!(
                        subagent.status,
                        crate::domain::conversation::SubagentStatus::Running
                    );
                if !regresses_terminal_status {
                    current.status = subagent.status;
                }
            })
            .or_insert(subagent);
    }

    let mut values = merged.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.depth
            .cmp(&right.depth)
            .then_with(|| subagent_sort_label(left).cmp(subagent_sort_label(right)))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    values
}

fn apply_subagent_updates(
    snapshot: &mut ThreadConversationSnapshot,
    incoming: Vec<crate::domain::conversation::SubagentThreadSnapshot>,
) {
    snapshot.subagents = merge_subagent_snapshots(&snapshot.subagents, incoming);
    if !can_accept_late_subagent_update(snapshot) && !has_live_subagents(&snapshot.subagents) {
        snapshot.subagents.clear();
    }
}

fn apply_collab_subagent_updates(
    snapshot: &mut ThreadConversationSnapshot,
    incoming: Vec<crate::domain::conversation::SubagentThreadSnapshot>,
) {
    snapshot.subagents = merge_collab_subagent_snapshots(&snapshot.subagents, incoming);
}

fn enrich_subagents_with_metadata(
    subagents: &mut [crate::domain::conversation::SubagentThreadSnapshot],
    metadata: &HashMap<String, SubagentMetadata>,
) {
    for subagent in subagents.iter_mut() {
        let Some(meta) = metadata.get(&subagent.thread_id) else {
            continue;
        };
        if subagent.nickname.is_none() {
            if let Some(nickname) = meta.nickname.as_ref() {
                subagent.nickname = Some(nickname.clone());
            }
        }
        if subagent.role.is_none() {
            if let Some(role) = meta.role.as_ref() {
                subagent.role = Some(role.clone());
            }
        }
    }
}

async fn record_subagent_thread_started(
    state: &Arc<Mutex<SessionState>>,
    events: &EventSink,
    subagent_start: crate::runtime::protocol::SubagentThreadStart,
) {
    let mut updated_snapshots: Vec<ThreadConversationSnapshot> = Vec::new();
    {
        let mut session_state = state.lock().await;
        let thread_id = subagent_start.snapshot.thread_id.clone();
        let entry = session_state
            .subagent_metadata_by_codex_thread_id
            .entry(thread_id.clone())
            .or_default();
        entry.parent_thread_id = Some(subagent_start.parent_thread_id.clone());
        entry.depth = Some(subagent_start.snapshot.depth);
        if let Some(value) = subagent_start.snapshot.nickname.as_ref() {
            entry.nickname = Some(value.clone());
        }
        if let Some(value) = subagent_start.snapshot.role.as_ref() {
            entry.role = Some(value.clone());
        }

        if let Some(local_parent_thread_id) = session_state
            .local_thread_by_codex_id
            .get(&subagent_start.parent_thread_id)
            .cloned()
        {
            if let Some(snapshot) = session_state
                .snapshots_by_thread
                .get_mut(&local_parent_thread_id)
            {
                if can_accept_late_subagent_update(snapshot) {
                    apply_subagent_updates(snapshot, vec![subagent_start.snapshot.clone()]);
                    updated_snapshots.push(snapshot.clone());
                }
            }
        }

        for snapshot in session_state.snapshots_by_thread.values_mut() {
            if updated_snapshots
                .iter()
                .any(|updated| updated.thread_id == snapshot.thread_id)
            {
                continue;
            }
            let mut changed = false;
            let accepts_late_running_status = can_accept_late_subagent_update(snapshot);
            if let Some(subagent) = snapshot
                .subagents
                .iter_mut()
                .find(|candidate| candidate.thread_id == thread_id)
            {
                if subagent.nickname.is_none() && subagent_start.snapshot.nickname.is_some() {
                    subagent.nickname = subagent_start.snapshot.nickname.clone();
                    changed = true;
                }
                if subagent.role.is_none() && subagent_start.snapshot.role.is_some() {
                    subagent.role = subagent_start.snapshot.role.clone();
                    changed = true;
                }
                if subagent.depth == 0 && subagent_start.snapshot.depth > 0 {
                    subagent.depth = subagent_start.snapshot.depth;
                    changed = true;
                }
                if accepts_late_running_status
                    && matches!(
                        subagent.status,
                        crate::domain::conversation::SubagentStatus::Completed
                    )
                    && matches!(
                        subagent_start.snapshot.status,
                        crate::domain::conversation::SubagentStatus::Running
                    )
                {
                    subagent.status = crate::domain::conversation::SubagentStatus::Running;
                    changed = true;
                }
            }
            if changed {
                updated_snapshots.push(snapshot.clone());
            }
        }
    }

    for snapshot in updated_snapshots {
        emit_snapshot_from_handle(events, snapshot);
    }
}

async fn update_subagent_thread_status(
    state: &Arc<Mutex<SessionState>>,
    events: &EventSink,
    thread_id: &str,
    status: &crate::runtime::protocol::ThreadStatusWire,
) {
    let mut updated_snapshots: Vec<ThreadConversationSnapshot> = Vec::new();
    let next_status = crate::runtime::protocol::subagent_status_from_thread_status(status);
    {
        let mut session_state = state.lock().await;
        let metadata = session_state
            .subagent_metadata_by_codex_thread_id
            .get(thread_id)
            .cloned();
        let existing_parent_local_thread_id = metadata
            .as_ref()
            .and_then(|meta| meta.parent_thread_id.as_deref())
            .and_then(|parent_thread_id| {
                session_state
                    .local_thread_by_codex_id
                    .get(parent_thread_id)
                    .cloned()
            });

        if let Some(local_parent_thread_id) = existing_parent_local_thread_id {
            if let Some(snapshot) = session_state
                .snapshots_by_thread
                .get_mut(&local_parent_thread_id)
            {
                if can_accept_late_subagent_update(snapshot)
                    && !snapshot
                        .subagents
                        .iter()
                        .any(|subagent| subagent.thread_id == thread_id)
                {
                    let subagent = crate::domain::conversation::SubagentThreadSnapshot {
                        thread_id: thread_id.to_string(),
                        nickname: metadata.as_ref().and_then(|meta| meta.nickname.clone()),
                        role: metadata.as_ref().and_then(|meta| meta.role.clone()),
                        depth: metadata.as_ref().and_then(|meta| meta.depth).unwrap_or(1),
                        status: next_status,
                    };
                    apply_subagent_updates(snapshot, vec![subagent]);
                    updated_snapshots.push(snapshot.clone());
                }
            }
        }

        for snapshot in session_state.snapshots_by_thread.values_mut() {
            let mut changed = false;
            for subagent in snapshot.subagents.iter_mut() {
                if subagent.thread_id == thread_id && subagent.status != next_status {
                    subagent.status = next_status;
                    changed = true;
                }
            }
            if changed {
                updated_snapshots.push(snapshot.clone());
            }
        }
    }

    for snapshot in updated_snapshots {
        emit_snapshot_from_handle(events, snapshot);
    }
}

fn can_accept_late_subagent_update(snapshot: &ThreadConversationSnapshot) -> bool {
    snapshot.active_turn_id.is_some()
        || matches!(
            snapshot.status,
            crate::domain::conversation::ConversationStatus::Running
                | crate::domain::conversation::ConversationStatus::WaitingForExternalAction
        )
}

fn has_live_subagents(subagents: &[crate::domain::conversation::SubagentThreadSnapshot]) -> bool {
    subagents.iter().any(|subagent| {
        matches!(
            subagent.status,
            crate::domain::conversation::SubagentStatus::Running
        )
    })
}

async fn close_subagent_thread(
    state: &Arc<Mutex<SessionState>>,
    events: &EventSink,
    thread_id: &str,
) {
    let mut updated_snapshots: Vec<ThreadConversationSnapshot> = Vec::new();
    {
        let mut session_state = state.lock().await;
        session_state
            .subagent_metadata_by_codex_thread_id
            .remove(thread_id);

        for snapshot in session_state.snapshots_by_thread.values_mut() {
            let mut changed = false;
            for subagent in snapshot.subagents.iter_mut() {
                if subagent.thread_id == thread_id
                    && matches!(
                        subagent.status,
                        crate::domain::conversation::SubagentStatus::Running
                    )
                {
                    subagent.status = crate::domain::conversation::SubagentStatus::Completed;
                    changed = true;
                }
            }
            if changed {
                updated_snapshots.push(snapshot.clone());
            }
        }
    }

    for snapshot in updated_snapshots {
        emit_snapshot_from_handle(events, snapshot);
    }
}

fn subagent_sort_label(subagent: &crate::domain::conversation::SubagentThreadSnapshot) -> &str {
    subagent
        .nickname
        .as_deref()
        .or(subagent.role.as_deref())
        .unwrap_or(subagent.thread_id.as_str())
}

fn interaction_id_for(interaction: &ConversationInteraction) -> &str {
    match interaction {
        ConversationInteraction::Approval(request) => &request.id,
        ConversationInteraction::UserInput(request) => &request.id,
        ConversationInteraction::Unsupported(request) => &request.id,
    }
}

fn interaction_thread_id(interaction: &ConversationInteraction) -> &str {
    match interaction {
        ConversationInteraction::Approval(request) => &request.thread_id,
        ConversationInteraction::UserInput(request) => &request.thread_id,
        ConversationInteraction::Unsupported(request) => &request.thread_id,
    }
}

fn approval_response_payload(response: ApprovalResponseInput) -> AppResult<serde_json::Value> {
    match response {
        ApprovalResponseInput::CommandExecution {
            decision,
            execpolicy_amendment,
            network_policy_amendment,
        } => match decision {
            CommandApprovalDecisionInput::Accept => Ok(serde_json::json!({ "decision": "accept" })),
            CommandApprovalDecisionInput::AcceptForSession => {
                Ok(serde_json::json!({ "decision": "acceptForSession" }))
            }
            CommandApprovalDecisionInput::Decline => {
                Ok(serde_json::json!({ "decision": "decline" }))
            }
            CommandApprovalDecisionInput::Cancel => Ok(serde_json::json!({ "decision": "cancel" })),
            CommandApprovalDecisionInput::AcceptWithExecpolicyAmendment => {
                let execpolicy_amendment = execpolicy_amendment.ok_or_else(|| {
                    AppError::Validation(
                        "An execpolicy amendment is required for this approval decision."
                            .to_string(),
                    )
                })?;
                Ok(serde_json::json!({
                    "decision": {
                        "acceptWithExecpolicyAmendment": {
                            "execpolicy_amendment": execpolicy_amendment
                        }
                    }
                }))
            }
            CommandApprovalDecisionInput::ApplyNetworkPolicyAmendment => {
                let network_policy_amendment = network_policy_amendment.ok_or_else(|| {
                    AppError::Validation(
                        "A network policy amendment is required for this approval decision."
                            .to_string(),
                    )
                })?;
                Ok(serde_json::json!({
                    "decision": {
                        "applyNetworkPolicyAmendment": {
                            "network_policy_amendment": {
                                "action": network_policy_amendment.action,
                                "host": network_policy_amendment.host
                            }
                        }
                    }
                }))
            }
        },
        ApprovalResponseInput::FileChange { decision } => match decision {
            FileChangeApprovalDecisionInput::Accept => {
                Ok(serde_json::json!({ "decision": "accept" }))
            }
            FileChangeApprovalDecisionInput::AcceptForSession => {
                Ok(serde_json::json!({ "decision": "acceptForSession" }))
            }
            FileChangeApprovalDecisionInput::Decline => {
                Ok(serde_json::json!({ "decision": "decline" }))
            }
            FileChangeApprovalDecisionInput::Cancel => {
                Ok(serde_json::json!({ "decision": "cancel" }))
            }
        },
        ApprovalResponseInput::Permissions {
            decision,
            permissions,
            scope,
        } => match decision {
            PermissionsApprovalDecisionInput::Approve => {
                let permissions = permissions.ok_or_else(|| {
                    AppError::Validation(
                        "Permissions approval requires the requested permission profile."
                            .to_string(),
                    )
                })?;
                Ok(serde_json::json!({
                    "permissions": permission_profile_json(&permissions),
                    "scope": match scope.unwrap_or(PermissionGrantScope::Turn) {
                        PermissionGrantScope::Turn => "turn",
                        PermissionGrantScope::Session => "session",
                    }
                }))
            }
            PermissionsApprovalDecisionInput::Decline => Ok(serde_json::json!({
                "permissions": {},
                "scope": "turn"
            })),
        },
    }
}

fn permission_profile_json(
    permissions: &crate::domain::conversation::PermissionProfileSnapshot,
) -> serde_json::Value {
    serde_json::json!({
        "fileSystem": permissions.file_system.as_ref().map(|file_system| {
            serde_json::json!({
                "read": file_system.read,
                "write": file_system.write
            })
        }),
        "network": permissions.network.as_ref().map(|network| {
            serde_json::json!({
                "enabled": network.enabled
            })
        })
    })
}

async fn mark_runtime_disconnected(events: &EventSink, state: &Arc<Mutex<SessionState>>) {
    let snapshots = {
        let mut state = state.lock().await;
        state.pending_server_requests.clear();
        state.turn_modes_by_id.clear();
        state.pending_turn_mode_by_thread.clear();
        state
            .snapshots_by_thread
            .values_mut()
            .filter_map(|snapshot| {
                if !snapshot_has_runtime_work(snapshot) {
                    return None;
                }
                fail_snapshot_for_runtime_disconnect(snapshot);
                Some(snapshot.clone())
            })
            .collect::<Vec<_>>()
    };

    for snapshot in snapshots {
        emit_snapshot_from_handle(events, snapshot);
    }
}

fn snapshot_has_runtime_work(snapshot: &ThreadConversationSnapshot) -> bool {
    matches!(
        snapshot.status,
        ConversationStatus::Running | ConversationStatus::WaitingForExternalAction
    ) || snapshot.active_turn_id.is_some()
        || !snapshot.pending_interactions.is_empty()
        || snapshot
            .task_plan
            .as_ref()
            .is_some_and(|plan| matches!(plan.status, ConversationTaskStatus::Running))
        || snapshot
            .subagents
            .iter()
            .any(|subagent| matches!(subagent.status, SubagentStatus::Running))
}

fn fail_snapshot_for_runtime_disconnect(snapshot: &mut ThreadConversationSnapshot) {
    if let Some(task_plan) = snapshot.task_plan.as_mut() {
        let is_active_task = snapshot
            .active_turn_id
            .as_deref()
            .is_some_and(|turn_id| turn_id == task_plan.turn_id);
        if is_active_task || matches!(task_plan.status, ConversationTaskStatus::Running) {
            task_plan.status = ConversationTaskStatus::Failed;
        }
    }
    snapshot.active_turn_id = None;
    snapshot.status = ConversationStatus::Failed;
    snapshot.subagents.clear();
    snapshot.pending_interactions.clear();
    snapshot.error = Some(crate::domain::conversation::ConversationErrorSnapshot {
        message: "The Codex runtime disconnected unexpectedly.".to_string(),
        codex_error_info: None,
        additional_details: None,
    });
}

fn emit_snapshot_from_handle(events: &EventSink, snapshot: ThreadConversationSnapshot) {
    queue_snapshot_emit(events.clone(), snapshot);
}

fn queue_snapshot_emit(events: EventSink, snapshot: ThreadConversationSnapshot) {
    snapshot_store::save(&snapshot);
    tokio::spawn(async move {
        let signature = SnapshotEmitSignature::from_snapshot(&snapshot);
        let thread_id = snapshot.thread_id.clone();
        let emit_state = snapshot_emit_state();
        let action = {
            let mut emits = emit_state.lock().await;
            let entry = emits.entry(thread_id.clone()).or_default();
            update_buffered_snapshot_emit(entry, signature, snapshot.clone())
        };

        match action {
            BufferedSnapshotEmitAction::EmitNow => {
                emit_snapshot_payload(&events, snapshot);
            }
            BufferedSnapshotEmitAction::Buffered => {}
            BufferedSnapshotEmitAction::ScheduleFlush => {
                tokio::spawn(async move {
                    sleep(SNAPSHOT_EMIT_DEBOUNCE).await;
                    let next_snapshot = {
                        let mut emits = emit_state.lock().await;
                        emits.get_mut(&thread_id).and_then(take_buffered_snapshot)
                    };

                    if let Some(snapshot) = next_snapshot {
                        emit_snapshot_payload(&events, snapshot);
                    }
                });
            }
        }
    });
}

fn update_buffered_snapshot_emit(
    entry: &mut BufferedSnapshotEmit,
    signature: SnapshotEmitSignature,
    snapshot: ThreadConversationSnapshot,
) -> BufferedSnapshotEmitAction {
    if entry.last_emitted_signature.as_ref() != Some(&signature) {
        entry.last_emitted_signature = Some(signature);
        entry.latest_snapshot = None;
        return BufferedSnapshotEmitAction::EmitNow;
    }

    entry.latest_snapshot = Some(snapshot);
    if entry.scheduled {
        BufferedSnapshotEmitAction::Buffered
    } else {
        entry.scheduled = true;
        BufferedSnapshotEmitAction::ScheduleFlush
    }
}

fn take_buffered_snapshot(entry: &mut BufferedSnapshotEmit) -> Option<ThreadConversationSnapshot> {
    entry.scheduled = false;
    entry.latest_snapshot.take()
}

fn emit_snapshot_payload(events: &EventSink, snapshot: ThreadConversationSnapshot) {
    let payload = ConversationEventPayload {
        thread_id: snapshot.thread_id.clone(),
        environment_id: snapshot.environment_id.clone(),
        snapshot,
    };
    events.emit(CONVERSATION_EVENT_NAME, payload);
}

fn snapshot_emit_state() -> &'static Mutex<HashMap<String, BufferedSnapshotEmit>> {
    SNAPSHOT_EMIT_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn clear_buffered_snapshot_emits(thread_ids: &[String]) {
    if thread_ids.is_empty() {
        return;
    }

    let mut emits = snapshot_emit_state().lock().await;
    for thread_id in thread_ids {
        emits.remove(thread_id);
    }
}

fn conversation_item_is_streaming(item: &ConversationItem) -> bool {
    match item {
        ConversationItem::Message(message) => message.is_streaming,
        ConversationItem::Reasoning(reasoning) => reasoning.is_streaming,
        ConversationItem::Tool(_)
        | ConversationItem::AutoApprovalReview(_)
        | ConversationItem::System(_) => false,
    }
}

trait ConversationItemSnapshotExt {
    fn id(&self) -> &str;
}

impl ConversationItemSnapshotExt for ConversationItem {
    fn id(&self) -> &str {
        match self {
            ConversationItem::Message(message) => message.id.as_str(),
            ConversationItem::Reasoning(reasoning) => reasoning.id.as_str(),
            ConversationItem::Tool(tool) => tool.id.as_str(),
            ConversationItem::AutoApprovalReview(review) => review.id.as_str(),
            ConversationItem::System(system) => system.id.as_str(),
        }
    }
}

fn emit_usage_update_from_params(
    usage_updates: &Option<mpsc::UnboundedSender<RuntimeUsageUpdate>>,
    environment_id: &str,
    environment_path: &str,
    codex_binary_path: Option<&str>,
    params: &Value,
) {
    let Some(usage_updates) = usage_updates.as_ref() else {
        return;
    };
    let Some(update) =
        usage_update_payload(environment_id, environment_path, codex_binary_path, params)
    else {
        return;
    };
    if let Err(error) = usage_updates.send(update) {
        warn!("failed to forward codex usage snapshot: {error}");
    }
}

fn usage_update_payload(
    environment_id: &str,
    environment_path: &str,
    codex_binary_path: Option<&str>,
    params: &Value,
) -> Option<RuntimeUsageUpdate> {
    let rate_limits = params.get("rateLimits")?.clone();
    Some(RuntimeUsageUpdate {
        environment_id: environment_id.to_string(),
        environment_path: environment_path.to_string(),
        codex_binary_path: codex_binary_path.map(str::to_string),
        rate_limits,
    })
}

fn model_is_available(
    capabilities: &EnvironmentCapabilitiesSnapshot,
    provider: ProviderKind,
    model_id: &str,
) -> bool {
    capabilities
        .models
        .iter()
        .any(|model| model.id == model_id && model.provider == provider)
}

fn model_supports_image_input(
    capabilities: &EnvironmentCapabilitiesSnapshot,
    provider: ProviderKind,
    model_id: &str,
) -> bool {
    capabilities
        .models
        .iter()
        .find(|model| model.id == model_id && model.provider == provider)
        .map(|model| model.input_modalities.contains(&InputModality::Image))
        .unwrap_or(false)
}

fn model_supports_service_tier(
    capabilities: &EnvironmentCapabilitiesSnapshot,
    provider: ProviderKind,
    model_id: &str,
    service_tier: ServiceTier,
) -> bool {
    capabilities
        .models
        .iter()
        .find(|model| model.id == model_id && model.provider == provider)
        .map(|model| model.supported_service_tiers.contains(&service_tier))
        .unwrap_or(false)
}

fn mark_item_streaming(item: ConversationItem) -> ConversationItem {
    match item {
        ConversationItem::Reasoning(mut reasoning) => {
            reasoning.is_streaming = true;
            ConversationItem::Reasoning(reasoning)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::conversation::{
        CollaborationModeOption, ConversationComposerSettings, ConversationItemStatus,
        ConversationToolItem, EnvironmentCapabilitiesSnapshot, InputModality, ModelOption,
    };
    use crate::domain::settings::{ApprovalPolicy, ReasoningEffort, ServiceTier};

    fn test_session_with_snapshot(snapshot: ThreadConversationSnapshot) -> RuntimeSession {
        RuntimeSession::from_snapshot_for_test(snapshot)
    }

    #[test]
    fn initialize_requests_get_the_extended_timeout_budget() {
        assert_eq!(
            request_timeout_for("initialize"),
            INITIALIZE_REQUEST_TIMEOUT
        );
        assert_eq!(request_timeout_for("thread/start"), REQUEST_TIMEOUT);
    }

    #[test]
    fn reconcile_snapshot_status_preserves_failed_without_error_payload() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.status = ConversationStatus::Failed;
        snapshot.error = None;
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "assistant-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: ConversationRole::Assistant,
                text: "Something went wrong".to_string(),
                images: None,
                is_streaming: false,
            }));

        reconcile_snapshot_status(&mut snapshot);

        assert!(matches!(snapshot.status, ConversationStatus::Failed));
    }

    #[test]
    fn reconcile_snapshot_status_keeps_task_only_history_completed() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.status = ConversationStatus::Completed;
        snapshot.task_plan = Some(crate::domain::conversation::ConversationTaskSnapshot {
            turn_id: "turn-1".to_string(),
            item_id: Some("plan-item-1".to_string()),
            explanation: "Codex finished the task list.".to_string(),
            steps: Vec::new(),
            markdown: "## Tasks\n\n- Inspect runtime".to_string(),
            status: crate::domain::conversation::ConversationTaskStatus::Completed,
        });

        reconcile_snapshot_status(&mut snapshot);

        assert!(matches!(snapshot.status, ConversationStatus::Completed));
    }

    #[test]
    fn update_turn_mode_tracking_only_keeps_running_turns() {
        let mut state = SessionState::default();
        state
            .pending_turn_mode_by_thread
            .insert("thread-1".to_string(), CollaborationMode::Build);

        update_turn_mode_tracking(
            &mut state,
            "thread-1",
            "turn-1",
            CollaborationMode::Build,
            ConversationStatus::Completed,
        );

        assert!(state.pending_turn_mode_by_thread.is_empty());
        assert!(state.turn_modes_by_id.is_empty());
    }

    #[test]
    fn model_supports_image_input_requires_explicit_image_modality() {
        let capabilities = EnvironmentCapabilitiesSnapshot {
            environment_id: "env-1".to_string(),
            providers: Vec::new(),
            models: vec![
                ModelOption {
                    provider: ProviderKind::Codex,
                    id: "gpt-5.4".to_string(),
                    display_name: "GPT-5.4".to_string(),
                    description: "Primary".to_string(),
                    default_reasoning_effort: ReasoningEffort::High,
                    supported_reasoning_efforts: vec![ReasoningEffort::High],
                    input_modalities: vec![InputModality::Text],
                    supported_service_tiers: vec![],
                    supports_thinking: false,
                    is_default: true,
                },
                ModelOption {
                    provider: ProviderKind::Codex,
                    id: "gpt-5.4-vision".to_string(),
                    display_name: "GPT-5.4 Vision".to_string(),
                    description: "Vision".to_string(),
                    default_reasoning_effort: ReasoningEffort::High,
                    supported_reasoning_efforts: vec![ReasoningEffort::High],
                    input_modalities: vec![InputModality::Text, InputModality::Image],
                    supported_service_tiers: vec![ServiceTier::Fast],
                    supports_thinking: false,
                    is_default: false,
                },
            ],
            collaboration_modes: vec![CollaborationModeOption {
                id: "build".to_string(),
                label: "Build".to_string(),
                mode: CollaborationMode::Build,
                model: None,
                reasoning_effort: None,
            }],
        };

        assert!(!model_supports_image_input(
            &capabilities,
            ProviderKind::Codex,
            "gpt-5.4"
        ));
        assert!(model_supports_image_input(
            &capabilities,
            ProviderKind::Codex,
            "gpt-5.4-vision"
        ));
        assert!(!model_supports_image_input(
            &capabilities,
            ProviderKind::Claude,
            "gpt-5.4-vision"
        ));
        assert!(!model_supports_image_input(
            &capabilities,
            ProviderKind::Codex,
            "unknown-model"
        ));
    }

    #[test]
    fn model_supports_service_tier_requires_explicit_support() {
        let capabilities = EnvironmentCapabilitiesSnapshot {
            environment_id: "env-1".to_string(),
            providers: Vec::new(),
            models: vec![
                ModelOption {
                    provider: ProviderKind::Codex,
                    id: "gpt-5.4".to_string(),
                    display_name: "GPT-5.4".to_string(),
                    description: "Primary".to_string(),
                    default_reasoning_effort: ReasoningEffort::High,
                    supported_reasoning_efforts: vec![ReasoningEffort::High],
                    input_modalities: vec![InputModality::Text],
                    supported_service_tiers: vec![ServiceTier::Fast],
                    supports_thinking: false,
                    is_default: true,
                },
                ModelOption {
                    provider: ProviderKind::Codex,
                    id: "gpt-5.3-codex".to_string(),
                    display_name: "GPT-5.3-Codex".to_string(),
                    description: "Fallback".to_string(),
                    default_reasoning_effort: ReasoningEffort::Medium,
                    supported_reasoning_efforts: vec![ReasoningEffort::Medium],
                    input_modalities: vec![InputModality::Text],
                    supported_service_tiers: vec![],
                    supports_thinking: false,
                    is_default: false,
                },
            ],
            collaboration_modes: Vec::new(),
        };

        assert!(model_supports_service_tier(
            &capabilities,
            ProviderKind::Codex,
            "gpt-5.4",
            ServiceTier::Fast
        ));
        assert!(!model_supports_service_tier(
            &capabilities,
            ProviderKind::Codex,
            "gpt-5.3-codex",
            ServiceTier::Fast
        ));
        assert!(!model_supports_service_tier(
            &capabilities,
            ProviderKind::Claude,
            "gpt-5.4",
            ServiceTier::Fast
        ));
        assert!(!model_supports_service_tier(
            &capabilities,
            ProviderKind::Codex,
            "unknown-model",
            ServiceTier::Fast
        ));
    }

    #[tokio::test]
    async fn has_keep_alive_work_is_false_for_completed_history() {
        let session = test_session_with_snapshot(make_completed_snapshot());

        assert!(!session.has_keep_alive_work().await);
    }

    #[tokio::test]
    async fn has_keep_alive_work_is_true_for_waiting_or_running_subagents() {
        let mut snapshot = make_completed_snapshot();
        snapshot.status = ConversationStatus::WaitingForExternalAction;
        let waiting_session = test_session_with_snapshot(snapshot.clone());
        assert!(waiting_session.has_keep_alive_work().await);

        snapshot.status = ConversationStatus::Completed;
        snapshot.subagents = vec![crate::domain::conversation::SubagentThreadSnapshot {
            thread_id: "subagent-1".to_string(),
            nickname: Some("Scout".to_string()),
            role: Some("explorer".to_string()),
            depth: 1,
            status: SubagentStatus::Running,
        }];
        let subagent_session = test_session_with_snapshot(snapshot);
        assert!(subagent_session.has_keep_alive_work().await);
    }

    #[test]
    fn duplicate_snapshot_signatures_are_buffered_until_the_flush() {
        let mut entry = BufferedSnapshotEmit::default();
        let first = make_streaming_snapshot("First");
        let second = make_streaming_snapshot("Second");

        let first_action = update_buffered_snapshot_emit(
            &mut entry,
            SnapshotEmitSignature::from_snapshot(&first),
            first,
        );
        let second_action = update_buffered_snapshot_emit(
            &mut entry,
            SnapshotEmitSignature::from_snapshot(&second),
            second.clone(),
        );

        assert!(matches!(first_action, BufferedSnapshotEmitAction::EmitNow));
        assert!(matches!(
            second_action,
            BufferedSnapshotEmitAction::ScheduleFlush
        ));
        assert_eq!(
            take_buffered_snapshot(&mut entry)
                .expect("buffered snapshot should be kept")
                .items
                .last()
                .and_then(|item| match item {
                    ConversationItem::Message(message) => Some(message.text.as_str()),
                    _ => None,
                }),
            Some("Second")
        );
    }

    #[test]
    fn subagent_label_changes_are_emitted_immediately() {
        let mut entry = BufferedSnapshotEmit::default();
        let mut unnamed = make_completed_snapshot();
        unnamed.subagents = vec![crate::domain::conversation::SubagentThreadSnapshot {
            thread_id: "subagent-1".to_string(),
            nickname: None,
            role: None,
            depth: 1,
            status: SubagentStatus::Running,
        }];
        let mut named = unnamed.clone();
        named.subagents[0].nickname = Some("azur".to_string());

        assert!(matches!(
            update_buffered_snapshot_emit(
                &mut entry,
                SnapshotEmitSignature::from_snapshot(&unnamed),
                unnamed
            ),
            BufferedSnapshotEmitAction::EmitNow
        ));
        assert!(matches!(
            update_buffered_snapshot_emit(
                &mut entry,
                SnapshotEmitSignature::from_snapshot(&named),
                named
            ),
            BufferedSnapshotEmitAction::EmitNow
        ));
        assert!(take_buffered_snapshot(&mut entry).is_none());
    }

    #[test]
    fn final_snapshot_updates_clear_stale_buffered_duplicates() {
        let mut entry = BufferedSnapshotEmit::default();
        let first = make_streaming_snapshot("First");
        let buffered = make_streaming_snapshot("Buffered");
        let final_snapshot = make_completed_snapshot();

        assert!(matches!(
            update_buffered_snapshot_emit(
                &mut entry,
                SnapshotEmitSignature::from_snapshot(&first),
                first
            ),
            BufferedSnapshotEmitAction::EmitNow
        ));
        assert!(matches!(
            update_buffered_snapshot_emit(
                &mut entry,
                SnapshotEmitSignature::from_snapshot(&buffered),
                buffered
            ),
            BufferedSnapshotEmitAction::ScheduleFlush
        ));
        assert!(matches!(
            update_buffered_snapshot_emit(
                &mut entry,
                SnapshotEmitSignature::from_snapshot(&final_snapshot),
                final_snapshot
            ),
            BufferedSnapshotEmitAction::EmitNow
        ));
        assert!(take_buffered_snapshot(&mut entry).is_none());
    }

    #[tokio::test]
    async fn stop_clears_buffered_snapshot_emit_state_for_loaded_threads() {
        let session = test_session_with_snapshot(make_completed_snapshot());
        snapshot_emit_state().lock().await.insert(
            "thread-1".to_string(),
            BufferedSnapshotEmit {
                last_emitted_signature: Some(SnapshotEmitSignature::from_snapshot(
                    &make_completed_snapshot(),
                )),
                latest_snapshot: Some(make_streaming_snapshot("Buffered")),
                scheduled: true,
            },
        );

        session
            .stop()
            .await
            .expect("test session should stop cleanly");

        assert!(
            !snapshot_emit_state().lock().await.contains_key("thread-1"),
            "stopped sessions should clear buffered emit state"
        );
    }

    #[tokio::test]
    async fn plan_target_for_item_or_turn_persists_heading_mode_for_future_updates() {
        let snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        let state = Arc::new(Mutex::new(SessionState {
            snapshots_by_thread: HashMap::from([("thread-1".to_string(), snapshot)]),
            local_thread_by_codex_id: HashMap::from([(
                "thr_codex".to_string(),
                "thread-1".to_string(),
            )]),
            capabilities: None,
            buffered_assistant_control_deltas: HashMap::new(),
            raw_agent_message_text_by_item: HashMap::new(),
            pending_server_requests: HashMap::new(),
            turn_modes_by_id: HashMap::new(),
            pending_turn_mode_by_thread: HashMap::new(),
            subagent_metadata_by_codex_thread_id: HashMap::new(),
            stream_assistant_responses: true,
        }));
        let item = serde_json::json!({
            "id": "plan-item-1",
            "type": "plan",
            "text": "## Proposed plan\n\n- Inspect runtime"
        });

        let target = plan_target_for_item_or_turn(&state, "thr_codex", "turn-1", &item).await;

        assert!(matches!(target, PlanTarget::Proposed));
        assert!(matches!(
            plan_target_for_turn(&state, "thr_codex", "turn-1").await,
            PlanTarget::Proposed
        ));
        let state = state.lock().await;
        assert_eq!(
            state.turn_modes_by_id.get("turn-1"),
            Some(&CollaborationMode::Plan)
        );
    }

    fn make_completed_snapshot() -> ThreadConversationSnapshot {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.status = ConversationStatus::Completed;
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "assistant-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: ConversationRole::Assistant,
                text: "Done".to_string(),
                images: None,
                is_streaming: false,
            }));
        snapshot
    }

    #[test]
    fn late_subagent_updates_are_only_accepted_for_active_parent_snapshots() {
        let mut snapshot = make_completed_snapshot();
        assert!(!can_accept_late_subagent_update(&snapshot));

        snapshot.status = ConversationStatus::WaitingForExternalAction;
        assert!(can_accept_late_subagent_update(&snapshot));

        snapshot.status = ConversationStatus::Running;
        assert!(can_accept_late_subagent_update(&snapshot));
    }

    #[test]
    fn collab_subagent_merge_allows_completion_but_blocks_terminal_regression() {
        let running = crate::domain::conversation::SubagentThreadSnapshot {
            thread_id: "subagent-1".to_string(),
            nickname: Some("Scout".to_string()),
            role: Some("worker".to_string()),
            depth: 1,
            status: crate::domain::conversation::SubagentStatus::Running,
        };
        let completed = crate::domain::conversation::SubagentThreadSnapshot {
            status: crate::domain::conversation::SubagentStatus::Completed,
            ..running.clone()
        };

        let merged = merge_collab_subagent_snapshots(
            std::slice::from_ref(&running),
            vec![completed.clone()],
        );
        assert_eq!(
            merged[0].status,
            crate::domain::conversation::SubagentStatus::Completed
        );

        let regressed = merge_collab_subagent_snapshots(&merged, vec![running]);
        assert_eq!(
            regressed[0].status,
            crate::domain::conversation::SubagentStatus::Completed
        );
    }

    #[test]
    fn inactive_snapshot_subagent_refresh_drops_terminal_only_state() {
        let mut snapshot = make_completed_snapshot();
        apply_subagent_updates(
            &mut snapshot,
            vec![crate::domain::conversation::SubagentThreadSnapshot {
                thread_id: "subagent-1".to_string(),
                nickname: Some("Scout".to_string()),
                role: Some("worker".to_string()),
                depth: 1,
                status: crate::domain::conversation::SubagentStatus::Completed,
            }],
        );

        assert!(snapshot.subagents.is_empty());
    }

    fn make_streaming_snapshot(text: &str) -> ThreadConversationSnapshot {
        let mut snapshot = make_completed_snapshot();
        snapshot.status = ConversationStatus::Running;
        snapshot.active_turn_id = Some("turn-1".to_string());
        snapshot.items = vec![ConversationItem::Message(ConversationMessageItem {
            id: "assistant-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            role: ConversationRole::Assistant,
            text: text.to_string(),
            images: None,
            is_streaming: true,
        })];
        snapshot
    }

    #[tokio::test]
    async fn handle_notification_does_not_reuse_a_previous_turns_plan_snapshot() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Plan,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.proposed_plan = Some(crate::domain::conversation::ProposedPlanSnapshot {
            turn_id: "turn-old".to_string(),
            item_id: Some("plan-item-old".to_string()),
            explanation: "Old proposal".to_string(),
            steps: Vec::new(),
            markdown: "## Proposed plan\n\n- Old proposal".to_string(),
            status: crate::domain::conversation::ProposedPlanStatus::Ready,
            is_awaiting_decision: true,
        });

        let state = Arc::new(Mutex::new(SessionState {
            snapshots_by_thread: HashMap::from([("thread-1".to_string(), snapshot)]),
            local_thread_by_codex_id: HashMap::from([(
                "thr_codex".to_string(),
                "thread-1".to_string(),
            )]),
            capabilities: None,
            buffered_assistant_control_deltas: HashMap::new(),
            raw_agent_message_text_by_item: HashMap::new(),
            pending_server_requests: HashMap::new(),
            turn_modes_by_id: HashMap::from([("turn-new".to_string(), CollaborationMode::Plan)]),
            pending_turn_mode_by_thread: HashMap::new(),
            subagent_metadata_by_codex_thread_id: HashMap::new(),
            stream_assistant_responses: true,
        }));

        handle_notification(
            &EventSink::noop(),
            &state,
            "env-1",
            "/tmp/skein",
            Some("/opt/homebrew/bin/codex"),
            &None,
            crate::runtime::protocol::ServerNotificationEnvelope {
                method: "item/started".to_string(),
                params: serde_json::json!({
                    "threadId": "thr_codex",
                    "turnId": "turn-new",
                    "item": {
                        "id": "plan-item-new",
                        "type": "plan",
                        "text": ""
                    }
                }),
            },
        )
        .await;

        let state = state.lock().await;
        let snapshot = state
            .snapshots_by_thread
            .get("thread-1")
            .expect("snapshot should exist");
        assert!(snapshot.proposed_plan.is_none());
    }

    #[tokio::test]
    async fn take_pending_plan_decision_consumes_the_ready_plan_once() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Plan,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.proposed_plan = Some(crate::domain::conversation::ProposedPlanSnapshot {
            turn_id: "turn-1".to_string(),
            item_id: Some("plan-item-1".to_string()),
            explanation: "Inspect runtime".to_string(),
            steps: Vec::new(),
            markdown: "## Proposed plan\n\n- Inspect runtime".to_string(),
            status: crate::domain::conversation::ProposedPlanStatus::Ready,
            is_awaiting_decision: true,
        });
        let session = test_session_with_snapshot(snapshot);

        let consumed = session
            .take_pending_plan_decision("thread-1")
            .await
            .expect("first consume should succeed");
        assert!(!consumed
            .proposed_plan
            .as_ref()
            .is_some_and(|plan| plan.is_awaiting_decision));

        let error = session
            .take_pending_plan_decision("thread-1")
            .await
            .expect_err("second consume should fail");
        assert!(matches!(
            error,
            AppError::Validation(message)
                if message == "The current plan is no longer awaiting a decision."
        ));
    }

    #[tokio::test]
    async fn restore_pending_plan_decision_reopens_a_ready_plan_after_rollback() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Plan,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.proposed_plan = Some(crate::domain::conversation::ProposedPlanSnapshot {
            turn_id: "turn-1".to_string(),
            item_id: Some("plan-item-1".to_string()),
            explanation: "Inspect runtime".to_string(),
            steps: Vec::new(),
            markdown: "## Proposed plan\n\n- Inspect runtime".to_string(),
            status: crate::domain::conversation::ProposedPlanStatus::Ready,
            is_awaiting_decision: true,
        });
        let session = test_session_with_snapshot(snapshot);

        session
            .take_pending_plan_decision("thread-1")
            .await
            .expect("consume should succeed");
        session.restore_pending_plan_decision("thread-1").await;

        let state = session.state.lock().await;
        let snapshot = state
            .snapshots_by_thread
            .get("thread-1")
            .expect("snapshot should exist");
        assert!(snapshot
            .proposed_plan
            .as_ref()
            .is_some_and(|plan| plan.is_awaiting_decision));
    }

    #[tokio::test]
    async fn mark_runtime_disconnected_preserves_idle_snapshots() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.status = ConversationStatus::Completed;
        let session = test_session_with_snapshot(snapshot);

        mark_runtime_disconnected(&EventSink::noop(), &session.state).await;

        let state = session.state.lock().await;
        let snapshot = state
            .snapshots_by_thread
            .get("thread-1")
            .expect("snapshot should exist");
        assert!(matches!(snapshot.status, ConversationStatus::Completed));
        assert!(snapshot.error.is_none());
        assert!(snapshot.active_turn_id.is_none());
    }

    #[tokio::test]
    async fn mark_runtime_disconnected_fails_active_task_trackers() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.active_turn_id = Some("turn-1".to_string());
        snapshot.status = ConversationStatus::Running;
        snapshot.task_plan = Some(crate::domain::conversation::ConversationTaskSnapshot {
            turn_id: "turn-1".to_string(),
            item_id: Some("plan-item-1".to_string()),
            explanation: "Codex is working through the implementation.".to_string(),
            steps: Vec::new(),
            markdown: "## Tasks\n\n- Inspect runtime".to_string(),
            status: crate::domain::conversation::ConversationTaskStatus::Running,
        });

        let state = Arc::new(Mutex::new(SessionState {
            snapshots_by_thread: HashMap::from([("thread-1".to_string(), snapshot)]),
            local_thread_by_codex_id: HashMap::new(),
            capabilities: None,
            buffered_assistant_control_deltas: HashMap::new(),
            raw_agent_message_text_by_item: HashMap::new(),
            pending_server_requests: HashMap::new(),
            turn_modes_by_id: HashMap::new(),
            pending_turn_mode_by_thread: HashMap::new(),
            subagent_metadata_by_codex_thread_id: HashMap::new(),
            stream_assistant_responses: true,
        }));

        mark_runtime_disconnected(&EventSink::noop(), &state).await;

        let state = state.lock().await;
        let snapshot = state
            .snapshots_by_thread
            .get("thread-1")
            .expect("snapshot should exist");
        assert!(matches!(snapshot.status, ConversationStatus::Failed));
        assert!(matches!(
            snapshot.task_plan.as_ref().map(|plan| plan.status),
            Some(crate::domain::conversation::ConversationTaskStatus::Failed)
        ));
        assert!(snapshot.active_turn_id.is_none());
    }

    #[test]
    fn usage_update_payload_preserves_partial_rate_limit_updates() {
        let payload = usage_update_payload(
            "env-1",
            "/tmp/skein",
            Some("/opt/homebrew/bin/codex"),
            &serde_json::json!({
                "rateLimits": {
                    "primary": {
                        "resetsAt": 1_775_306_400
                    }
                }
            }),
        )
        .expect("rate limits payload should be emitted");

        assert_eq!(payload.environment_id, "env-1");
        assert_eq!(payload.environment_path, "/tmp/skein");
        assert_eq!(
            payload.codex_binary_path.as_deref(),
            Some("/opt/homebrew/bin/codex")
        );
        assert_eq!(
            payload.rate_limits["primary"]["resetsAt"],
            serde_json::json!(1_775_306_400)
        );
        assert!(payload.rate_limits["primary"].get("usedPercent").is_none());
        assert!(payload.rate_limits.get("secondary").is_none());
    }

    #[test]
    fn usage_update_payload_requires_rate_limits_object() {
        assert!(usage_update_payload(
            "env-1",
            "/tmp/skein",
            Some("/opt/homebrew/bin/codex"),
            &serde_json::json!({})
        )
        .is_none());
    }

    #[test]
    fn sync_plan_mode_agent_message_extracts_structured_plan_blocks() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Plan,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );

        sync_plan_mode_agent_message(
            &mut snapshot,
            "turn-1",
            "assistant-1",
            "Intro\n<proposed_plan>\n# Migration Plan\n\n1. Audit\n</proposed_plan>\nOutro",
            false,
        );

        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            ConversationItem::Message(message)
                if message.id == "assistant-1" && message.text == "Intro\nOutro"
        )));
        assert_eq!(
            snapshot
                .proposed_plan
                .as_ref()
                .map(|plan| plan.markdown.as_str()),
            Some("\n# Migration Plan\n\n1. Audit\n")
        );
        assert_eq!(
            snapshot.proposed_plan.as_ref().map(|plan| plan.status),
            Some(ProposedPlanStatus::Ready)
        );
        assert_eq!(
            snapshot
                .proposed_plan
                .as_ref()
                .map(|plan| plan.is_awaiting_decision),
            Some(true)
        );
    }

    #[test]
    fn sync_plan_mode_agent_message_streaming_plan_blocks_hide_empty_assistant_messages() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Plan,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );

        sync_plan_mode_agent_message(
            &mut snapshot,
            "turn-1",
            "assistant-1",
            "<proposed_plan>\n# Migration Plan\n",
            true,
        );

        assert!(snapshot.items.is_empty());
        assert_eq!(
            snapshot.proposed_plan.as_ref().map(|plan| plan.status),
            Some(ProposedPlanStatus::Streaming)
        );
        assert_eq!(
            snapshot
                .proposed_plan
                .as_ref()
                .map(|plan| plan.is_awaiting_decision),
            Some(false)
        );
    }

    #[tokio::test]
    async fn handle_notification_updates_reasoning_and_tool_output() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.items = vec![ConversationItem::Tool(ConversationToolItem {
            id: "tool-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool_type: "commandExecution".to_string(),
            title: "Command".to_string(),
            status: ConversationItemStatus::InProgress,
            summary: Some("npm test".to_string()),
            output: String::new(),
        })];

        let state = Arc::new(Mutex::new(SessionState {
            snapshots_by_thread: HashMap::from([("thread-1".to_string(), snapshot)]),
            local_thread_by_codex_id: HashMap::from([(
                "thr_codex".to_string(),
                "thread-1".to_string(),
            )]),
            capabilities: None,
            buffered_assistant_control_deltas: HashMap::new(),
            raw_agent_message_text_by_item: HashMap::new(),
            pending_server_requests: HashMap::new(),
            turn_modes_by_id: HashMap::new(),
            pending_turn_mode_by_thread: HashMap::new(),
            subagent_metadata_by_codex_thread_id: HashMap::new(),
            stream_assistant_responses: true,
        }));

        handle_notification(
            &EventSink::noop(),
            &state,
            "env-1",
            "/tmp/skein",
            Some("/opt/homebrew/bin/codex"),
            &None,
            crate::runtime::protocol::ServerNotificationEnvelope {
                method: "item/reasoning/summaryTextDelta".to_string(),
                params: serde_json::json!({
                    "threadId": "thr_codex",
                    "turnId": "turn-1",
                    "itemId": "reasoning-1",
                    "delta": "Inspecting files"
                }),
            },
        )
        .await;
        handle_notification(
            &EventSink::noop(),
            &state,
            "env-1",
            "/tmp/skein",
            Some("/opt/homebrew/bin/codex"),
            &None,
            crate::runtime::protocol::ServerNotificationEnvelope {
                method: "item/commandExecution/outputDelta".to_string(),
                params: serde_json::json!({
                    "threadId": "thr_codex",
                    "turnId": "turn-1",
                    "itemId": "tool-1",
                    "delta": "ok\n"
                }),
            },
        )
        .await;

        let state = state.lock().await;
        let snapshot = state
            .snapshots_by_thread
            .get("thread-1")
            .expect("snapshot should exist");
        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            ConversationItem::Reasoning(reasoning) if reasoning.summary == "Inspecting files"
        )));
        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            ConversationItem::Tool(tool) if tool.id == "tool-1" && tool.output == "ok\n"
        )));
    }
}
