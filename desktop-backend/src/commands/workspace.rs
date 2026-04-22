use serde::Deserialize;
use serde::Serialize;
use tracing::warn;

use crate::domain::conversation::EnvironmentCapabilitiesSnapshot;
use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::shortcuts::ShortcutSettings;
use crate::domain::workspace::{
    ChatThreadCreateResult, CodexRateLimitSnapshot, DraftThreadTarget, ManagedWorktreeCreateResult,
    ProjectActionIcon, ProjectRecord, RuntimeStatusSnapshot, SavedDraftThreadState, ThreadRecord,
    WorkspaceSnapshot,
};
use crate::error::{AppError, CommandError};
use crate::services::terminal::ManualActionLaunch;
use crate::services::workspace::{
    AddProjectRequest, ArchiveThreadRequest, CreateChatThreadRequest, CreateManagedWorktreeRequest,
    CreateThreadRequest, RenameProjectRequest, RenameThreadRequest, ReorderProjectsRequest,
    RunProjectActionRequest, SetProjectSidebarCollapsedRequest, UpdateProjectSettingsRequest,
};
use crate::services::worktree_scripts::{skein_context_environment, SkeinContextInput};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEnvironmentInput {
    pub environment_id: String,
    pub target_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjectActionResult {
    pub pty_id: String,
    pub cwd: String,
    pub action_id: String,
    pub action_label: String,
    pub action_icon: ProjectActionIcon,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjectActionInput {
    pub environment_id: String,
    pub action_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftThreadStateInput {
    pub target: DraftThreadTarget,
    pub state: Option<SavedDraftThreadState>,
}

pub(crate) async fn get_workspace_snapshot_impl(
    state: &AppState,
) -> Result<WorkspaceSnapshot, CommandError> {
    let runtime_statuses = state.runtime.refresh_statuses().await?;
    let pull_requests = state.pull_requests.snapshot();
    Ok(state
        .workspace
        .snapshot_with_pull_requests(runtime_statuses, &pull_requests)?)
}

pub(crate) fn get_draft_thread_state_impl(
    target: DraftThreadTarget,
    state: &AppState,
) -> Result<Option<SavedDraftThreadState>, CommandError> {
    Ok(state.workspace.draft_thread_state(&target)?)
}

pub(crate) fn save_draft_thread_state_impl(
    input: SaveDraftThreadStateInput,
    state: &AppState,
) -> Result<(), CommandError> {
    Ok(state
        .workspace
        .persist_draft_thread_state(&input.target, input.state.as_ref())?)
}

pub(crate) fn update_global_settings_impl(
    patch: GlobalSettingsPatch,
    state: &AppState,
) -> Result<GlobalSettings, CommandError> {
    Ok(state.workspace.update_settings(patch)?)
}

pub(crate) fn get_shortcut_defaults_impl() -> ShortcutSettings {
    ShortcutSettings::default()
}

pub(crate) fn add_project_impl(
    input: AddProjectRequest,
    state: &AppState,
) -> Result<ProjectRecord, CommandError> {
    Ok(state.workspace.add_project(input)?)
}

pub(crate) fn rename_project_impl(
    input: RenameProjectRequest,
    state: &AppState,
) -> Result<ProjectRecord, CommandError> {
    Ok(state.workspace.rename_project(input)?)
}

pub(crate) fn update_project_settings_impl(
    input: UpdateProjectSettingsRequest,
    state: &AppState,
) -> Result<ProjectRecord, CommandError> {
    Ok(state.workspace.update_project_settings(input)?)
}

pub(crate) fn run_project_action_impl(
    input: RunProjectActionInput,
    state: &AppState,
) -> Result<RunProjectActionResult, CommandError> {
    let environment_id = normalized_environment_id(&input.environment_id)?;
    let action_id = normalized_action_id(&input.action_id)?;
    let target = state
        .workspace
        .project_action_execution_target(RunProjectActionRequest {
            environment_id: environment_id.to_string(),
            action_id: action_id.to_string(),
        })?;
    let mut env = skein_context_environment(&SkeinContextInput {
        project_id: &target.project_id,
        project_name: &target.project_name,
        project_root: &target.project_root,
        worktree_id: &target.environment_id,
        worktree_name: &target.environment_name,
        worktree_branch: &target.branch_name,
        worktree_path: std::path::Path::new(&target.cwd),
        trigger: None,
    });
    env.push(("SKEIN_ACTION_ID".to_string(), target.action.id.clone()));
    env.push((
        "SKEIN_ACTION_LABEL".to_string(),
        target.action.label.clone(),
    ));
    env.push(("SKEIN_ACTION_KIND".to_string(), "manual".to_string()));
    let pty_id = state.terminal.spawn_manual_action(
        &state.events,
        ManualActionLaunch {
            environment_id: &target.environment_id,
            cwd: &target.cwd,
            cols: 80,
            rows: 24,
            env_overrides: env,
            action_id: &target.action.id,
            script: &target.action.script,
        },
    )?;

    Ok(RunProjectActionResult {
        pty_id,
        cwd: target.cwd,
        action_id: target.action.id,
        action_label: target.action.label,
        action_icon: target.action.icon,
    })
}

pub(crate) fn reorder_projects_impl(
    input: ReorderProjectsRequest,
    state: &AppState,
) -> Result<(), CommandError> {
    Ok(state.workspace.reorder_projects(input)?)
}

pub(crate) fn set_project_sidebar_collapsed_impl(
    input: SetProjectSidebarCollapsedRequest,
    state: &AppState,
) -> Result<(), CommandError> {
    Ok(state.workspace.set_project_sidebar_collapsed(input)?)
}

pub(crate) fn ensure_project_can_be_removed_impl(
    project_id: String,
    state: &AppState,
) -> Result<(), CommandError> {
    Ok(state.workspace.ensure_project_can_be_removed(&project_id)?)
}

pub(crate) async fn remove_project_impl(
    project_id: String,
    state: &AppState,
) -> Result<(), CommandError> {
    let environment_ids = state.workspace.project_environment_ids(&project_id)?;
    for environment_id in &environment_ids {
        state.runtime.stop(environment_id).await?;
    }
    state
        .terminal
        .kill_environments(environment_ids.iter().map(String::as_str))?;
    state.workspace.remove_project(&project_id)?;
    state.pull_requests.refresh_now();
    Ok(())
}

pub(crate) fn create_managed_worktree_impl(
    mut input: CreateManagedWorktreeRequest,
    state: &AppState,
) -> Result<ManagedWorktreeCreateResult, CommandError> {
    input.project_id = normalized_project_id(&input.project_id)?.to_string();
    let result = state.workspace.create_managed_worktree(input)?;
    state.pull_requests.refresh_now();
    Ok(result)
}

pub(crate) fn list_project_branches_impl(
    project_id: String,
    state: &AppState,
) -> Result<Vec<String>, CommandError> {
    Ok(state
        .workspace
        .list_project_branches(normalized_project_id(&project_id)?)?)
}

fn normalized_project_id(project_id: &str) -> Result<&str, CommandError> {
    let trimmed = project_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Project id cannot be empty.".to_string()).into());
    }
    Ok(trimmed)
}

fn normalized_environment_id(environment_id: &str) -> Result<&str, CommandError> {
    let trimmed = environment_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Environment id is required.".to_string()).into());
    }
    Ok(trimmed)
}

fn normalized_action_id(action_id: &str) -> Result<&str, CommandError> {
    let trimmed = action_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Action id is required.".to_string()).into());
    }
    Ok(trimmed)
}

