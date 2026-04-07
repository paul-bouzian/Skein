mod actions;
mod diff;
mod status;

use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

use crate::domain::git_review::{GitChangeSection, GitFileDiff, GitReviewScope, GitReviewSnapshot};
use crate::error::{AppError, AppResult};

pub use actions::{
    commit, fetch, generate_commit_message, pull, push, revert_all, revert_file, stage_all,
    stage_file, unstage_all, unstage_file,
};

#[derive(Debug, Clone)]
pub struct RepoContext {
    pub root_path: PathBuf,
    pub current_branch: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GitEnvironmentContext {
    pub environment_id: String,
    pub environment_path: String,
    pub current_branch: Option<String>,
    pub base_branch: Option<String>,
    pub codex_binary_path: Option<String>,
    pub default_model: String,
}

pub fn resolve_repo_context(path: &str) -> AppResult<RepoContext> {
    let root_path = run_git_for_output(path, ["rev-parse", "--show-toplevel"])?;
    let current_branch = run_git_for_output(&root_path, ["branch", "--show-current"]).ok();

    Ok(RepoContext {
        root_path: PathBuf::from(root_path),
        current_branch,
    })
}

pub fn current_branch(path: &Path) -> AppResult<Option<String>> {
    Ok(run_git_for_output(path, ["branch", "--show-current"]).ok())
}

pub fn create_worktree(
    repo_root: &Path,
    destination: &Path,
    branch_name: &str,
    base_branch: &str,
) -> AppResult<()> {
    if destination.exists() {
        return Err(AppError::Validation(format!(
            "The worktree path '{}' already exists.",
            destination.display()
        )));
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }

    run_git(
        repo_root,
        [
            "worktree",
            "add",
            "-b",
            branch_name,
            &destination.to_string_lossy(),
            base_branch,
        ],
    )
}

pub fn remove_worktree(repo_root: &Path, destination: &Path) -> AppResult<()> {
    run_git(
        repo_root,
        [
            "worktree",
            "remove",
            "--force",
            &destination.to_string_lossy(),
        ],
    )
}

pub fn move_worktree(repo_root: &Path, current_path: &Path, next_path: &Path) -> AppResult<()> {
    if current_path == next_path {
        return Ok(());
    }

    if next_path.exists() {
        return Err(AppError::Validation(format!(
            "The target worktree path '{}' already exists.",
            next_path.display()
        )));
    }

    if let Some(parent) = next_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    run_git(
        repo_root,
        [
            "worktree",
            "move",
            &current_path.to_string_lossy(),
            &next_path.to_string_lossy(),
        ],
    )
}

pub fn delete_branch(repo_root: &Path, branch_name: &str) -> AppResult<()> {
    if !branch_exists(repo_root, branch_name)? {
        return Ok(());
    }

    run_git(repo_root, ["branch", "-D", branch_name])
}

pub fn rename_branch(repo_root: &Path, current_branch: &str, next_branch: &str) -> AppResult<()> {
    if current_branch.trim() == next_branch.trim() {
        return Ok(());
    }

    run_git(repo_root, ["branch", "-m", current_branch, next_branch])
}

pub fn sanitize_path_component(value: &str, fallback: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            result.push(character.to_ascii_lowercase());
        } else {
            result.push('-');
        }
    }
    let trimmed = result.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn managed_worktree_project_path(managed_root: &Path, project_directory: &str) -> PathBuf {
    managed_root.join(sanitize_path_component(project_directory, "project"))
}

pub fn managed_worktree_path(
    managed_root: &Path,
    project_directory: &str,
    worktree_name: &str,
) -> PathBuf {
    managed_worktree_project_path(managed_root, project_directory)
        .join(sanitize_path_component(worktree_name, "worktree"))
}

pub fn git_review_snapshot(
    context: &GitEnvironmentContext,
    scope: GitReviewScope,
) -> AppResult<GitReviewSnapshot> {
    status::read_review_snapshot(context, scope)
}

pub fn git_file_diff(
    context: &GitEnvironmentContext,
    scope: GitReviewScope,
    section: GitChangeSection,
    path: &str,
) -> AppResult<GitFileDiff> {
    diff::read_file_diff(context, scope, section, path)
}

pub(crate) fn validate_relative_path(path: &str) -> AppResult<()> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(AppError::Validation(
            "Expected a repository-relative path.".to_string(),
        ));
    }

    if candidate.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(AppError::Validation(
            "Path traversal is not allowed for Git actions.".to_string(),
        ));
    }

    Ok(())
}

