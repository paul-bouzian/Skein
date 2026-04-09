use tauri::State;
use tracing::warn;

use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::shortcuts::ShortcutSettings;
use crate::domain::workspace::{
    CodexRateLimitSnapshot, ManagedWorktreeCreateResult, ProjectRecord, RuntimeStatusSnapshot,
    ThreadRecord, WorkspaceSnapshot,
};
use crate::error::CommandError;
use crate::services::workspace::{
    AddProjectRequest, ArchiveThreadRequest, CreateThreadRequest, RenameProjectRequest,
    RenameThreadRequest, UpdateProjectSettingsRequest,
};
use crate::state::AppState;

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
pub fn archive_thread(
    input: ArchiveThreadRequest,
    state: State<'_, AppState>,
) -> Result<ThreadRecord, CommandError> {
    Ok(state.workspace.archive_thread(input)?)
}

#[tauri::command]
pub async fn start_environment_runtime(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<RuntimeStatusSnapshot, CommandError> {
    let (environment_path, codex_binary_path) = state
        .workspace
        .environment_runtime_target(&environment_id)?;
    Ok(state
        .runtime
        .start(&environment_id, &environment_path, codex_binary_path)
        .await?)
}

#[tauri::command]
pub async fn stop_environment_runtime(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<RuntimeStatusSnapshot, CommandError> {
    Ok(state.runtime.stop(&environment_id).await?)
}

#[tauri::command]
pub async fn get_environment_codex_rate_limits(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<CodexRateLimitSnapshot, CommandError> {
    let (environment_path, codex_binary_path) = state
        .workspace
        .environment_runtime_target(&environment_id)?;
    Ok(state
        .runtime
        .read_account_rate_limits(&environment_id, &environment_path, codex_binary_path)
        .await?)
}
