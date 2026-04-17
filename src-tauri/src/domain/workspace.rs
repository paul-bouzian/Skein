use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::settings::{GlobalSettings, ServiceTier};
use super::shortcuts::{normalize_shortcut_option, shortcut_signature, ShortcutSettings};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentKind {
    Local,
    ManagedWorktree,
    PermanentWorktree,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    Running,
    Stopped,
    Exited,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChecksRollupState {
    Success,
    Failure,
    Pending,
    Neutral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChecksItemState {
    Success,
    Failure,
    Pending,
    Skipped,
    Neutral,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheckItem {
    pub name: String,
    pub state: ChecksItemState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestChecksSnapshot {
    pub rollup: ChecksRollupState,
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub items: Vec<PullRequestCheckItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPullRequestSnapshot {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PullRequestState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<PullRequestChecksSnapshot>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOverrides {
    pub model: Option<String>,
    pub reasoning_effort: Option<super::settings::ReasoningEffort>,
    pub collaboration_mode: Option<super::settings::CollaborationMode>,
    pub approval_policy: Option<super::settings::ApprovalPolicy>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<ServiceTier>,
    #[serde(default)]
    #[serde(skip_serializing_if = "is_false")]
    pub service_tier_overridden: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub worktree_setup_script: Option<String>,
    pub worktree_teardown_script: Option<String>,
    #[serde(default)]
    pub manual_actions: Vec<ProjectManualAction>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsPatch {
    pub worktree_setup_script: Option<Option<String>>,
    pub worktree_teardown_script: Option<Option<String>>,
    pub manual_actions: Option<Option<Vec<ProjectManualAction>>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectActionIcon {
    Play,
    Test,
    Lint,
    Configure,
    Build,
    Debug,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManualAction {
    pub id: String,
    pub label: String,
    pub icon: ProjectActionIcon,
    pub script: String,
    pub shortcut: Option<String>,
}

impl ProjectSettings {
    pub fn apply_patch(&mut self, patch: ProjectSettingsPatch) {
        if let Some(worktree_setup_script) = patch.worktree_setup_script {
            self.worktree_setup_script = normalize_project_script(worktree_setup_script);
        }
        if let Some(worktree_teardown_script) = patch.worktree_teardown_script {
            self.worktree_teardown_script = normalize_project_script(worktree_teardown_script);
        }
        if let Some(manual_actions) = patch.manual_actions {
            self.manual_actions = normalize_project_actions(manual_actions);
        }
    }

    pub fn validate(&self, shortcuts: Option<&ShortcutSettings>) -> Result<(), String> {
        let mut seen_action_ids = HashMap::new();
        let mut seen_signatures = HashMap::new();
        let mut reserved_shortcuts = HashMap::new();

        if let Some(shortcuts) = shortcuts {
            for (_, label, shortcut) in shortcuts.bindings() {
                let Some(shortcut) = shortcut else {
                    continue;
                };
                let signature = shortcut_signature(shortcut.as_str())
                    .map_err(|message| format!("{label}: {message}"))?;
                reserved_shortcuts.insert(signature, label);
            }
        }

        for (index, action) in self.manual_actions.iter().enumerate() {
            let action_number = index + 1;
            if action.id.trim().is_empty() {
                return Err(format!("Action {action_number}: Id is required."));
            }
            if action.label.trim().is_empty() {
                return Err(format!("Action {action_number}: Label is required."));
            }
            if action.script.trim().is_empty() {
                return Err(format!("Action {action_number}: Script is required."));
            }
            if let Some(previous_index) = seen_action_ids.insert(action.id.as_str(), action_number)
            {
                return Err(format!(
                    "Action {action_number}: Duplicate action id \"{}\" already used by action {previous_index}.",
                    action.id
                ));
            }
            if let Some(shortcut) = action.shortcut.as_deref() {
                let signature = shortcut_signature(shortcut)
                    .map_err(|message| format!("Action {action_number} shortcut: {message}"))?;
                if let Some(global_action) = reserved_shortcuts.get(&signature) {
                    return Err(format!(
                        "Action {action_number} shortcut conflicts with global shortcut {global_action}."
                    ));
                }
                if let Some(previous_label) =
                    seen_signatures.insert(signature, action.label.as_str())
                {
                    return Err(format!(
                        "Action {action_number} shortcut conflicts with action \"{previous_label}\"."
                    ));
                }
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusSnapshot {
    pub environment_id: String,
    pub state: RuntimeState,
    pub pid: Option<u32>,
    pub binary_path: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub last_exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    pub environment_id: String,
    pub title: String,
    pub status: ThreadStatus,
    pub codex_thread_id: Option<String>,
    pub overrides: ThreadOverrides,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub kind: EnvironmentKind,
    pub path: String,
    pub git_branch: Option<String>,
    pub base_branch: Option<String>,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<EnvironmentPullRequestSnapshot>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub threads: Vec<ThreadRecord>,
    pub runtime: RuntimeStatusSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub settings: ProjectSettings,
    pub sidebar_collapsed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub environments: Vec<EnvironmentRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub settings: GlobalSettings,
    pub projects: Vec<ProjectRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeCreateResult {
    pub environment: EnvironmentRecord,
    pub thread: ThreadRecord,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeScriptTrigger {
    Setup,
    Teardown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeScriptFailureEvent {
    pub trigger: WorktreeScriptTrigger,
    pub project_id: String,
    pub project_name: String,
    pub worktree_id: String,
    pub worktree_name: String,
    pub worktree_branch: String,
    pub worktree_path: String,
    pub message: String,
    pub log_path: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FirstPromptRenameFailureEvent {
    pub project_id: String,
    pub environment_id: String,
    pub thread_id: String,
    pub environment_name: String,
    pub branch_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEventKind {
    EnvironmentRenamed,
    EnvironmentPullRequestChanged,
    RuntimeStatusChanged,
    ThreadAutoRenamed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEvent {
    pub kind: WorkspaceEventKind,
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexPlanType {
    Free,
    Go,
    Plus,
    Pro,
    Team,
    SelfServeBusinessUsageBased,
    Business,
    EnterpriseCbpUsageBased,
    Enterprise,
    Edu,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCreditsSnapshot {
    pub balance: Option<String>,
    pub has_credits: bool,
    pub unlimited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitWindow {
    pub resets_at: Option<i64>,
    pub used_percent: i32,
    pub window_duration_mins: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitSnapshot {
    pub credits: Option<CodexCreditsSnapshot>,
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub plan_type: Option<CodexPlanType>,
    pub primary: Option<CodexRateLimitWindow>,
    pub secondary: Option<CodexRateLimitWindow>,
}

fn normalize_project_script(value: Option<String>) -> Option<String> {
    value.and_then(|script| {
        let trimmed = script.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn normalize_project_actions(value: Option<Vec<ProjectManualAction>>) -> Vec<ProjectManualAction> {
    value
        .unwrap_or_default()
        .into_iter()
        .map(|action| ProjectManualAction {
            id: action.id.trim().to_string(),
            label: action.label.trim().to_string(),
            icon: action.icon,
            script: action.script.trim().to_string(),
            shortcut: normalize_shortcut_option(action.shortcut),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};
    use serde_json::Value;

    use super::{
        EnvironmentKind, EnvironmentRecord, FirstPromptRenameFailureEvent, ProjectActionIcon,
        ProjectManualAction, ProjectRecord, ProjectSettings, ProjectSettingsPatch,
        PullRequestState, RuntimeState, RuntimeStatusSnapshot, WorkspaceEventKind,
    };
    use crate::domain::shortcuts::ShortcutSettings;

    #[test]
    fn project_settings_patch_trims_and_clears_scripts() {
        let mut settings = ProjectSettings::default();

        settings.apply_patch(ProjectSettingsPatch {
            worktree_setup_script: Some(Some("  pnpm install  ".to_string())),
            worktree_teardown_script: Some(Some("   ".to_string())),
            ..ProjectSettingsPatch::default()
        });

        assert_eq!(
            settings.worktree_setup_script.as_deref(),
            Some("pnpm install")
        );
        assert_eq!(settings.worktree_teardown_script, None);

        settings.apply_patch(ProjectSettingsPatch {
            worktree_setup_script: Some(None),
            ..ProjectSettingsPatch::default()
        });

        assert_eq!(settings.worktree_setup_script, None);
    }

    #[test]
    fn project_settings_patch_normalizes_manual_actions() {
        let mut settings = ProjectSettings::default();

        settings.apply_patch(ProjectSettingsPatch {
            manual_actions: Some(Some(vec![ProjectManualAction {
                id: "  dev  ".to_string(),
                label: "  Dev server  ".to_string(),
                icon: ProjectActionIcon::Play,
                script: "  bun run dev  ".to_string(),
                shortcut: Some("  mod+shift+d  ".to_string()),
            }])),
            ..ProjectSettingsPatch::default()
        });

        assert_eq!(
            settings.manual_actions,
            vec![ProjectManualAction {
                id: "dev".to_string(),
                label: "Dev server".to_string(),
                icon: ProjectActionIcon::Play,
                script: "bun run dev".to_string(),
                shortcut: Some("mod+shift+d".to_string()),
            }]
        );
    }

    #[test]
    fn project_settings_validate_rejects_manual_action_shortcut_conflicts() {
        let settings = ProjectSettings {
            manual_actions: vec![
                ProjectManualAction {
                    id: "dev".to_string(),
                    label: "Dev".to_string(),
                    icon: ProjectActionIcon::Play,
                    script: "bun run dev".to_string(),
                    shortcut: Some("mod+shift+d".to_string()),
                },
                ProjectManualAction {
                    id: "stop".to_string(),
                    label: "Stop".to_string(),
                    icon: ProjectActionIcon::Debug,
                    script: "pkill -f vite".to_string(),
                    shortcut: Some("mod+shift+d".to_string()),
                },
            ],
            ..ProjectSettings::default()
        };

        let error = settings
            .validate(Some(&ShortcutSettings::default()))
            .expect_err("duplicate shortcuts should be rejected");

        assert!(error.contains("shortcut conflicts with action"));
    }

    #[test]
    fn project_settings_validate_rejects_conflicts_with_global_shortcuts() {
        let settings = ProjectSettings {
            manual_actions: vec![ProjectManualAction {
                id: "dev".to_string(),
                label: "Dev".to_string(),
                icon: ProjectActionIcon::Play,
                script: "bun run dev".to_string(),
                shortcut: Some("mod+j".to_string()),
            }],
            ..ProjectSettings::default()
        };

        let error = settings
            .validate(Some(&ShortcutSettings::default()))
            .expect_err("global shortcut conflicts should be rejected");

        assert!(error.contains("global shortcut"));
    }

    #[test]
    fn project_settings_validate_allows_reusing_the_retired_new_worktree_shortcut() {
        let settings = ProjectSettings {
            manual_actions: vec![ProjectManualAction {
                id: "dev".to_string(),
                label: "Dev".to_string(),
                icon: ProjectActionIcon::Play,
                script: "bun run dev".to_string(),
                shortcut: Some("mod+n".to_string()),
            }],
            ..ProjectSettings::default()
        };

        settings
            .validate(Some(&ShortcutSettings::default()))
            .expect("retired shortcut should no longer be reserved globally");
    }

    #[test]
    fn environment_record_omits_absent_pull_request_in_serialized_payload() {
        let payload = serde_json::to_value(EnvironmentRecord {
            id: "env-1".to_string(),
            project_id: "project-1".to_string(),
            name: "feature".to_string(),
            kind: EnvironmentKind::ManagedWorktree,
            path: "/tmp/feature".to_string(),
            git_branch: Some("feature".to_string()),
            base_branch: Some("main".to_string()),
            is_default: false,
            pull_request: None,
            created_at: parse_datetime("2026-04-08T12:00:00Z"),
            updated_at: parse_datetime("2026-04-08T12:00:00Z"),
            threads: Vec::new(),
            runtime: RuntimeStatusSnapshot {
                environment_id: "env-1".to_string(),
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: None,
                started_at: None,
                last_exit_code: None,
            },
        })
        .expect("environment should serialize");

        let object = payload
            .as_object()
            .expect("environment payload should be a JSON object");
        assert!(!object.contains_key("pullRequest"));
    }

    #[test]
    fn pull_request_state_serializes_with_camel_case_labels() {
        let payload = serde_json::to_value(PullRequestState::Merged)
            .expect("pull request state should serialize");
        assert_eq!(payload, Value::String("merged".to_string()));
    }

    #[test]
    fn workspace_event_kind_runtime_status_changed_round_trips_with_camel_case_label() {
        let payload = serde_json::to_value(WorkspaceEventKind::RuntimeStatusChanged)
            .expect("workspace event kind should serialize");
        assert_eq!(payload, Value::String("runtimeStatusChanged".to_string()));
        let decoded = serde_json::from_value::<WorkspaceEventKind>(payload)
            .expect("workspace event kind should deserialize");
        assert_eq!(decoded, WorkspaceEventKind::RuntimeStatusChanged);
    }

    #[test]
    fn project_record_serializes_sidebar_collapsed_with_camel_case_key() {
        let payload = serde_json::to_value(ProjectRecord {
            id: "project-1".to_string(),
            name: "Skein".to_string(),
            root_path: "/tmp/skein".to_string(),
            settings: ProjectSettings::default(),
            sidebar_collapsed: true,
            created_at: parse_datetime("2026-04-08T12:00:00Z"),
            updated_at: parse_datetime("2026-04-08T12:00:00Z"),
            environments: Vec::new(),
        })
        .expect("project should serialize");
        let object = payload
            .as_object()
            .expect("project payload should be a JSON object");

        assert_eq!(object.get("sidebarCollapsed"), Some(&Value::Bool(true)));
        assert!(!object.contains_key("sidebar_collapsed"));
    }

    #[test]
    fn first_prompt_rename_failure_event_serializes_with_camel_case_keys() {
        let payload = serde_json::to_value(FirstPromptRenameFailureEvent {
            project_id: "project-1".to_string(),
            environment_id: "env-1".to_string(),
            thread_id: "thread-1".to_string(),
            environment_name: "snowy-toad".to_string(),
            branch_name: "snowy-toad".to_string(),
            message: "Codex timed out after 45s while generating a first prompt name.".to_string(),
        })
        .expect("rename failure event should serialize");
        let object = payload
            .as_object()
            .expect("rename failure event should serialize to a JSON object");

        for key in [
            "projectId",
            "environmentId",
            "threadId",
            "environmentName",
            "branchName",
            "message",
        ] {
            assert!(object.contains_key(key), "missing camelCase key {key}");
        }
        for key in [
            "project_id",
            "environment_id",
            "thread_id",
            "environment_name",
            "branch_name",
        ] {
            assert!(!object.contains_key(key), "unexpected snake_case key {key}");
        }
    }

    fn parse_datetime(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("timestamp should parse")
            .with_timezone(&Utc)
    }
}
