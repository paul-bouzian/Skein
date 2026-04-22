use std::path::Path;

use crate::domain::git_review::{
    GitChangeKind, GitChangeSection, GitChangeSectionSnapshot, GitFileChange, GitRepoSummary,
    GitReviewScope, GitReviewSnapshot,
};
use crate::error::{AppError, AppResult};

use super::{
    command_output, current_branch, resolve_base_reference, stderr_message, stdout_message,
    upstream_branch, GitEnvironmentContext,
};

pub(super) fn read_review_snapshot(
    context: &GitEnvironmentContext,
    scope: GitReviewScope,
) -> AppResult<GitReviewSnapshot> {
    let repo_root = Path::new(&context.environment_path);
    let branch = current_branch(repo_root)?.or_else(|| context.current_branch.clone());
    let base_branch = resolve_base_reference(repo_root, context.base_branch.as_deref());
    let upstream_branch = upstream_branch(repo_root).ok();

    let summary = build_repo_summary(
        &context.environment_id,
        repo_root,
        branch,
        base_branch.clone(),
        upstream_branch,
    )?;

    let sections = match scope {
        GitReviewScope::Uncommitted => read_uncommitted_sections(repo_root)?,
        GitReviewScope::Branch => read_branch_sections(repo_root, base_branch.as_deref())?,
    };

    Ok(GitReviewSnapshot {
        environment_id: context.environment_id.clone(),
        scope,
        summary,
        sections,
    })
}

fn build_repo_summary(
    environment_id: &str,
    repo_root: &Path,
    branch: Option<String>,
    base_branch: Option<String>,
    upstream_branch_name: Option<String>,
) -> AppResult<GitRepoSummary> {
    let mut ahead = 0;
    let mut behind = 0;
    if upstream_branch_name.is_some() {
        let counts = super::run_git_for_output(
            repo_root,
            ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        )?;
        let mut parts = counts.split_whitespace();
        behind = parts
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or_default();
        ahead = parts
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or_default();
    }

    let status_output = command_output(
        repo_root,
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    if !status_output.status.success() {
        return Err(AppError::Git(stderr_message(&status_output.stderr)));
    }
    let flags = collect_status_flags(&status_output.stdout)?;

    Ok(GitRepoSummary {
        environment_id: environment_id.to_string(),
        repo_path: repo_root.to_string_lossy().to_string(),
        branch,
        base_branch,
        upstream_branch: upstream_branch_name,
        ahead,
        behind,
        dirty: flags.has_staged_changes
            || flags.has_unstaged_changes
            || flags.has_untracked_changes,
        has_staged_changes: flags.has_staged_changes,
        has_unstaged_changes: flags.has_unstaged_changes,
        has_untracked_changes: flags.has_untracked_changes,
    })
}

fn read_uncommitted_sections(repo_root: &Path) -> AppResult<Vec<GitChangeSectionSnapshot>> {
    let output = command_output(
        repo_root,
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::Git(stderr_message(&output.stderr)));
    }

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    let mut records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(|token| String::from_utf8_lossy(token).to_string());

    while let Some(record) = records.next() {
        if record.starts_with('#') {
            continue;
        }

        if let Some(path) = record.strip_prefix("? ") {
            untracked.push(make_change(
                path.to_string(),
                None,
                GitChangeSection::Untracked,
                GitChangeKind::Added,
            ));
            continue;
        }

        if let Some(entry) = parse_status_record(&record, &mut records)? {
            if let Some(kind) = entry.staged_kind {
                staged.push(make_change(
                    entry.path.clone(),
                    entry.old_path.clone(),
                    GitChangeSection::Staged,
                    kind,
                ));
            }
            if let Some(kind) = entry.unstaged_kind {
                unstaged.push(make_change(
                    entry.path,
                    entry.old_path,
                    GitChangeSection::Unstaged,
                    kind,
                ));
            }
        }
    }

    staged.sort_by(|left, right| left.path.cmp(&right.path));
    unstaged.sort_by(|left, right| left.path.cmp(&right.path));
    untracked.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(compact_sections(vec![
        GitChangeSectionSnapshot {
            id: GitChangeSection::Staged,
            label: "Staged".to_string(),
            files: staged,
        },
        GitChangeSectionSnapshot {
            id: GitChangeSection::Unstaged,
            label: "Unstaged".to_string(),
            files: unstaged,
        },
        GitChangeSectionSnapshot {
            id: GitChangeSection::Untracked,
            label: "Untracked".to_string(),
            files: untracked,
        },
    ]))
}

