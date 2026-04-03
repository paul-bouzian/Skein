use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, duplex};
use tokio::sync::Mutex;

use crate::domain::conversation::ConversationComposerSettings;
use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};
use crate::error::AppError;
use crate::services::workspace::ThreadRuntimeContext;

use super::session::RuntimeSession;

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    params: Value,
}

struct FakeCodexHarness {
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    writer: Arc<Mutex<DuplexStream>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeCodexHarness {
    async fn new() -> (RuntimeSession, Self) {
        let (client_writer, server_reader) = duplex(32 * 1024);
        let (server_writer, client_reader) = duplex(32 * 1024);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(Mutex::new(server_writer));
        let task = spawn_fake_codex(server_reader, writer.clone(), requests.clone());

        let session = RuntimeSession::from_test_transport(
            "env-1".to_string(),
            "/tmp/threadex".to_string(),
            "0.1.0".to_string(),
            client_writer,
            client_reader,
        )
        .await
        .expect("test runtime should initialize");

        (
            session,
            Self {
                requests,
                writer,
                task,
            },
        )
    }

    async fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().await.clone()
    }

    async fn emit_notification(&self, method: &str, params: Value) {
        write_server_message(
            &self.writer,
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params
            }),
        )
        .await;
    }

    async fn emit_request(&self, method: &str, params: Value) {
        write_server_message(
            &self.writer,
            json!({
                "jsonrpc": "2.0",
                "id": 900,
                "method": method,
                "params": params
            }),
        )
        .await;
    }
}

impl Drop for FakeCodexHarness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn spawn_fake_codex(
    reader: DuplexStream,
    writer: Arc<Mutex<DuplexStream>>,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let payload = serde_json::from_str::<Value>(&line).expect("json-rpc should parse");
            let Some(id) = payload.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let method = payload
                .get("method")
                .and_then(Value::as_str)
                .expect("method should exist")
                .to_string();
            let params = payload.get("params").cloned().unwrap_or(Value::Null);
            requests.lock().await.push(RecordedRequest {
                method: method.clone(),
                params: params.clone(),
            });

            let result = match method.as_str() {
                "initialize" => json!({}),
                "model/list" => json!({
                    "data": [{
                        "id": "gpt-5.4",
                        "displayName": "GPT-5.4",
                        "description": "Main Codex model",
                        "supportedReasoningEfforts": [
                            {"reasoningEffort": "low"},
                            {"reasoningEffort": "medium"},
                            {"reasoningEffort": "high"},
                            {"reasoningEffort": "xhigh"}
                        ],
                        "defaultReasoningEffort": "high",
                        "isDefault": true,
                        "hidden": false
                    }]
                }),
                "collaborationMode/list" => json!({
                    "data": [
                        {"name": "build", "mode": "default"},
                        {"name": "plan", "mode": "plan", "reasoningEffort": "high"}
                    ]
                }),
                "thread/read" => json!({
                    "thread": {
                        "id": params["threadId"],
                        "turns": [{
                            "id": "turn-history-1",
                            "status": "completed",
                            "error": null,
                            "items": [
                                {
                                    "id": "user-1",
                                    "type": "userMessage",
                                    "content": [{"type": "text", "text": "Inspect the repo"}]
                                },
                                {
                                    "id": "assistant-1",
                                    "type": "agentMessage",
                                    "text": "History loaded"
                                }
                            ]
                        }]
                    }
                }),
                "thread/resume" => json!({}),
                "thread/start" => json!({
                    "thread": { "id": "thr-new" }
                }),
                "turn/start" => json!({
                    "turn": { "id": "turn-live-1", "status": "inProgress", "error": null }
                }),
                "turn/interrupt" => json!({}),
                _ => json!({}),
            };

            write_server_message(
                &writer,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result
                }),
            )
            .await;
        }
    })
}

async fn write_server_message(writer: &Arc<Mutex<DuplexStream>>, payload: Value) {
    let mut writer = writer.lock().await;
    let encoded = serde_json::to_string(&payload).expect("payload should encode");
    writer
        .write_all(encoded.as_bytes())
        .await
        .expect("message should write");
    writer
        .write_all(b"\n")
        .await
        .expect("newline should write");
    writer.flush().await.expect("flush should succeed");
}

fn context(
    local_thread_id: &str,
    codex_thread_id: Option<&str>,
    collaboration_mode: CollaborationMode,
    approval_policy: ApprovalPolicy,
) -> ThreadRuntimeContext {
    ThreadRuntimeContext {
        thread_id: local_thread_id.to_string(),
        environment_id: "env-1".to_string(),
        environment_path: "/tmp/threadex".to_string(),
        codex_thread_id: codex_thread_id.map(ToString::to_string),
        composer: ConversationComposerSettings {
            model: "gpt-5.4".to_string(),
            reasoning_effort: ReasoningEffort::High,
            collaboration_mode,
            approval_policy,
        },
        codex_binary_path: Some("/opt/homebrew/bin/codex".to_string()),
    }
}

