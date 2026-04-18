use serde::Deserialize;
use serde::Serialize;
use tauri::State;
use tracing::warn;

use crate::domain::conversation::EnvironmentCapabilitiesSnapshot;
use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::shortcuts::ShortcutSettings;
use crate::domain::workspace::{
    ChatThreadCreateResult, CodexRateLimitSnapshot, ManagedWorktreeCreateResult, ProjectActionIcon,
    ProjectRecord, RuntimeStatusSnapshot, ThreadRecord, WorkspaceSnapshot,
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
    #[serde(default)]
    pub pty_id: Option<String>,
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
pub fn run_project_action(
    input: RunProjectActionInput,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RunProjectActionResult, CommandError> {
    let environment_id = input.environment_id.trim();
    if environment_id.is_empty() {
        return Err(AppError::Validation("Environment id is required.".to_string()).into());
    }

    let action_id = input.action_id.trim();
    if action_id.is_empty() {
        return Err(AppError::Validation("Action id is required.".to_string()).into());
    }

    let pty_id = input
        .pty_id
        .as_deref()
        .map(str::trim)
        .filter(|pty_id| !pty_id.is_empty());
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
    let pty_id = if let Some(existing_pty_id) = pty_id {
        state.terminal.rerun_manual_action(
            &app,
            existing_pty_id,
            &target.environment_id,
            &target.action.id,
            env,
            &target.action.script,
        )?;
        existing_pty_id.to_string()
    } else {
        state.terminal.spawn_manual_action(
            &app,
            ManualActionLaunch {
                environment_id: &target.environment_id,
                cwd: &target.cwd,
                cols: 80,
                rows: 24,
                env_overrides: env,
                action_id: &target.action.id,
                script: &target.action.script,
            },
        )?
    };

    Ok(RunProjectActionResult {
        pty_id,
        cwd: target.cwd,
        action_id: target.action.id,
        action_label: target.action.label,
        action_icon: target.action.icon,
    })
}

#[tauri::command]
pub fn reorder_projects(
    input: ReorderProjectsRequest,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.workspace.reorder_projects(input)?)
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
    mut input: CreateManagedWorktreeRequest,
    state: State<'_, AppState>,
) -> Result<ManagedWorktreeCreateResult, CommandError> {
    input.project_id = normalized_project_id(&input.project_id)?.to_string();
    let result = state.workspace.create_managed_worktree(input)?;
    state.pull_requests.refresh_now();
    Ok(result)
}

#[tauri::command]
pub fn list_project_branches(
    project_id: String,
    state: State<'_, AppState>,
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
pub fn create_chat_thread(
    input: CreateChatThreadRequest,
    state: State<'_, AppState>,
) -> Result<ChatThreadCreateResult, CommandError> {
    Ok(state.workspace.create_chat_thread(input)?)
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
pub async fn get_environment_capabilities(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<EnvironmentCapabilitiesSnapshot, CommandError> {
    let environment_id = environment_id.trim();
    if environment_id.is_empty() {
        return Err(AppError::Validation("Environment id is required.".to_string()).into());
    }
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
