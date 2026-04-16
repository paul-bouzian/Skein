use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use uuid::Uuid;

use super::{
    normalize_pull_request_state, parse_repository_name_from_pull_request_url,
    parse_repository_name_with_owner_from_remote_url, resolve_head_context,
    resolve_pull_request_for_target, select_display_pull_request, PullRequestHeadContext,
    ResolvedPullRequest, ResolvedPullRequestState,
};
use crate::domain::workspace::PullRequestState;
use crate::services::git;
use crate::services::workspace::{
    AddProjectRequest, CreateManagedWorktreeRequest, PullRequestWatchTarget, WorkspaceService,
};
use crate::services::worktree_scripts::WorktreeScriptService;

#[test]
fn repository_name_with_owner_parses_common_remote_urls() {
    assert_eq!(
        parse_repository_name_with_owner_from_remote_url("git@github.com:owner/repo.git"),
        Some("owner/repo".to_string())
    );
    assert_eq!(
        parse_repository_name_with_owner_from_remote_url(
            "https://github.example.com/owner/repo.git"
        ),
        Some("owner/repo".to_string())
    );
}

#[test]
fn pull_request_url_parses_repository_name() {
    assert_eq!(
        parse_repository_name_from_pull_request_url("https://github.com/owner/repo/pull/42"),
        Some("repo".to_string())
    );
}

#[test]
fn merged_at_wins_when_normalizing_pull_request_state() {
    assert_eq!(
        normalize_pull_request_state(Some("closed"), Some("2026-04-08T10:00:00Z")),
        ResolvedPullRequestState::Merged
    );
}

#[test]
fn select_display_pull_request_prefers_open_then_latest_merged() {
    let selected = select_display_pull_request(vec![
        ResolvedPullRequest {
            number: 9,
            title: "Merged".to_string(),
            url: "https://github.com/acme/skein/pull/9".to_string(),
            head_ref_name: "feature".to_string(),
            state: ResolvedPullRequestState::Merged,
            updated_at: Some("2026-04-08T10:00:00Z".to_string()),
            is_cross_repository: Some(false),
            head_repository_name_with_owner: Some("acme/skein".to_string()),
            head_repository_owner_login: Some("acme".to_string()),
        },
        ResolvedPullRequest {
            number: 10,
            title: "Open".to_string(),
            url: "https://github.com/acme/skein/pull/10".to_string(),
            head_ref_name: "feature".to_string(),
            state: ResolvedPullRequestState::Open,
            updated_at: Some("2026-04-08T09:00:00Z".to_string()),
            is_cross_repository: Some(false),
            head_repository_name_with_owner: Some("acme/skein".to_string()),
            head_repository_owner_login: Some("acme".to_string()),
        },
    ])
    .expect("open pull request should win");

    assert_eq!(selected.number, 10);
    assert_eq!(selected.state, ResolvedPullRequestState::Open);
}

#[test]
fn select_display_pull_request_picks_latest_among_merged_and_closed() {
    let selected = select_display_pull_request(vec![
        ResolvedPullRequest {
            number: 9,
            title: "Older merged".to_string(),
            url: "https://github.com/acme/skein/pull/9".to_string(),
            head_ref_name: "feature".to_string(),
            state: ResolvedPullRequestState::Merged,
            updated_at: Some("2026-04-08T10:00:00Z".to_string()),
            is_cross_repository: Some(false),
            head_repository_name_with_owner: Some("acme/skein".to_string()),
            head_repository_owner_login: Some("acme".to_string()),
        },
        ResolvedPullRequest {
            number: 11,
            title: "Newer closed".to_string(),
            url: "https://github.com/acme/skein/pull/11".to_string(),
            head_ref_name: "feature".to_string(),
            state: ResolvedPullRequestState::Closed,
            updated_at: Some("2026-04-09T09:00:00Z".to_string()),
            is_cross_repository: Some(false),
            head_repository_name_with_owner: Some("acme/skein".to_string()),
            head_repository_owner_login: Some("acme".to_string()),
        },
    ])
    .expect("newer closed pull request should surface over older merged one");

    assert_eq!(selected.number, 11);
    assert_eq!(selected.state, ResolvedPullRequestState::Closed);
}

#[test]
fn select_display_pull_request_falls_back_to_closed_when_no_open_or_merged() {
    let selected = select_display_pull_request(vec![ResolvedPullRequest {
        number: 11,
        title: "Closed without merge".to_string(),
        url: "https://github.com/acme/skein/pull/11".to_string(),
        head_ref_name: "feature".to_string(),
        state: ResolvedPullRequestState::Closed,
        updated_at: Some("2026-04-09T09:00:00Z".to_string()),
        is_cross_repository: Some(false),
        head_repository_name_with_owner: Some("acme/skein".to_string()),
        head_repository_owner_login: Some("acme".to_string()),
    }])
    .expect("closed pull request should surface when no open or merged exists");

    assert_eq!(selected.number, 11);
    assert_eq!(selected.state, ResolvedPullRequestState::Closed);
}

