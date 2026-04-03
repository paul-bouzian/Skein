use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::domain::git_review::{GitChangeSection, GitReviewScope};
use crate::error::{AppError, AppResult};

use super::{
    command_output, current_branch, reference_exists, run_git, stderr_message, stdout_message,
    upstream_branch, validate_relative_path,
    GitEnvironmentContext,
};

pub fn stage_file(repo_root: &Path, path: &str) -> AppResult<()> {
    validate_relative_path(path)?;
    run_git(repo_root, ["add", "--", path])
}

pub fn stage_all(repo_root: &Path) -> AppResult<()> {
    run_git(repo_root, ["add", "--all"])
}

pub fn unstage_file(repo_root: &Path, path: &str) -> AppResult<()> {
    validate_relative_path(path)?;
    if !reference_exists(repo_root, "HEAD") {
        return run_git(repo_root, ["rm", "--cached", "--quiet", "--force", "--", path]);
    }
    run_git(repo_root, ["restore", "--staged", "--", path])
}

pub fn unstage_all(repo_root: &Path) -> AppResult<()> {
    if !reference_exists(repo_root, "HEAD") {
        return run_git(
            repo_root,
            [
                "rm",
                "--cached",
                "--quiet",
                "--force",
                "-r",
                "--ignore-unmatch",
                ".",
            ],
        );
    }
    run_git(repo_root, ["restore", "--staged", "--", "."])
}

pub fn revert_file(repo_root: &Path, path: &str, section: GitChangeSection) -> AppResult<()> {
    if matches!(section, GitChangeSection::Untracked | GitChangeSection::Branch) {
        return Err(AppError::Validation(
            "This change type cannot be reverted from ThreadEx yet.".to_string(),
        ));
    }

    validate_relative_path(path)?;
    match section {
        GitChangeSection::Staged => {
            run_git(repo_root, ["restore", "--source=HEAD", "--staged", "--", path])
        }
        GitChangeSection::Unstaged => run_git(repo_root, ["restore", "--worktree", "--", path]),
        GitChangeSection::Untracked | GitChangeSection::Branch => unreachable!(),
    }
}

pub fn revert_all(repo_root: &Path) -> AppResult<()> {
    run_git(
        repo_root,
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."],
    )
}

pub fn commit(repo_root: &Path, message: &str) -> AppResult<()> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "Commit message cannot be empty.".to_string(),
        ));
    }
    run_git(repo_root, ["commit", "-m", trimmed])
}

pub fn fetch(repo_root: &Path) -> AppResult<()> {
    run_git(repo_root, ["fetch", "--all", "--prune"])
}

pub fn pull(repo_root: &Path) -> AppResult<()> {
    run_git(repo_root, ["pull", "--ff-only"])
}

pub fn push(repo_root: &Path) -> AppResult<()> {
    if upstream_branch(repo_root).is_ok() {
        return run_git(repo_root, ["push"]);
    }

    let branch = current_branch(repo_root)?
        .ok_or_else(|| AppError::Git("Cannot determine the current branch.".to_string()))?;
    run_git(repo_root, ["push", "-u", "origin", &branch])
}

pub fn generate_commit_message(context: &GitEnvironmentContext) -> AppResult<String> {
    let repo_root = Path::new(&context.environment_path);
    let snapshot = super::status::read_review_snapshot(context, GitReviewScope::Uncommitted)?;
    let has_staged = snapshot
        .sections
        .iter()
        .any(|section| section.id == GitChangeSection::Staged && !section.files.is_empty());
    let has_uncommitted = snapshot.summary.dirty;

    if !has_uncommitted {
        return Err(AppError::Validation(
            "No repository changes are available to summarize.".to_string(),
        ));
    }

    let diff_args = if has_staged {
        vec!["diff", "--cached", "--no-ext-diff", "--no-color", "--stat=120,80", "--summary"]
    } else {
        vec!["diff", "--no-ext-diff", "--no-color", "--stat=120,80", "--summary"]
    };
    let patch_args = if has_staged {
        vec!["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"]
    } else {
        vec!["diff", "--no-ext-diff", "--no-color", "--unified=3"]
    };

    let diff_stat = read_command_stdout(repo_root, diff_args)?;
    let patch = read_command_stdout(repo_root, patch_args)?;
    let patch = truncate_diff(&patch, 20_000);
    let untracked_paths = snapshot
        .sections
        .iter()
        .find(|section| section.id == GitChangeSection::Untracked)
        .map(|section| {
            section
                .files
                .iter()
                .map(|file| format!("- {}", file.path))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|value| !value.is_empty());

    let prompt = format!(
        "Generate a concise git commit message for this repository diff.\n\
         Requirements:\n\
         - Use conventional commit format.\n\
         - Prefer a single line under 72 characters.\n\
         - Mention the real change, not generic wording.\n\
         - Output only the commit message.\n\n\
         Diff summary:\n{}\n\n\
         Untracked files:\n{}\n\n\
         Unified diff:\n{}\n",
        if diff_stat.is_empty() { "(no diff summary available)" } else { &diff_stat },
        untracked_paths.as_deref().unwrap_or("(none)"),
        if patch.is_empty() { "(no unified diff available)" } else { &patch },
    );

    let binary = context
        .codex_binary_path
        .clone()
        .unwrap_or_else(|| "codex".to_string());
    let output_path = std::env::temp_dir().join(format!(
        "threadex-commit-message-{}.txt",
        uuid::Uuid::now_v7()
    ));

    let mut command = Command::new(&binary);
    command
        .current_dir(repo_root)
        .args([
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--model",
            &context.default_model,
            "--output-last-message",
            output_path
                .to_str()
                .ok_or_else(|| AppError::Runtime("Invalid temporary output path.".to_string()))?,
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(AppError::from)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).map_err(AppError::from)?;
    }

    let output = child.wait_with_output().map_err(AppError::from)?;
    if !output.status.success() {
        return Err(AppError::Runtime(stderr_message(&output.stderr)));
    }

    let message = fs::read_to_string(&output_path).map_err(AppError::from)?;
    let _ = fs::remove_file(&output_path);
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(AppError::Runtime(
            "Codex returned an empty commit message.".to_string(),
        ));
    }

    Ok(message)
}

