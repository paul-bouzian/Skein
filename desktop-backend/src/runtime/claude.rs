use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{mpsc as std_mpsc, OnceLock};
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;
use uuid::Uuid;

use crate::domain::conversation::{
    ApprovalResponseInput, CollaborationModeOption, CommandApprovalDecisionInput,
    ConversationApprovalKind, ConversationComposerSettings, ConversationErrorSnapshot,
    ConversationEventPayload, ConversationImageAttachment, ConversationInteraction,
    ConversationItem, ConversationItemStatus, ConversationMessageItem, ConversationRole,
    ConversationStatus, ConversationTaskSnapshot, ConversationTaskStatus, ConversationTone,
    ConversationToolItem, EnvironmentCapabilitiesSnapshot, FileChangeApprovalDecisionInput,
    InputModality, ModelOption, PendingApprovalRequest, PendingUserInputOption,
    PendingUserInputQuestion, PendingUserInputRequest, PermissionsApprovalDecisionInput,
    PlanDecisionAction, ProposedPlanSnapshot, ProposedPlanStatus, ProposedPlanStep,
    ProposedPlanStepStatus, ProviderOption, RespondToUserInputRequestInput, SubagentStatus,
    SubagentThreadSnapshot, SubmitPlanDecisionInput, ThreadConversationOpenResponse,
    ThreadConversationSnapshot, ThreadTokenUsageSnapshot, TokenUsageBreakdown,
};
use crate::domain::settings::{
    ApprovalPolicy, CollaborationMode, ProviderKind, ReasoningEffort, ServiceTier,
};
use crate::error::{AppError, AppResult};
use crate::events::EventSink;
use crate::runtime::item_store;
use crate::runtime::protocol::{
    clear_streaming_flags, mark_plan_approved, mark_plan_superseded, merge_persisted_items,
    plan_approval_message, reconcile_snapshot_status, upsert_item, CONVERSATION_EVENT_NAME,
};
use crate::runtime::session::SendMessageResult;
use crate::services::composer::{load_prompt_definitions, resolve_composer_text};
use crate::services::workspace::ThreadRuntimeContext;

const CLAUDE_WORKER_PATH_ENV: &str = "SKEIN_CLAUDE_WORKER_PATH";
const NODE_EXECUTABLE_ENV: &str = "SKEIN_NODE_EXECUTABLE";
const CLAUDE_WORKER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Debug)]
pub struct ClaudeRuntimeSession {
    events: EventSink,
    app_version: String,
    state: Mutex<ClaudeRuntimeState>,
}

#[derive(Debug, Default)]
struct ClaudeRuntimeState {
    snapshots_by_thread: HashMap<String, ThreadConversationSnapshot>,
    control_senders_by_thread: HashMap<String, ClaudeControlSender>,
}

