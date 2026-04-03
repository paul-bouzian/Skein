use serde_json::json;

use crate::domain::conversation::{
    ConversationComposerSettings, ConversationInteraction, ConversationItem, ProposedPlanSnapshot,
    ProposedPlanStatus,
};
use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};

use super::protocol::{
    CollaborationModeListResponse, CollaborationModeWire, IncomingMessage, ModelListResponse,
    ModelWire, ReasoningEffortOptionWire, ThreadWire, approval_policy_value,
    build_history_snapshot, collaboration_mode_options_from_response, model_options_from_response,
    complete_proposed_plan, normalize_server_interaction, parse_incoming_message,
    proposed_plan_from_item,
    sandbox_policy_value, ServerRequestEnvelope,
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
fn history_snapshot_extracts_latest_plan_items() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        composer(),
        ThreadWire {
            id: "thr-existing".to_string(),
            turns: vec![super::protocol::TurnWire {
                id: "turn-plan-1".to_string(),
                status: "completed".to_string(),
                error: None,
                items: vec![json!({
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Proposed plan\n\n- Inspect runtime"
                })],
            }],
        },
    );

    assert!(matches!(
        snapshot.proposed_plan.as_ref().map(|plan| plan.status),
        Some(ProposedPlanStatus::Ready)
    ));
    assert_eq!(
        snapshot
            .proposed_plan
            .as_ref()
            .expect("plan should exist")
            .markdown,
        "## Proposed plan\n\n- Inspect runtime"
    );
}

#[test]
fn history_snapshot_ignores_historical_plans_once_a_later_turn_exists() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        composer(),
        ThreadWire {
            id: "thr-existing".to_string(),
            turns: vec![
                super::protocol::TurnWire {
                    id: "turn-plan-1".to_string(),
                    status: "completed".to_string(),
                    error: None,
                    items: vec![json!({
                        "id": "plan-item-1",
                        "type": "plan",
                        "text": "## Proposed plan\n\n- Inspect runtime"
                    })],
                },
                super::protocol::TurnWire {
                    id: "turn-build-1".to_string(),
                    status: "completed".to_string(),
                    error: None,
                    items: vec![json!({
                        "id": "assistant-1",
                        "type": "agentMessage",
                        "text": "Implementation started"
                    })],
                },
            ],
        },
    );

    assert!(snapshot.proposed_plan.is_none());
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ConversationItem::Message(message) if message.text == "Implementation started"
    )));
}

#[test]
fn normalizes_user_input_server_requests() {
    let interaction = normalize_server_interaction(
        "interaction-1",
        &ServerRequestEnvelope {
            id: json!(900),
            method: "item/tool/requestUserInput".to_string(),
            params: json!({
                "threadId": "thr-existing",
                "turnId": "turn-1",
                "itemId": "item-1",
                "questions": [{
                    "id": "scope",
                    "header": "Scope",
                    "question": "Which path should Codex take?",
                    "options": [{ "label": "Frontend", "description": "Recommended" }],
                    "isOther": true
                }]
            }),
        },
    )
    .expect("interaction should normalize");

    match interaction {
        ConversationInteraction::UserInput(request) => {
            assert_eq!(request.thread_id, "thr-existing");
            assert_eq!(request.questions.len(), 1);
            assert_eq!(request.questions[0].options[0].label, "Frontend");
            assert!(request.questions[0].is_other);
        }
        _ => panic!("expected a user input interaction"),
    }
}

#[test]
fn proposed_plan_from_item_marks_ready_plans_as_actionable() {
    let plan = proposed_plan_from_item(
        "turn-1",
        &json!({
            "id": "plan-item-1",
            "type": "plan",
            "text": "## Proposed plan\n\n- Inspect runtime"
        }),
        ProposedPlanStatus::Ready,
    )
    .expect("plan item should normalize");

    assert!(plan.is_awaiting_decision);
    assert_eq!(plan.item_id.as_deref(), Some("plan-item-1"));
}

#[test]
fn complete_proposed_plan_leaves_empty_plans_unchanged() {
    let mut plan = ProposedPlanSnapshot {
        turn_id: "turn-1".to_string(),
        item_id: None,
        explanation: String::new(),
        steps: Vec::new(),
        markdown: String::new(),
        status: ProposedPlanStatus::Streaming,
        is_awaiting_decision: false,
    };

    complete_proposed_plan(
        &mut plan,
        "plan-item-1",
        Some(&json!({
            "text": []
        })),
    );

    assert_eq!(plan.item_id, None);
    assert!(plan.markdown.is_empty());
    assert!(matches!(plan.status, ProposedPlanStatus::Streaming));
    assert!(!plan.is_awaiting_decision);
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