pub(crate) async fn delete_worktree_environment_impl(
    environment_id: String,
    state: &AppState,
) -> Result<(), CommandError> {
    state
        .workspace
        .ensure_worktree_environment_can_be_deleted(&environment_id)?;
    state.runtime.stop(&environment_id).await?;
    state.terminal.kill_environment(&environment_id)?;
    state
        .workspace
        .delete_worktree_environment(&environment_id)?;
    state.pull_requests.refresh_now();
    Ok(())
}

pub(crate) fn create_thread_impl(
    input: CreateThreadRequest,
    state: &AppState,
) -> Result<ThreadRecord, CommandError> {
    Ok(state.workspace.create_thread(input)?)
}

pub(crate) fn create_chat_thread_impl(
    input: CreateChatThreadRequest,
    state: &AppState,
) -> Result<ChatThreadCreateResult, CommandError> {
    Ok(state.workspace.create_chat_thread(input)?)
}

pub(crate) fn rename_thread_impl(
    input: RenameThreadRequest,
    state: &AppState,
) -> Result<ThreadRecord, CommandError> {
    Ok(state.workspace.rename_thread(input)?)
}

pub(crate) async fn archive_thread_impl(
    input: ArchiveThreadRequest,
    state: &AppState,
) -> Result<ThreadRecord, CommandError> {
    let result = state.workspace.archive_thread(input)?;
    if let Some(environment_id) = result.runtime_environment_to_stop.as_deref() {
        if let Err(error) = state.runtime.stop(environment_id).await {
            warn!(
                environment_id,
                "failed to stop runtime after archiving the last active thread: {error}"
            );
        }
    }
    Ok(result.thread)
}