#[derive(Debug, Clone)]
struct ClaudeControlSender {
    turn_id: String,
    sender: mpsc::UnboundedSender<ClaudeControlMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSimpleMessage {
    id: String,
    role: ConversationRole,
    text: String,
    #[serde(default)]
    images: Option<Vec<ConversationImageAttachment>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOpenResult {
    provider_thread_id: Option<String>,
    messages: Vec<ClaudeSimpleMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSendResult {
    provider_thread_id: Option<String>,
    messages: Vec<ClaudeSimpleMessage>,
    #[serde(default)]
    messages_authoritative: Option<bool>,
    plan_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ClaudeControlMessage {
    UserInputResponse {
        interaction_id: String,
        answers: HashMap<String, Vec<String>>,
    },
    ApprovalResponse {
        interaction_id: String,
        approved: bool,
    },
    Interrupt {
        request_id: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ClaudeRuntimeEvent {
    Session {
        provider_thread_id: String,
    },
    AssistantDelta {
        item_id: String,
        delta: String,
    },
    ToolStarted {
        item_id: String,
        tool_name: String,
        title: String,
        summary: Option<String>,
    },
    ToolUpdated {
        item_id: String,
        tool_name: String,
        title: String,
        summary: Option<String>,
    },
    ToolOutput {
        item_id: String,
        delta: String,
        is_error: Option<bool>,
    },
    ToolCompleted {
        item_id: String,
        is_error: Option<bool>,
    },
    Reasoning {
        item_id: String,
        delta: String,
    },
    TokenUsage {
        total: TokenUsageBreakdown,
        last: TokenUsageBreakdown,
        model_context_window: Option<i64>,
    },
    PlanReady {
        item_id: Option<String>,
        markdown: String,
    },
    TaskPlanUpdated {
        item_id: String,
        steps: Vec<ClaudeTaskStep>,
    },
    SubagentStarted {
        item_id: String,
        description: String,
        subagent_type: String,
    },
    SubagentCompleted {
        item_id: String,
        #[serde(default)]
        is_error: Option<bool>,
    },
    UserInputRequest {
        interaction_id: String,
        item_id: String,
        questions: Vec<ClaudeUserInputQuestion>,
    },
    ApprovalRequest {
        interaction_id: String,
        item_id: String,
        tool_name: String,
        title: String,
        summary: Option<String>,
        command: Option<String>,
        reason: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeTaskStep {
    content: String,
    status: ProposedPlanStepStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeUserInputQuestion {
    id: String,
    header: String,
    question: String,
    options: Vec<ClaudeUserInputOption>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeUserInputOption {
    label: String,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOpenPayload {
    provider_thread_id: String,
    cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSendPayload {
    provider_thread_id: Option<String>,
    cwd: String,
    model: String,
    supports_thinking: bool,
    effort: ReasoningEffort,
    service_tier: Option<ServiceTier>,
    collaboration_mode: CollaborationMode,
    approval_policy: ApprovalPolicy,
    claude_binary_path: Option<String>,
    app_version: String,
    visible_text: String,
    text: String,
    images: Vec<ConversationImageAttachment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerRequest<T> {
    id: u64,
    #[serde(rename = "type")]
    kind: &'static str,
    payload: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerResponse<T> {
    id: u64,
    ok: bool,
    result: Option<T>,
    error: Option<ClaudeWorkerError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerEventEnvelope {
    id: u64,
    event: ClaudeRuntimeEvent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerError {
    message: String,
}

impl ClaudeRuntimeSession {
    pub fn new(events: EventSink, app_version: String) -> Self {
        Self {
            events,
            app_version,
            state: Mutex::new(ClaudeRuntimeState::default()),
        }
    }

    pub async fn open_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationOpenResponse> {
        if let Some(snapshot) = self
            .state
            .lock()
            .await
            .snapshots_by_thread
            .get_mut(&context.thread_id)
        {
            snapshot.composer = context.composer.clone();
            snapshot.provider_thread_id = context.provider_thread_id.clone();
            return Ok(ThreadConversationOpenResponse {
                snapshot: snapshot.clone(),
                capabilities: claude_capabilities(&context),
                composer_draft: None,
            });
        }

        let snapshot = self.load_open_snapshot(&context).await?;

        self.state
            .lock()
            .await
            .snapshots_by_thread
            .insert(context.thread_id.clone(), snapshot.clone());

        Ok(ThreadConversationOpenResponse {
            snapshot,
            capabilities: claude_capabilities(&context),
            composer_draft: None,
        })
    }

    async fn load_open_snapshot(
        &self,
        context: &ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        if let Some(provider_thread_id) = context.provider_thread_id.clone() {
            let result = run_claude_worker::<_, ClaudeOpenResult>(
                None,
                "open",
                ClaudeOpenPayload {
                    provider_thread_id: provider_thread_id.clone(),
                    cwd: context.environment_path.clone(),
                },
            )
            .await?;
            let mut snapshot = snapshot_from_claude_messages(
                context,
                result.provider_thread_id.or(Some(provider_thread_id)),
                result.messages,
                ConversationStatus::Completed,
                None,
            );
            merge_persisted_claude_items(&mut snapshot, &context.thread_id);
            Ok(snapshot)
        } else {
            let messages = context
                .handoff
                .as_ref()
                .map(|handoff| {
                    handoff
                        .imported_messages
                        .iter()
                        .map(|message| ClaudeSimpleMessage {
                            id: message.id.clone(),
                            role: message.role,
                            text: message.text.clone(),
                            images: message.images.clone(),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut snapshot = snapshot_from_claude_messages(
                context,
                None,
                messages,
                ConversationStatus::Idle,
                None,
            );
            merge_persisted_claude_items(&mut snapshot, &context.thread_id);
            Ok(snapshot)
        }
    }

    pub async fn send_message(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        images: Vec<ConversationImageAttachment>,
        mention_bindings: Vec<crate::domain::conversation::ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        self.send_message_with_visibility(context, text, images, mention_bindings, true, true)
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
                let system_item_id = format!("system-plan-approved-{}", Uuid::now_v7());
                self.push_system_item(
                    &thread_id,
                    &system_item_id,
                    "Plan approved",
                    "Skein approved the current plan and switched the thread to Build mode.",
                )
                .await?;
                context.composer.collaboration_mode = CollaborationMode::Build;
                let mut result = match self
                    .send_message_with_visibility(
                        context,
                        plan_approval_message().to_string(),
                        Vec::new(),
                        Vec::new(),
                        false,
                        false,
                    )
                    .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        self.remove_item(&thread_id, &system_item_id).await;
                        self.restore_pending_plan_decision(&thread_id).await;
                        return Err(error);
                    }
                };
                result.snapshot = self
                    .mark_plan_state(&result.snapshot.thread_id, mark_plan_approved)
                    .await?;
                Ok(result)
            }
            PlanDecisionAction::Refine => {
                let feedback = input.feedback.unwrap_or_default();
                let trimmed = feedback.trim();
                if trimmed.is_empty() {
                    return Err(AppError::Validation(
                        "Add refinement guidance before asking Claude to revise the plan."
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
                        input.mention_bindings.unwrap_or_default(),
                        true,
                        true,
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

    async fn send_message_with_visibility(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        images: Vec<ConversationImageAttachment>,
        mention_bindings: Vec<crate::domain::conversation::ComposerMentionBindingInput>,
        show_user_message: bool,
        accept_plan_markdown: bool,
    ) -> AppResult<SendMessageResult> {
        if !mention_bindings.is_empty() {
            return Err(AppError::Validation(
                "Claude threads currently support prompt expansion but not app or skill mentions."
                    .to_string(),
            ));
        }
        let visible_text = text.trim();
        validate_claude_message_content(visible_text, &images)?;

        let mut resolved_text = if visible_text.is_empty() {
            String::new()
        } else {
            resolve_text_for_claude(&context, visible_text)?
        };
        let hidden_handoff_context = context
            .handoff_bootstrap_context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        if let Some(prefix) = hidden_handoff_context.as_deref() {
            resolved_text = if resolved_text.trim().is_empty() {
                prefix.to_string()
            } else {
                format!("{prefix}\n\n{resolved_text}")
            };
        }

        let open = self.open_thread(context.clone()).await?;
        let active_turn_id = format!("claude-turn-{}", Uuid::now_v7());
        let (rollback_snapshot, running_snapshot) = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .entry(context.thread_id.clone())
                .or_insert_with(|| open.snapshot.clone());
            if claude_snapshot_has_active_turn(snapshot) {
                return Err(AppError::Runtime(
                    "Claude runtime is already running a turn for this thread.".to_string(),
                ));
            }
            let rollback_snapshot = snapshot.clone();
            snapshot.status = ConversationStatus::Running;
            snapshot.active_turn_id = Some(active_turn_id.clone());
            snapshot.error = None;
            snapshot.pending_interactions.clear();
            if show_user_message {
                snapshot
                    .items
                    .push(ConversationItem::Message(ConversationMessageItem {
                        id: format!("local-user-{}", Uuid::now_v7()),
                        turn_id: None,
                        role: ConversationRole::User,
                        text: visible_text.to_string(),
                        images: if images.is_empty() {
                            None
                        } else {
                            Some(images.clone())
                        },
                        is_streaming: false,
                    }));
            }
            (rollback_snapshot, snapshot.clone())
        };
        self.emit_snapshot(running_snapshot);

        let result = run_claude_worker::<_, ClaudeSendResult>(
            Some(ClaudeWorkerSession {
                session: self,
                thread_id: context.thread_id.as_str(),
                turn_id: active_turn_id.as_str(),
            }),
            "send",
            ClaudeSendPayload {
                provider_thread_id: context.provider_thread_id.clone(),
                cwd: context.environment_path.clone(),
                model: context.composer.model.clone(),
                supports_thinking: claude_model_supports_thinking(&context.composer.model),
                effort: context.composer.reasoning_effort,
                service_tier: supported_claude_service_tier(
                    &context.composer.model,
                    context.composer.service_tier,
                ),
                collaboration_mode: context.composer.collaboration_mode,
                approval_policy: context.composer.approval_policy,
                claude_binary_path: context.claude_binary_path.clone(),
                app_version: self.app_version.clone(),
                visible_text: if show_user_message {
                    visible_text.to_string()
                } else {
                    String::new()
                },
                text: resolved_text,
                images: images.clone(),
            },
        )
        .await;

        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if is_claude_interrupt_error(&error) {
                    let snapshot = self
                        .state
                        .lock()
                        .await
                        .snapshots_by_thread
                        .get(&context.thread_id)
                        .cloned()
                        .unwrap_or_else(|| rollback_snapshot.clone());
                    let new_provider_thread_id = changed_provider_thread_id(
                        context.provider_thread_id.as_deref(),
                        snapshot.provider_thread_id.clone(),
                    );
                    return Ok(SendMessageResult {
                        snapshot,
                        new_provider_thread_id,
                        new_codex_thread_id: None,
                    });
                }
                remove_persisted_claude_items_for_turn(&context.thread_id, &active_turn_id).await;
                let mut snapshot = rollback_snapshot;
                snapshot.status = ConversationStatus::Failed;
                snapshot.error = Some(ConversationErrorSnapshot {
                    message: error.to_string(),
                    codex_error_info: None,
                    additional_details: None,
                });
                self.store_and_emit(snapshot.clone()).await;
                return Err(error);
            }
        };

        let provider_thread_id = result.provider_thread_id.clone();
        let mut snapshot = self
            .state
            .lock()
            .await
            .snapshots_by_thread
            .get(&context.thread_id)
            .cloned()
            .unwrap_or_else(|| open.snapshot.clone());
        snapshot.provider_thread_id = provider_thread_id.clone();
        snapshot.status = ConversationStatus::Completed;
        snapshot.pending_interactions.clear();
        if result.messages_authoritative.unwrap_or(true) {
            let messages = if show_user_message {
                strip_hidden_handoff_context_from_messages(
                    result.messages,
                    hidden_handoff_context.as_deref(),
                    visible_text,
                )
            } else {
                filter_hidden_user_message(result.messages, visible_text)
            };
            merge_claude_messages(&mut snapshot, messages);
        }
        if accept_plan_markdown {
            complete_claude_plan(&mut snapshot, result.plan_markdown);
        }
        complete_current_claude_turn(&mut snapshot, show_user_message);
        clear_streaming_flags(&mut snapshot.items);
        complete_running_tools(&mut snapshot.items);
        clear_claude_active_turn_state(&mut snapshot);
        persist_claude_items_for_turn(&context.thread_id, &snapshot.items, &active_turn_id);
        snapshot.active_turn_id = None;
        if show_user_message {
            attach_current_user_images(&mut snapshot, visible_text, &images);
        }
        reconcile_snapshot_status(&mut snapshot);
        self.store_and_emit(snapshot.clone()).await;

        Ok(SendMessageResult {
            snapshot,
            new_provider_thread_id: changed_provider_thread_id(
                context.provider_thread_id.as_deref(),
                provider_thread_id,
            ),
            new_codex_thread_id: None,
        })
    }

    pub async fn refresh_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        if let Some(active_snapshot) = self
            .state
            .lock()
            .await
            .snapshots_by_thread
            .get(&context.thread_id)
            .filter(|snapshot| claude_snapshot_has_active_turn(snapshot))
            .cloned()
        {
            return Ok(active_snapshot);
        }

        let snapshot = self.load_open_snapshot(&context).await?;
        self.store_and_emit(snapshot.clone()).await;
        Ok(snapshot)
    }

    pub async fn interrupt_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        let (control_sender, snapshot, items_to_persist) = {
            let mut state = self.state.lock().await;
            let active_turn_id = state
                .snapshots_by_thread
                .get(&context.thread_id)
                .and_then(|snapshot| snapshot.active_turn_id.clone());
            let control_sender = active_turn_id.as_deref().and_then(|turn_id| {
                state
                    .control_senders_by_thread
                    .get(&context.thread_id)
                    .filter(|sender| sender.turn_id == turn_id)
                    .cloned()
            });
            let snapshot = state
                .snapshots_by_thread
                .get_mut(&context.thread_id)
                .ok_or_else(|| {
                    AppError::NotFound("Thread conversation is not open.".to_string())
                })?;
            if snapshot.active_turn_id.is_none() {
                return Ok(snapshot.clone());
            }
            let control_sender = control_sender.ok_or_else(|| {
                AppError::Runtime("Claude runtime is not running a turn.".to_string())
            })?;
            snapshot.active_turn_id = None;
            snapshot.status = ConversationStatus::Interrupted;
            snapshot.pending_interactions.clear();
            clear_streaming_flags(&mut snapshot.items);
            complete_running_tools(&mut snapshot.items);
            clear_claude_active_turn_state(snapshot);
            let items_to_persist = active_turn_id
                .clone()
                .map(|turn_id| (turn_id, snapshot.items.clone()));
            reconcile_snapshot_status(snapshot);
            (control_sender, snapshot.clone(), items_to_persist)
        };
        if let Some((turn_id, items)) = items_to_persist {
            persist_claude_items_for_turn_async(context.thread_id.clone(), items, turn_id);
        }
        control_sender
            .sender
            .send(ClaudeControlMessage::Interrupt { request_id: 1 })
            .map_err(|_| {
                AppError::Runtime("Claude runtime stopped before receiving interrupt.".to_string())
            })?;
        self.store_and_emit(snapshot.clone()).await;
        Ok(snapshot)
    }

    pub async fn respond_to_user_input_request(
        &self,
        input: RespondToUserInputRequestInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        let control_sender = {
            let state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get(&input.thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            let request_turn_id = snapshot
                .pending_interactions
                .iter()
                .find_map(|interaction| match interaction {
                    ConversationInteraction::UserInput(request)
                        if request.id == input.interaction_id =>
                    {
                        Some(request.turn_id.as_str())
                    }
                    _ => None,
                })
                .ok_or_else(|| {
                    AppError::Validation("User input request is no longer pending.".to_string())
                })?;
            let control_sender = state
                .control_senders_by_thread
                .get(&input.thread_id)
                .cloned()
                .ok_or_else(|| {
                    AppError::Runtime("Claude runtime is no longer waiting for input.".to_string())
                })?;
            if control_sender.turn_id != request_turn_id {
                return Err(AppError::Runtime(
                    "Claude runtime is no longer waiting for this input request.".to_string(),
                ));
            }
            control_sender
        };
        control_sender
            .sender
            .send(ClaudeControlMessage::UserInputResponse {
                interaction_id: input.interaction_id.clone(),
                answers: input.answers,
            })
            .map_err(|_| {
                AppError::Runtime("Claude runtime stopped before receiving input.".to_string())
            })?;
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(&input.thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            let before = snapshot.pending_interactions.len();
            snapshot.pending_interactions.retain(|interaction| {
                !matches!(interaction, ConversationInteraction::UserInput(request) if request.id == input.interaction_id)
            });
            if before == snapshot.pending_interactions.len() {
                return Err(AppError::Validation(
                    "User input request is no longer pending.".to_string(),
                ));
            }
            if snapshot.pending_interactions.is_empty()
                && snapshot.status == ConversationStatus::WaitingForExternalAction
            {
                snapshot.status = ConversationStatus::Running;
            }
            snapshot.clone()
        };
        self.emit_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn respond_to_approval_request(
        &self,
        thread_id: &str,
        interaction_id: &str,
        response: ApprovalResponseInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        let approved = claude_approval_response_is_approved(&response);
        let control_sender = {
            let state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get(thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            let request_turn_id = snapshot
                .pending_interactions
                .iter()
                .find_map(|interaction| match interaction {
                    ConversationInteraction::Approval(request) if request.id == interaction_id => {
                        Some(request.turn_id.as_str())
                    }
                    _ => None,
                })
                .ok_or_else(|| {
                    AppError::Validation("Approval request is no longer pending.".to_string())
                })?;
            let control_sender = state
                .control_senders_by_thread
                .get(thread_id)
                .cloned()
                .ok_or_else(|| {
                    AppError::Runtime(
                        "Claude runtime is no longer waiting for approval.".to_string(),
                    )
                })?;
            if control_sender.turn_id != request_turn_id {
                return Err(AppError::Runtime(
                    "Claude runtime is no longer waiting for this approval request.".to_string(),
                ));
            }
            control_sender
        };
        control_sender
            .sender
            .send(ClaudeControlMessage::ApprovalResponse {
                interaction_id: interaction_id.to_string(),
                approved,
            })
            .map_err(|_| {
                AppError::Runtime("Claude runtime stopped before receiving approval.".to_string())
            })?;
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            let before = snapshot.pending_interactions.len();
            snapshot.pending_interactions.retain(|interaction| {
                !matches!(interaction, ConversationInteraction::Approval(request) if request.id == interaction_id)
            });
            if before == snapshot.pending_interactions.len() {
                return Err(AppError::Validation(
                    "Approval request is no longer pending.".to_string(),
                ));
            }
            if snapshot.pending_interactions.is_empty()
                && snapshot.status == ConversationStatus::WaitingForExternalAction
            {
                snapshot.status = ConversationStatus::Running;
            }
            snapshot.clone()
        };
        self.emit_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    async fn take_pending_plan_decision(
        &self,
        thread_id: &str,
    ) -> AppResult<ThreadConversationSnapshot> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            let plan = snapshot.proposed_plan.as_mut().ok_or_else(|| {
                AppError::Validation("There is no proposed plan to update.".to_string())
            })?;
            if !matches!(plan.status, ProposedPlanStatus::Ready) {
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
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.store_and_emit(snapshot.clone()).await;
        Ok(snapshot)
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
            if !matches!(plan.status, ProposedPlanStatus::Ready) || plan.is_awaiting_decision {
                return;
            }
            plan.is_awaiting_decision = true;
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.store_and_emit(snapshot).await;
    }

    async fn mark_plan_state<F>(
        &self,
        thread_id: &str,
        mutate: F,
    ) -> AppResult<ThreadConversationSnapshot>
    where
        F: FnOnce(&mut ProposedPlanSnapshot),
    {
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            let plan = snapshot.proposed_plan.as_mut().ok_or_else(|| {
                AppError::Validation("There is no proposed plan to update.".to_string())
            })?;
            mutate(plan);
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.store_and_emit(snapshot.clone()).await;
        Ok(snapshot)
    }

    async fn push_system_item(
        &self,
        thread_id: &str,
        item_id: &str,
        title: &str,
        body: &str,
    ) -> AppResult<ThreadConversationSnapshot> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(thread_id)
                .ok_or_else(|| AppError::Validation("Claude thread is not open.".to_string()))?;
            upsert_item(
                &mut snapshot.items,
                ConversationItem::System(crate::domain::conversation::ConversationSystemItem {
                    id: item_id.to_string(),
                    turn_id: None,
                    tone: ConversationTone::Info,
                    title: title.to_string(),
                    body: body.to_string(),
                }),
            );
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.store_and_emit(snapshot.clone()).await;
        Ok(snapshot)
    }

    async fn remove_item(&self, thread_id: &str, item_id: &str) {
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(snapshot) = state.snapshots_by_thread.get_mut(thread_id) else {
                return;
            };
            snapshot
                .items
                .retain(|item| conversation_item_id(item) != item_id);
            reconcile_snapshot_status(snapshot);
            snapshot.clone()
        };
        self.store_and_emit(snapshot).await;
    }

    async fn apply_runtime_event(&self, thread_id: &str, turn_id: &str, event: ClaudeRuntimeEvent) {
        let event_item_id = claude_event_item_id(&event).map(ToString::to_string);
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(snapshot) = state.snapshots_by_thread.get_mut(thread_id) else {
                return;
            };
            if !apply_claude_event(snapshot, turn_id, event) {
                return;
            }
            snapshot.clone()
        };
        let item_to_persist = event_item_id.and_then(|item_id| {
            snapshot
                .items
                .iter()
                .find(|item| conversation_item_id(item) == item_id)
                .cloned()
        });
        self.emit_snapshot(snapshot);
        if let Some(item) = item_to_persist {
            persist_claude_item_async(thread_id.to_string(), item);
        }
    }

    async fn store_and_emit(&self, snapshot: ThreadConversationSnapshot) {
        self.state
            .lock()
            .await
            .snapshots_by_thread
            .insert(snapshot.thread_id.clone(), snapshot.clone());
        self.emit_snapshot(snapshot);
    }

    fn emit_snapshot(&self, snapshot: ThreadConversationSnapshot) {
        self.events.emit(
            CONVERSATION_EVENT_NAME,
            ConversationEventPayload {
                thread_id: snapshot.thread_id.clone(),
                environment_id: snapshot.environment_id.clone(),
                snapshot,
            },
        );
    }
}

pub fn claude_provider_option(is_default: bool) -> ProviderOption {
    let models = claude_model_options();
    ProviderOption {
        id: ProviderKind::Claude,
        display_name: "Anthropic".to_string(),
        icon: "claude".to_string(),
        is_default,
        models,
    }
}

pub fn claude_model_options() -> Vec<ModelOption> {
    vec![
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-opus-4-7".to_string(),
            display_name: "Claude Opus 4.7".to_string(),
            description: "Most capable Claude model for complex agentic coding.".to_string(),
            default_reasoning_effort: ReasoningEffort::XHigh,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::XHigh,
                ReasoningEffort::Max,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: vec![ServiceTier::Fast],
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-opus-4-7[1m]".to_string(),
            display_name: "Claude Opus 4.7 1M".to_string(),
            description: "Claude Opus 4.7 with the 1M-token context window enabled.".to_string(),
            default_reasoning_effort: ReasoningEffort::XHigh,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::XHigh,
                ReasoningEffort::Max,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: vec![ServiceTier::Fast],
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-opus-4-6".to_string(),
            display_name: "Claude Opus 4.6".to_string(),
            description: "Previous Opus model with strong reasoning and fast mode support."
                .to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: vec![ServiceTier::Fast],
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-opus-4-6[1m]".to_string(),
            display_name: "Claude Opus 4.6 1M".to_string(),
            description: "Claude Opus 4.6 with the 1M-token context window enabled.".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: vec![ServiceTier::Fast],
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-opus-4-5".to_string(),
            display_name: "Claude Opus 4.5".to_string(),
            description: "Anthropic Opus model for agentic coding.".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: Vec::new(),
            supports_thinking: true,
            is_default: true,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-opus-4-5[1m]".to_string(),
            display_name: "Claude Opus 4.5 1M".to_string(),
            description: "Claude Opus 4.5 with the 1M-token context window enabled.".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: Vec::new(),
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-sonnet-4-6".to_string(),
            display_name: "Claude Sonnet 4.6".to_string(),
            description: "Balanced Claude model for fast coding and planning.".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: Vec::new(),
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-sonnet-4-6[1m]".to_string(),
            display_name: "Claude Sonnet 4.6 1M".to_string(),
            description: "Claude Sonnet 4.6 with the 1M-token context window enabled.".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            supported_reasoning_efforts: vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: Vec::new(),
            supports_thinking: true,
            is_default: false,
        },
        ModelOption {
            provider: ProviderKind::Claude,
            id: "claude-haiku-4-5".to_string(),
            display_name: "Claude Haiku 4.5".to_string(),
            description: "Fast Claude model for simple scoped coding tasks.".to_string(),
            default_reasoning_effort: ReasoningEffort::Low,
            supported_reasoning_efforts: vec![ReasoningEffort::Low],
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supported_service_tiers: Vec::new(),
            supports_thinking: false,
            is_default: false,
        },
    ]
}

pub fn claude_capabilities(context: &ThreadRuntimeContext) -> EnvironmentCapabilitiesSnapshot {
    EnvironmentCapabilitiesSnapshot {
        environment_id: context.environment_id.clone(),
        providers: vec![claude_provider_option(matches!(
            context.composer.provider,
            ProviderKind::Claude
        ))],
        models: claude_model_options(),
        collaboration_modes: vec![
            CollaborationModeOption {
                id: "build".to_string(),
                label: "Build".to_string(),
                mode: CollaborationMode::Build,
                model: None,
                reasoning_effort: None,
            },
            CollaborationModeOption {
                id: "plan".to_string(),
                label: "Plan".to_string(),
                mode: CollaborationMode::Plan,
                model: None,
                reasoning_effort: None,
            },
        ],
    }
}

pub fn append_claude_provider(capabilities: &mut EnvironmentCapabilitiesSnapshot) {
    if capabilities
        .providers
        .iter()
        .any(|provider| matches!(provider.id, ProviderKind::Claude))
    {
        return;
    }
    let provider = claude_provider_option(false);
    capabilities.models.extend(provider.models.clone());
    capabilities.providers.push(provider);
}

fn resolve_text_for_claude(
    context: &ThreadRuntimeContext,
    visible_text: &str,
) -> AppResult<String> {
    if !visible_text.contains("/prompts:") {
        return Ok(visible_text.to_string());
    }
    let prompts = load_prompt_definitions(&context.environment_path).unwrap_or_default();
    let resolved = resolve_composer_text(visible_text, &prompts, &[], &[], &[])?;
    Ok(resolved.text)
}

fn validate_claude_message_content(
    visible_text: &str,
    images: &[ConversationImageAttachment],
) -> AppResult<()> {
    if visible_text.trim().is_empty() && images.is_empty() {
        return Err(AppError::Validation(
            "Message must include text or an image.".to_string(),
        ));
    }
    Ok(())
}

fn changed_provider_thread_id(current: Option<&str>, next: Option<String>) -> Option<String> {
    next.filter(|id| current != Some(id.as_str()))
}

fn snapshot_from_claude_messages(
    context: &ThreadRuntimeContext,
    provider_thread_id: Option<String>,
    messages: Vec<ClaudeSimpleMessage>,
    status: ConversationStatus,
    plan_markdown: Option<String>,
) -> ThreadConversationSnapshot {
    let mut snapshot = ThreadConversationSnapshot::new_for_provider(
        context.thread_id.clone(),
        context.environment_id.clone(),
        ProviderKind::Claude,
        provider_thread_id,
        None,
        ConversationComposerSettings {
            provider: ProviderKind::Claude,
            ..context.composer.clone()
        },
    );
    snapshot.status = status;
    snapshot.items = messages
        .into_iter()
        .filter(claude_message_has_visible_content)
        .map(|message| {
            ConversationItem::Message(ConversationMessageItem {
                id: message.id,
                turn_id: None,
                role: message.role,
                text: message.text,
                images: message.images,
                is_streaming: false,
            })
        })
        .collect();
    if let Some(markdown) = plan_markdown.filter(|value| !value.trim().is_empty()) {
        let turn_id = format!("claude-plan-{}", Uuid::now_v7());
        snapshot.proposed_plan = Some(ProposedPlanSnapshot {
            turn_id,
            item_id: None,
            explanation: String::new(),
            steps: Vec::new(),
            markdown,
            status: ProposedPlanStatus::Ready,
            is_awaiting_decision: true,
        });
    }
    reconcile_snapshot_status(&mut snapshot);
    snapshot
}

fn attach_current_user_images(
    snapshot: &mut ThreadConversationSnapshot,
    visible_text: &str,
    images: &[ConversationImageAttachment],
) {
    if images.is_empty() {
        return;
    }
    let Some(ConversationItem::Message(message)) = snapshot
        .items
        .iter_mut()
        .rev()
        .find(|item| matches!(item, ConversationItem::Message(message) if matches!(message.role, ConversationRole::User) && message.text.trim() == visible_text.trim()))
    else {
        return;
    };
    message.images = Some(images.to_vec());
}

fn merge_claude_messages(
    snapshot: &mut ThreadConversationSnapshot,
    messages: Vec<ClaudeSimpleMessage>,
) {
    for message in messages {
        if !claude_message_has_visible_content(&message) {
            continue;
        }
        if snapshot.items.iter().any(
            |item| matches!(item, ConversationItem::Message(existing) if existing.id == message.id),
        ) {
            continue;
        }
        if replace_current_turn_provisional_message(snapshot, &message) {
            continue;
        }
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: message.id,
                turn_id: snapshot.active_turn_id.clone(),
                role: message.role,
                text: message.text,
                images: message.images,
                is_streaming: false,
            }));
    }
}

fn claude_message_has_visible_content(message: &ClaudeSimpleMessage) -> bool {
    !message.text.trim().is_empty()
        || message
            .images
            .as_ref()
            .is_some_and(|images| !images.is_empty())
}

fn replace_current_turn_provisional_message(
    snapshot: &mut ThreadConversationSnapshot,
    message: &ClaudeSimpleMessage,
) -> bool {
    let current_turn_id = snapshot.active_turn_id.as_deref();
    let Some(ConversationItem::Message(existing)) = snapshot.items.iter_mut().rev().find(|item| {
        matches!(
            item,
            ConversationItem::Message(existing)
                if existing.role == message.role
                    && existing.text.trim() == message.text.trim()
                    && is_current_turn_provisional_message(existing, current_turn_id)
        )
    }) else {
        return false;
    };

    existing.id = message.id.clone();
    if message.images.is_some() {
        existing.images = message.images.clone();
    }
    existing.is_streaming = false;
    true
}

fn is_current_turn_provisional_message(
    message: &ConversationMessageItem,
    current_turn_id: Option<&str>,
) -> bool {
    match message.role {
        ConversationRole::User => {
            message.id.starts_with("local-user-") && message.turn_id.is_none()
        }
        ConversationRole::Assistant => {
            message.id.starts_with("claude-turn-")
                && message.id.contains("-assistant-")
                && message.turn_id.as_deref() == current_turn_id
        }
    }
}

fn filter_hidden_user_message(
    messages: Vec<ClaudeSimpleMessage>,
    hidden_text: &str,
) -> Vec<ClaudeSimpleMessage> {
    let hidden_text = hidden_text.trim();
    messages
        .into_iter()
        .filter(|message| {
            !(matches!(&message.role, ConversationRole::User) && message.text.trim() == hidden_text)
        })
        .collect()
}

fn strip_hidden_handoff_context_from_messages(
    messages: Vec<ClaudeSimpleMessage>,
    hidden_context: Option<&str>,
    visible_text: &str,
) -> Vec<ClaudeSimpleMessage> {
    let Some(hidden_context) = hidden_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return messages;
    };
    messages
        .into_iter()
        .map(|mut message| {
            if matches!(message.role, ConversationRole::User)
                && claude_text_starts_with_hidden_context(&message.text, hidden_context)
            {
                message.text = visible_text.to_string();
            }
            message
        })
        .collect()
}

fn claude_text_starts_with_hidden_context(text: &str, hidden_context: &str) -> bool {
    text.trim_start().starts_with(hidden_context)
}

fn conversation_item_id(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::Message(item) => &item.id,
        ConversationItem::Reasoning(item) => &item.id,
        ConversationItem::Tool(item) => &item.id,
        ConversationItem::System(item) => &item.id,
    }
}

fn merge_persisted_claude_items(snapshot: &mut ThreadConversationSnapshot, thread_id: &str) {
    merge_persisted_items(&mut snapshot.items, item_store::load(thread_id));
    finalize_opened_claude_snapshot(snapshot);
    reconcile_snapshot_status(snapshot);
}

fn finalize_opened_claude_snapshot(snapshot: &mut ThreadConversationSnapshot) {
    if snapshot.active_turn_id.is_none() {
        clear_streaming_flags(&mut snapshot.items);
        complete_running_tools(&mut snapshot.items);
    }
}

fn conversation_item_turn_id(item: &ConversationItem) -> Option<&str> {
    match item {
        ConversationItem::Message(item) => item.turn_id.as_deref(),
        ConversationItem::Reasoning(item) => item.turn_id.as_deref(),
        ConversationItem::Tool(item) => item.turn_id.as_deref(),
        ConversationItem::System(item) => item.turn_id.as_deref(),
    }
}

fn persist_claude_items_for_turn(thread_id: &str, items: &[ConversationItem], turn_id: &str) {
    for item in items
        .iter()
        .filter(|item| conversation_item_turn_id(item) == Some(turn_id))
    {
        item_store::save(thread_id, item);
    }
}

fn persist_claude_item_async(thread_id: String, item: ConversationItem) {
    enqueue_claude_persistence(ClaudePersistenceOperation::SaveItem { thread_id, item });
}

fn persist_claude_items_for_turn_async(
    thread_id: String,
    items: Vec<ConversationItem>,
    turn_id: String,
) {
    enqueue_claude_persistence(ClaudePersistenceOperation::SaveTurn {
        thread_id,
        items,
        turn_id,
    });
}

async fn remove_persisted_claude_items_for_turn(thread_id: &str, turn_id: &str) {
    let thread_id = thread_id.to_string();
    let turn_id = turn_id.to_string();
    let (done_tx, done_rx) = std_mpsc::channel();
    enqueue_claude_persistence(ClaudePersistenceOperation::RemoveTurn {
        thread_id,
        turn_id,
        done: Some(done_tx),
    });
    let _ = tokio::task::spawn_blocking(move || done_rx.recv()).await;
}

enum ClaudePersistenceOperation {
    SaveItem {
        thread_id: String,
        item: ConversationItem,
    },
    SaveTurn {
        thread_id: String,
        items: Vec<ConversationItem>,
        turn_id: String,
    },
    RemoveTurn {
        thread_id: String,
        turn_id: String,
        done: Option<std_mpsc::Sender<()>>,
    },
}

static CLAUDE_PERSISTENCE_QUEUE: OnceLock<std_mpsc::Sender<ClaudePersistenceOperation>> =
    OnceLock::new();

fn enqueue_claude_persistence(operation: ClaudePersistenceOperation) {
    if let Err(error) = claude_persistence_sender().send(operation) {
        apply_claude_persistence_operation(error.0);
    }
}

fn claude_persistence_sender() -> &'static std_mpsc::Sender<ClaudePersistenceOperation> {
    CLAUDE_PERSISTENCE_QUEUE.get_or_init(|| {
        let (sender, receiver) = std_mpsc::channel();
        std::thread::Builder::new()
            .name("claude-item-persistence".to_string())
            .spawn(move || {
                while let Ok(operation) = receiver.recv() {
                    apply_claude_persistence_operation(operation);
                }
            })
            .expect("claude persistence worker should start");
        sender
    })
}

fn apply_claude_persistence_operation(operation: ClaudePersistenceOperation) {
    match operation {
        ClaudePersistenceOperation::SaveItem { thread_id, item } => {
            item_store::save(&thread_id, &item);
        }
        ClaudePersistenceOperation::SaveTurn {
            thread_id,
            items,
            turn_id,
        } => {
            persist_claude_items_for_turn(&thread_id, &items, &turn_id);
        }
        ClaudePersistenceOperation::RemoveTurn {
            thread_id,
            turn_id,
            done,
        } => {
            item_store::remove_turn(&thread_id, &turn_id);
            if let Some(done) = done {
                let _ = done.send(());
            }
        }
    }
}

fn claude_event_item_id(event: &ClaudeRuntimeEvent) -> Option<&str> {
    match event {
        ClaudeRuntimeEvent::AssistantDelta { item_id, .. }
        | ClaudeRuntimeEvent::ToolStarted { item_id, .. }
        | ClaudeRuntimeEvent::ToolUpdated { item_id, .. }
        | ClaudeRuntimeEvent::ToolOutput { item_id, .. }
        | ClaudeRuntimeEvent::ToolCompleted { item_id, .. }
        | ClaudeRuntimeEvent::Reasoning { item_id, .. } => Some(item_id),
        ClaudeRuntimeEvent::Session { .. }
        | ClaudeRuntimeEvent::TokenUsage { .. }
        | ClaudeRuntimeEvent::PlanReady { .. }
        | ClaudeRuntimeEvent::TaskPlanUpdated { .. }
        | ClaudeRuntimeEvent::SubagentStarted { .. }
        | ClaudeRuntimeEvent::SubagentCompleted { .. }
        | ClaudeRuntimeEvent::UserInputRequest { .. }
        | ClaudeRuntimeEvent::ApprovalRequest { .. } => None,
    }
}

fn complete_claude_plan(snapshot: &mut ThreadConversationSnapshot, markdown: Option<String>) {
    if let Some(markdown) = markdown.filter(|value| !value.trim().is_empty()) {
        upsert_claude_plan(snapshot, None, markdown, ProposedPlanStatus::Ready, true);
    }
}

fn complete_running_tools(items: &mut [ConversationItem]) {
    for item in items {
        if let ConversationItem::Tool(tool) = item {
            if tool.status == ConversationItemStatus::InProgress {
                tool.status = ConversationItemStatus::Completed;
            }
        }
    }
}

fn complete_current_claude_turn(
    snapshot: &mut ThreadConversationSnapshot,
    include_visible_user_message: bool,
) {
    let Some(turn_id) = snapshot.active_turn_id.clone() else {
        return;
    };

    let first_current_item_index = snapshot.items.iter().position(|item| match item {
        ConversationItem::Message(message) => message.turn_id.as_deref() == Some(turn_id.as_str()),
        ConversationItem::Reasoning(reasoning) => {
            reasoning.turn_id.as_deref() == Some(turn_id.as_str())
        }
        ConversationItem::Tool(tool) => tool.turn_id.as_deref() == Some(turn_id.as_str()),
        ConversationItem::System(system) => system.turn_id.as_deref() == Some(turn_id.as_str()),
    });
    let latest_user_index = if include_visible_user_message {
        snapshot.items.iter().rposition(|item| {
            matches!(
                item,
                ConversationItem::Message(message) if message.role == ConversationRole::User
            )
        })
    } else {
        None
    };

    if let Some(user_index) = latest_user_index {
        if let Some(ConversationItem::Message(message)) = snapshot.items.get_mut(user_index) {
            message.turn_id.get_or_insert_with(|| turn_id.clone());
        }
    }

    let start_index = latest_user_index
        .map(|index| index + 1)
        .or(first_current_item_index)
        .unwrap_or(snapshot.items.len());
    for item in snapshot.items.iter_mut().skip(start_index) {
        match item {
            ConversationItem::Message(message) if message.role == ConversationRole::Assistant => {
                message.turn_id.get_or_insert_with(|| turn_id.clone());
            }
            ConversationItem::Reasoning(reasoning) => {
                reasoning.turn_id.get_or_insert_with(|| turn_id.clone());
            }
            ConversationItem::Tool(tool) => {
                tool.turn_id.get_or_insert_with(|| turn_id.clone());
            }
            _ => {}
        }
    }
}

fn apply_claude_event(
    snapshot: &mut ThreadConversationSnapshot,
    worker_turn_id: &str,
    event: ClaudeRuntimeEvent,
) -> bool {
    let Some(turn_id) = snapshot.active_turn_id.clone() else {
        return false;
    };
    if turn_id != worker_turn_id {
        return false;
    }
    snapshot.status = ConversationStatus::Running;
    match event {
        ClaudeRuntimeEvent::Session { provider_thread_id } => {
            snapshot.provider_thread_id = Some(provider_thread_id);
        }
        ClaudeRuntimeEvent::AssistantDelta { item_id, delta } => {
            append_assistant_delta(snapshot, &turn_id, &item_id, &delta);
        }
        ClaudeRuntimeEvent::ToolStarted {
            item_id,
            tool_name,
            title,
            summary,
        }
        | ClaudeRuntimeEvent::ToolUpdated {
            item_id,
            tool_name,
            title,
            summary,
        } => {
            upsert_tool(snapshot, &turn_id, &item_id, &tool_name, &title, summary);
        }
        ClaudeRuntimeEvent::ToolOutput {
            item_id,
            delta,
            is_error,
        } => {
            append_tool_delta(
                snapshot,
                &turn_id,
                &item_id,
                &delta,
                is_error.unwrap_or(false),
            );
        }
        ClaudeRuntimeEvent::ToolCompleted { item_id, is_error } => {
            complete_tool(snapshot, &turn_id, &item_id, is_error.unwrap_or(false));
        }
        ClaudeRuntimeEvent::Reasoning { item_id, delta } => {
            append_reasoning(snapshot, &turn_id, &item_id, &delta);
        }
        ClaudeRuntimeEvent::TokenUsage {
            total,
            last,
            model_context_window,
        } => {
            snapshot.token_usage = Some(ThreadTokenUsageSnapshot {
                total,
                last,
                model_context_window,
            });
        }
        ClaudeRuntimeEvent::PlanReady { item_id, markdown } => {
            upsert_claude_plan(snapshot, item_id, markdown, ProposedPlanStatus::Ready, true);
        }
        ClaudeRuntimeEvent::TaskPlanUpdated { item_id, steps } => {
            apply_claude_task_plan(snapshot, &turn_id, &item_id, steps);
        }
        ClaudeRuntimeEvent::SubagentStarted {
            item_id,
            description,
            subagent_type,
        } => {
            apply_claude_subagent_started(snapshot, &item_id, description, subagent_type);
        }
        ClaudeRuntimeEvent::SubagentCompleted { item_id, is_error } => {
            apply_claude_subagent_completed(snapshot, &item_id, is_error.unwrap_or(false));
        }
        ClaudeRuntimeEvent::UserInputRequest {
            interaction_id,
            item_id,
            questions,
        } => {
            snapshot.status = ConversationStatus::WaitingForExternalAction;
            if !snapshot.pending_interactions.iter().any(|interaction| {
                matches!(interaction, ConversationInteraction::UserInput(request) if request.id == interaction_id)
            }) {
                snapshot
                    .pending_interactions
                    .push(ConversationInteraction::UserInput(Box::new(
                        PendingUserInputRequest {
                            id: interaction_id,
                            method: "claude/tool/AskUserQuestion".to_string(),
                            thread_id: snapshot.thread_id.clone(),
                            turn_id,
                            item_id,
                            questions: questions
                                .into_iter()
                                .map(|question| PendingUserInputQuestion {
                                    id: question.id,
                                    header: question.header,
                                    question: question.question,
                                    options: question
                                        .options
                                        .into_iter()
                                        .map(|option| PendingUserInputOption {
                                            label: option.label,
                                            description: option.description,
                                    })
                                    .collect(),
                                    is_other: true,
                                    is_secret: false,
                                })
                                .collect(),
                        },
                    )));
            }
        }
        ClaudeRuntimeEvent::ApprovalRequest {
            interaction_id,
            item_id,
            tool_name,
            title,
            summary,
            command,
            reason,
        } => {
            snapshot.status = ConversationStatus::WaitingForExternalAction;
            if !snapshot.pending_interactions.iter().any(|interaction| {
                matches!(interaction, ConversationInteraction::Approval(request) if request.id == interaction_id)
            }) {
                snapshot
                    .pending_interactions
                    .push(ConversationInteraction::Approval(Box::new(
                        PendingApprovalRequest {
                            id: interaction_id,
                            method: "claude/tool/canUseTool".to_string(),
                            thread_id: snapshot.thread_id.clone(),
                            turn_id,
                            item_id,
                            approval_kind: claude_approval_kind(&tool_name),
                            title,
                            summary,
                            reason,
                            command,
                            cwd: None,
                            grant_root: None,
                            permissions: None,
                            network_context: None,
                            proposed_execpolicy_amendment: Vec::new(),
                            proposed_network_policy_amendments: Vec::new(),
                        },
                    )));
            }
        }
    }
    true
}

fn claude_approval_kind(tool_name: &str) -> ConversationApprovalKind {
    match tool_name {
        "Bash" => ConversationApprovalKind::CommandExecution,
        "Edit" | "MultiEdit" | "Write" => ConversationApprovalKind::FileChange,
        _ => ConversationApprovalKind::Permissions,
    }
}

fn claude_approval_response_is_approved(response: &ApprovalResponseInput) -> bool {
    match response {
        ApprovalResponseInput::CommandExecution { decision, .. } => matches!(
            decision,
            CommandApprovalDecisionInput::Accept
                | CommandApprovalDecisionInput::AcceptForSession
                | CommandApprovalDecisionInput::AcceptWithExecpolicyAmendment
                | CommandApprovalDecisionInput::ApplyNetworkPolicyAmendment
        ),
        ApprovalResponseInput::FileChange { decision } => matches!(
            decision,
            FileChangeApprovalDecisionInput::Accept
                | FileChangeApprovalDecisionInput::AcceptForSession
        ),
        ApprovalResponseInput::Permissions { decision, .. } => {
            matches!(decision, PermissionsApprovalDecisionInput::Approve)
        }
    }
}

fn append_assistant_delta(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    delta: &str,
) {
    if delta.is_empty() {
        return;
    }
    if let Some(message) = snapshot.items.iter_mut().find_map(|item| match item {
        ConversationItem::Message(message)
            if message.id == item_id && message.role == ConversationRole::Assistant =>
        {
            Some(message)
        }
        _ => None,
    }) {
        message.turn_id.get_or_insert_with(|| turn_id.to_string());
        message.text.push_str(delta);
        message.is_streaming = true;
        return;
    }
    snapshot
        .items
        .push(ConversationItem::Message(ConversationMessageItem {
            id: item_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            role: ConversationRole::Assistant,
            text: delta.to_string(),
            images: None,
            is_streaming: true,
        }));
}

fn append_reasoning(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    delta: &str,
) {
    if delta.trim().is_empty() {
        return;
    }

    if let Some(reasoning) = snapshot.items.iter_mut().find_map(|item| match item {
        ConversationItem::Reasoning(reasoning) if reasoning.id == item_id => Some(reasoning),
        _ => None,
    }) {
        reasoning.turn_id.get_or_insert_with(|| turn_id.to_string());
        reasoning.summary.push_str(delta);
        reasoning.is_streaming = true;
        return;
    }

    snapshot.items.push(ConversationItem::Reasoning(
        crate::domain::conversation::ConversationReasoningItem {
            id: item_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            summary: delta.to_string(),
            content: String::new(),
            is_streaming: true,
        },
    ));
}

fn upsert_tool(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    tool_name: &str,
    title: &str,
    summary: Option<String>,
) {
    if let Some(tool) = snapshot.items.iter_mut().find_map(|item| match item {
        ConversationItem::Tool(tool) if tool.id == item_id => Some(tool),
        _ => None,
    }) {
        tool.turn_id.get_or_insert_with(|| turn_id.to_string());
        tool.tool_type = tool_name.to_string();
        tool.title = title.to_string();
        tool.summary = summary;
        tool.status = ConversationItemStatus::InProgress;
        return;
    }
    snapshot
        .items
        .push(ConversationItem::Tool(ConversationToolItem {
            id: item_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            tool_type: tool_name.to_string(),
            title: title.to_string(),
            status: ConversationItemStatus::InProgress,
            summary,
            output: String::new(),
        }));
}

fn append_tool_delta(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    delta: &str,
    is_error: bool,
) {
    if let Some(tool) = snapshot.items.iter_mut().find_map(|item| match item {
        ConversationItem::Tool(tool) if tool.id == item_id => Some(tool),
        _ => None,
    }) {
        tool.turn_id.get_or_insert_with(|| turn_id.to_string());
        if !tool.output.is_empty() && !tool.output.ends_with('\n') {
            tool.output.push('\n');
        }
        tool.output.push_str(delta);
        if is_error {
            tool.status = ConversationItemStatus::Failed;
        }
    }
}

fn complete_tool(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    is_error: bool,
) {
    if let Some(tool) = snapshot.items.iter_mut().find_map(|item| match item {
        ConversationItem::Tool(tool) if tool.id == item_id => Some(tool),
        _ => None,
    }) {
        tool.turn_id.get_or_insert_with(|| turn_id.to_string());
        tool.status = if is_error {
            ConversationItemStatus::Failed
        } else {
            ConversationItemStatus::Completed
        };
    }
}

fn upsert_claude_plan(
    snapshot: &mut ThreadConversationSnapshot,
    item_id: Option<String>,
    markdown: String,
    status: ProposedPlanStatus,
    is_awaiting_decision: bool,
) {
    if markdown.trim().is_empty() {
        return;
    }
    let turn_id = snapshot
        .active_turn_id
        .clone()
        .unwrap_or_else(|| format!("claude-plan-{}", Uuid::now_v7()));
    snapshot.proposed_plan = Some(ProposedPlanSnapshot {
        turn_id,
        item_id,
        explanation: String::new(),
        steps: Vec::new(),
        markdown,
        status,
        is_awaiting_decision,
    });
}

fn apply_claude_task_plan(
    snapshot: &mut ThreadConversationSnapshot,
    turn_id: &str,
    item_id: &str,
    steps: Vec<ClaudeTaskStep>,
) {
    if steps.is_empty() {
        if snapshot
            .task_plan
            .as_ref()
            .is_some_and(|plan| plan.turn_id == turn_id)
        {
            snapshot.task_plan = None;
        }
        return;
    }
    let mapped: Vec<ProposedPlanStep> = steps
        .into_iter()
        .map(|step| ProposedPlanStep {
            step: step.content,
            status: step.status,
        })
        .collect();
    let (explanation, markdown) = match snapshot
        .task_plan
        .as_ref()
        .filter(|plan| plan.turn_id == turn_id)
    {
        Some(existing) => (existing.explanation.clone(), existing.markdown.clone()),
        None => (String::new(), String::new()),
    };
    snapshot.task_plan = Some(ConversationTaskSnapshot {
        turn_id: turn_id.to_string(),
        item_id: Some(item_id.to_string()),
        explanation,
        steps: mapped,
        markdown,
        status: ConversationTaskStatus::Running,
    });
}

fn apply_claude_subagent_started(
    snapshot: &mut ThreadConversationSnapshot,
    item_id: &str,
    description: String,
    subagent_type: String,
) {
    if let Some(existing) = snapshot
        .subagents
        .iter_mut()
        .find(|subagent| subagent.thread_id == item_id)
    {
        existing.status = SubagentStatus::Running;
        let trimmed_description = description.trim();
        if !trimmed_description.is_empty() {
            existing.nickname = Some(trimmed_description.to_string());
        }
        let trimmed_role = subagent_type.trim();
        if !trimmed_role.is_empty() {
            existing.role = Some(trimmed_role.to_string());
        }
        return;
    }
    let nickname = {
        let trimmed = description.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    let role = {
        let trimmed = subagent_type.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    snapshot.subagents.push(SubagentThreadSnapshot {
        thread_id: item_id.to_string(),
        nickname,
        role,
        depth: 1,
        status: SubagentStatus::Running,
    });
}

fn apply_claude_subagent_completed(
    snapshot: &mut ThreadConversationSnapshot,
    item_id: &str,
    is_error: bool,
) {
    if let Some(subagent) = snapshot
        .subagents
        .iter_mut()
        .find(|candidate| candidate.thread_id == item_id)
    {
        subagent.status = if is_error {
            SubagentStatus::Failed
        } else {
            SubagentStatus::Completed
        };
    }
}

fn clear_claude_active_turn_state(snapshot: &mut ThreadConversationSnapshot) {
    snapshot.task_plan = None;
    snapshot.subagents.clear();
}

fn supported_claude_service_tier(
    model_id: &str,
    requested: Option<ServiceTier>,
) -> Option<ServiceTier> {
    requested.filter(|tier| {
        claude_model_options()
            .into_iter()
            .find(|model| model.id == model_id)
            .is_some_and(|model| model.supported_service_tiers.contains(tier))
    })
}

fn claude_model_supports_thinking(model_id: &str) -> bool {
    claude_model_options()
        .into_iter()
        .find(|model| model.id == model_id)
        .is_some_and(|model| model.supports_thinking)
}

fn claude_snapshot_has_active_turn(snapshot: &ThreadConversationSnapshot) -> bool {
    snapshot.active_turn_id.is_some()
        || matches!(
            snapshot.status,
            ConversationStatus::Running | ConversationStatus::WaitingForExternalAction
        )
}

fn is_claude_interrupt_error(error: &AppError) -> bool {
    error.to_string().contains("Claude turn was interrupted.")
}

#[derive(Clone, Copy)]
struct ClaudeWorkerSession<'a> {
    session: &'a ClaudeRuntimeSession,
    thread_id: &'a str,
    turn_id: &'a str,
}

async fn run_claude_worker<P, R>(
    session: Option<ClaudeWorkerSession<'_>>,
    kind: &'static str,
    payload: P,
) -> AppResult<R>
where
    P: Serialize,
    R: DeserializeOwned,
{
    let worker_path = std::env::var(CLAUDE_WORKER_PATH_ENV).map_err(|_| {
        AppError::Runtime(
            "Claude runtime worker is unavailable. Rebuild the Electron shell before using Claude."
                .to_string(),
        )
    })?;
    let node_executable = std::env::var(NODE_EXECUTABLE_ENV).unwrap_or_else(|_| "node".to_string());
    let mut child = Command::new(node_executable)
        .arg(worker_path)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::Runtime(format!("Failed to start Claude worker: {error}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Runtime("Claude worker stdin was unavailable.".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Runtime("Claude worker stdout was unavailable.".to_string()))?;
    let stderr = child.stderr.take();

    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!("Claude worker: {line}");
            }
        });
    }

    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<ClaudeControlMessage>();
    if let Some(session) = session {
        if let Err(error) = register_claude_control_sender(session, control_tx).await {
            let _ = child.start_kill();
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Err(error);
        }
    }
    let request = ClaudeWorkerRequest {
        id: 1,
        kind,
        payload,
    };
    let line = match serde_json::to_string(&request) {
        Ok(line) => line,
        Err(error) => {
            stop_claude_worker_after_error(child, session).await;
            return Err(AppError::Runtime(format!(
                "Failed to encode Claude request: {error}"
            )));
        }
    };
    if let Err(error) = stdin.write_all(line.as_bytes()).await {
        stop_claude_worker_after_error(child, session).await;
        return Err(error.into());
    }
    if let Err(error) = stdin.write_all(b"\n").await {
        stop_claude_worker_after_error(child, session).await;
        return Err(error.into());
    }

    let mut child_stdin = stdin;
    tokio::spawn(async move {
        while let Some(message) = control_rx.recv().await {
            let Ok(line) = serde_json::to_string(&message) else {
                continue;
            };
            if child_stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if child_stdin.write_all(b"\n").await.is_err() {
                break;
            }
        }
        let _ = child_stdin.shutdown().await;
    });

    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match timeout(CLAUDE_WORKER_RESPONSE_TIMEOUT, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                clear_claude_control_sender(session).await;
                return Err(error.into());
            }
            Err(_) => {
                stop_claude_worker_after_error(child, session).await;
                return Err(AppError::Runtime(
                    "Claude worker timed out before returning a response.".to_string(),
                ));
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let raw = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(raw) => raw,
            Err(error) => {
                stop_claude_worker_after_error(child, session).await;
                return Err(AppError::Runtime(format!(
                    "Failed to decode Claude worker message: {error}"
                )));
            }
        };
        if raw.get("type").and_then(serde_json::Value::as_str) == Some("event") {
            let event = match serde_json::from_value::<ClaudeWorkerEventEnvelope>(raw) {
                Ok(event) => event,
                Err(error) => {
                    stop_claude_worker_after_error(child, session).await;
                    return Err(AppError::Runtime(format!(
                        "Failed to decode Claude worker event: {error}"
                    )));
                }
            };
            if event.id == 1 {
                if let Some(session) = session {
                    session
                        .session
                        .apply_runtime_event(session.thread_id, session.turn_id, event.event)
                        .await;
                }
            }
            continue;
        }
        let response = match serde_json::from_str::<ClaudeWorkerResponse<R>>(&line) {
            Ok(response) => response,
            Err(error) => {
                stop_claude_worker_after_error(child, session).await;
                return Err(AppError::Runtime(format!(
                    "Failed to decode Claude worker response: {error}"
                )));
            }
        };
        if response.id != 1 {
            continue;
        }
        if response.ok {
            let result = response
                .result
                .ok_or_else(|| AppError::Runtime("Claude worker returned no result.".to_string()));
            let _ = child.start_kill();
            clear_claude_control_sender(session).await;
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return result;
        }
        stop_claude_worker_after_error(child, session).await;
        return Err(AppError::Runtime(
            response
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "Claude worker failed.".to_string()),
        ));
    }

    clear_claude_control_sender(session).await;
    let status = child.wait().await?;
    Err(AppError::Runtime(format!(
        "Claude worker exited without a response: {status}."
    )))
}

async fn stop_claude_worker_after_error(
    mut child: Child,
    session: Option<ClaudeWorkerSession<'_>>,
) {
    let _ = child.start_kill();
    clear_claude_control_sender(session).await;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
}

async fn register_claude_control_sender(
    session: ClaudeWorkerSession<'_>,
    sender: mpsc::UnboundedSender<ClaudeControlMessage>,
) -> AppResult<()> {
    let mut state = session.session.state.lock().await;
    if let Some(existing) = state.control_senders_by_thread.get(session.thread_id) {
        if existing.turn_id != session.turn_id {
            return Err(AppError::Runtime(
                "Claude runtime is already running a turn for this thread.".to_string(),
            ));
        }
    }
    state.control_senders_by_thread.insert(
        session.thread_id.to_string(),
        ClaudeControlSender {
            turn_id: session.turn_id.to_string(),
            sender,
        },
    );
    Ok(())
}

async fn clear_claude_control_sender(session: Option<ClaudeWorkerSession<'_>>) {
    if let Some(session) = session {
        let mut state = session.session.state.lock().await;
        if state
            .control_senders_by_thread
            .get(session.thread_id)
            .is_some_and(|sender| sender.turn_id == session.turn_id)
        {
            state.control_senders_by_thread.remove(session.thread_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::OnceLock;

    use super::*;
    use tokio::sync::Mutex as AsyncMutex;

    struct EnvVarOverride {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarOverride {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarOverride {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn claude_worker_env_lock() -> &'static AsyncMutex<()> {
        static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| AsyncMutex::new(()))
    }

    fn snapshot() -> ThreadConversationSnapshot {
        ThreadConversationSnapshot::new_for_provider(
            "thread-1".to_string(),
            "env-1".to_string(),
            ProviderKind::Claude,
            None,
            None,
            ConversationComposerSettings {
                provider: ProviderKind::Claude,
                model: "claude-sonnet-4-6".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        )
    }

    fn context() -> crate::services::workspace::ThreadRuntimeContext {
        crate::services::workspace::ThreadRuntimeContext {
            thread_id: "thread-1".to_string(),
            environment_id: "env-1".to_string(),
            environment_path: "/tmp/skein".to_string(),
            provider: ProviderKind::Claude,
            provider_thread_id: Some("claude-thread-1".to_string()),
            codex_thread_id: None,
            composer: ConversationComposerSettings {
                provider: ProviderKind::Claude,
                model: "claude-sonnet-4-6".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
            codex_binary_path: None,
            claude_binary_path: None,
            handoff: None,
            handoff_bootstrap_context: None,
            stream_assistant_responses: true,
            multi_agent_nudge_enabled: false,
            multi_agent_nudge_max_subagents: 0,
        }
    }

    #[test]
    fn claude_message_validation_allows_image_only_prompts() {
        let images = vec![ConversationImageAttachment::Image {
            url: "https://example.com/image.png".to_string(),
        }];

        validate_claude_message_content("", &images).expect("image-only prompt should be valid");
    }

    #[test]
    fn claude_message_validation_rejects_empty_prompts_without_images() {
        let error = validate_claude_message_content("   ", &[])
            .expect_err("empty prompt without images should fail");

        assert!(error.to_string().contains("text or an image"));
    }

    #[test]
    fn changed_provider_thread_id_preserves_new_interrupted_session_ids() {
        assert_eq!(
            changed_provider_thread_id(None, Some("claude-session-1".to_string())).as_deref(),
            Some("claude-session-1")
        );
        assert_eq!(
            changed_provider_thread_id(
                Some("claude-session-1"),
                Some("claude-session-1".to_string())
            ),
            None
        );
        assert_eq!(changed_provider_thread_id(Some("old"), None), None);
    }

    #[tokio::test]
    async fn refresh_thread_bypasses_cached_claude_snapshot() {
        let _guard = claude_worker_env_lock().lock().await;
        let worker_path =
            std::env::temp_dir().join(format!("skein-claude-refresh-worker-{}.sh", Uuid::now_v7()));
        std::fs::write(
            &worker_path,
            r#"read line
printf '%s\n' '{"id":1,"ok":true,"result":{"providerThreadId":"provider-refreshed","messages":[{"id":"assistant-refreshed","role":"assistant","text":"fresh from worker"}]}}'
"#,
        )
        .expect("fake Claude worker should be written");
        let _worker_path = EnvVarOverride::set(CLAUDE_WORKER_PATH_ENV, &worker_path);
        let _node_executable = EnvVarOverride::set(NODE_EXECUTABLE_ENV, "/bin/sh");

        let session = ClaudeRuntimeSession::new(EventSink::noop(), "test".to_string());
        let mut cached = snapshot();
        cached.provider_thread_id = Some("provider-cached".to_string());
        cached
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "cached-assistant".to_string(),
                turn_id: None,
                role: ConversationRole::Assistant,
                text: "stale cached answer".to_string(),
                images: None,
                is_streaming: false,
            }));
        session
            .state
            .lock()
            .await
            .snapshots_by_thread
            .insert("thread-1".to_string(), cached);

        let refreshed = session
            .refresh_thread(context())
            .await
            .expect("refresh should re-read Claude history");

        assert_eq!(
            refreshed.provider_thread_id.as_deref(),
            Some("provider-refreshed")
        );
        assert!(refreshed.items.iter().any(|item| matches!(
            item,
            ConversationItem::Message(message)
                if message.role == ConversationRole::Assistant
                    && message.text == "fresh from worker"
        )));
        assert!(!refreshed.items.iter().any(|item| matches!(
            item,
            ConversationItem::Message(message) if message.text == "stale cached answer"
        )));
    }

    #[test]
    fn claude_events_surface_tool_activity_and_assistant_streams() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::Reasoning {
                item_id: "reasoning-1".to_string(),
                delta: "Inspecting".to_string(),
            },
        );
        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::Reasoning {
                item_id: "reasoning-1".to_string(),
                delta: " files".to_string(),
            },
        );
        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::ToolStarted {
                item_id: "tool-1".to_string(),
                tool_name: "Read".to_string(),
                title: "Search".to_string(),
                summary: Some("src/main.ts".to_string()),
            },
        );
        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::ToolOutput {
                item_id: "tool-1".to_string(),
                delta: "file contents".to_string(),
                is_error: Some(false),
            },
        );
        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::ToolCompleted {
                item_id: "tool-1".to_string(),
                is_error: Some(false),
            },
        );
        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::AssistantDelta {
                item_id: "assistant-1".to_string(),
                delta: "Done".to_string(),
            },
        );

        assert!(snapshot.items.iter().any(|item| {
            matches!(
                item,
                ConversationItem::Reasoning(reasoning)
                    if reasoning.id == "reasoning-1"
                        && reasoning.turn_id.as_deref() == Some("turn-1")
                        && reasoning.summary == "Inspecting files"
                        && reasoning.is_streaming
            )
        }));
        assert_eq!(
            snapshot
                .items
                .iter()
                .filter(|item| matches!(item, ConversationItem::Reasoning(reasoning) if reasoning.id == "reasoning-1"))
                .count(),
            1
        );
        assert!(snapshot.items.iter().any(|item| {
            matches!(
                item,
                ConversationItem::Tool(tool)
                    if tool.id == "tool-1"
                        && tool.turn_id.as_deref() == Some("turn-1")
                        && tool.status == ConversationItemStatus::Completed
                        && tool.output.contains("file contents")
            )
        }));
        assert!(snapshot.items.iter().any(|item| {
            matches!(
                item,
                ConversationItem::Message(message)
                    if message.id == "assistant-1"
                        && message.role == ConversationRole::Assistant
                        && message.text == "Done"
                        && message.is_streaming
            )
        }));
    }

    #[test]
    fn empty_claude_task_plan_update_clears_current_turn_plan() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::TaskPlanUpdated {
                item_id: "todo-1".to_string(),
                steps: vec![ClaudeTaskStep {
                    content: "Inspect runtime".to_string(),
                    status: ProposedPlanStepStatus::InProgress,
                }],
            },
        );
        assert!(snapshot.task_plan.is_some());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::TaskPlanUpdated {
                item_id: "todo-1".to_string(),
                steps: Vec::new(),
            },
        );
        assert!(snapshot.task_plan.is_none());
    }

