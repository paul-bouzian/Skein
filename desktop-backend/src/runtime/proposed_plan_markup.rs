const OPEN_TAG: &str = "<proposed_plan>";
const CLOSE_TAG: &str = "</proposed_plan>";

pub fn strip_proposed_plan_blocks(text: &str) -> String {
    let mut remaining = text;
    let mut visible = String::new();

    loop {
        let Some(open_index) = remaining.find(OPEN_TAG) else {
            visible.push_str(remaining);
            return visible;
        };

        visible.push_str(&remaining[..open_index]);
        let after_open = &remaining[open_index + OPEN_TAG.len()..];
        let Some(close_index) = after_open.find(CLOSE_TAG) else {
            return visible;
        };
        let after_close = &after_open[close_index + CLOSE_TAG.len()..];
        remaining = if visible.ends_with('\n') && after_close.starts_with('\n') {
            &after_close[1..]
        } else {
            after_close
        };
    }
}

pub fn extract_proposed_plan_text(text: &str) -> Option<String> {
    let open_index = text.find(OPEN_TAG)?;
    let after_open = &text[open_index + OPEN_TAG.len()..];
    let close_index = after_open.find(CLOSE_TAG).unwrap_or(after_open.len());
    Some(after_open[..close_index].to_string())
}

#[cfg(test)]
mod tests {
    use super::{extract_proposed_plan_text, strip_proposed_plan_blocks};

    #[test]
    fn strips_complete_proposed_plan_blocks() {
        let text = "before\n<proposed_plan>\n- step\n</proposed_plan>\nafter";

        assert_eq!(strip_proposed_plan_blocks(text), "before\nafter");
    }

    #[test]
    fn strips_unterminated_proposed_plan_blocks_from_visible_text() {
        let text = "before\n<proposed_plan>\n- step";

        assert_eq!(strip_proposed_plan_blocks(text), "before\n");
    }

    #[test]
    fn extracts_plan_text_from_complete_blocks() {
        let text = "before\n<proposed_plan>\n- step\n</proposed_plan>\nafter";

        assert_eq!(
            extract_proposed_plan_text(text),
            Some("\n- step\n".to_string())
        );
    }

    #[test]
    fn extracts_plan_text_from_unterminated_blocks() {
        let text = "before\n<proposed_plan>\n- step";

        assert_eq!(
            extract_proposed_plan_text(text),
            Some("\n- step".to_string())
        );
    }
}