pub(crate) async fn start_environment_runtime_impl(
    environment_id: String,
    state: &AppState,
) -> Result<RuntimeStatusSnapshot, CommandError> {
    let environment_id = normalized_environment_id(&environment_id)?;
    let runtime_target = state.workspace.environment_runtime_target(environment_id)?;
    Ok(state.runtime.start(environment_id, &runtime_target).await?)
}

pub(crate) async fn stop_environment_runtime_impl(
    environment_id: String,
    state: &AppState,
) -> Result<RuntimeStatusSnapshot, CommandError> {
    Ok(state.runtime.stop(&environment_id).await?)
}

pub(crate) async fn touch_environment_runtime_impl(
    environment_id: String,
    state: &AppState,
) -> Result<bool, CommandError> {
    let environment_id = normalized_environment_id(&environment_id)?;
    Ok(state.runtime.touch(environment_id).await?)
}

pub(crate) async fn get_environment_codex_rate_limits_impl(
    environment_id: String,
    state: &AppState,
) -> Result<CodexRateLimitSnapshot, CommandError> {
    let environment_id = normalized_environment_id(&environment_id)?;
    let runtime_target = state.workspace.environment_runtime_target(environment_id)?;
    Ok(state
        .runtime
        .read_account_rate_limits(
            environment_id,
            &runtime_target.environment_path,
            runtime_target.codex_binary_path,
        )
        .await?)
}

pub(crate) async fn get_environment_capabilities_impl(
    environment_id: String,
    state: &AppState,
) -> Result<EnvironmentCapabilitiesSnapshot, CommandError> {
    let environment_id = normalized_environment_id(&environment_id)?;
    let runtime_target = state.workspace.environment_runtime_target(environment_id)?;
    Ok(state
        .runtime
        .read_capabilities(
            environment_id,
            &runtime_target.environment_path,
            runtime_target.codex_binary_path,
        )
        .await?)
}

pub(crate) fn open_environment_impl(
    input: OpenEnvironmentInput,
    state: &AppState,
) -> Result<(), CommandError> {
    let environment_id = normalized_environment_id(&input.environment_id)?;
    let context = state
        .workspace
        .environment_open_context(environment_id, input.target_id.as_deref())?;
    Ok(crate::services::open::open_environment(
        &context.environment_path,
        &context.target,
    )?)
}
