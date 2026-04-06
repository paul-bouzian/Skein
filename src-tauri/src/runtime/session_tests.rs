use std::fs;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::Mutex;

use crate::domain::conversation::ConversationComposerSettings;
use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};
use crate::domain::voice::VoiceAuthMode;
use crate::services::workspace::ThreadRuntimeContext;

use super::session::RuntimeSession;

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    params: Value,
}

#[derive(Clone, Debug)]
struct RecordedResponse {
    id: Value,
    result: Value,
}

struct FakeCodexHarness {
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    responses: Arc<Mutex<Vec<RecordedResponse>>>,
    writer: Arc<Mutex<DuplexStream>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeCodexHarness {
    async fn new() -> (RuntimeSession, Self) {
        let (client_writer, server_reader) = duplex(32 * 1024);
        let (server_writer, client_reader) = duplex(32 * 1024);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let responses = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(Mutex::new(server_writer));
        let task = spawn_fake_codex(
            server_reader,
            writer.clone(),
            requests.clone(),
            responses.clone(),
        );

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
                responses,
                writer,
                task,
            },
        )
    }

    async fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().await.clone()
    }

    async fn responses(&self) -> Vec<RecordedResponse> {
        self.responses.lock().await.clone()
    }

    async fn wait_for_response_count(&self, expected: usize) -> Vec<RecordedResponse> {
        for _ in 0..20 {
            let responses = self.responses().await;
            if responses.len() >= expected {
                return responses;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.responses().await
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
    responses: Arc<Mutex<Vec<RecordedResponse>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let payload = serde_json::from_str::<Value>(&line).expect("json-rpc should parse");
            if payload.get("method").is_none() {
                responses.lock().await.push(RecordedResponse {
                    id: payload.get("id").cloned().unwrap_or(Value::Null),
                    result: payload.get("result").cloned().unwrap_or(Value::Null),
                });
                continue;
            }
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
                "skills/list" => {
                    let cwd = params
                        .get("cwds")
                        .and_then(Value::as_array)
                        .and_then(|cwds| cwds.first())
                        .and_then(Value::as_str)
                        .unwrap_or("/tmp/threadex");
                    json!({
                        "data": [{
                            "cwd": cwd,
                            "skills": [{
                                "name": "threadex-standards",
                                "description": "ThreadEx standards",
                                "enabled": true,
                                "path": format!("{cwd}/.codex/skills/threadex-standards/SKILL.md"),
                                "interface": {
                                    "shortDescription": "Standards"
                                }
                            }],
                            "errors": []
                        }]
                    })
                }
                "app/list" => json!({
                    "data": [{
                        "id": "github",
                        "name": "GitHub",
                        "description": "GitHub connector",
                        "isEnabled": true
                    }],
                    "nextCursor": null
                }),
                "fuzzyFileSearch" => {
                    let root = params
                        .get("roots")
                        .and_then(Value::as_array)
                        .and_then(|roots| roots.first())
                        .and_then(Value::as_str)
                        .unwrap_or("/tmp/threadex");
                    json!({
                        "files": [
                            {
                                "root": root,
                                "path": "src/main.ts",
                                "matchType": "file",
                                "fileName": "main.ts",
                                "score": 100
                            },
                            {
                                "root": root,
                                "path": "src",
                                "matchType": "directory",
                                "fileName": "src",
                                "score": 50
                            }
                        ]
                    })
                }
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
                "thread/loaded/list" => json!({
                    "data": ["thr-existing", "thr-new", "subagent-child", "subagent-grandchild"]
                }),
                "thread/list" => json!({
                    "data": [
                        {
                            "id": "subagent-child",
                            "agentNickname": "Scout",
                            "agentRole": "explorer",
                            "source": {
                                "subAgent": {
                                    "thread_spawn": {
                                        "parent_thread_id": "thr-existing",
                                        "depth": 1,
                                        "agent_nickname": "Scout",
                                        "agent_role": "explorer"
                                    }
                                }
                            },
                            "status": { "type": "active" }
                        },
                        {
                            "id": "subagent-grandchild",
                            "agentNickname": "Atlas",
                            "agentRole": "worker",
                            "source": {
                                "subAgent": {
                                    "thread_spawn": {
                                        "parent_thread_id": "subagent-child",
                                        "depth": 2,
                                        "agent_nickname": "Atlas",
                                        "agent_role": "worker"
                                    }
                                }
                            },
                            "status": { "type": "idle" }
                        },
                        {
                            "id": "subagent-new",
                            "agentNickname": "Builder",
                            "agentRole": "worker",
                            "source": {
                                "subAgent": {
                                    "thread_spawn": {
                                        "parent_thread_id": "thr-new",
                                        "depth": 1,
                                        "agent_nickname": "Builder",
                                        "agent_role": "worker"
                                    }
                                }
                            },
                            "status": { "type": "active" }
                        }
                    ]
                }),
                "thread/resume" => json!({}),
                "thread/start" => json!({
                    "thread": { "id": "thr-new" }
                }),
                "turn/start" => {
                    let status = params["input"]
                        .as_array()
                        .and_then(|input| input.first())
                        .and_then(|value| value.get("text"))
                        .and_then(Value::as_str)
                        .filter(|text| *text == "Complete immediately")
                        .map(|_| "completed")
                        .unwrap_or("inProgress");
                    json!({
                        "turn": { "id": "turn-live-1", "status": status, "error": null }
                    })
                }
                "account/rateLimits/read" => json!({
                    "rateLimits": {
                        "primary": {
                            "usedPercent": 64,
                            "windowDurationMins": 300,
                            "resetsAt": 1_775_306_400
                        },
                        "secondary": {
                            "usedPercent": 22,
                            "windowDurationMins": 10_080,
                            "resetsAt": 1_775_910_400
                        }
                    }
                }),
                "account/read" => json!({
                    "account": {
                        "type": "chatgpt",
                        "email": "codex@example.com",
                        "planType": "plus"
                    },
                    "requiresOpenaiAuth": false
                }),
                "getAuthStatus" => json!({
                    "authMethod": "chatgpt",
                    "authToken": params["includeToken"]
                        .as_bool()
                        .filter(|include_token| *include_token)
                        .map(|_| "token-123"),
                    "requiresOpenaiAuth": false
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
    writer.write_all(b"\n").await.expect("newline should write");
    writer.flush().await.expect("flush should succeed");
}

fn context(
    local_thread_id: &str,
    codex_thread_id: Option<&str>,
    collaboration_mode: CollaborationMode,
    approval_policy: ApprovalPolicy,
) -> ThreadRuntimeContext {
    context_with_environment(
        local_thread_id,
        codex_thread_id,
        collaboration_mode,
        approval_policy,
        "/tmp/threadex",
    )
}

fn context_with_environment(
    local_thread_id: &str,
    codex_thread_id: Option<&str>,
    collaboration_mode: CollaborationMode,
    approval_policy: ApprovalPolicy,
    environment_path: &str,
) -> ThreadRuntimeContext {
    ThreadRuntimeContext {
        thread_id: local_thread_id.to_string(),
        environment_id: "env-1".to_string(),
        environment_path: environment_path.to_string(),
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

fn unique_test_environment_path(suffix: &str) -> String {
    std::env::temp_dir()
        .join(format!("threadex-{suffix}-{}", uuid::Uuid::now_v7()))
        .to_string_lossy()
        .into_owned()
}

fn write_prompt_file(environment_path: &str, name: &str, content: &str) {
    let prompt_dir = std::path::Path::new(environment_path)
        .join(".codex")
        .join("prompts");
    fs::create_dir_all(&prompt_dir).expect("prompt directory should be created");
    fs::write(prompt_dir.join(format!("{name}.md")), content)
        .expect("prompt file should be written");
}

async fn wait_for_snapshot<F>(
    session: &RuntimeSession,
    runtime_context: ThreadRuntimeContext,
    predicate: F,
) -> crate::domain::conversation::ThreadConversationSnapshot
where
    F: Fn(&crate::domain::conversation::ThreadConversationSnapshot) -> bool,
{
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = session
                .open_thread(runtime_context.clone())
                .await
                .expect("snapshot should reopen")
                .snapshot;
            if predicate(&snapshot) {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("snapshot did not reach the expected state in time")
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

    assert_eq!(
        response.snapshot.codex_thread_id.as_deref(),
        Some("thr-existing")
    );
    assert_eq!(response.snapshot.items.len(), 2);
    assert_eq!(response.capabilities.models.len(), 1);
    assert_eq!(response.capabilities.collaboration_modes.len(), 2);

    let requests = harness.requests().await;
    assert!(requests
        .iter()
        .any(|request| request.method == "thread/read"));
    assert!(requests
        .iter()
        .any(|request| request.method == "thread/resume"));
}

#[tokio::test]
async fn send_message_starts_new_codex_thread_with_real_turn_params() {
    let (session, harness) = FakeCodexHarness::new().await;
    let mut runtime_context = context(
        "thread-local-2",
        None,
        CollaborationMode::Build,
        ApprovalPolicy::AskToEdit,
    );
    runtime_context.composer.model = "gpt-5.3-codex".to_string();
    runtime_context.composer.reasoning_effort = ReasoningEffort::Low;

    let result = session
        .send_message(
            runtime_context,
            "Run the test suite".to_string(),
            Vec::new(),
        )
        .await
        .expect("message should send");

    assert_eq!(result.new_codex_thread_id.as_deref(), Some("thr-new"));
    assert_eq!(
        result.snapshot.active_turn_id.as_deref(),
        Some("turn-live-1")
    );

    let requests = harness.requests().await;
    let turn_start = requests
        .iter()
        .find(|request| request.method == "turn/start")
        .expect("turn/start should be issued");
    assert_eq!(turn_start.params["approvalPolicy"], "on-request");
    assert_eq!(turn_start.params["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(turn_start.params["collaborationMode"]["mode"], "default");
    assert_eq!(
        turn_start.params["collaborationMode"]["settings"]["model"],
        "gpt-5.3-codex"
    );
    assert_eq!(
        turn_start.params["collaborationMode"]["settings"]["reasoning_effort"],
        "low"
    );
    assert_eq!(turn_start.params["input"][0]["text"], "Run the test suite");
    assert!(!requests
        .iter()
        .any(|request| request.method == "skills/list"));
    assert!(!requests.iter().any(|request| request.method == "app/list"));
}

#[tokio::test]
async fn read_auth_status_requests_token_refresh_fields() {
    let (session, harness) = FakeCodexHarness::new().await;

    let auth_status = session
        .read_auth_status(true, true)
        .await
        .expect("auth status should load");

    assert_eq!(auth_status.auth_token.as_deref(), Some("token-123"));
    assert_eq!(auth_status.auth_method, Some(VoiceAuthMode::Chatgpt));

    let requests = harness.requests().await;
    let auth_request = requests
        .iter()
        .find(|request| request.method == "getAuthStatus")
        .expect("getAuthStatus should be requested");
    assert_eq!(auth_request.params["includeToken"], true);
    assert_eq!(auth_request.params["refreshToken"], true);
}

#[tokio::test]
async fn read_account_requests_refresh_token_without_auth_bridge() {
    let (session, harness) = FakeCodexHarness::new().await;

    let account = session
        .read_account(false)
        .await
        .expect("account should load");

    assert_eq!(
        account.account.as_ref().map(|account| &account.auth_type),
        Some(&crate::runtime::protocol::AccountReadAuthTypeWire::Chatgpt)
    );
    assert!(!account.requires_openai_auth);

    let requests = harness.requests().await;
    let account_request = requests
        .iter()
        .find(|request| request.method == "account/read")
        .expect("account/read should be requested");
    assert_eq!(account_request.params["refreshToken"], false);
}

#[tokio::test]
async fn send_message_expands_inline_prompts_and_emits_native_skills_and_mentions() {
    let (session, harness) = FakeCodexHarness::new().await;
    let environment_path = unique_test_environment_path("inline-payload");
    write_prompt_file(
        &environment_path,
        "inline-payload",
        "---\ndescription: \"Inline payload\"\n---\nReview the $TARGET flow thoroughly.",
    );
    let runtime_context = context_with_environment(
        "thread-inline-payload",
        None,
        CollaborationMode::Build,
        ApprovalPolicy::AskToEdit,
        &environment_path,
    );
    let visible_text =
        "Please run /prompts:inline-payload(TARGET=\"composer\") with $threadex-standards and $github";

    session
        .send_message(runtime_context, visible_text.to_string(), Vec::new())
        .await
        .expect("message should send");

    let requests = harness.requests().await;
    let turn_start = requests
        .iter()
        .find(|request| request.method == "turn/start")
        .expect("turn/start should be issued");
    let expanded = "Review the composer flow thoroughly.";
    let expected_text = format!("Please run {expanded} with $threadex-standards and $github");

    assert_eq!(turn_start.params["input"][0]["text"], json!(expected_text));
    assert_eq!(
        turn_start.params["input"][0]["text_elements"][0],
        json!({
            "byteRange": {
                "start": "Please run ".len(),
                "end": "Please run ".len() + expanded.len()
            },
            "placeholder": "/prompts:inline-payload(TARGET=\"composer\")"
        })
    );
    assert_eq!(
        turn_start.params["input"][1],
        json!({
            "type": "skill",
            "name": "threadex-standards",
            "path": format!(
                "{environment_path}/.codex/skills/threadex-standards/SKILL.md"
            )
        })
    );
    assert_eq!(
        turn_start.params["input"][2],
        json!({
            "type": "mention",
            "name": "github",
            "path": "app://github"
        })
    );
}

#[tokio::test]
async fn refresh_thread_discovers_loaded_subagents_for_the_active_thread() {
    let (session, _harness) = FakeCodexHarness::new().await;

    let open = session
        .open_thread(context(
            "thread-local-subagents",
            Some("thr-existing"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("thread should open");
    assert_eq!(open.snapshot.subagents.len(), 2);
    assert_eq!(
        open.snapshot.subagents[0].nickname.as_deref(),
        Some("Scout")
    );
    assert_eq!(
        open.snapshot.subagents[1].nickname.as_deref(),
        Some("Atlas")
    );
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
        .send_message(runtime_context.clone(), "Ship it".to_string(), Vec::new())
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
async fn read_account_rate_limits_uses_the_official_app_server_method() {
    let (session, harness) = FakeCodexHarness::new().await;

    let rate_limits = session
        .read_account_rate_limits()
        .await
        .expect("rate limits should load");

    assert_eq!(
        rate_limits
            .primary
            .as_ref()
            .map(|window| window.used_percent),
        Some(64),
    );
    assert_eq!(
        rate_limits
            .secondary
            .as_ref()
            .and_then(|window| window.window_duration_mins),
        Some(10_080),
    );

    let requests = harness.requests().await;
    let read_request = requests
        .iter()
        .find(|request| request.method == "account/rateLimits/read")
        .expect("account/rateLimits/read should be issued");
    assert_eq!(read_request.params, json!({}));
}

#[tokio::test]
async fn unsupported_server_requests_surface_pending_interactions() {
    let (session, harness) = FakeCodexHarness::new().await;
    let runtime_context = context(
        "thread-local-4",
        None,
        CollaborationMode::Build,
        ApprovalPolicy::AskToEdit,
    );

    session
        .send_message(
            runtime_context.clone(),
            "Run deployment checks".to_string(),
            Vec::new(),
        )
        .await
        .expect("message should send");

    harness
        .emit_request(
            "item/tool/call",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "itemId": "tool-call-1"
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
    assert_eq!(snapshot.pending_interactions.len(), 1);
    assert!(matches!(
        snapshot.pending_interactions[0],
        crate::domain::conversation::ConversationInteraction::Unsupported(ref interaction)
            if interaction.method == "item/tool/call"
    ));
}

#[tokio::test]
async fn plan_mode_starts_a_real_plan_turn() {
    let (session, harness) = FakeCodexHarness::new().await;
    let result = session
        .send_message(
            context(
                "thread-local-5",
                None,
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            "Create a plan".to_string(),
            Vec::new(),
        )
        .await
        .expect("plan mode should now be supported");

    assert_eq!(
        result.snapshot.active_turn_id.as_deref(),
        Some("turn-live-1")
    );
    let requests = harness.requests().await;
    let turn_start = requests
        .iter()
        .find(|request| request.method == "turn/start")
        .expect("turn/start should be issued");
    assert_eq!(turn_start.params["collaborationMode"]["mode"], "plan");
}

#[tokio::test]
async fn user_input_requests_can_be_answered() {
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
            Vec::new(),
        )
        .await
        .expect("message should send");

    harness
        .emit_request(
            "item/tool/requestUserInput",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "itemId": "user-input-1",
                "questions": [{
                    "id": "scope",
                    "header": "Scope",
                    "question": "Which scope should Codex use?",
                    "options": [
                        { "label": "Frontend", "description": "Recommended" },
                        { "label": "Backend", "description": "Rust only" }
                    ],
                    "isOther": true
                }]
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let open = session
        .open_thread(context(
            "thread-local-6",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should reopen");
    let interaction = match &open.snapshot.pending_interactions[0] {
        crate::domain::conversation::ConversationInteraction::UserInput(interaction) => interaction,
        other => panic!("expected user input interaction, got {other:?}"),
    };

    let snapshot = session
        .respond_to_user_input_request(
            crate::domain::conversation::RespondToUserInputRequestInput {
                thread_id: "thread-local-6".to_string(),
                interaction_id: interaction.id.clone(),
                answers: std::collections::HashMap::from([(
                    "scope".to_string(),
                    vec!["Frontend".to_string(), "Plus the CLI".to_string()],
                )]),
            },
        )
        .await
        .expect("answering user input should succeed");

    assert!(snapshot.pending_interactions.is_empty());
    let responses = harness.wait_for_response_count(1).await;
    assert!(responses.iter().any(|response| {
        response.id == json!(900)
            && response.result["answers"]["scope"]["answers"][0] == json!("Frontend")
            && response.result["answers"]["scope"]["answers"][1] == json!("Plus the CLI")
    }));
}

#[tokio::test]
async fn invalid_approval_payload_keeps_the_request_pending() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-approval",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Run the risky command".to_string(),
            Vec::new(),
        )
        .await
        .expect("message should send");

    harness
        .emit_request(
            "item/commandExecution/requestApproval",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "itemId": "command-approval-1",
                "command": "rm -rf build",
                "proposedExecpolicyAmendment": ["allow rm -rf build"]
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let open = session
        .open_thread(context(
            "thread-local-approval",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should reopen");
    let interaction_id = match &open.snapshot.pending_interactions[0] {
        crate::domain::conversation::ConversationInteraction::Approval(interaction) => {
            interaction.id.clone()
        }
        other => panic!("expected approval interaction, got {other:?}"),
    };

    let error = session
        .respond_to_approval_request(
            "thread-local-approval",
            &interaction_id,
            crate::domain::conversation::ApprovalResponseInput::CommandExecution {
                decision:
                    crate::domain::conversation::CommandApprovalDecisionInput::AcceptWithExecpolicyAmendment,
                execpolicy_amendment: None,
                network_policy_amendment: None,
            },
        )
        .await
        .expect_err("invalid approval payload should fail");
    assert!(error
        .to_string()
        .contains("execpolicy amendment is required"));

    let snapshot = session
        .open_thread(context(
            "thread-local-approval",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should still reopen")
        .snapshot;
    assert_eq!(snapshot.pending_interactions.len(), 1);
}

#[tokio::test]
async fn answering_the_same_request_twice_fails_after_the_first_response() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-dup",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Investigate".to_string(),
            Vec::new(),
        )
        .await
        .expect("message should send");

    harness
        .emit_request(
            "item/tool/requestUserInput",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "itemId": "user-input-dup",
                "questions": [{
                    "id": "scope",
                    "header": "Scope",
                    "question": "Which scope should Codex use?",
                    "options": [{ "label": "Frontend", "description": "Recommended" }],
                    "isOther": false
                }]
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let open = session
        .open_thread(context(
            "thread-local-dup",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should reopen");
    let interaction_id = match &open.snapshot.pending_interactions[0] {
        crate::domain::conversation::ConversationInteraction::UserInput(interaction) => {
            interaction.id.clone()
        }
        other => panic!("expected user input interaction, got {other:?}"),
    };

    let snapshot = session
        .respond_to_user_input_request(
            crate::domain::conversation::RespondToUserInputRequestInput {
                thread_id: "thread-local-dup".to_string(),
                interaction_id: interaction_id.clone(),
                answers: std::collections::HashMap::from([(
                    "scope".to_string(),
                    vec!["Frontend".to_string()],
                )]),
            },
        )
        .await
        .expect("first answer should succeed");
    assert!(snapshot.pending_interactions.is_empty());

    let error = session
        .respond_to_user_input_request(
            crate::domain::conversation::RespondToUserInputRequestInput {
                thread_id: "thread-local-dup".to_string(),
                interaction_id,
                answers: std::collections::HashMap::from([(
                    "scope".to_string(),
                    vec!["Frontend".to_string()],
                )]),
            },
        )
        .await
        .expect_err("the same request should not be answerable twice");
    assert!(error.to_string().contains("Interactive request not found"));
}

#[tokio::test]
async fn plan_notifications_and_approval_continue_the_same_thread_in_build_mode() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-7",
                None,
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            "Draft the implementation plan".to_string(),
            Vec::new(),
        )
        .await
        .expect("plan message should send");

    harness
        .emit_notification(
            "turn/plan/updated",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "explanation": "Codex clarified the path.",
                "plan": [
                    { "step": "Inspect runtime", "status": "completed" },
                    { "step": "Add UI", "status": "pending" }
                ]
            }),
        )
        .await;
    harness
        .emit_notification(
            "item/completed",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Proposed plan\n\n- Inspect runtime\n- Add UI"
                }
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let snapshot = session
        .submit_plan_decision(
            context(
                "thread-local-7",
                Some("thr-new"),
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            crate::domain::conversation::SubmitPlanDecisionInput {
                thread_id: "thread-local-7".to_string(),
                action: crate::domain::conversation::PlanDecisionAction::Approve,
                feedback: None,
                composer: None,
                images: None,
                mention_bindings: None,
            },
        )
        .await
        .expect("plan approval should continue the thread")
        .snapshot;

    assert!(matches!(
        snapshot.proposed_plan.as_ref().map(|plan| plan.status),
        Some(crate::domain::conversation::ProposedPlanStatus::Approved)
    ));
    assert!(matches!(
        snapshot.composer.collaboration_mode,
        CollaborationMode::Build
    ));

    let requests = harness.requests().await;
    assert!(
        requests
            .iter()
            .filter(|request| request.method == "turn/start")
            .count()
            >= 2
    );
    let build_turn = requests
        .iter()
        .rev()
        .find(|request| request.method == "turn/start")
        .expect("a build continuation turn should exist");
    assert_eq!(build_turn.params["collaborationMode"]["mode"], "default");
    assert_eq!(
        build_turn.params["input"][0]["text"],
        super::protocol::plan_approval_message()
    );
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
            Vec::new(),
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

#[tokio::test]
async fn build_turn_plan_updates_surface_as_task_progress_without_approval_state() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-build",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Implement the requested changes".to_string(),
            Vec::new(),
        )
        .await
        .expect("build message should send");

    harness
        .emit_notification(
            "turn/plan/updated",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "explanation": "Codex is working through the implementation.",
                "plan": [
                    { "step": "Inspect runtime", "status": "completed" },
                    { "step": "Wire task UI", "status": "inProgress" }
                ]
            }),
        )
        .await;
    harness
        .emit_notification(
            "item/completed",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Tasks\n\n- Inspect runtime\n- Wire task UI"
                }
            }),
        )
        .await;
    harness
        .emit_notification(
            "turn/completed",
            json!({
                "threadId": "thr-new",
                "turn": {
                    "id": "turn-live-1",
                    "status": "completed",
                    "error": null
                }
            }),
        )
        .await;
    let snapshot = wait_for_snapshot(
        &session,
        context(
            "thread-local-build",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ),
        |snapshot| {
            matches!(
                snapshot.task_plan.as_ref().map(|plan| plan.status),
                Some(crate::domain::conversation::ConversationTaskStatus::Completed)
            ) && matches!(
                snapshot.status,
                crate::domain::conversation::ConversationStatus::Completed
            )
        },
    )
    .await;

    assert!(snapshot.proposed_plan.is_none());
    assert!(matches!(
        snapshot.task_plan.as_ref().map(|plan| plan.status),
        Some(crate::domain::conversation::ConversationTaskStatus::Completed)
    ));
    assert!(matches!(
        snapshot.status,
        crate::domain::conversation::ConversationStatus::Completed
    ));

    let error = session
        .submit_plan_decision(
            context(
                "thread-local-build",
                Some("thr-new"),
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            crate::domain::conversation::SubmitPlanDecisionInput {
                thread_id: "thread-local-build".to_string(),
                action: crate::domain::conversation::PlanDecisionAction::Approve,
                composer: None,
                feedback: None,
                images: None,
                mention_bindings: None,
            },
        )
        .await
        .expect_err("task progress should not be actionable as a proposed plan");
    assert!(error
        .to_string()
        .contains("There is no proposed plan to update"));
}

#[tokio::test]
async fn reopening_an_active_plan_turn_with_build_selected_keeps_plan_updates_actionable() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-reopen-plan",
                None,
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            "Draft a plan".to_string(),
            Vec::new(),
        )
        .await
        .expect("plan turn should start");

    harness
        .emit_notification(
            "turn/plan/updated",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "explanation": "Codex is drafting the plan.",
                "plan": [{ "step": "Inspect runtime", "status": "inProgress" }]
            }),
        )
        .await;

    session
        .open_thread(context(
            "thread-local-reopen-plan",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("thread should reopen with build selected");

    harness
        .emit_notification(
            "item/completed",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Proposed plan\n\n- Inspect runtime"
                }
            }),
        )
        .await;

    let snapshot = wait_for_snapshot(
        &session,
        context(
            "thread-local-reopen-plan",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ),
        |snapshot| {
            snapshot.task_plan.is_none()
                && matches!(
                    snapshot.proposed_plan.as_ref().map(|plan| plan.status),
                    Some(crate::domain::conversation::ProposedPlanStatus::Ready)
                )
                && snapshot
                    .proposed_plan
                    .as_ref()
                    .is_some_and(|plan| plan.markdown.contains("## Proposed plan"))
        },
    )
    .await;

    assert!(snapshot.task_plan.is_none());
    assert!(matches!(
        snapshot.proposed_plan.as_ref().map(|plan| plan.status),
        Some(crate::domain::conversation::ProposedPlanStatus::Ready)
    ));
}

#[tokio::test]
async fn reopening_a_plan_turn_before_plan_progress_exists_still_uses_item_heading() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-heading-reopen",
                None,
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            "Draft a plan".to_string(),
            Vec::new(),
        )
        .await
        .expect("plan turn should start");

    session
        .open_thread(context(
            "thread-local-heading-reopen",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("thread should reopen with build selected");

    harness
        .emit_notification(
            "item/completed",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Proposed plan\n\n- Inspect runtime"
                }
            }),
        )
        .await;

    let snapshot = wait_for_snapshot(
        &session,
        context(
            "thread-local-heading-reopen",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ),
        |snapshot| {
            snapshot.task_plan.is_none()
                && matches!(
                    snapshot.proposed_plan.as_ref().map(|plan| plan.status),
                    Some(crate::domain::conversation::ProposedPlanStatus::Ready)
                )
                && snapshot
                    .proposed_plan
                    .as_ref()
                    .is_some_and(|plan| plan.markdown.contains("## Proposed plan"))
        },
    )
    .await;

    assert!(snapshot.task_plan.is_none());
    assert!(matches!(
        snapshot.proposed_plan.as_ref().map(|plan| plan.status),
        Some(crate::domain::conversation::ProposedPlanStatus::Ready)
    ));
}

#[tokio::test]
async fn immediate_turn_start_results_clear_the_previous_task_tracker() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-immediate",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Run the build task".to_string(),
            Vec::new(),
        )
        .await
        .expect("build turn should start");

    harness
        .emit_notification(
            "item/completed",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Tasks\n\n- Inspect runtime"
                }
            }),
        )
        .await;
    harness
        .emit_notification(
            "turn/completed",
            json!({
                "threadId": "thr-new",
                "turn": {
                    "id": "turn-live-1",
                    "status": "completed",
                    "error": null
                }
            }),
        )
        .await;

    let completed_snapshot = wait_for_snapshot(
        &session,
        context(
            "thread-local-immediate",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ),
        |snapshot| {
            matches!(
                snapshot.task_plan.as_ref().map(|plan| plan.status),
                Some(crate::domain::conversation::ConversationTaskStatus::Completed)
            )
        },
    )
    .await;
    assert!(completed_snapshot.task_plan.is_some());

    let snapshot = session
        .send_message(
            context(
                "thread-local-immediate",
                Some("thr-new"),
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Complete immediately".to_string(),
            Vec::new(),
        )
        .await
        .expect("immediate turn should complete")
        .snapshot;

    assert!(snapshot.task_plan.is_none());
    assert!(matches!(
        snapshot.status,
        crate::domain::conversation::ConversationStatus::Completed
    ));
}

#[tokio::test]
async fn submit_plan_decision_requires_an_actionable_plan_before_sending() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .open_thread(context(
            "thread-local-no-plan",
            None,
            CollaborationMode::Plan,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("thread should open");

    let error = session
        .submit_plan_decision(
            context(
                "thread-local-no-plan",
                None,
                CollaborationMode::Plan,
                ApprovalPolicy::AskToEdit,
            ),
            crate::domain::conversation::SubmitPlanDecisionInput {
                thread_id: "thread-local-no-plan".to_string(),
                action: crate::domain::conversation::PlanDecisionAction::Approve,
                composer: None,
                feedback: None,
                images: None,
                mention_bindings: None,
            },
        )
        .await
        .expect_err("approving without a plan should fail");
    assert!(error
        .to_string()
        .contains("There is no proposed plan to update"));

    let requests = harness.requests().await;
    assert!(!requests
        .iter()
        .any(|request| request.method == "turn/start"));
}

#[tokio::test]
async fn collab_agent_notifications_update_subagent_strip_without_timeline_noise() {
    let (session, harness) = FakeCodexHarness::new().await;

    session
        .send_message(
            context(
                "thread-local-7",
                None,
                CollaborationMode::Build,
                ApprovalPolicy::AskToEdit,
            ),
            "Spawn a few helpers".to_string(),
            Vec::new(),
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
                    "id": "collab-1",
                    "type": "collabAgentToolCall",
                    "tool": "spawnAgent",
                    "status": "inProgress",
                    "senderThreadId": "thr-new",
                    "receiverThreadIds": ["subagent-child", "subagent-grandchild"],
                    "agentsStates": {
                        "subagent-child": { "status": "running" },
                        "subagent-grandchild": { "status": "pendingInit" }
                    }
                }
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let snapshot = session
        .open_thread(context(
            "thread-local-7",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should reopen")
        .snapshot;

    assert_eq!(snapshot.subagents.len(), 2);
    assert!(snapshot.items.iter().all(|item| !matches!(
        item,
        crate::domain::conversation::ConversationItem::System(system)
            if system.title == "Unsupported item"
    )));

    harness
        .emit_notification(
            "item/completed",
            json!({
                "threadId": "thr-new",
                "turnId": "turn-live-1",
                "item": {
                    "id": "collab-1",
                    "type": "collabAgentToolCall",
                    "tool": "spawnAgent",
                    "status": "completed",
                    "senderThreadId": "thr-new",
                    "receiverThreadIds": ["subagent-child", "subagent-grandchild"],
                    "agentsStates": {
                        "subagent-child": { "status": "completed" },
                        "subagent-grandchild": { "status": "completed" }
                    }
                }
            }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    let completed_snapshot = session
        .open_thread(context(
            "thread-local-7",
            Some("thr-new"),
            CollaborationMode::Build,
            ApprovalPolicy::AskToEdit,
        ))
        .await
        .expect("snapshot should reopen after completion")
        .snapshot;

    assert!(completed_snapshot.subagents.is_empty());
}
