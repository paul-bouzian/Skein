use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::domain::git_review::{
    GitAction, GitActionCommitResult, GitActionPullRequestResult, GitActionPullResult,
    GitActionPushResult, GitActionResult, GitReviewScope,
};
use crate::error::{AppError, AppResult};

use super::{
    actions::{commit, generate_commit_message, pull, push, stage_all},
    command_output, current_branch, resolve_base_reference, run_git_for_output, stderr_message,
    stdout_message, upstream_branch, GitEnvironmentContext,
};

pub fn run_action(
    context: &GitEnvironmentContext,
    scope: GitReviewScope,
    action: GitAction,
) -> AppResult<GitActionResult> {
    let repo_root = Path::new(&context.environment_path);
    let mut commit_result = None;
    let mut push_result = None;
    let mut pull_result = None;
    let mut pr_result = None;
    let mut action_error = None;

    match action {
        GitAction::Pull => {
            pull(repo_root)?;
            pull_result = Some(GitActionPullResult {
                branch: current_branch_required(repo_root)?,
                upstream_branch: upstream_branch(repo_root).ok(),
            });
        }
        GitAction::Commit => {
            commit_result = Some(commit_all_with_generated_message(context)?);
        }
        GitAction::Push => {
            push(repo_root)?;
            push_result = Some(push_result_snapshot(repo_root)?);
        }
        GitAction::CommitPush => {
            if has_working_tree_changes(repo_root)? {
                commit_result = Some(commit_all_with_generated_message(context)?);
            }
            push(repo_root)?;
            push_result = Some(push_result_snapshot(repo_root)?);
        }
        GitAction::ViewPr => {
            pr_result = Some(resolve_existing_open_pr(repo_root)?);
        }
        GitAction::CreatePr => {
            validate_can_create_pr(context, repo_root)?;
            if has_working_tree_changes(repo_root)? {
                return Err(AppError::Validation(
                    "Commit local changes before creating a pull request.".to_string(),
                ));
            }
            if let Some(existing) = find_open_pr(repo_root)? {
                pr_result = Some(existing);
            } else {
                if needs_push(repo_root)? {
                    push(repo_root)?;
                    push_result = Some(push_result_snapshot(repo_root)?);
                }
                match create_pull_request(context, repo_root, None) {
                    Ok(pr) => pr_result = Some(pr),
                    Err(error) => action_error = Some(error.to_string()),
                }
            }
        }
        GitAction::CommitPushCreatePr => {
            let existing_pr = find_open_pr(repo_root)?;
            if existing_pr.is_none() {
                validate_can_create_pr(context, repo_root)?;
            }
            if has_working_tree_changes(repo_root)? {
                commit_result = Some(commit_all_with_generated_message(context)?);
            }
            if needs_push(repo_root)? {
                push(repo_root)?;
                push_result = Some(push_result_snapshot(repo_root)?);
            }
            if let Some(existing) = existing_pr {
                pr_result = Some(existing);
            } else {
                match create_pull_request(context, repo_root, commit_result.as_ref()) {
                    Ok(pr) => pr_result = Some(pr),
                    Err(error) => action_error = Some(error.to_string()),
                }
            }
        }
    }

    let snapshot = super::status::read_review_snapshot(context, scope)?;
    Ok(GitActionResult {
        environment_id: context.environment_id.clone(),
        action,
        snapshot,
        commit: commit_result,
        push: push_result,
        pull: pull_result,
        pr: pr_result,
        error: action_error,
    })
}

fn commit_all_with_generated_message(
    context: &GitEnvironmentContext,
) -> AppResult<GitActionCommitResult> {
    let repo_root = Path::new(&context.environment_path);
    if !has_working_tree_changes(repo_root)? {
        return Err(AppError::Validation(
            "No repository changes are available to commit.".to_string(),
        ));
    }
    stage_all(repo_root)?;
    let message = generate_commit_message(context)?;
    commit(repo_root, &message)?;
    commit_result_snapshot(repo_root)
}

