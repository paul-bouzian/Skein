use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::runtime::codex_paths::{build_codex_process_path, resolve_codex_binary_path};

const AUTO_THREAD_TITLE_PREFIX: &str = "Thread ";
const FIRST_PROMPT_NAMING_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_THREAD_TITLE_CHARS: usize = 42;
const MAX_WORKTREE_LABEL_CHARS: usize = 48;
const MAX_BRANCH_SLUG_CHARS: usize = 48;
const MAX_NAMING_MESSAGE_LINES: usize = 4;
const MAX_NAMING_MESSAGE_CHARS: usize = 360;
// Keep naming on a dedicated lightweight model so thread model settings remain untouched.
pub(crate) const FIRST_PROMPT_NAMING_MODEL: &str = "gpt-5.4-mini";
const NAMING_REASONING_EFFORT: &str = "low";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstPromptNamingSuggestion {
    pub thread_title: String,
    pub worktree_label: String,
    pub branch_slug: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirstPromptNamingSuggestionWire {
    thread_title: String,
    worktree_label: String,
    branch_slug: String,
}

pub struct GenerateFirstPromptNamingInput<'a> {
    pub binary_path: Option<&'a str>,
    pub cwd: &'a Path,
    pub message: &'a str,
}

pub fn is_auto_generated_thread_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed
        .strip_prefix(AUTO_THREAD_TITLE_PREFIX)
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
        })
}

pub fn is_auto_generated_worktree_name(name: &str) -> bool {
    let mut parts = name.trim().split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    let Some(second) = parts.next() else {
        return false;
    };
    let third = parts.next();

    if parts.next().is_some() {
        return false;
    }

    is_ascii_lower_token(first)
        && is_ascii_lower_token(second)
        && third.is_none_or(|value| value.chars().all(|character| character.is_ascii_digit()))
}

pub fn derive_thread_title_from_message(message: &str) -> Option<String> {
    let normalized = first_meaningful_line(message)?;
    let cleaned = strip_markdown_prefixes(&normalized);
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim_matches([' ', '.', ',', ':', ';', '!', '?', '-', '#', '*', '>']);
    clamp_text(trimmed, MAX_THREAD_TITLE_CHARS)
}

pub fn generate_first_prompt_naming(
    input: GenerateFirstPromptNamingInput<'_>,
) -> AppResult<FirstPromptNamingSuggestion> {
    let prompt = build_first_prompt_naming_prompt(input.message);
    let binary = resolve_codex_binary_path(input.binary_path)?;
    let reasoning_config = format!("model_reasoning_effort=\"{NAMING_REASONING_EFFORT}\"");
    let output_path = std::env::temp_dir().join(format!(
        "loom-first-prompt-naming-{}.json",
        uuid::Uuid::now_v7()
    ));
    let output_guard = TempFileGuard::new(output_path.clone());

    let mut command = Command::new(&binary);
    command
        .current_dir(input.cwd)
        .env("PATH", build_codex_process_path(&binary))
        .args([
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--model",
            FIRST_PROMPT_NAMING_MODEL,
            "-c",
            &reasoning_config,
            "--output-last-message",
            output_guard
                .path()
                .to_str()
                .ok_or_else(|| AppError::Runtime("Invalid naming output path.".to_string()))?,
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(AppError::from)?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(prompt.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::from(error));
        }
    }

    let deadline = Instant::now() + FIRST_PROMPT_NAMING_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(AppError::from)? {
            if !status.success() {
                let stderr = read_stderr(&mut child);
                let message = if stderr.is_empty() {
                    format!("Codex exited with {status} while generating a first prompt name.")
                } else {
                    stderr
                };
                return Err(AppError::Runtime(message));
            }
            break;
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Runtime(format!(
                "Codex timed out after {}s while generating a first prompt name.",
                FIRST_PROMPT_NAMING_TIMEOUT.as_secs()
            )));
        }

        thread::sleep(Duration::from_millis(50));
    }

    let raw = fs::read_to_string(output_guard.path()).map_err(AppError::from)?;
    parse_first_prompt_naming(&raw)
}

pub fn clamp_worktree_label(value: &str) -> Option<String> {
    clamp_text(value, MAX_WORKTREE_LABEL_CHARS)
}

