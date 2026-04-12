use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub open_settings: Option<String>,
    pub focus_composer: Option<String>,
    pub toggle_projects_sidebar: Option<String>,
    pub toggle_review_panel: Option<String>,
    pub toggle_terminal: Option<String>,
    pub new_thread: Option<String>,
    pub archive_current_thread: Option<String>,
    pub next_thread: Option<String>,
    pub previous_thread: Option<String>,
    pub new_worktree: Option<String>,
    pub next_environment: Option<String>,
    pub previous_environment: Option<String>,
    pub cycle_collaboration_mode: Option<String>,
    pub cycle_model: Option<String>,
    pub cycle_reasoning_effort: Option<String>,
    pub cycle_approval_policy: Option<String>,
    pub interrupt_thread: Option<String>,
    pub approve_or_submit: Option<String>,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            open_settings: Some("mod+comma".to_string()),
            focus_composer: Some("mod+l".to_string()),
            toggle_projects_sidebar: Some("mod+b".to_string()),
            toggle_review_panel: Some("mod+g".to_string()),
            toggle_terminal: Some("mod+j".to_string()),
            new_thread: Some("mod+t".to_string()),
            archive_current_thread: Some("mod+w".to_string()),
            next_thread: Some("mod+shift+]".to_string()),
            previous_thread: Some("mod+shift+[".to_string()),
            new_worktree: Some("mod+n".to_string()),
            next_environment: Some("mod+alt+arrowdown".to_string()),
            previous_environment: Some("mod+alt+arrowup".to_string()),
            cycle_collaboration_mode: Some("shift+tab".to_string()),
            cycle_model: Some("mod+shift+m".to_string()),
            cycle_reasoning_effort: Some("mod+shift+r".to_string()),
            cycle_approval_policy: Some("mod+shift+a".to_string()),
            interrupt_thread: Some(default_interrupt_shortcut().to_string()),
            approve_or_submit: Some("mod+enter".to_string()),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettingsPatch {
    pub open_settings: Option<Option<String>>,
    pub focus_composer: Option<Option<String>>,
    pub toggle_projects_sidebar: Option<Option<String>>,
    pub toggle_review_panel: Option<Option<String>>,
    pub toggle_terminal: Option<Option<String>>,
    pub new_thread: Option<Option<String>>,
    pub archive_current_thread: Option<Option<String>>,
    pub next_thread: Option<Option<String>>,
    pub previous_thread: Option<Option<String>>,
    pub new_worktree: Option<Option<String>>,
    pub next_environment: Option<Option<String>>,
    pub previous_environment: Option<Option<String>>,
    pub cycle_collaboration_mode: Option<Option<String>>,
    pub cycle_model: Option<Option<String>>,
    pub cycle_reasoning_effort: Option<Option<String>>,
    pub cycle_approval_policy: Option<Option<String>>,
    pub interrupt_thread: Option<Option<String>>,
    pub approve_or_submit: Option<Option<String>>,
}