fn commit_result_snapshot(repo_root: &Path) -> AppResult<GitActionCommitResult> {
    let sha = run_git_for_output(repo_root, ["rev-parse", "--short=12", "HEAD"])?;
    let subject = run_git_for_output(repo_root, ["log", "-1", "--pretty=%s"])?;
    Ok(GitActionCommitResult { sha, subject })
}

fn push_result_snapshot(repo_root: &Path) -> AppResult<GitActionPushResult> {
    Ok(GitActionPushResult {
        branch: current_branch_required(repo_root)?,
        upstream_branch: upstream_branch(repo_root).ok(),
    })
}

fn current_branch_required(repo_root: &Path) -> AppResult<String> {
    current_branch(repo_root)?.ok_or_else(|| {
        AppError::Validation("Checkout a branch before running this Git action.".to_string())
    })
}

fn has_working_tree_changes(repo_root: &Path) -> AppResult<bool> {
    Ok(
        !read_command_stdout(repo_root, ["status", "--porcelain=v1"])?
            .trim()
            .is_empty(),
    )
}

fn needs_push(repo_root: &Path) -> AppResult<bool> {
    if upstream_branch(repo_root).is_err() {
        return Ok(true);
    }
    let ahead = read_command_stdout(repo_root, ["rev-list", "--count", "@{upstream}..HEAD"])?;
    Ok(ahead.trim().parse::<u32>().unwrap_or(0) > 0)
}

fn validate_can_create_pr(context: &GitEnvironmentContext, repo_root: &Path) -> AppResult<()> {
    let branch = current_branch_required(repo_root)?;
    let base =
        resolve_base_reference(repo_root, context.base_branch.as_deref()).ok_or_else(|| {
            AppError::Validation(
                "No base branch is available for creating a pull request.".to_string(),
            )
        })?;
    let base_branch = short_branch_name(repo_root, &base);
    if branch == base_branch || branch == base {
        return Err(AppError::Validation(format!(
            "Cannot create a pull request from '{branch}' into itself."
        )));
    }
    Ok(())
}

