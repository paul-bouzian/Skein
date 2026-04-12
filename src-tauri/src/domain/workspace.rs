use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::settings::{GlobalSettings, ServiceTier};

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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPullRequestSnapshot {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PullRequestState,
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsPatch {
    pub worktree_setup_script: Option<Option<String>>,
    pub worktree_teardown_script: Option<Option<String>>,
}

impl ProjectSettings {
    pub fn apply_patch(&mut self, patch: ProjectSettingsPatch) {
        if let Some(worktree_setup_script) = patch.worktree_setup_script {
            self.worktree_setup_script = normalize_project_script(worktree_setup_script);
        }
        if let Some(worktree_teardown_script) = patch.worktree_teardown_script {
            self.worktree_teardown_script = normalize_project_script(worktree_teardown_script);
        }
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

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};
    use serde_json::Value;

    use super::{
        EnvironmentKind, EnvironmentRecord, FirstPromptRenameFailureEvent, ProjectRecord,
        ProjectSettings, ProjectSettingsPatch, PullRequestState, RuntimeState, WorkspaceEventKind,
        RuntimeStatusSnapshot,
    };

    #[test]
    fn project_settings_patch_trims_and_clears_scripts() {
        let mut settings = ProjectSettings::default();

        settings.apply_patch(ProjectSettingsPatch {
            worktree_setup_script: Some(Some("  pnpm install  ".to_string())),
            worktree_teardown_script: Some(Some("   ".to_string())),
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
            name: "Loom".to_string(),
            root_path: "/tmp/loom".to_string(),
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
