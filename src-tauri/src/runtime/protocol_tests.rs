use serde_json::json;

use crate::domain::conversation::{
    ConversationComposerSettings, ConversationInteraction, ConversationItem, ConversationStatus,
    ConversationTaskStatus, InputModality, ProposedPlanSnapshot, ProposedPlanStatus,
};
use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};

use super::protocol::{
    approval_policy_value, build_history_snapshot, collaboration_mode_options_from_response,
    complete_proposed_plan, loaded_subagents_for_primary, model_options_from_response,
    normalize_server_interaction, parse_incoming_message, proposed_plan_from_item,
    sandbox_policy_value, subagents_from_collab_item, task_plan_from_item,
    task_status_from_turn_status, user_input_payload, AccountRateLimitsReadResponse,
    CollaborationModeListResponse, CollaborationModeWire, IncomingMessage, ModelListResponse,
    ModelWire, OutgoingTextElement, OutgoingUserInputPayload, ReasoningEffortOptionWire,
    ServerRequestEnvelope, ThreadListEntryWire, ThreadStatusWire, ThreadWire,
};

fn composer() -> ConversationComposerSettings {
    ConversationComposerSettings {
        model: "gpt-5.4".to_string(),
        reasoning_effort: ReasoningEffort::High,
        collaboration_mode: CollaborationMode::Build,
        approval_policy: ApprovalPolicy::AskToEdit,
    }
}

fn inter_agent_control_message(agent_path: &str) -> String {
    format!(
        "{{\"author\":\"{agent_path}\",\"recipient\":\"/root\",\"other_recipients\":[],\"content\":\"<subagent_notification>\\n{{\\\"agent_path\\\":\\\"{agent_path}\\\",\\\"status\\\":{{\\\"completed\\\":\\\"Done\\\"}}}}\\n</subagent_notification>\",\"trigger_turn\":false}}"
    )
}

#[test]
fn parses_json_rpc_responses_and_notifications() {
    let response = parse_incoming_message(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#)
        .expect("response should parse");
    assert!(matches!(
        response,
        IncomingMessage::Response(envelope)
            if envelope.id == 7
                && envelope.error.is_none()
                && envelope.result["ok"] == json!(true)
    ));

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
fn decodes_account_rate_limit_payloads() {
    let response = serde_json::from_value::<AccountRateLimitsReadResponse>(json!({
        "rateLimits": {
            "planType": "pro",
            "primary": {
                "usedPercent": 38,
                "windowDurationMins": 300,
                "resetsAt": 1_775_306_400
            },
            "secondary": {
                "usedPercent": 12,
                "windowDurationMins": 10_080,
                "resetsAt": 1_775_910_400
            }
        }
    }))
    .expect("account rate limit response should decode");

    assert_eq!(
        response
            .rate_limits
            .primary
            .as_ref()
            .map(|window| window.used_percent),
        Some(38)
    );
    assert_eq!(
        response
            .rate_limits
            .secondary
            .as_ref()
            .and_then(|window| window.window_duration_mins),
        Some(10_080),
    );
}

#[test]
fn unknown_plan_types_fall_back_to_unknown() {
    let response = serde_json::from_value::<AccountRateLimitsReadResponse>(json!({
        "rateLimits": {
            "planType": "brand_new_plan",
            "primary": {
                "usedPercent": 25
            }
        }
    }))
    .expect("unknown plan types should still decode");

    assert_eq!(
        response.rate_limits.plan_type,
        Some(crate::domain::workspace::CodexPlanType::Unknown)
    );
}

#[test]
fn preserves_json_rpc_error_responses_for_pending_requests() {
    let response =
        parse_incoming_message(r#"{"jsonrpc":"2.0","id":9,"error":{"message":"request failed"}}"#)
            .expect("error response should parse");

    assert!(matches!(
        response,
        IncomingMessage::Response(envelope)
            if envelope.id == 9
                && envelope
                    .error
                    .as_ref()
                    .is_some_and(|error| error.contains("request failed"))
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
    assert!(matches!(
        snapshot.status,
        crate::domain::conversation::ConversationStatus::Completed
    ));
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
fn history_snapshot_skips_hidden_inter_agent_messages() {
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
                        "id": "assistant-control-1",
                        "type": "agentMessage",
                        "text": inter_agent_control_message("/root/review_swarm_security")
                    }),
                    json!({
                        "id": "assistant-visible-1",
                        "type": "agentMessage",
                        "text": "Visible answer"
                    }),
                ],
            }],
        },
    );

    assert_eq!(snapshot.items.len(), 1);
    assert!(matches!(
        snapshot.items.first(),
        Some(ConversationItem::Message(message)) if message.text == "Visible answer"
    ));
}

