use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Output};

use serde::Deserialize;
use tracing::debug;

use crate::domain::workspace::{EnvironmentPullRequestSnapshot, PullRequestState};
use crate::error::{AppError, AppResult};
use crate::services::git;
use crate::services::workspace::PullRequestWatchTarget;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PullRequestHeadContext {
    head_branch: String,
    head_selectors: Vec<String>,
    head_repository_name_with_owner: Option<String>,
    head_repository_owner_login: Option<String>,
    is_cross_repository: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteRepositoryContext {
    repository_name_with_owner: Option<String>,
    owner_login: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedPullRequest {
    number: u64,
    title: String,
    url: String,
    head_ref_name: String,
    state: ResolvedPullRequestState,
    updated_at: Option<String>,
    is_cross_repository: Option<bool>,
    head_repository_name_with_owner: Option<String>,
    head_repository_owner_login: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedPullRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    number: u64,
    title: String,
    url: String,
    head_ref_name: String,
    state: Option<String>,
    merged_at: Option<String>,
    updated_at: Option<String>,
    is_cross_repository: Option<bool>,
    head_repository: Option<RawRepository>,
    head_repository_owner: Option<RawRepositoryOwner>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepository {
    name_with_owner: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepositoryOwner {
    login: String,
}

pub(super) fn resolve_pull_request_for_target(
    target: &PullRequestWatchTarget,
) -> AppResult<Option<EnvironmentPullRequestSnapshot>> {
    let repo_root = Path::new(&target.path);
    if !repo_root.exists() {
        return Ok(None);
    }

    let head_context = resolve_head_context(repo_root, &target.git_branch)?;
    let pull_requests = list_matching_pull_requests(repo_root, &head_context)?;
    let next_pull_request = select_display_pull_request(pull_requests);

    Ok(
        next_pull_request.map(|pull_request| EnvironmentPullRequestSnapshot {
            number: pull_request.number,
            title: pull_request.title,
            url: pull_request.url,
            state: match pull_request.state {
                ResolvedPullRequestState::Open => PullRequestState::Open,
                ResolvedPullRequestState::Merged => PullRequestState::Merged,
                ResolvedPullRequestState::Closed => PullRequestState::Closed,
            },
        }),
    )
}

fn resolve_head_context(repo_root: &Path, local_branch: &str) -> AppResult<PullRequestHeadContext> {
    let upstream_ref = git::upstream_branch(repo_root).ok();
    let remote_name = read_git_config_value(repo_root, &format!("branch.{local_branch}.remote"))?
        .or_else(|| {
            upstream_ref
                .as_deref()
                .and_then(|reference| reference.split('/').next().map(ToString::to_string))
        });
    let head_branch = upstream_ref
        .as_deref()
        .map(|reference| extract_branch_name_from_remote_ref(reference, remote_name.as_deref()))
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or_else(|| local_branch.to_string());
    let should_probe_local_selector = upstream_ref.is_none() || head_branch == local_branch;

    let remote_repository = resolve_remote_repository_context(repo_root, remote_name.as_deref())?;
    let origin_repository = resolve_remote_repository_context(repo_root, Some("origin"))?;
    let is_cross_repository = match (
        remote_repository.repository_name_with_owner.as_deref(),
        origin_repository.repository_name_with_owner.as_deref(),
    ) {
        (Some(remote_repository), Some(origin_repository)) => {
            !remote_repository.eq_ignore_ascii_case(origin_repository)
        }
        (Some(_), None) => remote_name.as_deref().is_some_and(|name| name != "origin"),
        _ => false,
    };

    let owner_selector = remote_repository
        .owner_login
        .as_deref()
        .map(|owner| format!("{owner}:{head_branch}"));
    let remote_alias_selector = remote_name
        .as_deref()
        .map(|name| format!("{name}:{head_branch}"));
    let should_probe_remote_owned_selectors =
        is_cross_repository || remote_name.as_deref().is_some_and(|name| name != "origin");

    let mut head_selectors = Vec::new();
    if is_cross_repository && should_probe_remote_owned_selectors {
        push_unique_selector(&mut head_selectors, owner_selector.as_deref());
        push_unique_selector(&mut head_selectors, remote_alias_selector.as_deref());
    }
    if should_probe_local_selector {
        push_unique_selector(&mut head_selectors, Some(local_branch));
    }
    if head_branch != local_branch {
        push_unique_selector(&mut head_selectors, Some(&head_branch));
    }
    if !is_cross_repository && should_probe_remote_owned_selectors {
        push_unique_selector(&mut head_selectors, owner_selector.as_deref());
        push_unique_selector(&mut head_selectors, remote_alias_selector.as_deref());
    }

    Ok(PullRequestHeadContext {
        head_branch,
        head_selectors,
        head_repository_name_with_owner: remote_repository.repository_name_with_owner,
        head_repository_owner_login: remote_repository.owner_login,
        is_cross_repository,
    })
}

fn list_matching_pull_requests(
    repo_root: &Path,
    head_context: &PullRequestHeadContext,
) -> AppResult<Vec<ResolvedPullRequest>> {
    let mut pull_requests_by_number = HashMap::new();

    for head_selector in &head_context.head_selectors {
        let output = gh_command_output(
            repo_root,
            [
                "pr",
                "list",
                "--head",
                head_selector,
                "--state",
                "all",
                "--limit",
                "20",
                "--json",
                "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
            ],
        )?;
        let raw_stdout = git::stdout_message(&output.stdout);
        if raw_stdout.is_empty() {
            continue;
        }

        let raw_pull_requests =
            serde_json::from_str::<Vec<RawPullRequest>>(&raw_stdout).map_err(|error| {
                AppError::Runtime(format!("Invalid GitHub pull request JSON: {error}"))
            })?;

        for raw_pull_request in raw_pull_requests {
            let pull_request = normalize_pull_request(raw_pull_request);
            if matches_head_context(&pull_request, head_context) {
                pull_requests_by_number.insert(pull_request.number, pull_request);
            }
        }
    }

    Ok(pull_requests_by_number.into_values().collect())
}

fn select_display_pull_request(
    mut pull_requests: Vec<ResolvedPullRequest>,
) -> Option<ResolvedPullRequest> {
    pull_requests.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    if let Some(open) = pull_requests
        .iter()
        .find(|pull_request| pull_request.state == ResolvedPullRequestState::Open)
        .cloned()
    {
        return Some(open);
    }
    // Among non-open PRs, surface the most recently updated one so a freshly
    // closed rejection wins over an older merge on the same branch (and vice
    // versa). The list is already sorted by updated_at desc above.
    pull_requests.into_iter().find(|pull_request| {
        matches!(
            pull_request.state,
            ResolvedPullRequestState::Merged | ResolvedPullRequestState::Closed
        )
    })
}

fn normalize_pull_request(raw: RawPullRequest) -> ResolvedPullRequest {
    let head_repository_name_with_owner = raw
        .head_repository
        .map(|repository| repository.name_with_owner)
        .filter(|value| !value.trim().is_empty());
    let head_repository_owner_login = raw
        .head_repository_owner
        .map(|owner| owner.login)
        .filter(|value| !value.trim().is_empty());

    ResolvedPullRequest {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        head_ref_name: raw.head_ref_name,
        state: normalize_pull_request_state(raw.state.as_deref(), raw.merged_at.as_deref()),
        updated_at: raw.updated_at.filter(|value| !value.trim().is_empty()),
        is_cross_repository: raw.is_cross_repository,
        head_repository_name_with_owner,
        head_repository_owner_login,
    }
}

fn normalize_pull_request_state(
    state: Option<&str>,
    merged_at: Option<&str>,
) -> ResolvedPullRequestState {
    if merged_at.is_some_and(|value| !value.trim().is_empty())
        || state.is_some_and(|value| value.eq_ignore_ascii_case("merged"))
    {
        return ResolvedPullRequestState::Merged;
    }
    if state.is_some_and(|value| value.eq_ignore_ascii_case("closed")) {
        return ResolvedPullRequestState::Closed;
    }
    ResolvedPullRequestState::Open
}

fn matches_head_context(
    pull_request: &ResolvedPullRequest,
    head_context: &PullRequestHeadContext,
) -> bool {
    if pull_request.head_ref_name != head_context.head_branch {
        return false;
    }

    let expected_repository =
        normalize_optional_repository_name(head_context.head_repository_name_with_owner.as_deref());
    let expected_owner =
        normalize_optional_owner_login(head_context.head_repository_owner_login.as_deref())
            .or_else(|| parse_repository_owner(expected_repository.as_deref()));
    let pull_request_repository = normalize_optional_repository_name(
        resolve_pull_request_head_repository_name(pull_request).as_deref(),
    );
    let pull_request_owner =
        normalize_optional_owner_login(pull_request.head_repository_owner_login.as_deref())
            .or_else(|| parse_repository_owner(pull_request_repository.as_deref()));

    if head_context.is_cross_repository {
        if pull_request.is_cross_repository == Some(false) {
            return false;
        }
        if (expected_repository.is_some() || expected_owner.is_some())
            && pull_request_repository.is_none()
            && pull_request_owner.is_none()
        {
            return false;
        }
        if expected_repository.is_some() && pull_request_repository.is_some() {
            return expected_repository == pull_request_repository;
        }
        if expected_owner.is_some() && pull_request_owner.is_some() {
            return expected_owner == pull_request_owner;
        }
        return true;
    }

    if pull_request.is_cross_repository == Some(true) {
        return false;
    }
    if expected_repository.is_some() && pull_request_repository.is_some() {
        return expected_repository == pull_request_repository;
    }
    if expected_owner.is_some() && pull_request_owner.is_some() {
        return expected_owner == pull_request_owner;
    }
    true
}

fn resolve_pull_request_head_repository_name(pull_request: &ResolvedPullRequest) -> Option<String> {
    if let Some(name_with_owner) = pull_request.head_repository_name_with_owner.as_deref() {
        return Some(name_with_owner.to_string());
    }
    if pull_request.is_cross_repository == Some(true) {
        let owner = pull_request.head_repository_owner_login.as_deref()?;
        let repository = parse_repository_name_from_pull_request_url(&pull_request.url)?;
        return Some(format!("{owner}/{repository}"));
    }
    None
}

fn normalize_optional_repository_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn normalize_optional_owner_login(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn resolve_remote_repository_context(
    repo_root: &Path,
    remote_name: Option<&str>,
) -> AppResult<RemoteRepositoryContext> {
    let Some(remote_name) = remote_name else {
        return Ok(RemoteRepositoryContext {
            repository_name_with_owner: None,
            owner_login: None,
        });
    };

    let remote_url = read_git_config_value(repo_root, &format!("remote.{remote_name}.url"))?;
    let repository_name_with_owner = remote_url
        .as_deref()
        .and_then(parse_repository_name_with_owner_from_remote_url);
    let owner_login = parse_repository_owner(repository_name_with_owner.as_deref());

    Ok(RemoteRepositoryContext {
        repository_name_with_owner,
        owner_login,
    })
}

fn read_git_config_value(repo_root: &Path, key: &str) -> AppResult<Option<String>> {
    let output = git::command_output(repo_root, ["config", "--get", key])?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = git::stdout_message(&output.stdout);
    Ok((!value.is_empty()).then_some(value))
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

    let message = gh_stderr_message(&output.stderr);
    if is_expected_gh_failure(&message) {
        debug!(cwd = %repo_root.display(), "pull request lookup unavailable: {message}");
        return Ok(Output {
            status: output.status,
            stdout: Vec::new(),
            stderr: output.stderr,
        });
    }

    Err(AppError::Runtime(message))
}

fn is_expected_gh_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("authentication failed")
        || lower.contains("could not resolve to a repository")
        || lower.contains("unable to determine base repository")
        || lower.contains("no git remotes found")
        || lower.contains("not a git repository")
}

fn parse_repository_name_with_owner_from_remote_url(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_scheme = trimmed
        .strip_prefix("git@")
        .and_then(|value| value.split_once(':').map(|(_, path)| path.to_string()))
        .or_else(|| {
            trimmed
                .strip_prefix("ssh://git@")
                .and_then(|value| value.split_once('/').map(|(_, path)| path.to_string()))
        })
        .or_else(|| {
            trimmed
                .split_once("://")
                .and_then(|(_, value)| value.split_once('/').map(|(_, path)| path.to_string()))
        })?;
    let normalized = without_scheme
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let mut segments = normalized.split('/').filter(|segment| !segment.is_empty());
    let owner = segments.next()?;
    let repository = segments.next()?;
    Some(format!("{owner}/{repository}"))
}

fn parse_repository_owner(repository_name_with_owner: Option<&str>) -> Option<String> {
    repository_name_with_owner?
        .split('/')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn parse_repository_name_from_pull_request_url(url: &str) -> Option<String> {
    let segments = url
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let pull_index = segments.iter().position(|segment| *segment == "pull")?;
    (pull_index >= 1).then(|| segments[pull_index - 1].to_string())
}

fn extract_branch_name_from_remote_ref(reference: &str, remote_name: Option<&str>) -> String {
    if let Some(remote_name) = remote_name {
        let prefix = format!("{remote_name}/");
        if let Some(branch) = reference.strip_prefix(&prefix) {
            return branch.to_string();
        }
    }
    reference
        .split_once('/')
        .map(|(_, branch)| branch.to_string())
        .unwrap_or_else(|| reference.to_string())
}

fn push_unique_selector(selectors: &mut Vec<String>, candidate: Option<&str>) {
    let Some(candidate) = candidate.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    if selectors.iter().any(|selector| selector == candidate) {
        return;
    }
    selectors.push(candidate.to_string());
}

fn gh_stderr_message(buffer: &[u8]) -> String {
    let message = String::from_utf8_lossy(buffer).trim().to_string();
    if message.is_empty() {
        "GitHub command failed.".to_string()
    } else {
        message
    }
}

#[cfg(test)]
mod tests;
