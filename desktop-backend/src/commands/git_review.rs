use std::path::Path;

use serde::Deserialize;

use crate::domain::git_review::{GitChangeSection, GitFileDiff, GitReviewScope, GitReviewSnapshot};
use crate::error::{AppError, CommandError};
use crate::services::git;
use crate::services::git::GitEnvironmentContext;
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

pub(crate) async fn get_git_review_snapshot_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    let scope = input.scope;
    with_git_context(state, &input.environment_id, move |context| {
        git::git_review_snapshot(&context, scope)
    })
    .await
}

pub(crate) async fn get_git_file_diff_impl(
    state: &AppState,
    input: GitFileDiffInput,
) -> Result<GitFileDiff, CommandError> {
    let scope = input.scope;
    let section = input.section;
    let path = input.path;
    with_git_context(state, &input.environment_id, move |context| {
        git::git_file_diff(&context, scope, section, &path)
    })
    .await
}

pub(crate) async fn stage_git_file_impl(
    state: &AppState,
    input: GitFileInput,
) -> Result<GitReviewSnapshot, CommandError> {
    let scope = input.scope;
    let path = input.path;
    run_git_update(
        state,
        &input.environment_id,
        scope,
        move |environment_path| git::stage_file(environment_path, &path),
    )
    .await
}

pub(crate) async fn stage_git_all_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    run_git_update(state, &input.environment_id, input.scope, git::stage_all).await
}

pub(crate) async fn unstage_git_file_impl(
    state: &AppState,
    input: GitFileInput,
) -> Result<GitReviewSnapshot, CommandError> {
    let scope = input.scope;
    let path = input.path;
    run_git_update(
        state,
        &input.environment_id,
        scope,
        move |environment_path| git::unstage_file(environment_path, &path),
    )
    .await
}

pub(crate) async fn unstage_git_all_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    run_git_update(state, &input.environment_id, input.scope, git::unstage_all).await
}

pub(crate) async fn revert_git_file_impl(
    state: &AppState,
    input: GitRevertFileInput,
) -> Result<GitReviewSnapshot, CommandError> {
    let scope = input.scope;
    let section = input.section;
    let path = input.path;
    run_git_update(
        state,
        &input.environment_id,
        scope,
        move |environment_path| git::revert_file(environment_path, &path, section),
    )
    .await
}

pub(crate) async fn revert_git_all_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    run_git_update(state, &input.environment_id, input.scope, git::revert_all).await
}

pub(crate) async fn commit_git_impl(
    state: &AppState,
    input: CommitGitInput,
) -> Result<GitReviewSnapshot, CommandError> {
    let scope = input.scope;
    let message = input.message;
    run_git_update(
        state,
        &input.environment_id,
        scope,
        move |environment_path| git::commit(environment_path, &message),
    )
    .await
}

pub(crate) async fn fetch_git_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    run_git_update(state, &input.environment_id, input.scope, git::fetch).await
}

pub(crate) async fn pull_git_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    run_git_update(state, &input.environment_id, input.scope, git::pull).await
}

pub(crate) async fn push_git_impl(
    state: &AppState,
    input: GitScopeInput,
) -> Result<GitReviewSnapshot, CommandError> {
    run_git_update(state, &input.environment_id, input.scope, git::push).await
}

pub(crate) async fn generate_git_commit_message_impl(
    state: &AppState,
    environment_id: &str,
) -> Result<String, CommandError> {
    with_git_context(state, environment_id, move |context| {
        git::generate_commit_message(&context)
    })
    .await
}

async fn run_git_update<F>(
    state: &AppState,
    environment_id: &str,
    scope: GitReviewScope,
    operation: F,
) -> Result<GitReviewSnapshot, CommandError>
where
    F: FnOnce(&Path) -> Result<(), AppError> + Send + 'static,
{
    with_git_context(state, environment_id, move |context| {
        operation(Path::new(&context.environment_path))?;
        git::git_review_snapshot(&context, scope)
    })
    .await
}

async fn with_git_context<T, F>(
    state: &AppState,
    environment_id: &str,
    operation: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(GitEnvironmentContext) -> Result<T, AppError> + Send + 'static,
{
    let context = git_context(state, environment_id)?;
    spawn_blocking(move || operation(context)).await
}

fn git_context(
    state: &AppState,
    environment_id: &str,
) -> Result<GitEnvironmentContext, CommandError> {
    Ok(state.workspace.environment_git_context(environment_id)?)
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