fn truncate_diff(diff: &str, limit: usize) -> String {
    if diff.len() <= limit {
        return diff.to_string();
    }

    let truncate_at = diff
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= limit)
        .last()
        .unwrap_or(0);
    let mut truncated = diff[..truncate_at].to_string();
    truncated.push_str("\n\n[diff truncated]");
    truncated
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{commit, revert_file, stage_file, unstage_all, unstage_file};
    use crate::domain::git_review::GitChangeSection;
    use crate::error::AppResult;

    #[test]
    fn commit_rejects_empty_message() {
        let error = commit(Path::new("."), "   ").expect_err("message should fail");
        assert!(error.to_string().contains("cannot be empty"));
    }

    #[test]
    fn git_actions_round_trip_file_staging() -> AppResult<()> {
        let repo = TestRepo::new()?;
        let file = repo.path.join("src/app.ts");
        fs::create_dir_all(file.parent().expect("parent"))?;
        fs::write(&file, "const answer = 1;\n")?;

        stage_file(&repo.path, "src/app.ts")?;
        unstage_file(&repo.path, "src/app.ts")?;
        stage_file(&repo.path, "src/app.ts")?;
        repo.run(["commit", "-m", "feat: add app file"])?;

        fs::write(&file, "const answer = 2;\n")?;
        stage_file(&repo.path, "src/app.ts")?;
        revert_file(&repo.path, "src/app.ts", GitChangeSection::Staged)?;
        let content = fs::read_to_string(&file)?;
        assert_eq!(content, "const answer = 2;\n");
        Ok(())
    }

    #[test]
    fn unstage_all_is_a_noop_on_a_fresh_repo_without_tracked_files() -> AppResult<()> {
        let repo = TestRepo::new()?;
        unstage_all(&repo.path)?;
        Ok(())
    }

    #[test]
    fn revert_unstaged_preserves_staged_changes() -> AppResult<()> {
        let repo = TestRepo::new()?;
        let file = repo.path.join("src/app.ts");
        fs::create_dir_all(file.parent().expect("parent"))?;
        fs::write(&file, "const answer = 1;\n")?;
        stage_file(&repo.path, "src/app.ts")?;
        repo.run(["commit", "-m", "feat: add app file"])?;

        fs::write(&file, "const answer = 2;\n")?;
        stage_file(&repo.path, "src/app.ts")?;
        fs::write(&file, "const answer = 3;\n")?;

        revert_file(&repo.path, "src/app.ts", GitChangeSection::Unstaged)?;

        assert_eq!(fs::read_to_string(&file)?, "const answer = 2;\n");
        assert!(repo
            .stdout(["diff", "--cached", "--", "src/app.ts"])?
            .contains("+const answer = 2;"));
        Ok(())
    }

    #[test]
    fn revert_branch_rejects_with_validation_error() {
        let error = revert_file(Path::new("."), "src/app.ts", GitChangeSection::Branch)
            .expect_err("branch changes should be rejected");
        assert!(error.to_string().contains("cannot be reverted"));
    }

    #[test]
    fn truncate_diff_keeps_utf8_boundaries() {
        let truncated = super::truncate_diff("ééé", 1);
        assert!(truncated.ends_with("[diff truncated]"));
    }

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn new() -> AppResult<Self> {
            let path = std::env::temp_dir().join(format!(
                "threadex-git-actions-{}",
                uuid::Uuid::now_v7()
            ));
            fs::create_dir_all(&path)?;
            let repo = Self { path };
            repo.run(["init", "--initial-branch=main"])?;
            repo.run(["config", "user.email", "threadex@example.com"])?;
            repo.run(["config", "user.name", "ThreadEx Tests"])?;
            Ok(repo)
        }

        fn run<const N: usize>(&self, args: [&str; N]) -> AppResult<()> {
            super::run_git(&self.path, args)
        }

        fn stdout<const N: usize>(&self, args: [&str; N]) -> AppResult<String> {
            Ok(super::stdout_message(&super::command_output(&self.path, args)?.stdout))
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