pub(crate) fn resolve_base_reference(repo_root: &Path, preferred: Option<&str>) -> Option<String> {
    if let Some(preferred) = preferred.filter(|value| !value.trim().is_empty()) {
        return Some(preferred.to_string());
    }

    if let Ok(upstream) = upstream_branch(repo_root) {
        return Some(upstream);
    }

    if let Ok(origin_head) =
        run_git_for_output(repo_root, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    {
        return Some(origin_head.trim_start_matches("refs/remotes/").to_string());
    }

    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find(|candidate| reference_exists(repo_root, candidate))
        .map(ToString::to_string)
}

pub(crate) fn upstream_branch(repo_root: &Path) -> AppResult<String> {
    run_git_for_output(
        repo_root,
        [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
}

pub(crate) fn reference_exists(repo_root: &Path, reference: &str) -> bool {
    run_git(repo_root, ["rev-parse", "--verify", "--quiet", reference]).is_ok()
}

pub fn list_branch_refs(repo_root: &Path) -> AppResult<Vec<String>> {
    let output = command_output(
        repo_root,
        [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    if !output.status.success() {
        return Err(AppError::Git(stderr_message(&output.stderr)));
    }

    Ok(stdout_message_lines(&output.stdout))
}

pub fn branch_exists(repo_root: &Path, branch_name: &str) -> AppResult<bool> {
    let needle = branch_name.trim();
    Ok(list_branch_refs(repo_root)?.into_iter().any(|reference| {
        reference == needle
            || reference
                .split_once('/')
                .is_some_and(|(_, remote_branch)| remote_branch == needle)
    }))
}

pub(crate) fn run_git<P, I, A>(path: P, args: I) -> AppResult<()>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = A>,
    A: AsRef<str>,
{
    let output = command_output(path, args)?;

    if output.status.success() {
        return Ok(());
    }

    Err(AppError::Git(stderr_message(&output.stderr)))
}

pub(crate) fn run_git_for_output<P, I, A>(path: P, args: I) -> AppResult<String>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = A>,
    A: AsRef<str>,
{
    let output = command_output(path, args)?;

    if output.status.success() {
        let value = stdout_message(&output.stdout);
        if value.is_empty() {
            return Err(AppError::Git("Git returned an empty response.".to_string()));
        }
        return Ok(value);
    }

    Err(AppError::Git(stderr_message(&output.stderr)))
}

pub(crate) fn command_output<P, I, A>(path: P, args: I) -> AppResult<Output>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = A>,
    A: AsRef<str>,
{
    let mut command = Command::new("git");
    command.current_dir(path.as_ref());

    for argument in args {
        command.arg(argument.as_ref());
    }

    command.output().map_err(AppError::from)
}

pub(crate) fn stdout_message(buffer: &[u8]) -> String {
    String::from_utf8_lossy(buffer).trim().to_string()
}

pub(crate) fn stderr_message(buffer: &[u8]) -> String {
    let message = String::from_utf8_lossy(buffer).trim().to_string();
    if message.is_empty() {
        "Git command failed.".to_string()
    } else {
        message
    }
}

fn stdout_message_lines(buffer: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(buffer)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        managed_worktree_path, managed_worktree_project_path, sanitize_path_component,
        validate_relative_path,
    };

    #[test]
    fn path_component_sanitization_removes_unsafe_characters() {
        assert_eq!(
            sanitize_path_component("ThreadEx Workspace!", "fallback"),
            "threadex-workspace"
        );
    }

    #[test]
    fn managed_worktree_project_path_is_nested_under_threadex_home_directory() {
        let path = managed_worktree_project_path(
            Path::new("/Users/test/.threadex/worktrees"),
            "Acme Repo",
        );
        assert_eq!(path, Path::new("/Users/test/.threadex/worktrees/acme-repo"));
    }

    #[test]
    fn managed_worktree_path_is_nested_under_project_directory() {
        let path = managed_worktree_path(
            Path::new("/Users/test/.threadex/worktrees"),
            "Acme Repo",
            "feature-plan-mode",
        );
        assert_eq!(
            path,
            Path::new("/Users/test/.threadex/worktrees/acme-repo/feature-plan-mode")
        );
    }

    #[test]
    fn git_actions_reject_parent_path_segments() {
        let error = validate_relative_path("../secrets.txt").expect_err("path should be rejected");
        assert!(error.to_string().contains("Path traversal"));
    }
}