fn short_branch_name(repo_root: &Path, reference: &str) -> String {
    let trimmed = reference.trim();
    if let Some(remote_reference) = trimmed.strip_prefix("refs/remotes/") {
        return remote_reference
            .split_once('/')
            .map(|(_, branch)| branch)
            .unwrap_or(remote_reference)
            .to_string();
    }

    if let Ok(remotes) = read_command_stdout(repo_root, ["remote"]) {
        for remote in remotes
            .lines()
            .map(str::trim)
            .filter(|remote| !remote.is_empty())
        {
            if let Some(branch) = trimmed.strip_prefix(&format!("{remote}/")) {
                return branch.to_string();
            }
        }
    }

    trimmed.to_string()
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGhPullRequest {
    number: u64,
    title: String,
    url: String,
    #[serde(default)]
    base_ref_name: Option<String>,
    #[serde(default)]
    head_ref_name: Option<String>,
}

fn resolve_existing_open_pr(repo_root: &Path) -> AppResult<GitActionPullRequestResult> {
    find_open_pr(repo_root)?.ok_or_else(|| {
        AppError::Validation("No open pull request exists for this branch.".to_string())
    })
}

fn find_open_pr(repo_root: &Path) -> AppResult<Option<GitActionPullRequestResult>> {
    let branch = current_branch_required(repo_root)?;
    let output = gh_command_output(
        repo_root,
        [
            "pr",
            "list",
            "--head",
            &branch,
            "--state",
            "open",
            "--limit",
            "1",
            "--json",
            "number,title,url,baseRefName,headRefName",
        ],
    )?;
    let stdout = stdout_message(&output.stdout);
    if stdout.is_empty() {
        return Ok(None);
    }
    let mut pull_requests = serde_json::from_str::<Vec<RawGhPullRequest>>(&stdout)
        .map_err(|error| AppError::Runtime(format!("Invalid GitHub pull request JSON: {error}")))?;
    Ok(pull_requests.pop().map(normalize_gh_pull_request))
}

fn create_pull_request(
    context: &GitEnvironmentContext,
    repo_root: &Path,
    commit_result: Option<&GitActionCommitResult>,
) -> AppResult<GitActionPullRequestResult> {
    let branch = current_branch_required(repo_root)?;
    let base =
        resolve_base_reference(repo_root, context.base_branch.as_deref()).ok_or_else(|| {
            AppError::Validation(
                "No base branch is available for creating a pull request.".to_string(),
            )
        })?;
    let base_branch = short_branch_name(repo_root, &base);
    let title = commit_result
        .map(|commit| commit.subject.clone())
        .or_else(|| run_git_for_output(repo_root, ["log", "-1", "--pretty=%s"]).ok())
        .unwrap_or_else(|| format!("Update {branch}"));
    let body_path = std::env::temp_dir().join(format!("skein-pr-body-{}.md", uuid::Uuid::now_v7()));
    let body_guard = TempFileGuard::new(body_path.clone());
    fs::write(
        body_guard.path(),
        build_pull_request_body(repo_root, &base)?,
    )?;

    let output = gh_command_output(
        repo_root,
        [
            "pr",
            "create",
            "--base",
            &base_branch,
            "--head",
            &branch,
            "--title",
            &title,
            "--body-file",
            body_guard
                .path()
                .to_str()
                .ok_or_else(|| AppError::Runtime("Invalid temporary PR body path.".to_string()))?,
        ],
    )?;
    let url = stdout_message(&output.stdout);
    if url.is_empty() {
        return find_open_pr(repo_root)?
            .ok_or_else(|| AppError::Runtime("GitHub did not return a pull request.".to_string()));
    }

    gh_view_pr(repo_root, &url)?.ok_or_else(|| {
        AppError::Runtime(
            "GitHub created a pull request but its metadata was unavailable.".to_string(),
        )
    })
}

fn gh_view_pr(repo_root: &Path, reference: &str) -> AppResult<Option<GitActionPullRequestResult>> {
    let output = gh_command_output(
        repo_root,
        [
            "pr",
            "view",
            reference,
            "--json",
            "number,title,url,baseRefName,headRefName",
        ],
    )?;
    let stdout = stdout_message(&output.stdout);
    if stdout.is_empty() {
        return Ok(None);
    }
    let raw = serde_json::from_str::<RawGhPullRequest>(&stdout)
        .map_err(|error| AppError::Runtime(format!("Invalid GitHub pull request JSON: {error}")))?;
    Ok(Some(normalize_gh_pull_request(raw)))
}

fn normalize_gh_pull_request(raw: RawGhPullRequest) -> GitActionPullRequestResult {
    GitActionPullRequestResult {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        base_branch: raw.base_ref_name,
        head_branch: raw.head_ref_name,
    }
}

fn build_pull_request_body(repo_root: &Path, base_reference: &str) -> AppResult<String> {
    let stat = read_command_stdout(
        repo_root,
        [
            "diff",
            "--stat=120,80",
            "--summary",
            &format!("{base_reference}...HEAD"),
        ],
    )
    .unwrap_or_default();
    let body = if stat.trim().is_empty() {
        "## Summary\n\n- Update branch changes.\n\n## Tests\n\n- Not run by Skein.\n".to_string()
    } else {
        format!(
            "## Summary\n\n- Update branch changes.\n\n## Changed files\n\n```text\n{}\n```\n\n## Tests\n\n- Not run by Skein.\n",
            stat.trim()
        )
    };
    Ok(body)
}

fn gh_command_output<I, A>(repo_root: &Path, args: I) -> AppResult<Output>
where
    I: IntoIterator<Item = A>,
    A: AsRef<str>,
{
    let mut command = Command::new("gh");
    command.current_dir(repo_root);
    for arg in args {
        command.arg(arg.as_ref());
    }

    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::Runtime(
                "GitHub CLI (`gh`) is required but not available on PATH.".to_string(),
            )
        } else {
            AppError::from(error)
        }
    })?;

    if output.status.success() {
        return Ok(output);
    }

    Err(AppError::Runtime(stderr_message(&output.stderr)))
}

