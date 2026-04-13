use serde::Deserialize;
use tauri::State;
use tracing::warn;

use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::shortcuts::ShortcutSettings;
use crate::domain::workspace::{
    CodexRateLimitSnapshot, ManagedWorktreeCreateResult, ProjectRecord, RuntimeStatusSnapshot,
    ThreadRecord, WorkspaceSnapshot,
};
use crate::error::{AppError, CommandError};
use crate::services::workspace::{
    AddProjectRequest, ArchiveThreadRequest, CreateThreadRequest, RenameProjectRequest,
    RenameThreadRequest, ReorderProjectsRequest, ReorderWorktreeEnvironmentsRequest,
    SetProjectSidebarCollapsedRequest, UpdateProjectSettingsRequest,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEnvironmentInput {
    pub environment_id: String,
    pub target_id: Option<String>,
}

#[tauri::command]
pub async fn get_workspace_snapshot(
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, CommandError> {
    let runtime_statuses = state.runtime.refresh_statuses().await?;
    let pull_requests = state.pull_requests.snapshot();
    Ok(state
        .workspace
        .snapshot_with_pull_requests(runtime_statuses, &pull_requests)?)
}

#[tauri::command]
pub fn update_global_settings(
    patch: GlobalSettingsPatch,
    state: State<'_, AppState>,
) -> Result<GlobalSettings, CommandError> {
    let settings = state.workspace.update_settings(patch)?;
    #[cfg(target_os = "macos")]
    if let Err(error) = crate::menu::sync_settings_menu_shortcut(&state.handle, &settings) {
        warn!("failed to sync settings menu shortcut after saving settings: {error}");
    }
    Ok(settings)
}

#[tauri::command]
pub fn get_shortcut_defaults() -> ShortcutSettings {
    ShortcutSettings::default()
}

#[tauri::command]
pub fn add_project(
    input: AddProjectRequest,
    state: State<'_, AppState>,
) -> Result<ProjectRecord, CommandError> {
    Ok(state.workspace.add_project(input)?)
}

#[tauri::command]
pub fn rename_project(
    input: RenameProjectRequest,
    state: State<'_, AppState>,
) -> Result<ProjectRecord, CommandError> {
    Ok(state.workspace.rename_project(input)?)
}

#[tauri::command]
pub fn update_project_settings(
    input: UpdateProjectSettingsRequest,
    state: State<'_, AppState>,
) -> Result<ProjectRecord, CommandError> {
    Ok(state.workspace.update_project_settings(input)?)
}

#[tauri::command]
pub fn reorder_projects(
    input: ReorderProjectsRequest,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.workspace.reorder_projects(input)?)
}

#[tauri::command]
pub fn reorder_worktree_environments(
    input: ReorderWorktreeEnvironmentsRequest,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.workspace.reorder_worktree_environments(input)?)
}

#[tauri::command]
pub fn set_project_sidebar_collapsed(
    input: SetProjectSidebarCollapsedRequest,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.workspace.set_project_sidebar_collapsed(input)?)
}

#[tauri::command]
pub fn ensure_project_can_be_removed(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.workspace.ensure_project_can_be_removed(&project_id)?)
}

#[tauri::command]
pub async fn remove_project(
    project_id: String,
    state: State<'_, AppState>,
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

#[tauri::command]
pub fn create_managed_worktree(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<ManagedWorktreeCreateResult, CommandError> {
    let result = state.workspace.create_managed_worktree(&project_id)?;
    state.pull_requests.refresh_now();
    Ok(result)
}

#[tauri::command]
pub async fn delete_worktree_environment(
    environment_id: String,
    state: State<'_, AppState>,
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

#[tauri::command]
pub fn create_thread(
    input: CreateThreadRequest,
    state: State<'_, AppState>,
) -> Result<ThreadRecord, CommandError> {
    Ok(state.workspace.create_thread(input)?)
}

#[tauri::command]
pub fn rename_thread(
    input: RenameThreadRequest,
    state: State<'_, AppState>,
) -> Result<ThreadRecord, CommandError> {
    Ok(state.workspace.rename_thread(input)?)
}

#[tauri::command]
pub async fn archive_thread(
    input: ArchiveThreadRequest,
    state: State<'_, AppState>,
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

#[tauri::command]
pub async fn start_environment_runtime(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<RuntimeStatusSnapshot, CommandError> {
    let environment_id = environment_id.trim();
    if environment_id.is_empty() {
        return Err(AppError::Validation("Environment id is required.".to_string()).into());
    }
    let runtime_target = state.workspace.environment_runtime_target(environment_id)?;
    Ok(state.runtime.start(environment_id, &runtime_target).await?)
}

#[tauri::command]
pub async fn stop_environment_runtime(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<RuntimeStatusSnapshot, CommandError> {
    Ok(state.runtime.stop(&environment_id).await?)
}

#[tauri::command]
pub async fn touch_environment_runtime(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let environment_id = environment_id.trim();
    if environment_id.is_empty() {
        return Err(AppError::Validation("Environment id is required.".to_string()).into());
    }
    Ok(state.runtime.touch(environment_id).await?)
}

#[tauri::command]
pub async fn get_environment_codex_rate_limits(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<CodexRateLimitSnapshot, CommandError> {
    let environment_id = environment_id.trim();
    if environment_id.is_empty() {
        return Err(AppError::Validation("Environment id is required.".to_string()).into());
    }
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

#[tauri::command]
pub fn open_environment(
    input: OpenEnvironmentInput,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let environment_id = input.environment_id.trim();
    if environment_id.is_empty() {
        return Err(
            crate::error::AppError::Validation("Environment id is required.".to_string()).into(),
        );
    }
    let context = state
        .workspace
        .environment_open_context(environment_id, input.target_id.as_deref())?;
    Ok(crate::services::open::open_environment(
        &context.environment_path,
        &context.target,
    )?)
}
