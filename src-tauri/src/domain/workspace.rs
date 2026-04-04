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