fn read_command_stdout<I, A>(repo_root: &Path, args: I) -> AppResult<String>
where
    I: IntoIterator<Item = A>,
    A: AsRef<str>,
{
    let output = command_output(repo_root, args)?;
    if !output.status.success() {
        return Err(AppError::Git(stderr_message(&output.stderr)));
    }
    Ok(stdout_message(&output.stdout))
}

struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use crate::domain::git_review::{GitAction, GitReviewScope};
    use crate::error::AppResult;
    use crate::services::git::GitEnvironmentContext;

    use super::{run_action, short_branch_name};

    #[test]
    fn run_action_commit_rejects_empty_work_tree() -> AppResult<()> {
        let repo = TestRepo::new()?;
        let context = repo.context();

        let error = run_action(&context, GitReviewScope::Uncommitted, GitAction::Commit)
            .expect_err("empty commit should fail");

        assert!(error.to_string().contains("No repository changes"));
        Ok(())
    }

    #[test]
    fn create_pr_rejects_dirty_work_tree_without_committing() -> AppResult<()> {
        let repo = TestRepo::new()?;
        repo.run(["switch", "-c", "feature/review"])?;
        let context = repo.context_with_branch("feature/review", Some("origin/main"));
        fs::write(repo.path.join("src.ts"), "export const value = 1;\n")?;

        let error = run_action(&context, GitReviewScope::Uncommitted, GitAction::CreatePr)
            .expect_err("dirty createPr should fail before committing");

        assert!(error.to_string().contains("Commit local changes"));
        assert!(repo.stdout(["rev-parse", "--verify", "HEAD"]).is_err());
        Ok(())
    }

    #[test]
    fn short_branch_name_strips_configured_remote_prefixes() -> AppResult<()> {
        let repo = TestRepo::new()?;
        repo.run(["remote", "add", "upstream", "https://example.com/repo.git"])?;

        assert_eq!(short_branch_name(&repo.path, "upstream/main"), "main");
        assert_eq!(
            short_branch_name(&repo.path, "refs/remotes/upstream/main"),
            "main"
        );
        assert_eq!(
            short_branch_name(&repo.path, "feature/main"),
            "feature/main"
        );
        Ok(())
    }

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn new() -> AppResult<Self> {
            let path =
                std::env::temp_dir().join(format!("skein-git-actions-{}", uuid::Uuid::now_v7()));
            fs::create_dir_all(&path)?;
            let repo = Self { path };
            repo.run(["init", "--initial-branch=main"])?;
            repo.run(["config", "user.email", "skein@example.com"])?;
            repo.run(["config", "user.name", "Skein Tests"])?;
            Ok(repo)
        }

        fn run<const N: usize>(&self, args: [&str; N]) -> AppResult<()> {
            crate::services::git::run_git(&self.path, args)
        }

        fn stdout<const N: usize>(&self, args: [&str; N]) -> AppResult<String> {
            let output = super::command_output(&self.path, args)?;
            if !output.status.success() {
                return Err(crate::error::AppError::Git(super::stderr_message(
                    &output.stderr,
                )));
            }
            Ok(super::stdout_message(&output.stdout))
        }

        fn context(&self) -> GitEnvironmentContext {
            self.context_with_branch("main", Some("origin/main"))
        }

        fn context_with_branch(
            &self,
            current_branch: &str,
            base_branch: Option<&str>,
        ) -> GitEnvironmentContext {
            GitEnvironmentContext {
                environment_id: "env-1".to_string(),
                environment_path: self.path.to_string_lossy().to_string(),
                current_branch: Some(current_branch.to_string()),
                base_branch: base_branch.map(ToString::to_string),
                codex_binary_path: None,
                default_model: "gpt-5.4".to_string(),
            }
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
