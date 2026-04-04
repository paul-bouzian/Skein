use std::fs;
use std::path::Path;

use crate::domain::git_review::{
    GitChangeKind, GitChangeSection, GitDiffHunk, GitDiffLine, GitDiffLineKind, GitFileChange,
    GitFileDiff, GitReviewScope,
};
use crate::error::{AppError, AppResult};

use super::{
    command_output, resolve_base_reference, validate_relative_path, GitEnvironmentContext,
};

pub(super) fn read_file_diff(
    context: &GitEnvironmentContext,
    scope: GitReviewScope,
    section: GitChangeSection,
    path: &str,
) -> AppResult<GitFileDiff> {
    validate_relative_path(path)?;

    let snapshot = super::status::read_review_snapshot(context, scope)?;
    let change = snapshot
        .sections
        .into_iter()
        .find(|candidate| candidate.id == section)
        .and_then(|candidate| candidate.files.into_iter().find(|file| file.path == path))
        .ok_or_else(|| AppError::NotFound("Git change not found.".to_string()))?;

    let repo_root = Path::new(&context.environment_path);
    let diff = match section {
        GitChangeSection::Untracked => {
            synthetic_untracked_diff(repo_root, &context.environment_id, scope, change)?
        }
        GitChangeSection::Staged => parse_git_diff_output(
            &context.environment_id,
            scope,
            change,
            command_output(
                repo_root,
                [
                    "diff",
                    "--cached",
                    "--no-ext-diff",
                    "--no-color",
                    "--unified=3",
                    "--",
                    path,
                ],
            )?,
        )?,
        GitChangeSection::Unstaged => parse_git_diff_output(
            &context.environment_id,
            scope,
            change,
            command_output(
                repo_root,
                [
                    "diff",
                    "--no-ext-diff",
                    "--no-color",
                    "--unified=3",
                    "--",
                    path,
                ],
            )?,
        )?,
        GitChangeSection::Branch => {
            let base_reference = resolve_base_reference(repo_root, context.base_branch.as_deref())
                .ok_or_else(|| {
                    AppError::Git("No base branch available for branch diff.".to_string())
                })?;
            parse_git_diff_output(
                &context.environment_id,
                scope,
                change,
                command_output(
                    repo_root,
                    [
                        "diff",
                        "--no-ext-diff",
                        "--no-color",
                        "--unified=3",
                        &format!("{base_reference}...HEAD"),
                        "--",
                        path,
                    ],
                )?,
            )?
        }
    };

    Ok(diff)
}

fn synthetic_untracked_diff(
    repo_root: &Path,
    environment_id: &str,
    scope: GitReviewScope,
    change: GitFileChange,
) -> AppResult<GitFileDiff> {
    let file_path = repo_root.join(&change.path);
    let content = fs::read(&file_path)?;
    if content.contains(&0) {
        return Ok(GitFileDiff {
            environment_id: environment_id.to_string(),
            scope,
            section: GitChangeSection::Untracked,
            path: change.path,
            old_path: change.old_path,
            kind: change.kind,
            is_binary: true,
            hunks: Vec::new(),
            empty_message: Some("Binary untracked file".to_string()),
        });
    }

    let text = String::from_utf8_lossy(&content);
    let lines = text.lines().collect::<Vec<_>>();
    let mut hunk_lines = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        hunk_lines.push(GitDiffLine {
            kind: GitDiffLineKind::Added,
            text: format!("+{line}"),
            old_line_number: None,
            new_line_number: Some(index as u32 + 1),
        });
    }

    if text.ends_with('\n') && lines.is_empty() {
        hunk_lines.push(GitDiffLine {
            kind: GitDiffLineKind::Added,
            text: "+".to_string(),
            old_line_number: None,
            new_line_number: Some(1),
        });
    }

    Ok(GitFileDiff {
        environment_id: environment_id.to_string(),
        scope,
        section: GitChangeSection::Untracked,
        path: change.path,
        old_path: change.old_path,
        kind: change.kind,
        is_binary: false,
        hunks: vec![GitDiffHunk {
            header: format!("@@ -0,0 +1,{} @@", hunk_lines.len()),
            lines: hunk_lines,
        }],
        empty_message: None,
    })
}