#[test]
fn resolve_head_context_prioritizes_fork_selector_when_tracking_fork_remote() {
    let harness = PullRequestHarness::new().expect("harness");
    let repo = harness
        .create_repo(
            "fuzzy-tiger",
            Some(("feature", "git@github.com:alice/skein.git")),
        )
        .expect("repo should be created");

    let context = resolve_head_context(&repo, "fuzzy-tiger").expect("head context");

    assert_eq!(
        context,
        PullRequestHeadContext {
            head_branch: "fuzzy-tiger".to_string(),
            head_selectors: vec![
                "alice:fuzzy-tiger".to_string(),
                "feature:fuzzy-tiger".to_string(),
                "fuzzy-tiger".to_string(),
            ],
            head_repository_name_with_owner: Some("alice/skein".to_string()),
            head_repository_owner_login: Some("alice".to_string()),
            is_cross_repository: true,
        }
    );
}

#[test]
fn resolve_head_context_falls_back_to_local_branch_without_upstream() {
    let harness = PullRequestHarness::new().expect("harness");
    let repo = harness
        .create_repo("feature/no-upstream", None)
        .expect("repo should be created");

    let context = resolve_head_context(&repo, "feature/no-upstream").expect("head context");

    assert_eq!(context.head_branch, "feature/no-upstream");
    assert_eq!(
        context.head_selectors,
        vec!["feature/no-upstream".to_string()]
    );
    assert!(!context.is_cross_repository);
}

#[test]
fn resolver_prefers_open_pull_requests_and_ignores_closed_only_matches() {
    let _env_lock = environment_lock()
        .lock()
        .expect("environment lock should not be poisoned");
    let harness = PullRequestHarness::new().expect("harness");
    let repo = harness
        .create_repo(
            "fuzzy-tiger",
            Some(("origin", "git@github.com:acme/skein.git")),
        )
        .expect("repo should be created");
    let project = harness
        .workspace
        .add_project(AddProjectRequest {
            path: repo.to_string_lossy().to_string(),
            name: None,
        })
        .expect("project should be added");
    let worktree = harness
        .workspace
        .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
        .expect("worktree should be created");
    let worktree_path = PathBuf::from(&worktree.environment.path);

    let gh_path = mock_gh_command_path(&harness.gh_path);
    fs::write(&gh_path, mock_gh_command_script()).expect("gh script should be written");
    make_executable(&gh_path);
    let previous_path = std::env::var_os("PATH");
    std::env::set_var(
        "PATH",
        prefixed_path(&harness.gh_path, previous_path.as_deref()),
    );

    let snapshot = resolve_pull_request_for_target(&PullRequestWatchTarget {
        environment_id: worktree.environment.id,
        project_id: project.id,
        path: worktree_path.to_string_lossy().to_string(),
        git_branch: "fuzzy-tiger".to_string(),
    })
    .expect("pull request should resolve");

    restore_path(previous_path);

    let snapshot = snapshot.expect("open pull request should be returned");
    assert_eq!(snapshot.number, 17);
    assert_eq!(snapshot.state, PullRequestState::Open);
}

struct PullRequestHarness {
    workspace: WorkspaceService,
    temp_root: PathBuf,
    gh_path: PathBuf,
}

impl PullRequestHarness {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let temp_root = std::env::temp_dir().join(format!("skein-pr-test-{}", Uuid::now_v7()));
        fs::create_dir_all(&temp_root)?;
        let database = crate::infrastructure::database::AppDatabase::for_test(
            temp_root.join("skein.sqlite3"),
        )?;
        let managed_root = temp_root.join("managed-worktrees");
        fs::create_dir_all(&managed_root)?;
        let gh_path = temp_root.join("bin");
        fs::create_dir_all(&gh_path)?;

