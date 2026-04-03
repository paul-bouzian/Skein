use serde_json::json;

use crate::domain::conversation::{ConversationComposerSettings, ConversationItem};
use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};

use super::protocol::{
    CollaborationModeListResponse, CollaborationModeWire, IncomingMessage, ModelListResponse,
    ModelWire, ReasoningEffortOptionWire, ThreadWire, approval_policy_value,
    build_history_snapshot, collaboration_mode_options_from_response, model_options_from_response,
    parse_incoming_message, sandbox_policy_value,
};

fn composer() -> ConversationComposerSettings {
    ConversationComposerSettings {
        model: "gpt-5.4".to_string(),
        reasoning_effort: ReasoningEffort::High,
        collaboration_mode: CollaborationMode::Build,
        approval_policy: ApprovalPolicy::AskToEdit,
    }
}

#[test]
fn parses_json_rpc_responses_and_notifications() {
    let response = parse_incoming_message(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#)
        .expect("response should parse");
    assert!(matches!(response, IncomingMessage::Response(envelope) if envelope.id == 7));

    let notification = parse_incoming_message(
        r#"{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thr_1"}}"#,
    )
    .expect("notification should parse");
    assert!(matches!(
        notification,
        IncomingMessage::Notification(envelope) if envelope.method == "turn/started"
    ));
}

#[test]
fn builds_history_snapshot_from_thread_turns() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        composer(),
        ThreadWire {
            id: "thr-existing".to_string(),
            turns: vec![super::protocol::TurnWire {
                id: "turn-1".to_string(),
                status: "completed".to_string(),
                error: None,
                items: vec![
                    json!({
                        "id": "user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "Inspect the repo"}]
                    }),
                    json!({
                        "id": "assistant-1",
                        "type": "agentMessage",
                        "text": "Done"
                    }),
                    json!({
                        "id": "tool-1",
                        "type": "commandExecution",
                        "status": "completed",
                        "command": "ls",
                        "aggregatedOutput": "src\nsrc-tauri"
                    }),
                ],
            }],
        },
    );

    assert_eq!(snapshot.codex_thread_id.as_deref(), Some("thr-existing"));
    assert!(matches!(snapshot.status, crate::domain::conversation::ConversationStatus::Completed));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ConversationItem::Message(message) if message.text == "Inspect the repo"
    )));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ConversationItem::Tool(tool) if tool.summary.as_deref() == Some("ls")
    )));
}

#[test]
fn filters_hidden_models_and_preserves_effort_metadata() {
    let models = model_options_from_response(ModelListResponse {
        data: vec![
            ModelWire {
                id: "gpt-5.4".to_string(),
                display_name: "GPT-5.4".to_string(),
                description: "Main model".to_string(),
                supported_reasoning_efforts: vec![
                    ReasoningEffortOptionWire {
                        reasoning_effort: ReasoningEffort::Low,
                    },
                    ReasoningEffortOptionWire {
                        reasoning_effort: ReasoningEffort::High,
                    },
                ],
                default_reasoning_effort: ReasoningEffort::High,
                is_default: true,
                hidden: false,
            },
            ModelWire {
                id: "hidden".to_string(),
                display_name: "Hidden".to_string(),
                description: "Hidden".to_string(),
                supported_reasoning_efforts: vec![],
                default_reasoning_effort: ReasoningEffort::Medium,
                is_default: false,
                hidden: true,
            },
        ],
    });

    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "gpt-5.4");
    assert_eq!(models[0].supported_reasoning_efforts.len(), 2);
}

#[test]
fn normalizes_collaboration_modes_and_sandbox_mapping() {
    let modes = collaboration_mode_options_from_response(CollaborationModeListResponse {
        data: vec![
            CollaborationModeWire {
                name: "build".to_string(),
                mode: Some("default".to_string()),
                model: None,
                reasoning_effort: None,
            },
            CollaborationModeWire {
                name: "plan".to_string(),
                mode: Some("plan".to_string()),
                model: Some("gpt-5.4".to_string()),
                reasoning_effort: Some(Some(ReasoningEffort::High)),
            },
            CollaborationModeWire {
                name: "unknown".to_string(),
                mode: Some("something-else".to_string()),
                model: None,
                reasoning_effort: None,
            },
        ],
    });

    assert_eq!(modes.len(), 2);
    assert_eq!(modes[0].id, "build");
    assert_eq!(modes[1].id, "plan");
    assert_eq!(approval_policy_value(ApprovalPolicy::AskToEdit), "on-request");
    assert_eq!(
        sandbox_policy_value(ApprovalPolicy::AskToEdit, "/tmp/threadex")["type"],
        "workspaceWrite"
    );
    assert_eq!(
        sandbox_policy_value(ApprovalPolicy::FullAccess, "/tmp/threadex")["type"],
        "dangerFullAccess"
    );
}
