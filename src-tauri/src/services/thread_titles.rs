const AUTO_THREAD_TITLE_PREFIX: &str = "Thread ";
const MAX_THREAD_TITLE_CHARS: usize = 42;

pub fn is_auto_generated_thread_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed
        .strip_prefix(AUTO_THREAD_TITLE_PREFIX)
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|char| char.is_ascii_digit())
        })
}

pub fn derive_thread_title_from_message(message: &str) -> Option<String> {
    let normalized = first_meaningful_line(message)?;
    let cleaned = strip_markdown_prefixes(&normalized);
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim_matches([' ', '.', ',', ':', ';', '!', '?', '-', '#', '*', '>']);
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.chars().count() <= MAX_THREAD_TITLE_CHARS {
        return Some(trimmed.to_string());
    }

    let mut boundary = 0usize;
    for (index, char) in trimmed.char_indices() {
        if index > MAX_THREAD_TITLE_CHARS.saturating_sub(3) {
            break;
        }
        if char.is_whitespace() {
            boundary = index;
        }
    }

    let cutoff = if boundary >= 12 {
        boundary
    } else {
        trimmed
            .char_indices()
            .take_while(|(index, _)| *index <= MAX_THREAD_TITLE_CHARS.saturating_sub(3))
            .map(|(index, char)| index + char.len_utf8())
            .last()
            .unwrap_or(trimmed.len())
    };

    let shortened = trimmed[..cutoff].trim_end_matches([' ', '.', ',', ':', ';', '!', '?']);
    if shortened.is_empty() {
        None
    } else {
        Some(format!("{shortened}..."))
    }
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
        .take_while(|char| char.is_ascii_digit())
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

#[cfg(test)]
mod tests {
    use super::{derive_thread_title_from_message, is_auto_generated_thread_title};

    #[test]
    fn detects_placeholder_thread_titles() {
        assert!(is_auto_generated_thread_title("Thread 1"));
        assert!(is_auto_generated_thread_title("Thread 42"));
        assert!(!is_auto_generated_thread_title("Investigate auth flow"));
        assert!(!is_auto_generated_thread_title("Thread alpha"));
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
    fn strips_markdown_list_prefixes_and_clamps_long_titles() {
        let title = derive_thread_title_from_message(
            "1. Investigate why the environment status badge does not reflect waiting for approvals and user input in the sidebar",
        )
        .expect("title should exist");

        assert_eq!(title, "Investigate why the environment status...");
    }

    #[test]
    fn skips_fenced_code_markers_when_deriving_titles() {
        let title =
            derive_thread_title_from_message("```ts\nconst status = compute(env);\n```")
                .expect("title should exist");

        assert_eq!(title, "const status = compute(env)");
    }

    #[test]
    fn ignores_messages_that_only_contain_code_fences() {
        assert_eq!(derive_thread_title_from_message("```bash\n```"), None);
        assert_eq!(derive_thread_title_from_message("~~~python\n~~~"), None);
    }
}
