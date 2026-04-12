pub fn is_auto_generated_thread_title(title: &str) -> bool {
    super::prompt_naming::is_auto_generated_thread_title(title)
}

pub fn derive_thread_title_from_message(message: &str) -> Option<String> {
    super::prompt_naming::derive_thread_title_from_message(message)
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
        let title = derive_thread_title_from_message("```ts\nconst status = compute(env);\n```")
            .expect("title should exist");

        assert_eq!(title, "const status = compute(env)");
    }

    #[test]
    fn ignores_messages_that_only_contain_code_fences() {
        assert_eq!(derive_thread_title_from_message("```bash\n```"), None);
        assert_eq!(derive_thread_title_from_message("~~~python\n~~~"), None);
    }
}
