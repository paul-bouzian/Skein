use serde::Deserialize;
use tauri::State;

use crate::domain::git_review::{GitChangeSection, GitFileDiff, GitReviewScope, GitReviewSnapshot};
use crate::error::{AppError, CommandError};
use crate::services::git;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitScopeInput {
    pub environment_id: String,
    pub scope: GitReviewScope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileInput {
    pub environment_id: String,
    pub scope: GitReviewScope,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffInput {
    pub environment_id: String,
    pub scope: GitReviewScope,
    pub section: GitChangeSection,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRevertFileInput {
    pub environment_id: String,
    pub scope: GitReviewScope,
    pub section: GitChangeSection,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGitInput {
    pub environment_id: String,
    pub scope: GitReviewScope,
    pub message: String,
}

#[tauri::command]
pub async fn get_git_review_snapshot(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    spawn_blocking(move || git::git_review_snapshot(&context, input.scope)).await
}

#[tauri::command]
pub async fn get_git_file_diff(
    input: GitFileDiffInput,
    state: State<'_, AppState>,
) -> Result<GitFileDiff, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    spawn_blocking(move || git::git_file_diff(&context, input.scope, input.section, &input.path))
        .await
}

#[tauri::command]
pub async fn stage_git_file(
    input: GitFileInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let path = input.path;
    let scope = input.scope;
    spawn_blocking(move || {
        git::stage_file(std::path::Path::new(&context.environment_path), &path)?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn stage_git_all(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    spawn_blocking(move || {
        git::stage_all(std::path::Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn unstage_git_file(
    input: GitFileInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let path = input.path;
    let scope = input.scope;
    spawn_blocking(move || {
        git::unstage_file(std::path::Path::new(&context.environment_path), &path)?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn unstage_git_all(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    spawn_blocking(move || {
        git::unstage_all(std::path::Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn revert_git_file(
    input: GitRevertFileInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let path = input.path;
    let scope = input.scope;
    let section = input.section;
    spawn_blocking(move || {
        git::revert_file(
            std::path::Path::new(&context.environment_path),
            &path,
            section,
        )?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn revert_git_all(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    spawn_blocking(move || {
        git::revert_all(std::path::Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn commit_git(
    input: CommitGitInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    let message = input.message;
    spawn_blocking(move || {
        git::commit(std::path::Path::new(&context.environment_path), &message)?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn fetch_git(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    spawn_blocking(move || {
        git::fetch(std::path::Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn pull_git(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    spawn_blocking(move || {
        git::pull(std::path::Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn push_git(
    input: GitScopeInput,
    state: State<'_, AppState>,
) -> Result<GitReviewSnapshot, CommandError> {
    let context = state
        .workspace
        .environment_git_context(&input.environment_id)?;
    let scope = input.scope;
    spawn_blocking(move || {
        git::push(std::path::Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

#[tauri::command]
pub async fn generate_git_commit_message(
    environment_id: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let context = state.workspace.environment_git_context(&environment_id)?;
    spawn_blocking(move || git::generate_commit_message(&context)).await
}

async fn spawn_blocking<T, F>(operation: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| CommandError::from(AppError::Runtime(error.to_string())))?
        .map_err(CommandError::from)
}
