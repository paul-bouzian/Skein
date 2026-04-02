use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct RepoContext {
    pub root_path: PathBuf,
    pub current_branch: Option<String>,
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

pub fn ensure_branch_name(name: &str) -> AppResult<String> {
    let slug = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|character| match character {
            'a'..='z' | '0'..='9' => character,
            '/' | '-' => character,
            _ => '-',
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if slug.is_empty() {
        return Err(AppError::Validation(
            "The worktree or branch name cannot be empty.".to_string(),
        ));
    }

    Ok(slug)
}

pub fn managed_worktree_path(repo_root: &Path, branch_name: &str) -> PathBuf {
    let project_name = repo_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project");
    let parent = repo_root.parent().unwrap_or(repo_root);

    parent
        .join(".threadex-worktrees")
        .join(project_name)
        .join(branch_name)
}

fn run_git<P, I, A>(path: P, args: I) -> AppResult<()>
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

fn run_git_for_output<P, I, A>(path: P, args: I) -> AppResult<String>
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

fn command_output<P, I, A>(path: P, args: I) -> AppResult<std::process::Output>
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

fn stdout_message(buffer: &[u8]) -> String {
    String::from_utf8_lossy(buffer).trim().to_string()
}

fn stderr_message(buffer: &[u8]) -> String {
    let message = String::from_utf8_lossy(buffer).trim().to_string();
    if message.is_empty() {
        "Git command failed.".to_string()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{ensure_branch_name, managed_worktree_path};

    #[test]
    fn branch_name_is_sanitized_into_a_git_safe_slug() {
        let slug = ensure_branch_name(" Feature: Plan Mode UI! ").expect("slug should be created");
        assert_eq!(slug, "feature-plan-mode-ui");
    }

    #[test]
    fn branch_name_rejects_empty_values() {
        let error = ensure_branch_name("   ").expect_err("empty name should fail");
        assert!(error.to_string().contains("cannot be empty"));
    }

    #[test]
    fn managed_worktree_path_is_nested_under_threadex_directory() {
        let path = managed_worktree_path(Path::new("/tmp/acme/repo"), "feature-plan-mode");
        assert_eq!(
            path,
            Path::new("/tmp/acme/.threadex-worktrees/repo/feature-plan-mode")
        );
    }
}
