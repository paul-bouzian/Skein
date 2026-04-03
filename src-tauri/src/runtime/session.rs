use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{error, warn};
use uuid::Uuid;

use crate::domain::conversation::{
    BlockedInteractionSnapshot, ConversationEventPayload, ConversationItem, ConversationMessageItem,
    ConversationRole, ConversationStatus, EnvironmentCapabilitiesSnapshot,
    ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::domain::settings::CollaborationMode;
use crate::error::{AppError, AppResult};
use crate::runtime::protocol::{
    CONVERSATION_EVENT_NAME, CollaborationModeListResponse, ErrorNotification, IncomingMessage,
    ItemDeltaNotification, ItemNotification, ModelListResponse, ReasoningBoundaryNotification,
    ThreadReadResponse, ThreadStartResponse, TokenUsageNotification, TurnCompletedNotification,
    TurnResponse, TurnStartedNotification, append_agent_delta, append_reasoning_boundary,
    append_reasoning_content, append_reasoning_summary, append_tool_output,
    approval_policy_value, build_history_snapshot, clear_streaming_flags,
    collaboration_mode_options_from_response, collaboration_mode_payload,
    conversation_status_from_turn_status, error_snapshot, initialize_params,
    initialized_notification, model_options_from_response, normalize_item,
    parse_incoming_message, sandbox_policy_value, token_usage_snapshot, upsert_item,
    user_input_payload,
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
        let mut command = Command::new(&binary_path);
        command
            .arg("app-server")
            .current_dir(&environment_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Runtime("Codex app-server stdin is unavailable.".to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::Runtime("Codex app-server stdout is unavailable.".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::Runtime("Codex app-server stderr is unavailable.".to_string())
        })?;

        Self::from_transport(
            Some(app),
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

        session
            .send_request("initialize", initialize_params(&app_version))
            .await?;
        session
            .send_notification("initialized", initialized_notification())
            .await?;
        Ok(session)
    }

    pub async fn open_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationOpenResponse> {
        let capabilities = self.ensure_capabilities().await?;

        {
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
                return Ok(ThreadConversationOpenResponse {
                    snapshot: snapshot_clone,
                    capabilities,
                });
            }
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

        Ok(ThreadConversationOpenResponse {
            snapshot,
            capabilities,
        })
    }

    pub async fn send_message(
        &self,
        context: ThreadRuntimeContext,
        text: String,
    ) -> AppResult<SendMessageResult> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation("Message cannot be empty.".to_string()));
        }
        if matches!(context.composer.collaboration_mode, CollaborationMode::Plan) {
            return Err(AppError::Validation(
                "Plan mode is not part of this milestone yet. Switch the composer to Build."
                    .to_string(),
            ));
        }

        let mut open = self.open_thread(context.clone()).await?;
        let user_item = ConversationItem::Message(ConversationMessageItem {
            id: format!("local-user-{}", Uuid::now_v7()),
            role: ConversationRole::User,
            text: trimmed.to_string(),
            is_streaming: false,
        });
        open.snapshot.status = ConversationStatus::Running;
        open.snapshot.error = None;
        open.snapshot.blocked_interaction = None;
        upsert_item(&mut open.snapshot.items, user_item);

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
                    "input": user_input_payload(trimmed),
                    "cwd": context.environment_path,
                    "approvalPolicy": approval_policy_value(context.composer.approval_policy),
                    "sandboxPolicy": sandbox_policy_value(
                        context.composer.approval_policy,
                        &context.environment_path,
                    ),
                    "collaborationMode": collaboration_mode_payload(&context.composer),
                }),
            )
            .await?;

        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state
                .snapshots_by_thread
                .get_mut(&context.thread_id)
                .ok_or_else(|| {
                    AppError::Runtime("Conversation snapshot disappeared unexpectedly.".to_string())
                })?;
            snapshot.active_turn_id = Some(turn_response.turn.id);
            snapshot.status = conversation_status_from_turn_status(&turn_response.turn.status);
            snapshot.error = turn_response.turn.error.map(error_snapshot);
            snapshot.clone()
        };
        self.emit_snapshot(&snapshot);

        Ok(SendMessageResult {
            snapshot,
            new_codex_thread_id,
        })
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
        Ok(())
    }

    pub async fn try_wait(&self) -> AppResult<Option<i32>> {
        let Some(child) = self.child.as_ref() else {
            return Ok(None);
        };

        let mut child = child.lock().await;
        Ok(child.try_wait()?.and_then(|status| status.code()))
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
        self.write_message(request).await?;

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
                            let _ = sender.send(Ok(response.result));
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
    let Some(codex_thread_id) = request
        .params
        .get("threadId")
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };

    let snapshot = {
        let mut state = state.lock().await;
        let Some(local_thread_id) = state.local_thread_by_codex_id.get(codex_thread_id).cloned() else {
            return;
        };
        let Some(snapshot) = state.snapshots_by_thread.get_mut(&local_thread_id) else {
            return;
        };
        snapshot.status = ConversationStatus::WaitingForExternalAction;
        snapshot.blocked_interaction = Some(BlockedInteractionSnapshot {
            method: request.method.clone(),
            title: "User action required".to_string(),
            message: format!(
                "`{}` is not actionable in ThreadEx yet. This turn is waiting for the next milestone UI.",
                request.method
            ),
        });
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
            if let Ok(event) = serde_json::from_value::<TurnStartedNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(state, &event.thread_id, |snapshot| {
                    snapshot.active_turn_id = Some(event.turn.id.clone());
                    snapshot.status = ConversationStatus::Running;
                    snapshot.error = None;
                    snapshot.blocked_interaction = None;
                }, app)
                .await;
            }
        }
        "turn/completed" => {
            if let Ok(event) =
                serde_json::from_value::<TurnCompletedNotification>(notification.params)
            {
                update_snapshot_for_codex_thread(state, &event.thread_id, |snapshot| {
                    snapshot.active_turn_id = None;
                    snapshot.status = conversation_status_from_turn_status(&event.turn.status);
                    snapshot.error = event.turn.error.clone().map(error_snapshot);
                    snapshot.blocked_interaction = None;
                    clear_streaming_flags(&mut snapshot.items);
                }, app)
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
                        if let Some(item) = normalize_item(&event.item).map(|item| {
                            if is_started {
                                mark_item_streaming(item)
                            } else {
                                item
                            }
                        }) {
                            upsert_item(&mut snapshot.items, item);
                        }
                    },
                    app,
                )
                .await;
            }
        }
        "item/agentMessage/delta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params) {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| append_agent_delta(&mut snapshot.items, &event.item_id, &event.delta),
                    app,
                )
                .await;
            }
        }
        "item/reasoning/summaryTextDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params) {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_reasoning_summary(&mut snapshot.items, &event.item_id, &event.delta)
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
                    |snapshot| append_reasoning_boundary(&mut snapshot.items, &event.item_id),
                    app,
                )
                .await;
            }
        }
        "item/reasoning/textDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params) {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| {
                        append_reasoning_content(&mut snapshot.items, &event.item_id, &event.delta)
                    },
                    app,
                )
                .await;
            }
        }
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            if let Ok(event) = serde_json::from_value::<ItemDeltaNotification>(notification.params) {
                update_snapshot_for_codex_thread(
                    state,
                    &event.thread_id,
                    |snapshot| append_tool_output(&mut snapshot.items, &event.item_id, &event.delta),
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
                    |snapshot| snapshot.token_usage = Some(token_usage_snapshot(event.token_usage.clone())),
                    app,
                )
                .await;
            }
        }
        "error" => {
            if let Ok(event) = serde_json::from_value::<ErrorNotification>(notification.params) {
                if let Some(thread_id) = event.thread_id {
                    update_snapshot_for_codex_thread(
                        state,
                        &thread_id,
                        |snapshot| snapshot.error = Some(error_snapshot(event.error.clone())),
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
        let Some(local_thread_id) = state.local_thread_by_codex_id.get(codex_thread_id).cloned() else {
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

async fn mark_runtime_disconnected(app: &Option<AppHandle>, state: &Arc<Mutex<SessionState>>) {
    let snapshots = {
        let mut state = state.lock().await;
        state
            .snapshots_by_thread
            .values_mut()
            .map(|snapshot| {
                snapshot.status = ConversationStatus::Failed;
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