impl ShortcutSettings {
    pub fn apply_patch(&mut self, patch: ShortcutSettingsPatch) {
        if let Some(value) = patch.open_settings {
            self.open_settings = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.focus_composer {
            self.focus_composer = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.toggle_projects_sidebar {
            self.toggle_projects_sidebar = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.toggle_review_panel {
            self.toggle_review_panel = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.toggle_terminal {
            self.toggle_terminal = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.new_thread {
            self.new_thread = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.archive_current_thread {
            self.archive_current_thread = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.next_thread {
            self.next_thread = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.previous_thread {
            self.previous_thread = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.new_worktree {
            self.new_worktree = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.next_environment {
            self.next_environment = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.previous_environment {
            self.previous_environment = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.cycle_collaboration_mode {
            self.cycle_collaboration_mode = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.cycle_model {
            self.cycle_model = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.cycle_reasoning_effort {
            self.cycle_reasoning_effort = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.cycle_approval_policy {
            self.cycle_approval_policy = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.interrupt_thread {
            self.interrupt_thread = normalize_shortcut_option(value);
        }
        if let Some(value) = patch.approve_or_submit {
            self.approve_or_submit = normalize_shortcut_option(value);
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        let mut seen = HashMap::new();
        for (_, label, value) in self.bindings() {
            let Some(raw) = value else {
                continue;
            };
            let parsed = parse_shortcut(raw)
                .map_err(|message| AppError::Validation(format!("{label}: {message}")))?;
            let signature = parsed.signature();
            if let Some(previous) = seen.insert(signature, label) {
                return Err(AppError::Validation(format!(
                    "Shortcut conflict: {previous} and {label} use the same keybinding."
                )));
            }
        }
        Ok(())
    }

    pub fn binding_for(&self, action: &str) -> Option<&str> {
        self.bindings()
            .into_iter()
            .find_map(|(id, _, value)| (id == action).then_some(value))
            .flatten()
            .map(String::as_str)
    }

    fn bindings(&self) -> [(&'static str, &'static str, Option<&String>); 18] {
        [
            ("openSettings", "Open settings", self.open_settings.as_ref()),
            (
                "focusComposer",
                "Focus composer",
                self.focus_composer.as_ref(),
            ),
            (
                "toggleProjectsSidebar",
                "Toggle Projects sidebar",
                self.toggle_projects_sidebar.as_ref(),
            ),
            (
                "toggleReviewPanel",
                "Toggle Review panel",
                self.toggle_review_panel.as_ref(),
            ),
            (
                "toggleTerminal",
                "Toggle terminal",
                self.toggle_terminal.as_ref(),
            ),
            ("newThread", "New thread", self.new_thread.as_ref()),
            (
                "archiveCurrentThread",
                "Archive current thread",
                self.archive_current_thread.as_ref(),
            ),
            ("nextThread", "Next thread", self.next_thread.as_ref()),
            (
                "previousThread",
                "Previous thread",
                self.previous_thread.as_ref(),
            ),
            ("newWorktree", "New worktree", self.new_worktree.as_ref()),
            (
                "nextEnvironment",
                "Next environment",
                self.next_environment.as_ref(),
            ),
            (
                "previousEnvironment",
                "Previous environment",
                self.previous_environment.as_ref(),
            ),
            (
                "cycleCollaborationMode",
                "Cycle Build/Plan mode",
                self.cycle_collaboration_mode.as_ref(),
            ),
            ("cycleModel", "Cycle model", self.cycle_model.as_ref()),
            (
                "cycleReasoningEffort",
                "Cycle reasoning",
                self.cycle_reasoning_effort.as_ref(),
            ),
            (
                "cycleApprovalPolicy",
                "Cycle approval policy",
                self.cycle_approval_policy.as_ref(),
            ),
            (
                "interruptThread",
                "Interrupt active turn",
                self.interrupt_thread.as_ref(),
            ),
            (
                "approveOrSubmit",
                "Approve plan / submit pending input",
                self.approve_or_submit.as_ref(),
            ),
        ]
    }
}

#[cfg(target_os = "macos")]
pub fn shortcut_to_menu_accelerator(value: &str) -> Option<String> {
    let parsed = parse_shortcut(value).ok()?;
    let mut parts = Vec::new();
    if parsed.meta || parsed.mod_ {
        parts.push("Cmd".to_string());
    }
    if parsed.ctrl {
        parts.push("Ctrl".to_string());
    }
    if parsed.alt {
        parts.push("Alt".to_string());
    }
    if parsed.shift {
        parts.push("Shift".to_string());
    }
    let key = match parsed.key.as_str() {
        "plus" => "+".to_string(),
        "comma" => ",".to_string(),
        "period" => ".".to_string(),
        "slash" => "/".to_string(),
        "backquote" => "`".to_string(),
        "escape" => "Esc".to_string(),
        "enter" => "Enter".to_string(),
        "tab" => "Tab".to_string(),
        "space" => "Space".to_string(),
        "arrowup" => "Up".to_string(),
        "arrowdown" => "Down".to_string(),
        "arrowleft" => "Left".to_string(),
        "arrowright" => "Right".to_string(),
        value if value.len() == 1 => value.to_uppercase(),
        value => value.to_string(),
    };
    parts.push(key);
    Some(parts.join("+"))
}

fn default_interrupt_shortcut() -> &'static str {
    if cfg!(target_os = "macos") {
        "ctrl+c"
    } else {
        "ctrl+shift+c"
    }
}

fn normalize_shortcut_option(value: Option<String>) -> Option<String> {
    value.and_then(|shortcut| {
        let trimmed = shortcut.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShortcutDefinition {
    key: String,
    meta: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
    mod_: bool,
}

impl ShortcutDefinition {
    fn signature(&self) -> String {
        let is_mac = cfg!(target_os = "macos");
        let resolved_meta = self.meta || (self.mod_ && is_mac);
        let resolved_ctrl = self.ctrl || (self.mod_ && !is_mac);
        format!(
            "{}:{}:{}:{}:{}",
            self.key, resolved_meta, resolved_ctrl, self.alt, self.shift
        )
    }
}

fn parse_shortcut(value: &str) -> Result<ShortcutDefinition, String> {
    let tokens = value
        .trim()
        .split('+')
        .map(|token| token.trim().to_lowercase())
        .collect::<Vec<_>>();
    if tokens.is_empty() || tokens.iter().any(|token| token.is_empty()) {
        return Err("Invalid shortcut.".to_string());
    }

    let mut key = None;
    let mut meta = false;
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut mod_ = false;

    for token in tokens {
        match token.as_str() {
            "cmd" | "meta" => meta = true,
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "mod" => mod_ = true,
            _ => {
                if key.is_some() {
                    return Err("Only one non-modifier key is allowed.".to_string());
                }
                key = Some(normalize_key_token(&token));
            }
        }
    }

    let Some(key) = key else {
        return Err("Shortcut must include a non-modifier key.".to_string());
    };
    if matches!(
        key.as_str(),
        "cmd" | "meta" | "ctrl" | "control" | "alt" | "option" | "shift" | "mod"
    ) {
        return Err("Shortcut must include a non-modifier key.".to_string());
    }

    let has_primary_modifier = meta || ctrl || alt || mod_;
    if !(has_primary_modifier || (shift && key == "tab")) {
        return Err("Shortcut needs a primary modifier unless it is Shift+Tab.".to_string());
    }

    Ok(ShortcutDefinition {
        key,
        meta,
        ctrl,
        alt,
        shift,
        mod_,
    })
}

fn normalize_key_token(token: &str) -> String {
    match token {
        "+" | "plus" => "plus".to_string(),
        "{" => "[".to_string(),
        "}" => "]".to_string(),
        "," | "comma" => "comma".to_string(),
        "." | "period" => "period".to_string(),
        "/" | "slash" => "slash".to_string(),
        "`" | "backquote" => "backquote".to_string(),
        "esc" | "escape" => "escape".to_string(),
        "return" | "enter" => "enter".to_string(),
        " " | "space" => "space".to_string(),
        "up" | "arrowup" => "arrowup".to_string(),
        "down" | "arrowdown" => "arrowdown".to_string(),
        "left" | "arrowleft" => "arrowleft".to_string(),
        "right" | "arrowright" => "arrowright".to_string(),
        _ => token.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_shortcut, shortcut_to_menu_accelerator, ShortcutSettings, ShortcutSettingsPatch,
    };

    #[test]
    fn defaults_include_common_shortcuts() {
        let defaults = ShortcutSettings::default();

        assert_eq!(defaults.toggle_terminal.as_deref(), Some("mod+j"));
        assert_eq!(defaults.open_settings.as_deref(), Some("mod+comma"));
        assert_eq!(
            defaults.cycle_collaboration_mode.as_deref(),
            Some("shift+tab")
        );
    }

    #[test]
    fn patch_can_clear_and_replace_bindings() {
        let mut settings = ShortcutSettings::default();

        settings.apply_patch(ShortcutSettingsPatch {
            toggle_terminal: Some(Some("mod+shift+j".to_string())),
            archive_current_thread: Some(None),
            ..ShortcutSettingsPatch::default()
        });

        assert_eq!(settings.toggle_terminal.as_deref(), Some("mod+shift+j"));
        assert_eq!(settings.archive_current_thread, None);
    }

    #[test]
    fn validate_rejects_duplicate_bindings() {
        let settings = ShortcutSettings {
            toggle_terminal: Some("mod+j".to_string()),
            new_thread: Some("mod+j".to_string()),
            ..ShortcutSettings::default()
        };

        let error = settings.validate().expect_err("should reject conflicts");
        assert_eq!(
            error.to_string(),
            "Shortcut conflict: Toggle terminal and New thread use the same keybinding."
        );
    }

    #[test]
    fn validate_rejects_missing_primary_modifier() {
        let settings = ShortcutSettings {
            toggle_terminal: Some("j".to_string()),
            ..ShortcutSettings::default()
        };

        let error = settings
            .validate()
            .expect_err("should reject invalid shortcuts");
        assert_eq!(
            error.to_string(),
            "Toggle terminal: Shortcut needs a primary modifier unless it is Shift+Tab."
        );
    }

    #[test]
    fn parse_normalizes_named_keys() {
        let shortcut = parse_shortcut("mod+Shift+,").expect("shortcut should parse");

        assert_eq!(shortcut.key, "comma");
        assert!(shortcut.shift);
        assert!(shortcut.mod_);
    }

    #[test]
    fn parse_normalizes_shifted_brackets_and_plus_keys() {
        assert_eq!(
            parse_shortcut("mod+shift+}")
                .expect("shifted bracket should parse")
                .key,
            "]"
        );
        assert_eq!(
            parse_shortcut("mod+shift+plus")
                .expect("plus should parse")
                .key,
            "plus"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn menu_accelerator_uses_mac_tokens() {
        assert_eq!(
            shortcut_to_menu_accelerator("mod+shift+m"),
            Some("Cmd+Shift+M".to_string())
        );
        assert_eq!(
            shortcut_to_menu_accelerator("mod+comma"),
            Some("Cmd+,".to_string())
        );
    }
}
