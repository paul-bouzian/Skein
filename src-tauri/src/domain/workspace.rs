use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::settings::GlobalSettings;

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOverrides {
    pub model: Option<String>,
    pub reasoning_effort: Option<super::settings::ReasoningEffort>,
    pub collaboration_mode: Option<super::settings::CollaborationMode>,
    pub approval_policy: Option<super::settings::ApprovalPolicy>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEventKind {
    EnvironmentRenamed,
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
    use super::{ProjectSettings, ProjectSettingsPatch};

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
}