        Ok(Self {
            workspace: WorkspaceService::new(
                database,
                managed_root,
                WorktreeScriptService::for_test(temp_root.clone()),
            ),
            temp_root,
            gh_path,
        })
    }

    fn create_repo(
        &self,
        branch_name: &str,
        upstream_remote: Option<(&str, &str)>,
    ) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let path = self.temp_root.join(branch_name.replace('/', "-"));
        fs::create_dir_all(&path)?;
        git::run_git(&path, ["init", "--initial-branch=main"])?;
        git::run_git(&path, ["config", "user.email", "skein@example.com"])?;
        git::run_git(&path, ["config", "user.name", "Skein Tests"])?;
        fs::write(path.join("README.md"), "# Skein\n")?;
        git::run_git(&path, ["add", "README.md"])?;
        git::run_git(&path, ["commit", "-m", "Initial commit"])?;
        git::run_git(
            &path,
            ["remote", "add", "origin", "git@github.com:acme/skein.git"],
        )?;
        git::run_git(&path, ["checkout", "-b", branch_name])?;

        if let Some((remote_name, remote_url)) = upstream_remote {
            if remote_name != "origin" {
                git::run_git(&path, ["remote", "add", remote_name, remote_url])?;
            }
            git::run_git(
                &path,
                [
                    "config",
                    &format!("branch.{branch_name}.remote"),
                    remote_name,
                ],
            )?;
            git::run_git(
                &path,
                [
                    "config",
                    &format!("branch.{branch_name}.merge"),
                    &format!("refs/heads/{branch_name}"),
                ],
            )?;
        }

        Ok(path)
    }
}

impl Drop for PullRequestHarness {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.temp_root);
    }
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)
            .expect("script metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("script permissions should update");
    }
}

#[cfg(unix)]
fn mock_gh_command_path(directory: &Path) -> PathBuf {
    directory.join("gh")
}

#[cfg(windows)]
fn mock_gh_command_path(directory: &Path) -> PathBuf {
    directory.join("gh.cmd")
}

#[cfg(unix)]
fn mock_gh_command_script() -> String {
    format!(
        "#!/bin/sh\nif [ \"$1\" = \"pr\" ] && [ \"$2\" = \"list\" ]; then\ncat <<'EOF'\n[{open},{merged},{closed}]\nEOF\nexit 0\nfi\necho unexpected >&2\nexit 1\n",
        open = "{\"number\":17,\"title\":\"Open PR\",\"url\":\"https://github.com/acme/skein/pull/17\",\"baseRefName\":\"main\",\"headRefName\":\"fuzzy-tiger\",\"state\":\"OPEN\",\"updatedAt\":\"2026-04-08T09:00:00Z\"}",
        merged = "{\"number\":16,\"title\":\"Merged PR\",\"url\":\"https://github.com/acme/skein/pull/16\",\"baseRefName\":\"main\",\"headRefName\":\"fuzzy-tiger\",\"state\":\"MERGED\",\"mergedAt\":\"2026-04-08T08:00:00Z\",\"updatedAt\":\"2026-04-08T08:00:00Z\"}",
        closed = "{\"number\":15,\"title\":\"Closed PR\",\"url\":\"https://github.com/acme/skein/pull/15\",\"baseRefName\":\"main\",\"headRefName\":\"fuzzy-tiger\",\"state\":\"CLOSED\",\"updatedAt\":\"2026-04-08T07:00:00Z\"}",
    )
}

#[cfg(windows)]
fn mock_gh_command_script() -> String {
    format!(
        "@echo off\r\nif \"%1\"==\"pr\" if \"%2\"==\"list\" (\r\necho [{open},{merged},{closed}]\r\nexit /b 0\r\n)\r\necho unexpected 1>&2\r\nexit /b 1\r\n",
        open = "{\"number\":17,\"title\":\"Open PR\",\"url\":\"https://github.com/acme/skein/pull/17\",\"baseRefName\":\"main\",\"headRefName\":\"fuzzy-tiger\",\"state\":\"OPEN\",\"updatedAt\":\"2026-04-08T09:00:00Z\"}",
        merged = "{\"number\":16,\"title\":\"Merged PR\",\"url\":\"https://github.com/acme/skein/pull/16\",\"baseRefName\":\"main\",\"headRefName\":\"fuzzy-tiger\",\"state\":\"MERGED\",\"mergedAt\":\"2026-04-08T08:00:00Z\",\"updatedAt\":\"2026-04-08T08:00:00Z\"}",
        closed = "{\"number\":15,\"title\":\"Closed PR\",\"url\":\"https://github.com/acme/skein/pull/15\",\"baseRefName\":\"main\",\"headRefName\":\"fuzzy-tiger\",\"state\":\"CLOSED\",\"updatedAt\":\"2026-04-08T07:00:00Z\"}",
    )
}

fn environment_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn prefixed_path(prefix: &Path, existing: Option<&std::ffi::OsStr>) -> OsString {
    let mut paths = vec![prefix.to_path_buf()];
    if let Some(existing) = existing.filter(|value| !value.is_empty()) {
        paths.extend(std::env::split_paths(existing));
    }
    std::env::join_paths(paths).expect("path entries should be valid")
}

fn restore_path(previous_path: Option<OsString>) {
    if let Some(previous_path) = previous_path {
        std::env::set_var("PATH", previous_path);
    } else {
        std::env::remove_var("PATH");
    }
}