fn parse_git_diff_output(
    environment_id: &str,
    scope: GitReviewScope,
    change: GitFileChange,
    output: std::process::Output,
) -> AppResult<GitFileDiff> {
    if !output.status.success() {
        return Err(AppError::Git(super::stderr_message(&output.stderr)));
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if is_binary_diff_output(&text) {
        return Ok(GitFileDiff {
            environment_id: environment_id.to_string(),
            scope,
            section: change.section,
            path: change.path,
            old_path: change.old_path,
            kind: change.kind,
            is_binary: true,
            hunks: Vec::new(),
            empty_message: Some("Binary file diff".to_string()),
        });
    }

    let hunks = parse_unified_diff(&text);
    let empty_message = if hunks.is_empty() {
        Some(match change.kind {
            GitChangeKind::Deleted => "Deleted file".to_string(),
            _ => "No diff content available".to_string(),
        })
    } else {
        None
    };

    Ok(GitFileDiff {
        environment_id: environment_id.to_string(),
        scope,
        section: change.section,
        path: change.path,
        old_path: change.old_path,
        kind: change.kind,
        is_binary: false,
        hunks,
        empty_message,
    })
}

fn is_binary_diff_output(text: &str) -> bool {
    let Some(first_line) = text.lines().next() else {
        return false;
    };

    first_line.starts_with("Binary files ") && first_line.ends_with(" differ")
}

fn parse_unified_diff(diff_text: &str) -> Vec<GitDiffHunk> {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<GitDiffHunk> = None;
    let mut old_line = 0;
    let mut new_line = 0;

    for line in diff_text.lines() {
        if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }
            let (old_start, new_start) = parse_hunk_header(line);
            old_line = old_start;
            new_line = new_start;
            current_hunk = Some(GitDiffHunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
            continue;
        }

        if current_hunk.is_none()
            || line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("similarity index")
            || line.starts_with("rename from ")
            || line.starts_with("rename to ")
        {
            continue;
        }

        let Some(hunk) = current_hunk.as_mut() else {
            continue;
        };

        match line.chars().next() {
            Some('+') => {
                hunk.lines.push(GitDiffLine {
                    kind: GitDiffLineKind::Added,
                    text: line.to_string(),
                    old_line_number: None,
                    new_line_number: Some(new_line),
                });
                new_line += 1;
            }
            Some('-') => {
                hunk.lines.push(GitDiffLine {
                    kind: GitDiffLineKind::Removed,
                    text: line.to_string(),
                    old_line_number: Some(old_line),
                    new_line_number: None,
                });
                old_line += 1;
            }
            Some(' ') => {
                hunk.lines.push(GitDiffLine {
                    kind: GitDiffLineKind::Context,
                    text: line.to_string(),
                    old_line_number: Some(old_line),
                    new_line_number: Some(new_line),
                });
                old_line += 1;
                new_line += 1;
            }
            Some('\\') => {
                hunk.lines.push(GitDiffLine {
                    kind: GitDiffLineKind::Context,
                    text: line.to_string(),
                    old_line_number: None,
                    new_line_number: None,
                });
            }
            _ => {}
        }
    }

    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    hunks
}

fn parse_hunk_header(header: &str) -> (u32, u32) {
    let mut parts = header.split_whitespace();
    let _ = parts.next();
    let old = parts.next().unwrap_or("-0,0");
    let new = parts.next().unwrap_or("+0,0");
    (parse_hunk_position(old), parse_hunk_position(new))
}

fn parse_hunk_position(position: &str) -> u32 {
    position
        .trim_start_matches(['-', '+'])
        .split(',')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{is_binary_diff_output, parse_unified_diff};

    #[test]
    fn parses_added_and_removed_lines_from_unified_diff() {
        let hunks = parse_unified_diff(
            "diff --git a/src/app.ts b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n console.log(a);\n",
        );
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 3);
        assert_eq!(hunks[0].lines[0].old_line_number, Some(1));
        assert_eq!(hunks[0].lines[1].new_line_number, Some(1));
    }

    #[test]
    fn only_marks_true_binary_diff_headers_as_binary() {
        assert!(is_binary_diff_output(
            "Binary files a/test.png and b/test.png differ\n"
        ));
        assert!(!is_binary_diff_output(
            "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n+const msg = \"Binary files differ\";\n",
        ));
    }
}
