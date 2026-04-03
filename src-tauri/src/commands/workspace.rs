use tauri::State;

use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::workspace::{
    EnvironmentRecord, ProjectRecord, RuntimeStatusSnapshot, ThreadRecord, WorkspaceSnapshot,
};
use crate::error::CommandError;
use crate::services::workspace::{
    AddProjectRequest, ArchiveThreadRequest, CreateThreadRequest, CreateWorktreeRequest,
    RenameProjectRequest, RenameThreadRequest,
};
use crate::state::AppState;

#[tauri::command]
pub async fn get_workspace_snapshot(
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, CommandError> {
    let runtime_statuses = state.runtime.refresh_statuses().await?;
    Ok(state.workspace.snapshot(runtime_statuses)?)
}

#[tauri::command]
pub fn update_global_settings(
    patch: GlobalSettingsPatch,
    state: State<'_, AppState>,
) -> Result<GlobalSettings, CommandError> {
    Ok(state.workspace.update_settings(patch)?)
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
pub async fn remove_project(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let environment_ids = state.workspace.project_environment_ids(&project_id)?;
    for environment_id in environment_ids {
        state.runtime.stop(&environment_id).await?;
    }
    state.workspace.remove_project(&project_id)?;
    Ok(())
}

#[tauri::command]
pub fn create_worktree_environment(
    input: CreateWorktreeRequest,
    state: State<'_, AppState>,
) -> Result<EnvironmentRecord, CommandError> {
    Ok(state.workspace.create_worktree(input)?)
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
    let (environment_path, codex_binary_path) =
        state.workspace.environment_runtime_target(&environment_id)?;
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
