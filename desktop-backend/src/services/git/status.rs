use std::collections::HashMap;
use std::path::Path;

use crate::domain::git_review::{
    GitChangeKind, GitChangeSection, GitChangeSectionSnapshot, GitFileChange, GitRepoSummary,
    GitReviewScope, GitReviewSnapshot,
};
use crate::error::{AppError, AppResult};

use super::{
    command_output, current_branch, resolve_base_reference, stderr_message, upstream_branch,
    GitEnvironmentContext,
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
    let staged_stats = read_numstat(
        repo_root,
        ["diff", "--cached", "--numstat", "--find-renames=50%"],
    )?;
    let unstaged_stats = read_numstat(repo_root, ["diff", "--numstat", "--find-renames=50%"])?;
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
                None,
            ));
            continue;
        }

        if let Some(entry) = parse_status_record(&record, &mut records)? {
            if let Some(kind) = entry.staged_kind {
                let stats = staged_stats.get(&entry.path).copied();
                staged.push(make_change(
                    entry.path.clone(),
                    entry.old_path.clone(),
                    GitChangeSection::Staged,
                    kind,
                    stats,
                ));
            }
            if let Some(kind) = entry.unstaged_kind {
                let stats = unstaged_stats.get(&entry.path).copied();
                unstaged.push(make_change(
                    entry.path,
                    entry.old_path,
                    GitChangeSection::Unstaged,
                    kind,
                    stats,
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
            "-z",
            &format!("{base_branch}...HEAD"),
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::Git(stderr_message(&output.stderr)));
    }

    let stats_by_path = read_numstat(
        repo_root,
        [
            "diff".to_string(),
            "--numstat".to_string(),
            "--find-renames=50%".to_string(),
            format!("{base_branch}...HEAD"),
        ],
    )?;
    let mut files = parse_branch_name_status_output(&output.stdout)
        .into_iter()
        .map(|mut file| {
            let stats = stats_by_path.get(&file.path).copied();
            apply_stats(&mut file, stats);
            file
        })
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

fn parse_branch_name_status_output(output: &[u8]) -> Vec<GitFileChange> {
    let mut files = Vec::new();
    let mut records = output.split(|byte| *byte == 0);

    while let Some(status_record) = records.next() {
        if status_record.is_empty() {
            continue;
        }
        let status = String::from_utf8_lossy(status_record);
        let Some(first_path) = records
            .next()
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).to_string())
        else {
            continue;
        };
        let kind = parse_diff_status(&status);
        let second_path = if matches!(kind, GitChangeKind::Renamed | GitChangeKind::Copied) {
            records
                .next()
                .filter(|path| !path.is_empty())
                .map(|path| String::from_utf8_lossy(path).to_string())
        } else {
            None
        };

        files.push(make_branch_change(&status, first_path, second_path));
    }

    files
}

#[cfg(test)]
fn parse_branch_name_status_line(line: &str) -> Option<GitFileChange> {
    let mut parts = line.split('\t');
    let status = parts.next()?;
    let first_path = parts.next()?.to_string();
    let second_path = parts.next().map(ToString::to_string);
    Some(make_branch_change(status, first_path, second_path))
}

fn make_branch_change(
    status: &str,
    first_path: String,
    second_path: Option<String>,
) -> GitFileChange {
    let kind = parse_diff_status(status);
    let (path, old_path) = if matches!(kind, GitChangeKind::Renamed | GitChangeKind::Copied) {
        (second_path.unwrap_or(first_path.clone()), Some(first_path))
    } else {
        (first_path, second_path)
    };

    make_change(path, old_path, GitChangeSection::Branch, kind, None)
}

fn make_change(
    path: String,
    old_path: Option<String>,
    section: GitChangeSection,
    kind: GitChangeKind,
    stats: Option<ChangeStats>,
) -> GitFileChange {
    let (can_stage, can_unstage, can_revert) = match section {
        GitChangeSection::Staged => (false, true, true),
        GitChangeSection::Unstaged => (true, false, true),
        GitChangeSection::Untracked => (true, false, false),
        GitChangeSection::Branch => (false, false, false),
    };

    let mut change = GitFileChange {
        path,
        old_path,
        section,
        kind,
        additions: None,
        deletions: None,
        can_stage,
        can_unstage,
        can_revert,
    };
    apply_stats(&mut change, stats);
    change
}

fn apply_stats(change: &mut GitFileChange, stats: Option<ChangeStats>) {
    if let Some(stats) = stats {
        change.additions = Some(stats.additions);
        change.deletions = Some(stats.deletions);
    }
}

fn read_numstat<I, A>(repo_root: &Path, args: I) -> AppResult<HashMap<String, ChangeStats>>
where
    I: IntoIterator<Item = A>,
    A: AsRef<str>,
{
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .collect::<Vec<_>>();
    args.push("-z".to_string());

    let output = command_output(repo_root, args)?;
    if !output.status.success() {
        return Err(AppError::Git(stderr_message(&output.stderr)));
    }

    Ok(parse_numstat_output(&output.stdout))
}