pub fn sanitize_branch_slug(value: &str) -> Option<String> {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_was_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            previous_was_dash = false;
            continue;
        }

        if !previous_was_dash {
            normalized.push('-');
            previous_was_dash = true;
        }
    }

    let trimmed = normalized.trim_matches('-');
    if trimmed.is_empty() {
        return None;
    }

    let clamped = clamp_slug(trimmed, MAX_BRANCH_SLUG_CHARS);
    (!clamped.is_empty()).then_some(clamped)
}

pub fn ensure_unique_branch_slug<F>(base_slug: &str, exists: F) -> String
where
    F: Fn(&str) -> bool,
{
    if !exists(base_slug) {
        return base_slug.to_string();
    }

    for suffix in 2..10_000 {
        let suffix_text = format!("-{suffix}");
        let max_base_len = MAX_BRANCH_SLUG_CHARS.saturating_sub(suffix_text.len());
        let trimmed_base = clamp_slug(base_slug, max_base_len);
        let candidate = if trimmed_base.is_empty() {
            format!("task{suffix_text}")
        } else {
            format!("{trimmed_base}{suffix_text}")
        };
        if !exists(&candidate) {
            return candidate;
        }
    }

    format!("task-{}", uuid::Uuid::now_v7().simple())
}

fn build_first_prompt_naming_prompt(message: &str) -> String {
    let message_excerpt = compact_message_for_naming(message);
    format!(
        "You generate names for a new Git worktree from the user's first task request.\n\
         Return valid JSON only with this exact schema:\n\
         {{\"threadTitle\":\"...\",\"worktreeLabel\":\"...\",\"branchSlug\":\"...\"}}\n\n\
         Requirements:\n\
         - Translate the task intent to English before naming anything.\n\
         - threadTitle: concise, readable English title, no trailing punctuation.\n\
         - worktreeLabel: short English sidebar label, no generic filler.\n\
         - branchSlug: lowercase ASCII kebab-case English slug, short, descriptive, no quotes.\n\
         - Keep all values specific to the requested task.\n\
         - This is a fast naming task. Use minimal reasoning and answer immediately.\n\
         - Do not mention the repository or project name unless the user explicitly asked for it.\n\
         - Output JSON only.\n\n\
         Model reasoning effort for this task: {}.\n\n\
         User request excerpt:\n{}\n",
        NAMING_REASONING_EFFORT, message_excerpt
    )
}

fn compact_message_for_naming(message: &str) -> String {
    let mut excerpt_parts = Vec::new();
    let mut total_chars = 0usize;

    for line in message.lines().map(str::trim) {
        if line.is_empty() || is_fenced_code_marker(line) {
            continue;
        }

        let cleaned = strip_markdown_prefixes(line);
        let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
        let trimmed = compact.trim();
        if trimmed.is_empty() {
            continue;
        }

        let next_length = if excerpt_parts.is_empty() {
            trimmed.chars().count()
        } else {
            total_chars + 3 + trimmed.chars().count()
        };
        if next_length > MAX_NAMING_MESSAGE_CHARS {
            break;
        }

        excerpt_parts.push(trimmed.to_string());
        total_chars = next_length;
        if excerpt_parts.len() >= MAX_NAMING_MESSAGE_LINES {
            break;
        }
    }

    let excerpt = if excerpt_parts.is_empty() {
        clamp_text(message, MAX_NAMING_MESSAGE_CHARS).unwrap_or_else(|| {
            message
                .trim()
                .chars()
                .take(MAX_NAMING_MESSAGE_CHARS)
                .collect()
        })
    } else {
        excerpt_parts.join(" | ")
    };

    clamp_text(&excerpt, MAX_NAMING_MESSAGE_CHARS).unwrap_or(excerpt)
}

fn parse_first_prompt_naming(raw: &str) -> AppResult<FirstPromptNamingSuggestion> {
    let parsed = parse_first_prompt_naming_wire(raw)?;
    let thread_title =
        clamp_text(&parsed.thread_title, MAX_THREAD_TITLE_CHARS).ok_or_else(|| {
            AppError::Runtime(
                "Codex returned an empty thread title for first prompt naming.".to_string(),
            )
        })?;
    let worktree_label =
        clamp_text(&parsed.worktree_label, MAX_WORKTREE_LABEL_CHARS).ok_or_else(|| {
            AppError::Runtime(
                "Codex returned an empty worktree label for first prompt naming.".to_string(),
            )
        })?;
    let branch_slug = sanitize_branch_slug(&parsed.branch_slug).ok_or_else(|| {
        AppError::Runtime(
            "Codex returned an invalid branch slug for first prompt naming.".to_string(),
        )
    })?;

    Ok(FirstPromptNamingSuggestion {
        thread_title,
        worktree_label,
        branch_slug,
    })
}

