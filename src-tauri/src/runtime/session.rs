use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{error, warn};
use uuid::Uuid;

use crate::domain::conversation::{
    ApprovalResponseInput, CommandApprovalDecisionInput, ComposerMentionBindingInput,
    ConversationEventPayload, ConversationInteraction, ConversationItem, ConversationMessageItem,
    ConversationRole, ConversationStatus, EnvironmentCapabilitiesSnapshot,
    FileChangeApprovalDecisionInput, PermissionGrantScope, PermissionsApprovalDecisionInput,
    PlanDecisionAction, RespondToUserInputRequestInput, SubmitPlanDecisionInput,
    ThreadComposerCatalog, ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::domain::settings::CollaborationMode;
use crate::domain::workspace::CodexRateLimitSnapshot;
use crate::error::{AppError, AppResult};
use crate::runtime::codex_paths::build_codex_process_path;
use crate::runtime::protocol::{
    append_agent_delta, append_plan_delta, append_reasoning_boundary, append_reasoning_content,
    append_reasoning_summary, append_tool_output, approval_policy_value, build_history_snapshot,
    clear_streaming_flags, collaboration_mode_options_from_response, collaboration_mode_payload,
    complete_proposed_plan, conversation_status_from_turn_status, error_snapshot,
    initialize_params, initialized_notification, loaded_subagents_for_primary, mark_plan_approved,
    mark_plan_superseded, model_options_from_response, normalize_item,
    normalize_server_interaction, parse_incoming_message, plan_approval_message,
    proposed_plan_from_item, proposed_plan_from_turn_update, sandbox_policy_value,
    subagents_from_collab_item, token_usage_snapshot, upsert_item, user_input_payload,
    AccountRateLimitsReadResponse, AppInfoWire, AppsListResponse, CollaborationModeListResponse,
    ErrorNotification, FuzzyFileSearchMatchTypeWire, FuzzyFileSearchResponse, IncomingMessage,
    ItemDeltaNotification, ItemNotification, ModelListResponse, OutgoingNamedInput,
    OutgoingTextElement, OutgoingUserInputPayload, PlanDeltaNotification,
    ReasoningBoundaryNotification, SkillsListResponse, ThreadListResponse,
    ThreadLoadedListResponse, ThreadReadResponse, ThreadStartResponse, TokenUsageNotification,
    TurnCompletedNotification, TurnPlanUpdatedNotification, TurnResponse, TurnStartedNotification,
    CODEX_USAGE_EVENT_NAME, CONVERSATION_EVENT_NAME,
};
use crate::services::composer::{
    build_thread_catalog, connector_mention_slug, load_prompt_definitions, resolve_composer_text,
    trim_file_search_results, AppBinding, SkillBinding,
};
use crate::services::workspace::ThreadRuntimeContext;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

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

#[derive(Default)]
struct SessionState {
    snapshots_by_thread: HashMap<String, ThreadConversationSnapshot>,
    local_thread_by_codex_id: HashMap<String, String>,
    capabilities: Option<EnvironmentCapabilitiesSnapshot>,
    pending_server_requests: HashMap<String, PendingServerRequest>,
}

#[derive(Debug, Clone)]
struct PendingServerRequest {
    json_rpc_id: serde_json::Value,
    thread_id: String,
}

#[derive(Debug, Clone)]
pub struct SendMessageResult {
    pub snapshot: ThreadConversationSnapshot,
    pub new_codex_thread_id: Option<String>,
}

pub struct RuntimeSession {
    app: Option<AppHandle>,
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
        app: AppHandle,
        environment_id: String,
        environment_path: String,
        binary_path: String,
        app_version: String,
    ) -> AppResult<Self> {
        Self::spawn_with_app(
            Some(app),
            environment_id,
            environment_path,
            binary_path,
            app_version,
        )
        .await
    }

    pub async fn spawn_headless(
        environment_id: String,
        environment_path: String,
        binary_path: String,
        app_version: String,
    ) -> AppResult<Self> {
        Self::spawn_with_app(
            None,
            environment_id,
            environment_path,
            binary_path,
            app_version,
        )
        .await
    }

    async fn spawn_with_app(
        app: Option<AppHandle>,
        environment_id: String,
        environment_path: String,
        binary_path: String,
        app_version: String,
    ) -> AppResult<Self> {
        let mut command = Command::new(&binary_path);
        command
            .arg("app-server")
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
            app,
            environment_id,
            app_version,
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
        _environment_path: String,
        app_version: String,
        writer: W,
        reader: R,
    ) -> AppResult<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::from_transport(
            None,
            environment_id,
            app_version,
            SessionTransport {
                writer: Box::new(writer),
                reader,
                stderr_reader: tokio::io::empty(),
                child: None,
            },
        )
        .await
    }

    async fn from_transport<R, E>(
        app: Option<AppHandle>,
        environment_id: String,
        app_version: String,
        transport: SessionTransport<R, E>,
    ) -> AppResult<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        E: AsyncRead + Unpin + Send + 'static,
    {
        let writer = Arc::new(Mutex::new(transport.writer));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let state = Arc::new(Mutex::new(SessionState::default()));

        let stdout_task = spawn_stdout_task(
            app.clone(),
            environment_id.clone(),
            pending.clone(),
            state.clone(),
            transport.reader,
        );
        let stderr_task = spawn_stderr_task(environment_id.clone(), transport.stderr_reader);

        let session = Self {
            app,
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
            .send_request("initialize", initialize_params(&app_version))
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
                let snapshot_clone = snapshot.clone();
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
                let snapshot = build_history_snapshot(
                    context.thread_id.clone(),
                    context.environment_id.clone(),
                    Some(codex_thread_id.clone()),
                    context.composer.clone(),
                    read_response.thread,
                );
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
                state
                    .snapshots_by_thread
                    .insert(context.thread_id.clone(), snapshot.clone());
                snapshot
            }
            None => {
                let snapshot = ThreadConversationSnapshot::new(
                    context.thread_id.clone(),
                    context.environment_id.clone(),
                    None,
                    context.composer.clone(),
                );
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
        })
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
    ) -> AppResult<SendMessageResult> {
        self.send_message_with_bindings(context, text, Vec::new())
            .await
    }

    pub async fn send_message_with_bindings(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        self.send_message_with_visibility(context, text, true, mention_bindings)
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
        self.ensure_pending_plan(&context.thread_id).await?;

        if let Some(composer) = input.composer {
            context.composer = composer;
        }

        match input.action {
            PlanDecisionAction::Approve => {
                context.composer.collaboration_mode = CollaborationMode::Build;
                let mut result = self
                    .send_message_with_visibility(
                        context,
                        plan_approval_message().to_string(),
                        false,
                        Vec::new(),
                    )
                    .await?;
                self.mark_plan_state(&result.snapshot.thread_id, mark_plan_approved)
                    .await?;
                result.snapshot = self
                    .push_system_item(
                        &result.snapshot.thread_id,
                        "Plan approved",
                        "ThreadEx approved the current plan and switched the thread to Build mode.",
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
                let mut result = self
                    .send_message_with_visibility(
                        context,
                        trimmed.to_string(),
                        true,
                        input.mention_bindings.unwrap_or_default(),
                    )
                    .await?;
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
        self.state.lock().await.pending_server_requests.clear();
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

    pub async fn read_account_rate_limits(&self) -> AppResult<CodexRateLimitSnapshot> {
        Ok(self
            .request_typed::<AccountRateLimitsReadResponse>(
                "account/rateLimits/read",
                serde_json::json!({}),
            )
            .await?
            .rate_limits)
    }

    pub async fn composer_catalog(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadComposerCatalog> {
        let prompts = load_prompt_definitions(&context.environment_path)?;
        let skills = self.load_skill_bindings(&context.environment_path).await?;
        let apps = self
            .load_app_bindings(context.codex_thread_id.as_deref())
            .await?;
        Ok(build_thread_catalog(&prompts, &skills, &apps))
    }

    pub async fn search_thread_files(
        &self,
        context: ThreadRuntimeContext,
        query: String,
        limit: usize,
    ) -> AppResult<Vec<crate::domain::conversation::ComposerFileSearchResult>> {
        let response = self
            .request_typed::<FuzzyFileSearchResponse>(
                "fuzzyFileSearch",
                serde_json::json!({
                    "query": query,
                    "roots": [context.environment_path],
                    "cancellationToken": context.thread_id,
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
        if let Some(capabilities) = self.state.lock().await.capabilities.clone() {
            return Ok(capabilities);
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

        let capabilities = EnvironmentCapabilitiesSnapshot {
            environment_id: self.environment_id.clone(),
            models: model_options_from_response(models),
            collaboration_modes: collaboration_mode_options_from_response(collaboration_modes),
        };
        self.state.lock().await.capabilities = Some(capabilities.clone());
        Ok(capabilities)
    }

    async fn resolve_outgoing_user_input(
        &self,
        context: &ThreadRuntimeContext,
        visible_text: &str,
        mention_bindings: &[ComposerMentionBindingInput],
    ) -> AppResult<OutgoingUserInputPayload> {
        if !visible_text.contains("/prompts:") && !visible_text.contains('$') {
            return Ok(OutgoingUserInputPayload {
                text: visible_text.to_string(),
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

    async fn send_message_with_visibility(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        visible_to_user: bool,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation("Message cannot be empty.".to_string()));
        }
        let outgoing_input = self
            .resolve_outgoing_user_input(&context, trimmed, &mention_bindings)
            .await?;

        let mut open = self.open_thread(context.clone()).await?;
        let mut rollback_snapshot = open.snapshot.clone();
        if visible_to_user {
            let user_item = ConversationItem::Message(ConversationMessageItem {
                id: format!("local-user-{}", Uuid::now_v7()),
                role: ConversationRole::User,
                text: trimmed.to_string(),
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
                    "sandboxPolicy": sandbox_policy_value(
                        context.composer.approval_policy,
                        &context.environment_path,
                    ),
                    "collaborationMode": collaboration_mode_payload(&context.composer),
                }),
            )
            .await;

        let turn_response = match turn_response {
            Ok(response) => response,
            Err(error) => {
                let snapshot = {
                    let mut state = self.state.lock().await;
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
            let snapshot = state
                .snapshots_by_thread
                .get_mut(&context.thread_id)
                .ok_or_else(|| {
                    AppError::Runtime("Conversation snapshot disappeared unexpectedly.".to_string())
                })?;
            let status = conversation_status_from_turn_status(&turn_response.turn.status);
            snapshot.composer = context.composer.clone();
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

    async fn ensure_pending_plan(&self, thread_id: &str) -> AppResult<()> {
        let state = self.state.lock().await;
        let snapshot = state
            .snapshots_by_thread
            .get(thread_id)
            .ok_or_else(|| AppError::NotFound("Thread conversation is not open.".to_string()))?;
        let plan = snapshot.proposed_plan.as_ref().ok_or_else(|| {
            AppError::Validation("There is no proposed plan to update.".to_string())
        })?;

        if !plan.is_awaiting_decision {
            return Err(AppError::Validation(
                "The current plan is no longer awaiting a decision.".to_string(),
            ));
        }

        Ok(())
    }

    async fn push_system_item(
        &self,
        thread_id: &str,
        title: &str,
        body: &str,
    ) -> AppResult<ThreadConversationSnapshot> {
        self.mutate_snapshot(thread_id, |snapshot| {
            upsert_item(
                &mut snapshot.items,
                ConversationItem::System(crate::domain::conversation::ConversationSystemItem {
                    id: format!("system-{}", Uuid::now_v7()),
                    tone: crate::domain::conversation::ConversationTone::Info,
                    title: title.to_string(),
                    body: body.to_string(),
                }),
            );
            Ok(())
        })
        .await
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
    ) -> AppResult<Vec<crate::domain::conversation::SubagentThreadSnapshot>> {
        let Some(codex_thread_id) = codex_thread_id else {
            return Ok(Vec::new());
        };

        let loaded_thread_ids = self.load_all_loaded_thread_ids().await?;
        if loaded_thread_ids.is_empty() {
            return Ok(Vec::new());
        }

        let subagent_threads = self.load_all_subagent_threads(environment_path).await?;
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

        match timeout(REQUEST_TIMEOUT, receiver).await {
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
        let Some(app) = self.app.as_ref() else {
            return;
        };
        let payload = ConversationEventPayload {
            thread_id: snapshot.thread_id.clone(),
            environment_id: snapshot.environment_id.clone(),
            snapshot: snapshot.clone(),
        };
        if let Err(error) = app.emit(CONVERSATION_EVENT_NAME, payload) {
            warn!("failed to emit conversation snapshot: {error}");
        }
    }
}

fn spawn_stdout_task<R>(
    app: Option<AppHandle>,
    environment_id: String,
    pending: PendingRequestMap,
    state: Arc<Mutex<SessionState>>,
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
                        handle_server_request(&app, &state, request).await;
                    }
                    Ok(IncomingMessage::Notification(notification)) => {
                        handle_notification(&app, &state, &environment_id, notification).await;
                    }
                    Err(error) => {
                        error!("failed to parse codex notification: {error}");
                    }
                },
                Ok(None) => {
                    mark_runtime_disconnected(&app, &state).await;
                    break;
                }
                Err(error) => {
                    error!("failed reading codex stdout: {error}");
                    mark_runtime_disconnected(&app, &state).await;
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
    app: &Option<AppHandle>,
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
    emit_snapshot_from_handle(app, snapshot);
}

async fn handle_notification(
    app: &Option<AppHandle>,
    state: &Arc<Mutex<SessionState>>,
    environment_id: &str,
    notification: crate::runtime::protocol::ServerNotificationEnvelope,
) {
    match notification.method.as_str() {
        "turn/started" => {
            if let Ok(event) =
                serde_json::from_value::<TurnStartedNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        snapshot.active_turn_id = Some(event.turn.id.clone());
                        snapshot.status = ConversationStatus::Running;
                        snapshot.error = None;
                        snapshot.pending_interactions.clear();
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
                )
                .await;
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
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
                )
                .await;
            }
        }
        "turn/plan/updated" => {
            if let Ok(event) =
                serde_json::from_value::<TurnPlanUpdatedNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        snapshot.proposed_plan = Some(proposed_plan_from_turn_update(
                            event.clone(),
                            snapshot.proposed_plan.as_ref(),
                        ));
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
                )
                .await;
            }
        }
        "item/started" | "item/completed" => {
            if let Ok(event) = serde_json::from_value::<ItemNotification>(notification.params) {
                let is_started = notification.method == "item/started";
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        if event.item.get("type").and_then(serde_json::Value::as_str)
                            == Some("plan")
                        {
                            let existing = snapshot.proposed_plan.as_ref();
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
                            reconcile_snapshot_status(snapshot);
                            return;
                        }
                        let collab_subagents = subagents_from_collab_item(&event.item);
                        if !collab_subagents.is_empty() {
                            apply_subagent_updates(snapshot, collab_subagents);
                            reconcile_snapshot_status(snapshot);
                            return;
                        }
                        if let Some(item) = normalize_item(&event.item).map(|item| {
                            if is_started {
                                mark_item_streaming(item)
                            } else {
                                item
                            }
                        }) {
                            upsert_item(&mut snapshot.items, item);
                        }
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
                )
                .await;
            }
        }
        "item/plan/delta" => {
            if let Ok(event) = serde_json::from_value::<PlanDeltaNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
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
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
                )
                .await;
            }
        }
        "item/agentMessage/delta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_agent_delta(&mut snapshot.items, &event.item_id, &event.delta);
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
                )
                .await;
            }
        }
        "item/reasoning/summaryTextDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_reasoning_summary(&mut snapshot.items, &event.item_id, &event.delta);
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
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
                        append_reasoning_boundary(&mut snapshot.items, &event.item_id);
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
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
                        append_reasoning_content(&mut snapshot.items, &event.item_id, &event.delta);
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
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
                        append_tool_output(&mut snapshot.items, &event.item_id, &event.delta);
                        reconcile_snapshot_status(snapshot);
                    },
                    app,
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
                    app,
                )
                .await;
            }
        }
        "account/rateLimits/updated" => {
            emit_usage_from_handle(app, environment_id, &notification.params);
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
                        app,
                    )
                    .await;
                }
            }
        }
        "thread/started" => {
            let _ = environment_id;
        }
        other => {
            warn!("unhandled codex notification: {other}");
        }
    }
}