    #[test]
    fn claude_event_item_id_includes_assistant_progress_messages() {
        let event = ClaudeRuntimeEvent::AssistantDelta {
            item_id: "assistant-progress".to_string(),
            delta: "Checking the weather.".to_string(),
        };

        assert_eq!(claude_event_item_id(&event), Some("assistant-progress"));
    }

    #[test]
    fn opened_claude_snapshots_finalize_persisted_streaming_activity() {
        let mut snapshot = snapshot();
        snapshot.items.push(ConversationItem::Reasoning(
            crate::domain::conversation::ConversationReasoningItem {
                id: "reasoning-1".to_string(),
                turn_id: Some("turn-crashed".to_string()),
                summary: "Thinking".to_string(),
                content: String::new(),
                is_streaming: true,
            },
        ));
        snapshot
            .items
            .push(ConversationItem::Tool(ConversationToolItem {
                id: "tool-1".to_string(),
                turn_id: Some("turn-crashed".to_string()),
                tool_type: "WebSearch".to_string(),
                title: "Web".to_string(),
                status: ConversationItemStatus::InProgress,
                summary: Some("weather Bordeaux".to_string()),
                output: String::new(),
            }));

        finalize_opened_claude_snapshot(&mut snapshot);
        reconcile_snapshot_status(&mut snapshot);

        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            ConversationItem::Reasoning(reasoning)
                if reasoning.id == "reasoning-1" && !reasoning.is_streaming
        )));
        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            ConversationItem::Tool(tool)
                if tool.id == "tool-1" && tool.status == ConversationItemStatus::Completed
        )));
        assert_eq!(snapshot.status, ConversationStatus::Completed);
    }

    #[test]
    fn claude_model_supports_thinking_matches_model_catalog() {
        assert!(claude_model_supports_thinking("claude-opus-4-7"));
        assert!(!claude_model_supports_thinking("claude-haiku-4-5"));
        assert!(!claude_model_supports_thinking("unknown-claude-model"));
    }

    #[test]
    fn finalizing_hidden_claude_turn_keeps_work_activity_attached_to_answer() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-approved".to_string());
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "user-plan".to_string(),
                turn_id: None,
                role: ConversationRole::User,
                text: "Fais un plan.".to_string(),
                images: None,
                is_streaming: false,
            }));
        snapshot.items.push(ConversationItem::System(
            crate::domain::conversation::ConversationSystemItem {
                id: "system-plan-approved".to_string(),
                turn_id: None,
                tone: ConversationTone::Info,
                title: "Plan approved".to_string(),
                body: "Skein approved the current plan.".to_string(),
            },
        ));
        snapshot.items.push(ConversationItem::Reasoning(
            crate::domain::conversation::ConversationReasoningItem {
                id: "reasoning-approved".to_string(),
                turn_id: Some("turn-approved".to_string()),
                summary: "Checking sources.".to_string(),
                content: String::new(),
                is_streaming: false,
            },
        ));
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "assistant-approved".to_string(),
                turn_id: None,
                role: ConversationRole::Assistant,
                text: "Done.".to_string(),
                images: None,
                is_streaming: true,
            }));

        complete_current_claude_turn(&mut snapshot, false);

        assert!(matches!(
            &snapshot.items[0],
            ConversationItem::Message(message) if message.turn_id.is_none()
        ));
        assert!(matches!(
            &snapshot.items[3],
            ConversationItem::Message(message)
                if message.turn_id.as_deref() == Some("turn-approved")
        ));
    }

    #[test]
    fn merge_claude_messages_keeps_repeated_text_from_distinct_messages() {
        let mut snapshot = snapshot();
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "assistant-old".to_string(),
                turn_id: Some("turn-old".to_string()),
                role: ConversationRole::Assistant,
                text: "Done".to_string(),
                images: None,
                is_streaming: false,
            }));

        merge_claude_messages(
            &mut snapshot,
            vec![ClaudeSimpleMessage {
                id: "assistant-new".to_string(),
                role: ConversationRole::Assistant,
                text: "Done".to_string(),
                images: None,
            }],
        );

        let repeated = snapshot
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item,
                    ConversationItem::Message(message)
                        if message.role == ConversationRole::Assistant && message.text == "Done"
                )
            })
            .count();
        assert_eq!(repeated, 2);
    }

    #[test]
    fn merge_claude_messages_replaces_current_turn_provisional_messages() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-current".to_string());
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "local-user-temp".to_string(),
                turn_id: None,
                role: ConversationRole::User,
                text: "Thanks".to_string(),
                images: None,
                is_streaming: false,
            }));
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "claude-turn-current-assistant-0".to_string(),
                turn_id: Some("turn-current".to_string()),
                role: ConversationRole::Assistant,
                text: "Done".to_string(),
                images: None,
                is_streaming: true,
            }));

        merge_claude_messages(
            &mut snapshot,
            vec![
                ClaudeSimpleMessage {
                    id: "provider-user".to_string(),
                    role: ConversationRole::User,
                    text: "Thanks".to_string(),
                    images: None,
                },
                ClaudeSimpleMessage {
                    id: "provider-assistant".to_string(),
                    role: ConversationRole::Assistant,
                    text: "Done".to_string(),
                    images: None,
                },
            ],
        );

        assert_eq!(snapshot.items.len(), 2);
        assert!(matches!(
            &snapshot.items[0],
            ConversationItem::Message(message)
                if message.id == "provider-user" && message.text == "Thanks"
        ));
        assert!(matches!(
            &snapshot.items[1],
            ConversationItem::Message(message)
                if message.id == "provider-assistant"
                    && message.text == "Done"
                    && !message.is_streaming
        ));
    }

    #[test]
    fn claude_user_input_event_creates_actionable_interaction() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::UserInputRequest {
                interaction_id: "input-1".to_string(),
                item_id: "tool-ask".to_string(),
                questions: vec![ClaudeUserInputQuestion {
                    id: "scope".to_string(),
                    header: "Scope".to_string(),
                    question: "Which option?".to_string(),
                    options: vec![ClaudeUserInputOption {
                        label: "A".to_string(),
                        description: "Use A".to_string(),
                    }],
                }],
            },
        );

        assert_eq!(
            snapshot.status,
            ConversationStatus::WaitingForExternalAction
        );
        assert!(matches!(
            snapshot.pending_interactions.first(),
            Some(ConversationInteraction::UserInput(request))
                if request.id == "input-1"
                    && request.questions.first().is_some_and(|question| {
                        question.header == "Scope" && question.is_other
                    })
        ));
    }

    #[test]
    fn claude_plan_event_populates_proposed_plan() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::PlanReady {
                item_id: Some("plan-tool".to_string()),
                markdown: "# Plan\n\n- Inspect".to_string(),
            },
        );

        assert!(snapshot.proposed_plan.as_ref().is_some_and(|plan| {
            plan.item_id.as_deref() == Some("plan-tool")
                && plan.markdown.contains("Inspect")
                && plan.is_awaiting_decision
                && plan.status == ProposedPlanStatus::Ready
        }));
    }

    #[test]
    fn claude_events_ignore_interrupted_or_stale_turns() {
        let mut interrupted = snapshot();
        interrupted.status = ConversationStatus::Interrupted;
        interrupted.active_turn_id = None;

        assert!(!apply_claude_event(
            &mut interrupted,
            "turn-1",
            ClaudeRuntimeEvent::AssistantDelta {
                item_id: "assistant-late".to_string(),
                delta: "late".to_string(),
            },
        ));
        assert_eq!(interrupted.status, ConversationStatus::Interrupted);
        assert!(interrupted.items.is_empty());

        let mut mismatched = snapshot();
        mismatched.status = ConversationStatus::Running;
        mismatched.active_turn_id = Some("turn-current".to_string());
        assert!(!apply_claude_event(
            &mut mismatched,
            "turn-old",
            ClaudeRuntimeEvent::AssistantDelta {
                item_id: "assistant-old".to_string(),
                delta: "old".to_string(),
            },
        ));
        assert!(mismatched.items.is_empty());

        assert!(!apply_claude_event(
            &mut mismatched,
            "turn-old",
            ClaudeRuntimeEvent::ToolStarted {
                item_id: "tool-old".to_string(),
                tool_name: "Read".to_string(),
                title: "Search".to_string(),
                summary: Some("README.md".to_string()),
            },
        ));
        assert!(mismatched.items.is_empty());
    }

    #[tokio::test]
    async fn claude_plan_decision_hides_ready_plan_before_marking_approved() {
        let session = ClaudeRuntimeSession::new(EventSink::noop(), "test".to_string());
        let mut snapshot = snapshot();
        snapshot.proposed_plan = Some(ProposedPlanSnapshot {
            turn_id: "turn-plan".to_string(),
            item_id: Some("plan-tool".to_string()),
            explanation: String::new(),
            steps: Vec::new(),
            markdown: "# Plan\n\n- Inspect".to_string(),
            status: ProposedPlanStatus::Ready,
            is_awaiting_decision: true,
        });
        session
            .state
            .lock()
            .await
            .snapshots_by_thread
            .insert("thread-1".to_string(), snapshot);

        let hidden = session
            .take_pending_plan_decision("thread-1")
            .await
            .expect("ready plan can be taken once");
        assert!(hidden.proposed_plan.as_ref().is_some_and(|plan| {
            plan.status == ProposedPlanStatus::Ready && !plan.is_awaiting_decision
        }));

        let with_system = session
            .push_system_item(
                "thread-1",
                "system-plan-approved-test",
                "Plan approved",
                "Skein approved the current plan and switched the thread to Build mode.",
            )
            .await
            .expect("approval status item can be emitted before the follow-up turn");
        assert!(matches!(
            with_system.items.last(),
            Some(ConversationItem::System(item)) if item.id == "system-plan-approved-test"
        ));

        let approved = session
            .mark_plan_state("thread-1", mark_plan_approved)
            .await
            .expect("taken plan can be marked approved");
        assert!(approved.proposed_plan.as_ref().is_some_and(|plan| {
            plan.status == ProposedPlanStatus::Approved && !plan.is_awaiting_decision
        }));
    }

    #[tokio::test]
    async fn clear_claude_control_sender_removes_registered_thread() {
        let session = ClaudeRuntimeSession::new(EventSink::noop(), "test".to_string());
        let (sender, _receiver) = mpsc::unbounded_channel();
        session.state.lock().await.control_senders_by_thread.insert(
            "thread-1".to_string(),
            ClaudeControlSender {
                turn_id: "turn-1".to_string(),
                sender,
            },
        );

        clear_claude_control_sender(Some(ClaudeWorkerSession {
            session: &session,
            thread_id: "thread-1",
            turn_id: "turn-1",
        }))
        .await;

        assert!(!session
            .state
            .lock()
            .await
            .control_senders_by_thread
            .contains_key("thread-1"));
    }

    #[tokio::test]
    async fn interrupt_thread_aborts_active_claude_worker() {
        let session = ClaudeRuntimeSession::new(EventSink::noop(), "test".to_string());
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());
        snapshot.status = ConversationStatus::Running;
        session
            .state
            .lock()
            .await
            .snapshots_by_thread
            .insert("thread-1".to_string(), snapshot);
        session.state.lock().await.control_senders_by_thread.insert(
            "thread-1".to_string(),
            ClaudeControlSender {
                turn_id: "turn-1".to_string(),
                sender,
            },
        );

        let interrupted = session
            .interrupt_thread(context())
            .await
            .expect("active Claude turn should interrupt");

        assert_eq!(interrupted.status, ConversationStatus::Interrupted);
        assert!(interrupted.active_turn_id.is_none());
        assert!(matches!(
            receiver.recv().await,
            Some(ClaudeControlMessage::Interrupt { request_id: 1 })
        ));
    }

    #[tokio::test]
    async fn failed_user_input_control_send_keeps_pending_interaction() {
        let session = ClaudeRuntimeSession::new(EventSink::noop(), "test".to_string());
        let (sender, receiver) = mpsc::unbounded_channel();
        drop(receiver);
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());
        snapshot.status = ConversationStatus::WaitingForExternalAction;
        snapshot
            .pending_interactions
            .push(ConversationInteraction::UserInput(Box::new(
                PendingUserInputRequest {
                    id: "input-1".to_string(),
                    method: "claude/tool/AskUserQuestion".to_string(),
                    thread_id: "thread-1".to_string(),
                    turn_id: "turn-1".to_string(),
                    item_id: "tool-ask".to_string(),
                    questions: Vec::new(),
                },
            )));
        {
            let mut state = session.state.lock().await;
            state
                .snapshots_by_thread
                .insert("thread-1".to_string(), snapshot);
            state.control_senders_by_thread.insert(
                "thread-1".to_string(),
                ClaudeControlSender {
                    turn_id: "turn-1".to_string(),
                    sender,
                },
            );
        }

        let error = session
            .respond_to_user_input_request(RespondToUserInputRequestInput {
                thread_id: "thread-1".to_string(),
                interaction_id: "input-1".to_string(),
                answers: HashMap::new(),
            })
            .await
            .expect_err("closed control channel should fail");

        assert!(error.to_string().contains("stopped before receiving input"));
        let stored = session
            .state
            .lock()
            .await
            .snapshots_by_thread
            .get("thread-1")
            .cloned()
            .expect("snapshot should remain");
        assert_eq!(stored.status, ConversationStatus::WaitingForExternalAction);
        assert_eq!(stored.pending_interactions.len(), 1);
    }

    #[tokio::test]
    async fn failed_approval_control_send_keeps_pending_interaction() {
        let session = ClaudeRuntimeSession::new(EventSink::noop(), "test".to_string());
        let (sender, receiver) = mpsc::unbounded_channel();
        drop(receiver);
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());
        snapshot.status = ConversationStatus::WaitingForExternalAction;
        snapshot
            .pending_interactions
            .push(ConversationInteraction::Approval(Box::new(
                PendingApprovalRequest {
                    id: "approval-1".to_string(),
                    method: "claude/tool/canUseTool".to_string(),
                    thread_id: "thread-1".to_string(),
                    turn_id: "turn-1".to_string(),
                    item_id: "tool-bash".to_string(),
                    approval_kind: ConversationApprovalKind::CommandExecution,
                    title: "Command approval".to_string(),
                    summary: None,
                    reason: None,
                    command: Some("bun run test".to_string()),
                    cwd: None,
                    grant_root: None,
                    permissions: None,
                    network_context: None,
                    proposed_execpolicy_amendment: Vec::new(),
                    proposed_network_policy_amendments: Vec::new(),
                },
            )));
        {
            let mut state = session.state.lock().await;
            state
                .snapshots_by_thread
                .insert("thread-1".to_string(), snapshot);
            state.control_senders_by_thread.insert(
                "thread-1".to_string(),
                ClaudeControlSender {
                    turn_id: "turn-1".to_string(),
                    sender,
                },
            );
        }

        let error = session
            .respond_to_approval_request(
                "thread-1",
                "approval-1",
                ApprovalResponseInput::CommandExecution {
                    decision: CommandApprovalDecisionInput::Accept,
                    execpolicy_amendment: None,
                    network_policy_amendment: None,
                },
            )
            .await
            .expect_err("closed control channel should fail");

        assert!(error
            .to_string()
            .contains("stopped before receiving approval"));
        let stored = session
            .state
            .lock()
            .await
            .snapshots_by_thread
            .get("thread-1")
            .cloned()
            .expect("snapshot should remain");
        assert_eq!(stored.status, ConversationStatus::WaitingForExternalAction);
        assert_eq!(stored.pending_interactions.len(), 1);
    }

    #[test]
    fn claude_send_result_tracks_authoritative_history() {
        let result = serde_json::from_value::<ClaudeSendResult>(serde_json::json!({
            "providerThreadId": "claude-session-1",
            "messages": [],
            "messagesAuthoritative": false,
            "planMarkdown": null
        }))
        .expect("worker result should decode fallback flag");

        assert_eq!(result.messages_authoritative, Some(false));
    }

    #[test]
    fn hidden_user_message_filter_removes_internal_plan_approval_prompt() {
        let messages = vec![
            ClaudeSimpleMessage {
                id: "user-internal".to_string(),
                role: ConversationRole::User,
                text: plan_approval_message().to_string(),
                images: None,
            },
            ClaudeSimpleMessage {
                id: "assistant-final".to_string(),
                role: ConversationRole::Assistant,
                text: "Done.".to_string(),
                images: None,
            },
        ];

        let visible = filter_hidden_user_message(messages, plan_approval_message());

        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "assistant-final");
    }

    #[test]
    fn handoff_context_filter_keeps_only_visible_current_user_text() {
        let hidden = "<handoff_context>\nsource_provider: Claude\n</handoff_context>";
        let messages = vec![
            ClaudeSimpleMessage {
                id: "user-handoff".to_string(),
                role: ConversationRole::User,
                text: format!("{hidden}\n\nMerci, et pour Paris ?"),
                images: None,
            },
            ClaudeSimpleMessage {
                id: "assistant-final".to_string(),
                role: ConversationRole::Assistant,
                text: "Pour Paris...".to_string(),
                images: None,
            },
        ];

        let visible = strip_hidden_handoff_context_from_messages(
            messages,
            Some(hidden),
            "Merci, et pour Paris ?",
        );

        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0].text, "Merci, et pour Paris ?");
        assert_eq!(visible[1].text, "Pour Paris...");
    }

    #[test]
    fn handoff_context_filter_preserves_image_only_messages_without_visible_text() {
        let hidden = "<handoff_context>\nsource_provider: Codex\n</handoff_context>";
        let messages = vec![ClaudeSimpleMessage {
            id: "user-image".to_string(),
            role: ConversationRole::User,
            text: hidden.to_string(),
            images: Some(vec![ConversationImageAttachment::Image {
                url: "https://example.com/image.png".to_string(),
            }]),
        }];

        let visible = strip_hidden_handoff_context_from_messages(messages, Some(hidden), "");

        assert_eq!(visible.len(), 1);
        assert!(visible[0].text.is_empty());
        assert!(visible[0]
            .images
            .as_ref()
            .is_some_and(|images| !images.is_empty()));
    }

    #[test]
    fn worker_event_deserializes_camel_case_fields() {
        let event = serde_json::from_value::<ClaudeWorkerEventEnvelope>(serde_json::json!({
            "type": "event",
            "id": 1,
            "event": {
                "kind": "session",
                "providerThreadId": "claude-session-1"
            }
        }))
        .expect("worker events use camelCase fields");

        assert!(matches!(
            event.event,
            ClaudeRuntimeEvent::Session { provider_thread_id }
                if provider_thread_id == "claude-session-1"
        ));
    }

    #[test]
    fn claude_token_usage_event_updates_context_window_snapshot() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::TokenUsage {
                total: TokenUsageBreakdown {
                    total_tokens: 12_000,
                    input_tokens: 10_000,
                    cached_input_tokens: 1_000,
                    output_tokens: 1_000,
                    reasoning_output_tokens: 0,
                },
                last: TokenUsageBreakdown {
                    total_tokens: 8_000,
                    input_tokens: 8_000,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                    reasoning_output_tokens: 0,
                },
                model_context_window: Some(1_000_000),
            },
        );

        let usage = snapshot
            .token_usage
            .as_ref()
            .expect("Claude token usage is projected into the conversation");
        assert_eq!(usage.last.total_tokens, 8_000);
        assert_eq!(usage.total.total_tokens, 12_000);
        assert_eq!(usage.model_context_window, Some(1_000_000));
    }

    #[test]
    fn control_messages_serialize_for_worker_camel_case_contract() {
        let message = serde_json::to_value(ClaudeControlMessage::ApprovalResponse {
            interaction_id: "approval-1".to_string(),
            approved: true,
        })
        .expect("control message should serialize");

        assert_eq!(
            message,
            serde_json::json!({
                "type": "approvalResponse",
                "interactionId": "approval-1",
                "approved": true
            })
        );

        let interrupt = serde_json::to_value(ClaudeControlMessage::Interrupt { request_id: 1 })
            .expect("interrupt message should serialize");

        assert_eq!(
            interrupt,
            serde_json::json!({ "type": "interrupt", "requestId": 1 })
        );
    }

    #[test]
    fn claude_approval_event_creates_actionable_request() {
        let mut snapshot = snapshot();
        snapshot.active_turn_id = Some("turn-1".to_string());

        apply_claude_event(
            &mut snapshot,
            "turn-1",
            ClaudeRuntimeEvent::ApprovalRequest {
                interaction_id: "approval-1".to_string(),
                item_id: "tool-bash".to_string(),
                tool_name: "Bash".to_string(),
                title: "Command approval".to_string(),
                summary: Some("Run tests".to_string()),
                command: Some("bun run test".to_string()),
                reason: Some("Claude wants to use this tool.".to_string()),
            },
        );

        assert_eq!(
            snapshot.status,
            ConversationStatus::WaitingForExternalAction
        );
        assert!(matches!(
            snapshot.pending_interactions.first(),
            Some(ConversationInteraction::Approval(request))
                if request.id == "approval-1"
                    && request.approval_kind == ConversationApprovalKind::CommandExecution
                    && request.command.as_deref() == Some("bun run test")
        ));
    }
}