#[test]
fn history_snapshot_reconciles_control_only_threads_to_idle() {
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
                items: vec![json!({
                    "id": "assistant-control-1",
                    "type": "agentMessage",
                    "text": inter_agent_control_message("/root/review_swarm_security")
                })],
            }],
        },
    );

    assert!(snapshot.items.is_empty());
    assert_eq!(snapshot.status, ConversationStatus::Idle);
}

#[test]
fn history_snapshot_extracts_latest_plan_items() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        ConversationComposerSettings {
            collaboration_mode: CollaborationMode::Plan,
            ..composer()
        },
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
fn history_snapshot_routes_build_turn_plans_to_task_plan() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        ConversationComposerSettings {
            collaboration_mode: CollaborationMode::Build,
            ..composer()
        },
        ThreadWire {
            id: "thr-existing".to_string(),
            turns: vec![super::protocol::TurnWire {
                id: "turn-build-1".to_string(),
                status: "completed".to_string(),
                error: None,
                items: vec![json!({
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Tasks\n\n- Inspect runtime"
                })],
            }],
        },
    );

    assert!(snapshot.proposed_plan.is_none());
    assert!(matches!(
        snapshot.task_plan.as_ref().map(|plan| plan.status),
        Some(ConversationTaskStatus::Completed)
    ));
    assert_eq!(
        snapshot
            .task_plan
            .as_ref()
            .expect("task plan should exist")
            .markdown,
        "## Tasks\n\n- Inspect runtime"
    );
}

#[test]
fn history_snapshot_prefers_proposed_plan_heading_over_build_fallback_mode() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        ConversationComposerSettings {
            collaboration_mode: CollaborationMode::Build,
            ..composer()
        },
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
    assert!(snapshot.task_plan.is_none());
}