async fn update_snapshot_for_codex_thread<F>(
    state: &Arc<Mutex<SessionState>>,
    codex_thread_id: &str,
    mutate: F,
    app: &Option<AppHandle>,
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
        emit_snapshot_from_handle(app, snapshot);
    }
}

fn reconcile_snapshot_status(snapshot: &mut ThreadConversationSnapshot) {
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

    snapshot.status = if snapshot.items.is_empty() {
        ConversationStatus::Idle
    } else {
        ConversationStatus::Completed
    };
}

fn merge_subagent_snapshots(
    existing: &[crate::domain::conversation::SubagentThreadSnapshot],
    incoming: Vec<crate::domain::conversation::SubagentThreadSnapshot>,
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
                current.status = subagent.status;
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
    if !has_live_subagents(&snapshot.subagents) {
        snapshot.subagents.clear();
    }
}

fn has_live_subagents(subagents: &[crate::domain::conversation::SubagentThreadSnapshot]) -> bool {
    subagents.iter().any(|subagent| {
        matches!(
            subagent.status,
            crate::domain::conversation::SubagentStatus::Running
        )
    })
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

async fn mark_runtime_disconnected(app: &Option<AppHandle>, state: &Arc<Mutex<SessionState>>) {
    let snapshots = {
        let mut state = state.lock().await;
        state.pending_server_requests.clear();
        state
            .snapshots_by_thread
            .values_mut()
            .map(|snapshot| {
                snapshot.status = ConversationStatus::Failed;
                snapshot.subagents.clear();
                snapshot.pending_interactions.clear();
                snapshot.error = Some(crate::domain::conversation::ConversationErrorSnapshot {
                    message: "The Codex runtime disconnected unexpectedly.".to_string(),
                    codex_error_info: None,
                    additional_details: None,
                });
                snapshot.clone()
            })
            .collect::<Vec<_>>()
    };

    for snapshot in snapshots {
        emit_snapshot_from_handle(app, snapshot);
    }
}

fn emit_snapshot_from_handle(app: &Option<AppHandle>, snapshot: ThreadConversationSnapshot) {
    let Some(app) = app.as_ref() else {
        return;
    };
    let payload = ConversationEventPayload {
        thread_id: snapshot.thread_id.clone(),
        environment_id: snapshot.environment_id.clone(),
        snapshot,
    };
    if let Err(error) = app.emit(CONVERSATION_EVENT_NAME, payload) {
        warn!("failed to emit conversation snapshot: {error}");
    }
}

fn emit_usage_from_handle(app: &Option<AppHandle>, environment_id: &str, params: &Value) {
    let Some(app) = app.as_ref() else {
        return;
    };
    let Some(payload) = usage_event_payload(environment_id, params) else {
        return;
    };
    if let Err(error) = app.emit(CODEX_USAGE_EVENT_NAME, payload) {
        warn!("failed to emit codex usage snapshot: {error}");
    }
}

fn usage_event_payload(environment_id: &str, params: &Value) -> Option<Value> {
    let rate_limits = params.get("rateLimits")?.clone();
    Some(json!({
        "environmentId": environment_id,
        "rateLimits": rate_limits,
    }))
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
    use serde_json::json;

    use super::*;
    use crate::domain::conversation::{
        ConversationComposerSettings, ConversationItemStatus, ConversationToolItem,
    };
    use crate::domain::settings::{ApprovalPolicy, ReasoningEffort};

    #[test]
    fn reconcile_snapshot_status_preserves_failed_without_error_payload() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
            },
        );
        snapshot.status = ConversationStatus::Failed;
        snapshot.error = None;
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "assistant-1".to_string(),
                role: ConversationRole::Assistant,
                text: "Something went wrong".to_string(),
                is_streaming: false,
            }));

        reconcile_snapshot_status(&mut snapshot);

        assert!(matches!(snapshot.status, ConversationStatus::Failed));
    }

    #[test]
    fn usage_event_payload_preserves_partial_rate_limit_updates() {
        let payload = usage_event_payload(
            "env-1",
            &json!({
                "rateLimits": {
                    "primary": {
                        "resetsAt": 1_775_306_400
                    }
                }
            }),
        )
        .expect("rate limits payload should be emitted");

        assert_eq!(payload["environmentId"], json!("env-1"));
        assert_eq!(
            payload["rateLimits"]["primary"]["resetsAt"],
            json!(1_775_306_400)
        );
        assert!(payload["rateLimits"]["primary"]
            .get("usedPercent")
            .is_none());
        assert!(payload["rateLimits"].get("secondary").is_none());
    }

    #[test]
    fn usage_event_payload_requires_rate_limits_object() {
        assert!(usage_event_payload("env-1", &json!({})).is_none());
    }

    #[tokio::test]
    async fn handle_notification_updates_reasoning_and_tool_output() {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
            },
        );
        snapshot.items = vec![ConversationItem::Tool(ConversationToolItem {
            id: "tool-1".to_string(),
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
            pending_server_requests: HashMap::new(),
        }));

        handle_notification(
            &None,
            &state,
            "env-1",
            crate::runtime::protocol::ServerNotificationEnvelope {
                method: "item/reasoning/summaryTextDelta".to_string(),
                params: json!({
                    "threadId": "thr_codex",
                    "turnId": "turn-1",
                    "itemId": "reasoning-1",
                    "delta": "Inspecting files"
                }),
            },
        )
        .await;
        handle_notification(
            &None,
            &state,
            "env-1",
            crate::runtime::protocol::ServerNotificationEnvelope {
                method: "item/commandExecution/outputDelta".to_string(),
                params: json!({
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