fn read_branch_sections(
    repo_root: &Path,
    base_branch: Option<&str>,
) -> AppResult<Vec<GitChangeSectionSnapshot>> {
    let Some(base_branch) = base_branch else {
        return Ok(Vec::new());
    };

    let output = command_output(
        repo_root,
        [
            "diff",
            "--name-status",
            "--find-renames=50%",
            &format!("{base_branch}...HEAD"),
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::Git(stderr_message(&output.stderr)));
    }

    let mut files = stdout_message(&output.stdout)
        .lines()
        .filter_map(parse_branch_name_status_line)
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(compact_sections(vec![GitChangeSectionSnapshot {
        id: GitChangeSection::Branch,
        label: "Branch changes".to_string(),
        files,
    }]))
}

fn compact_sections(sections: Vec<GitChangeSectionSnapshot>) -> Vec<GitChangeSectionSnapshot> {
    sections
        .into_iter()
        .filter(|section| !section.files.is_empty())
        .collect()
}

fn parse_branch_name_status_line(line: &str) -> Option<GitFileChange> {
    let mut parts = line.split('\t');
    let status = parts.next()?;
    let first_path = parts.next()?.to_string();
    let second_path = parts.next().map(ToString::to_string);
    let kind = parse_diff_status(status);
    let (path, old_path) = if matches!(kind, GitChangeKind::Renamed | GitChangeKind::Copied) {
        (second_path.unwrap_or(first_path.clone()), Some(first_path))
    } else {
        (first_path, second_path)
    };

    Some(make_change(path, old_path, GitChangeSection::Branch, kind))
}

fn make_change(
    path: String,
    old_path: Option<String>,
    section: GitChangeSection,
    kind: GitChangeKind,
) -> GitFileChange {
    let (can_stage, can_unstage, can_revert) = match section {
        GitChangeSection::Staged => (false, true, true),
        GitChangeSection::Unstaged => (true, false, true),
        GitChangeSection::Untracked => (true, false, false),
        GitChangeSection::Branch => (false, false, false),
    };

    GitFileChange {
        path,
        old_path,
        section,
        kind,
        additions: None,
        deletions: None,
        can_stage,
        can_unstage,
        can_revert,
    }
}

fn collect_status_flags(buffer: &[u8]) -> AppResult<StatusFlags> {
    let mut flags = StatusFlags::default();
    let mut records = buffer
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(|token| String::from_utf8_lossy(token).to_string());

    while let Some(record) = records.next() {
        if record.starts_with('#') {
            continue;
        }
        if record.starts_with("? ") {
            flags.has_untracked_changes = true;
            continue;
        }
        if let Some(entry) = parse_status_record(&record, &mut records)? {
            flags.has_staged_changes |= entry.staged_kind.is_some();
            flags.has_unstaged_changes |= entry.unstaged_kind.is_some();
        }
    }

    Ok(flags)
}