#[test]
fn history_snapshot_prefers_task_heading_over_plan_fallback_mode() {
    let snapshot = build_history_snapshot(
        "thread-1".to_string(),
        "env-1".to_string(),
        Some("thr-existing".to_string()),
        ConversationComposerSettings {
            collaboration_mode: CollaborationMode::Plan,
            ..composer()
        },
        ThreadWire {
            id: "thr-existing".to_string(),
            turns: vec![super::protocol::TurnWire {
                id: "turn-build-1".to_string(),
                status: "completed".to_string(),
                error: None,
                items: vec![json!({
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "## Tasks\n\n- Inspect runtime"
                })],
            }],
        },
    );

    assert!(snapshot.proposed_plan.is_none());
    assert!(matches!(
        snapshot.task_plan.as_ref().map(|plan| plan.status),
        Some(ConversationTaskStatus::Completed)
    ));
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
fn discovers_loaded_subagent_descendants_for_a_primary_thread() {
    let subagents = loaded_subagents_for_primary(
        "thr-parent",
        &["thr-child".to_string(), "thr-grandchild".to_string()],
        vec![
            ThreadListEntryWire {
                id: "thr-child".to_string(),
                agent_nickname: Some("Scout".to_string()),
                agent_role: Some("explorer".to_string()),
                source: json!({
                    "subAgent": {
                        "thread_spawn": {
                            "parent_thread_id": "thr-parent",
                            "depth": 1,
                            "agent_nickname": "Scout",
                            "agent_role": "explorer"
                        }
                    }
                }),
                status: ThreadStatusWire {
                    kind: "active".to_string(),
                },
            },
            ThreadListEntryWire {
                id: "thr-grandchild".to_string(),
                agent_nickname: Some("Atlas".to_string()),
                agent_role: Some("worker".to_string()),
                source: json!({
                    "subAgent": {
                        "thread_spawn": {
                            "parent_thread_id": "thr-child",
                            "depth": 2,
                            "agent_nickname": "Atlas",
                            "agent_role": "worker"
                        }
                    }
                }),
                status: ThreadStatusWire {
                    kind: "idle".to_string(),
                },
            },
            ThreadListEntryWire {
                id: "thr-other".to_string(),
                agent_nickname: Some("Other".to_string()),
                agent_role: Some("reviewer".to_string()),
                source: json!({
                    "subAgent": {
                        "thread_spawn": {
                            "parent_thread_id": "thr-unrelated",
                            "depth": 1,
                            "agent_nickname": "Other",
                            "agent_role": "reviewer"
                        }
                    }
                }),
                status: ThreadStatusWire {
                    kind: "active".to_string(),
                },
            },
        ],
    );

    assert_eq!(subagents.len(), 2);
    assert_eq!(subagents[0].thread_id, "thr-child");
    assert_eq!(
        subagents[0].status,
        crate::domain::conversation::SubagentStatus::Running
    );
    assert_eq!(subagents[1].thread_id, "thr-grandchild");
    assert_eq!(
        subagents[1].status,
        crate::domain::conversation::SubagentStatus::Completed
    );
}

#[test]
fn discovers_loaded_subagents_from_camel_case_spawn_fields() {
    let subagents = loaded_subagents_for_primary(
        "thr-parent",
        &["thr-child".to_string()],
        vec![ThreadListEntryWire {
            id: "thr-child".to_string(),
            agent_nickname: Some("Scout".to_string()),
            agent_role: Some("explorer".to_string()),
            source: json!({
                "subAgent": {
                    "threadSpawn": {
                        "parentThreadId": "thr-parent",
                        "depth": 1,
                        "agentNickname": "Scout",
                        "agentRole": "explorer"
                    }
                }
            }),
            status: ThreadStatusWire {
                kind: "active".to_string(),
            },
        }],
    );

    assert_eq!(subagents.len(), 1);
    assert_eq!(subagents[0].nickname.as_deref(), Some("Scout"));
}

#[test]
fn extracts_subagents_from_collab_agent_tool_items() {
    let subagents = subagents_from_collab_item(&json!({
        "id": "collab-1",
        "type": "collabAgentToolCall",
        "tool": "spawnAgent",
        "status": "inProgress",
        "senderThreadId": "thr-parent",
        "receiverThreadIds": ["thr-child-1", "thr-child-2"],
        "agentsStates": {
            "thr-child-1": { "status": "running" },
            "thr-child-2": { "status": "completed" }
        }
    }));

    assert_eq!(subagents.len(), 2);
    assert_eq!(subagents[0].thread_id, "thr-child-1");
    assert_eq!(
        subagents[0].status,
        crate::domain::conversation::SubagentStatus::Running
    );
    assert_eq!(subagents[1].thread_id, "thr-child-2");
    assert_eq!(
        subagents[1].status,
        crate::domain::conversation::SubagentStatus::Completed
    );
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
fn task_plan_from_item_keeps_task_status_noninteractive() {
    let plan = task_plan_from_item(
        "turn-1",
        &json!({
            "id": "plan-item-1",
            "type": "plan",
            "text": "## Tasks\n\n- Inspect runtime"
        }),
        task_status_from_turn_status("completed"),
    )
    .expect("task item should normalize");

    assert_eq!(plan.item_id.as_deref(), Some("plan-item-1"));
    assert!(matches!(plan.status, ConversationTaskStatus::Completed));
}

#[test]
fn task_plan_from_item_keeps_interrupted_task_status_noninteractive() {
    let plan = task_plan_from_item(
        "turn-1",
        &json!({
            "id": "plan-item-1",
            "type": "plan",
            "text": "## Tasks\n\n- Inspect runtime"
        }),
        task_status_from_turn_status("interrupted"),
    )
    .expect("task item should normalize");

    assert_eq!(plan.item_id.as_deref(), Some("plan-item-1"));
    assert!(matches!(plan.status, ConversationTaskStatus::Interrupted));
}

#[test]
fn task_plan_from_item_keeps_failed_task_status_noninteractive() {
    let plan = task_plan_from_item(
        "turn-1",
        &json!({
            "id": "plan-item-1",
            "type": "plan",
            "text": "## Tasks\n\n- Inspect runtime"
        }),
        task_status_from_turn_status("failed"),
    )
    .expect("task item should normalize");

    assert_eq!(plan.item_id.as_deref(), Some("plan-item-1"));
    assert!(matches!(plan.status, ConversationTaskStatus::Failed));
}

#[test]
fn task_plan_from_item_defaults_unknown_status_to_running() {
    let plan = task_plan_from_item(
        "turn-1",
        &json!({
            "id": "plan-item-1",
            "type": "plan",
            "text": "## Tasks\n\n- Inspect runtime"
        }),
        task_status_from_turn_status("stillWorking"),
    )
    .expect("task item should normalize");

    assert_eq!(plan.item_id.as_deref(), Some("plan-item-1"));
    assert!(matches!(plan.status, ConversationTaskStatus::Running));
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
                input_modalities: vec![InputModality::Text, InputModality::Image],
                is_default: true,
                hidden: false,
            },
            ModelWire {
                id: "hidden".to_string(),
                display_name: "Hidden".to_string(),
                description: "Hidden".to_string(),
                supported_reasoning_efforts: vec![],
                default_reasoning_effort: ReasoningEffort::Medium,
                input_modalities: vec![InputModality::Text],
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
fn defaults_missing_input_modalities_to_text_only() {
    let models = model_options_from_response(
        serde_json::from_value::<ModelListResponse>(json!({
            "data": [
                {
                    "id": "gpt-5.4-mini",
                    "displayName": "GPT-5.4-mini",
                    "description": "Mini model",
                    "supportedReasoningEfforts": [],
                    "defaultReasoningEffort": "medium",
                    "isDefault": true,
                    "hidden": false
                }
            ]
        }))
        .expect("model list response should decode"),
    );

    assert_eq!(models.len(), 1);
    assert_eq!(models[0].input_modalities, vec![InputModality::Text]);
}

#[test]
fn preserves_placeholder_metadata_when_visible_text_is_empty() {
    let payload = user_input_payload(&OutgoingUserInputPayload {
        text: String::new(),
        images: Vec::new(),
        text_elements: vec![OutgoingTextElement {
            start: 0,
            end: 0,
            placeholder: Some("/prompts:empty".to_string()),
        }],
        skills: Vec::new(),
        mentions: Vec::new(),
    });

    assert_eq!(
        payload,
        json!([{
            "type": "text",
            "text": "",
            "text_elements": [{
                "byteRange": {
                    "start": 0,
                    "end": 0
                },
                "placeholder": "/prompts:empty"
            }]
        }])
    );
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
    assert_eq!(
        approval_policy_value(ApprovalPolicy::AskToEdit),
        "on-request"
    );
    assert_eq!(
        sandbox_policy_value(ApprovalPolicy::AskToEdit, "/tmp/loom")["type"],
        "workspaceWrite"
    );
    assert_eq!(
        sandbox_policy_value(ApprovalPolicy::FullAccess, "/tmp/loom")["type"],
        "dangerFullAccess"
    );
}