fn parse_first_prompt_naming_wire(raw: &str) -> AppResult<FirstPromptNamingSuggestionWire> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Runtime(
            "Codex returned an empty first prompt naming response.".to_string(),
        ));
    }

    let candidates = [
        trimmed.to_string(),
        strip_code_fence(trimmed).unwrap_or_default(),
        extract_json_object(trimmed).unwrap_or_default(),
    ];

    for candidate in candidates {
        if candidate.is_empty() {
            continue;
        }

        if let Ok(parsed) = serde_json::from_str::<FirstPromptNamingSuggestionWire>(&candidate) {
            return Ok(parsed);
        }
    }

    Err(AppError::Runtime(
        "Codex returned invalid JSON for first prompt naming.".to_string(),
    ))
}

fn strip_code_fence(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if !trimmed.starts_with("```") {
        return None;
    }

    let without_prefix = trimmed
        .trim_start_matches('`')
        .trim_start_matches(|character: char| character.is_ascii_alphabetic())
        .trim();
    let without_suffix = without_prefix.strip_suffix("```")?.trim();
    Some(without_suffix.to_string())
}

fn extract_json_object(value: &str) -> Option<String> {
    let start = value.find('{')?;
    let end = value.rfind('}')?;
    (start < end).then(|| value[start..=end].to_string())
}

fn clamp_text(value: &str, max_chars: usize) -> Option<String> {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim_matches([
        ' ', '"', '\'', '.', ',', ':', ';', '!', '?', '-', '#', '*', '>',
    ]);
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.chars().count() <= max_chars {
        return Some(trimmed.to_string());
    }

    let ellipsis = "...";
    let available_chars = max_chars.saturating_sub(ellipsis.chars().count());
    if available_chars == 0 {
        return Some(ellipsis.chars().take(max_chars).collect());
    }

    let mut cutoff = 0usize;
    let mut boundary = None;
    let mut character_count = 0usize;
    for (index, character) in trimmed.char_indices() {
        if character_count >= available_chars {
            break;
        }
        character_count += 1;
        cutoff = index + character.len_utf8();
        if character.is_whitespace() {
            boundary = Some((index, character_count.saturating_sub(1)));
        }
    }

    let cutoff = match boundary {
        Some((index, boundary_chars)) if boundary_chars >= 12 => index,
        _ => cutoff,
    };

    let shortened = trimmed[..cutoff].trim_end_matches([' ', '.', ',', ':', ';', '!', '?']);
    if shortened.is_empty() {
        None
    } else {
        Some(format!("{shortened}{ellipsis}"))
    }
}

fn clamp_slug(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim_matches('-');
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut cutoff = 0usize;
    let mut boundary = 0usize;
    for (character_count, (index, character)) in trimmed.char_indices().enumerate() {
        if character_count >= max_chars {
            break;
        }
        cutoff = index + character.len_utf8();
        if character == '-' {
            boundary = index;
        }
    }

    let shortened = if boundary >= 8 {
        &trimmed[..boundary]
    } else {
        &trimmed[..cutoff]
    };

    shortened.trim_matches('-').to_string()
}

fn first_meaningful_line(message: &str) -> Option<String> {
    message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !is_fenced_code_marker(line))
        .map(ToOwned::to_owned)
}

fn is_fenced_code_marker(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn strip_markdown_prefixes(line: &str) -> String {
    let trimmed = line.trim_start();
    let without_heading = trimmed.trim_start_matches('#').trim_start();
    let without_quote = without_heading.trim_start_matches('>').trim_start();
    let without_bullet = without_quote
        .strip_prefix("- ")
        .or_else(|| without_quote.strip_prefix("* "))
        .or_else(|| without_quote.strip_prefix("+ "))
        .unwrap_or(without_quote);

    let ordered_list_trimmed = without_bullet.trim_start();
    let digit_count = ordered_list_trimmed
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digit_count > 0 {
        let remainder = &ordered_list_trimmed[digit_count..];
        if let Some(stripped) = remainder
            .strip_prefix(". ")
            .or_else(|| remainder.strip_prefix(") "))
        {
            return stripped.trim().to_string();
        }
    }

    without_bullet.trim().to_string()
}

fn read_stderr(child: &mut std::process::Child) -> String {
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
    }
    stderr.trim().to_string()
}

fn is_ascii_lower_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_lowercase())
}

