use crate::domain::settings::CollaborationMode;

const PLAN_TEMPLATE: &str = include_str!("collaboration_mode_templates/plan.md");

pub fn developer_instructions_for_mode(mode: CollaborationMode) -> Option<String> {
    match mode {
        // Build mode uses Codex's built-in default collaboration mode. Sending
        // `null` here clears any prior plan-specific developer instructions.
        CollaborationMode::Build => None,
        CollaborationMode::Plan => Some(PLAN_TEMPLATE.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::developer_instructions_for_mode;
    use crate::domain::settings::CollaborationMode;

    #[test]
    fn build_mode_instructions_clear_mode_specific_template() {
        let instructions = developer_instructions_for_mode(CollaborationMode::Build);

        assert!(instructions.is_none());
    }

    #[test]
    fn plan_mode_instructions_include_proposed_plan_contract() {
        let instructions = developer_instructions_for_mode(CollaborationMode::Plan)
            .expect("plan mode instructions should exist");

        assert!(instructions.contains("You are in Plan mode."));
        assert!(instructions.contains("<proposed_plan>"));
        assert!(instructions.contains("must use the `request_user_input` tool"));
    }
}