#[tokio::test]
async fn open_thread_hydrates_history_and_capabilities() {
    let (session, harness) = FakeCodexHarness::new().await;

    let response = session
        .open_thread(context(
            "thread-local-1",
            Some("thr-existing"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("thread should open");

    assert_eq!(response.snapshot.codex_thread_id.as_deref(), Some("thr-existing"));
    assert_eq!(response.snapshot.items.len(), 2);
    assert_eq!(response.capabilities.models.len(), 1);
    assert_eq!(response.capabilities.collaboration_modes.len(), 2);

    let requests = harness.requests().await;
    assert!(requests.iter().any(|request| request.method == "thread/read"));
    assert!(requests.iter().any(|request| request.method == "thread/resume"));
}

#[tokio::test]
async fn send_message_starts_new_codex_thread_with_real_turn_params() {
    let (session, harness) = FakeCodexHarness::new().await;

    let result = session
        .send_message(
            context(
                "thread-local-2",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Run the test suite".to_string(),
        )
        .await
        .expect("message should send");

    assert_eq!(result.new_codex_thread_id.as_deref(), Some("thr-new"));
    assert_eq!(result.snapshot.active_turn_id.as_deref(), Some("turn-live-1"));

    let requests = harness.requests().await;
    let turn_start = requests
        .iter()
        .find(|request| request.method == "turn/start")
        .expect("turn/start should be issued");
    assert_eq!(turn_start.params["approvalPolicy"], "on-request");
    assert_eq!(turn_start.params["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(turn_start.params["collaborationMode"]["mode"], "default");
    assert_eq!(turn_start.params["input"][0]["text"], "Run the test suite");
}

#[tokio::test]
async fn interrupt_thread_marks_the_snapshot_interrupted() {
    let (session, harness) = FakeCodexHarness::new().await;
    let runtime_context = context(
        "thread-local-3",
        None,
        CollaborationMode::Build,
        ApprovalPolicy::FullAccess,
    );

    session
        .send_message(runtime_context.clone(), "Ship it".to_string())
        .await
        .expect("message should start a turn");

    let snapshot = session
        .interrupt_thread(runtime_context)
        .await
        .expect("interrupt should succeed");

    assert!(matches!(
        snapshot.status,
        crate::domain::conversation::ConversationStatus::Interrupted
    ));
    assert_eq!(snapshot.active_turn_id, None);

    let requests = harness.requests().await;
    let interrupt = requests
        .iter()
        .find(|request| request.method == "turn/interrupt")
        .expect("turn/interrupt should be issued");
    assert_eq!(interrupt.params["threadId"], "thr-new");
    assert_eq!(interrupt.params["turnId"], "turn-live-1");
}

#[tokio::test]
async fn unsupported_server_requests_surface_a_blocked_state() {
    let (session, harness) = FakeCodexHarness::new().await;
    let runtime_context = context(
        "thread-local-4",
        None,
        CollaborationMode::Build,
        ApprovalPolicy::AskToEdit,
    );

    session
        .send_message(runtime_context.clone(), "Run deployment checks".to_string())
        .await
        .expect("message should send");

    harness
        .emit_request(
            "item/tool/requestApproval",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1"
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let snapshot = session
        .open_thread(context(
            "thread-local-4",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should remain open")
        .snapshot;

    assert!(matches!(
        snapshot.status,
        crate::domain::conversation::ConversationStatus::WaitingForExternalAction
    ));
    assert_eq!(
        snapshot
            .blocked_interaction
            .as_ref()
            .expect("blocked interaction should exist")
            .method,
        "item/tool/requestApproval"
    );
}

#[tokio::test]
async fn plan_mode_is_rejected_before_turn_start() {
    let (session, harness) = FakeCodexHarness::new().await;
    let error = session
        .send_message(
            context(
                "thread-local-5",
                None,
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            "Create a plan".to_string(),
        )
        .await
        .expect_err("plan mode should be rejected for this milestone");

    assert!(matches!(error, AppError::Validation(message) if message.contains("Plan mode")));
    let requests = harness.requests().await;
    assert!(!requests.iter().any(|request| request.method == "turn/start"));
}

#[tokio::test]
async fn streamed_notifications_update_the_open_snapshot() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-6",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Investigate".to_string(),
        )
        .await
        .expect("message should send");

    harness
        .emit_notification(
            "item/started",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "tool-1",
                    "type": "commandExecution",
                    "status": "inProgress",
                    "command": "cargo test",
                    "aggregatedOutput": ""
                }
            }),
        )
        .await;
    harness
        .emit_notification(
            "item/reasoning/summaryTextDelta",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "itemId": "reasoning-1",
                "delta": "Inspecting files"
            }),
        )
        .await;
    harness
        .emit_notification(
            "item/commandExecution/outputDelta",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "itemId": "tool-1",
                "delta": "ok\n"
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let snapshot = session
        .open_thread(context(
            "thread-local-6",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should reopen")
        .snapshot;

    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        crate::domain::conversation::ConversationItem::Reasoning(reasoning)
            if reasoning.summary == "Inspecting files"
    )));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        crate::domain::conversation::ConversationItem::Tool(tool)
            if tool.id == "tool-1" && tool.output == "ok\n"
    )));
}