struct TempFileGuard {
    path: std::path::PathBuf,
}

impl TempFileGuard {
    fn new(path: std::path::PathBuf) -> Self {
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
    use super::{
        clamp_slug, clamp_text, compact_message_for_naming, derive_thread_title_from_message,
        ensure_unique_branch_slug, is_auto_generated_thread_title, is_auto_generated_worktree_name,
        parse_first_prompt_naming, sanitize_branch_slug,
    };

    #[test]
    fn detects_placeholder_thread_titles() {
        assert!(is_auto_generated_thread_title("Thread 1"));
        assert!(is_auto_generated_thread_title("Thread 42"));
        assert!(!is_auto_generated_thread_title("Investigate auth flow"));
    }

    #[test]
    fn detects_auto_generated_worktree_names() {
        assert!(is_auto_generated_worktree_name("hazy-linnet"));
        assert!(is_auto_generated_worktree_name("hazy-linnet-2048"));
        assert!(!is_auto_generated_worktree_name("Add themes"));
        assert!(!is_auto_generated_worktree_name("feature/add-themes"));
    }

    #[test]
    fn derives_a_title_from_the_first_meaningful_line() {
        let title = derive_thread_title_from_message(
            "\n\n# Fix the worktree sidebar layout\n\nAnd then review the runtime state",
        )
        .expect("title should exist");

        assert_eq!(title, "Fix the worktree sidebar layout");
    }

    #[test]
    fn sanitizes_branch_slugs() {
        assert_eq!(
            sanitize_branch_slug(" Add Themes / UI "),
            Some("add-themes-ui".to_string())
        );
        assert_eq!(sanitize_branch_slug("***"), None);
    }

    #[test]
    fn parses_json_wrapped_in_code_fences() {
        let suggestion = parse_first_prompt_naming(
            "```json\n{\"threadTitle\":\"Add themes\",\"worktreeLabel\":\"Add themes\",\"branchSlug\":\"add-themes\"}\n```",
        )
        .expect("suggestion should parse");

        assert_eq!(suggestion.thread_title, "Add themes");
        assert_eq!(suggestion.worktree_label, "Add themes");
        assert_eq!(suggestion.branch_slug, "add-themes");
    }

    #[test]
    fn ensures_unique_branch_slugs_with_suffixes() {
        let candidate = ensure_unique_branch_slug("add-themes", |value| {
            matches!(value, "add-themes" | "add-themes-2")
        });

        assert_eq!(candidate, "add-themes-3");
    }

    #[test]
    fn clamps_long_labels() {
        let value = clamp_text(
            "Investigate why the environment status badge does not reflect waiting for approvals and user input in the sidebar",
            42,
        )
        .expect("label should clamp");

        assert_eq!(value, "Investigate why the environment status...");
    }

    #[test]
    fn clamps_unicode_labels_by_character_count() {
        let value = clamp_text("éééééééééééé", 10).expect("label should clamp");

        assert_eq!(value, "ééééééé...");
    }

    #[test]
    fn clamps_branch_slugs_without_off_by_one_overflow() {
        assert_eq!(clamp_slug("abcdefg", 5), "abcde");
    }

    #[test]
    fn compacts_large_messages_for_naming() {
        let excerpt = compact_message_for_naming(
            "\n# Add a full theming system\n\n- Support light and dark themes\n- Add user theme persistence\n- Update the settings panel\n- Include migration notes\n- Include rollout steps\n",
        );

        assert_eq!(
            excerpt,
            "Add a full theming system | Support light and dark themes | Add user theme persistence | Update the settings panel"
        );
    }

    #[test]
    fn first_prompt_naming_prompt_requires_english_output() {
        let prompt = super::build_first_prompt_naming_prompt(
            "Ajouter un systeme de themes pour les modes clair et sombre",
        );

        assert!(prompt.contains("Translate the task intent to English before naming anything."));
        assert!(prompt.contains("threadTitle: concise, readable English title"));
        assert!(prompt.contains("worktreeLabel: short English sidebar label"));
        assert!(prompt.contains("branchSlug: lowercase ASCII kebab-case English slug"));
        assert!(prompt.contains("Model reasoning effort for this task: low."));
        assert!(!prompt.contains("same language as the user"));
    }

    #[test]
    fn first_prompt_naming_timeout_stays_short_for_best_effort_send_path() {
        assert!(super::FIRST_PROMPT_NAMING_TIMEOUT <= std::time::Duration::from_secs(30));
    }
}