fn parse_numstat_output(output: &[u8]) -> HashMap<String, ChangeStats> {
    let mut stats = HashMap::new();
    let mut records = output.split(|byte| *byte == 0);

    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }

        let line = String::from_utf8_lossy(record);
        let Some((stats_value, path)) = parse_numstat_record_prefix(&line) else {
            continue;
        };
        if path.is_empty() {
            let _old_path = records.next();
            if let Some(new_path) = records.next().filter(|path| !path.is_empty()) {
                stats.insert(String::from_utf8_lossy(new_path).to_string(), stats_value);
            }
            continue;
        }
        stats.insert(normalize_numstat_path(path), stats_value);
    }

    stats
}

#[cfg(test)]
fn parse_numstat_line(line: &str) -> Option<(String, ChangeStats)> {
    let (stats, path) = parse_numstat_record_prefix(line)?;
    Some((normalize_numstat_path(path), stats))
}

fn parse_numstat_record_prefix(line: &str) -> Option<(ChangeStats, &str)> {
    let mut parts = line.splitn(3, '\t');
    let additions = parse_numstat_count(parts.next()?)?;
    let deletions = parse_numstat_count(parts.next()?)?;
    Some((
        ChangeStats {
            additions,
            deletions,
        },
        parts.next()?,
    ))
}

fn parse_numstat_count(value: &str) -> Option<u32> {
    value.parse::<u32>().ok()
}

fn normalize_numstat_path(path: &str) -> String {
    if let Some((prefix, rename)) = path.split_once('{') {
        if let Some((rename_body, suffix)) = rename.split_once('}') {
            if let Some((_, new_name)) = rename_body.split_once(" => ") {
                return format!("{prefix}{new_name}{suffix}");
            }
        }
    }

    if let Some((_, new_path)) = path.split_once(" => ") {
        return new_path.to_string();
    }

    path.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChangeStats {
    additions: u32,
    deletions: u32,
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
    use super::{
        normalize_numstat_path, parse_branch_name_status_line, parse_branch_name_status_output,
        parse_numstat_line, parse_numstat_output, parse_xy,
    };
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

    #[test]
    fn parses_nul_delimited_branch_name_status_records() {
        let changes = parse_branch_name_status_output(b"A\0src/file \"quoted\".ts\0");

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "src/file \"quoted\".ts");
        assert_eq!(changes[0].kind, GitChangeKind::Added);
    }

    #[test]
    fn parses_nul_delimited_branch_renames_to_the_new_path() {
        let changes = parse_branch_name_status_output(b"R100\0src/old name.ts\0src/new name.ts\0");

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "src/new name.ts");
        assert_eq!(changes[0].old_path.as_deref(), Some("src/old name.ts"));
        assert_eq!(changes[0].kind, GitChangeKind::Renamed);
    }

    #[test]
    fn parses_text_numstat_lines() {
        let (path, stats) = parse_numstat_line("12\t4\tsrc/app.ts").expect("numstat");
        assert_eq!(path, "src/app.ts");
        assert_eq!(stats.additions, 12);
        assert_eq!(stats.deletions, 4);
    }

    #[test]
    fn skips_binary_numstat_lines() {
        assert!(parse_numstat_line("-\t-\tassets/icon.png").is_none());
    }

    #[test]
    fn normalizes_numstat_rename_paths_to_the_new_path() {
        assert_eq!(
            normalize_numstat_path("src/{old.ts => new.ts}"),
            "src/new.ts"
        );
        assert_eq!(
            normalize_numstat_path("src/old.ts => src/new.ts"),
            "src/new.ts"
        );
    }

    #[test]
    fn parses_nul_delimited_numstat_records() {
        let stats = parse_numstat_output(b"12\t4\tsrc/app.ts\0");

        assert_eq!(stats["src/app.ts"].additions, 12);
        assert_eq!(stats["src/app.ts"].deletions, 4);
    }

    #[test]
    fn parses_nul_delimited_rename_numstat_records_to_the_new_path() {
        let stats = parse_numstat_output(b"5\t2\t\0src/old name.ts\0src/new name.ts\0");

        assert_eq!(stats["src/new name.ts"].additions, 5);
        assert_eq!(stats["src/new name.ts"].deletions, 2);
        assert!(!stats.contains_key("src/old name.ts"));
    }

    #[test]
    fn parses_nul_delimited_numstat_paths_ending_with_tab() {
        let stats = parse_numstat_output(b"1\t2\tsrc/name\t\0");

        assert_eq!(stats["src/name\t"].additions, 1);
        assert_eq!(stats["src/name\t"].deletions, 2);
    }
}