fn parse_status_record<I>(record: &str, records: &mut I) -> AppResult<Option<ParsedStatusEntry>>
where
    I: Iterator<Item = String>,
{
    if let Some(rest) = record.strip_prefix("1 ") {
        let mut parts = rest.splitn(8, ' ');
        let xy = parts
            .next()
            .ok_or_else(|| AppError::Git("Invalid Git status entry.".to_string()))?;
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let path = parts
            .next()
            .ok_or_else(|| AppError::Git("Missing path in Git status entry.".to_string()))?;
        let (staged_kind, unstaged_kind) = parse_xy(xy);
        return Ok(Some(ParsedStatusEntry {
            path: path.to_string(),
            old_path: None,
            staged_kind,
            unstaged_kind,
        }));
    }

    if let Some(rest) = record.strip_prefix("2 ") {
        let mut parts = rest.splitn(9, ' ');
        let xy = parts
            .next()
            .ok_or_else(|| AppError::Git("Invalid rename status entry.".to_string()))?;
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let path = parts
            .next()
            .ok_or_else(|| AppError::Git("Missing renamed path.".to_string()))?;
        let old_path = records
            .next()
            .ok_or_else(|| AppError::Git("Missing original renamed path.".to_string()))?;
        let (staged_kind, unstaged_kind) = parse_xy(xy);
        return Ok(Some(ParsedStatusEntry {
            path: path.to_string(),
            old_path: Some(old_path),
            staged_kind,
            unstaged_kind,
        }));
    }

    if let Some(rest) = record.strip_prefix("u ") {
        let mut parts = rest.splitn(10, ' ');
        let xy = parts
            .next()
            .ok_or_else(|| AppError::Git("Invalid unmerged status entry.".to_string()))?;
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let _ = parts.next();
        let path = parts
            .next()
            .ok_or_else(|| AppError::Git("Missing unmerged path.".to_string()))?;
        let (staged_kind, unstaged_kind) = parse_xy(xy);
        return Ok(Some(ParsedStatusEntry {
            path: path.to_string(),
            old_path: None,
            staged_kind,
            unstaged_kind,
        }));
    }

    Ok(None)
}

fn parse_xy(xy: &str) -> (Option<GitChangeKind>, Option<GitChangeKind>) {
    let mut chars = xy.chars();
    (
        parse_status_char(chars.next()),
        parse_status_char(chars.next()),
    )
}

fn parse_status_char(value: Option<char>) -> Option<GitChangeKind> {
    match value {
        Some('A') => Some(GitChangeKind::Added),
        Some('M') => Some(GitChangeKind::Modified),
        Some('D') => Some(GitChangeKind::Deleted),
        Some('R') => Some(GitChangeKind::Renamed),
        Some('C') => Some(GitChangeKind::Copied),
        Some('T') => Some(GitChangeKind::TypeChanged),
        Some('U') => Some(GitChangeKind::Unmerged),
        Some('.') | Some(' ') | None => None,
        _ => Some(GitChangeKind::Unknown),
    }
}

fn parse_diff_status(status: &str) -> GitChangeKind {
    match status.chars().next() {
        Some('A') => GitChangeKind::Added,
        Some('M') => GitChangeKind::Modified,
        Some('D') => GitChangeKind::Deleted,
        Some('R') => GitChangeKind::Renamed,
        Some('C') => GitChangeKind::Copied,
        Some('T') => GitChangeKind::TypeChanged,
        Some('U') => GitChangeKind::Unmerged,
        _ => GitChangeKind::Unknown,
    }
}

#[derive(Debug, Default)]
struct StatusFlags {
    has_staged_changes: bool,
    has_unstaged_changes: bool,
    has_untracked_changes: bool,
}

#[derive(Debug)]
struct ParsedStatusEntry {
    path: String,
    old_path: Option<String>,
    staged_kind: Option<GitChangeKind>,
    unstaged_kind: Option<GitChangeKind>,
}

#[cfg(test)]
mod tests {
    use super::{parse_branch_name_status_line, parse_xy};
    use crate::domain::git_review::GitChangeKind;

    #[test]
    fn parses_porcelain_xy_flags_into_change_kinds() {
        assert_eq!(parse_xy("M."), (Some(GitChangeKind::Modified), None));
        assert_eq!(parse_xy(".A"), (None, Some(GitChangeKind::Added)));
    }

    #[test]
    fn parses_branch_name_status_rename_lines() {
        let change = parse_branch_name_status_line("R100\tsrc/old.ts\tsrc/new.ts").expect("change");
        assert_eq!(change.path, "src/new.ts");
        assert_eq!(change.old_path.as_deref(), Some("src/old.ts"));
        assert_eq!(change.kind, GitChangeKind::Renamed);
    }
}
