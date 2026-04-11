use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::shortcuts::{ShortcutSettings, ShortcutSettingsPatch};

fn default_collapse_work_activity() -> bool {
    true
}

fn default_open_targets() -> Vec<OpenTarget> {
    default_open_targets_for_platform()
}

fn default_open_target_id() -> String {
    default_open_targets()
        .into_iter()
        .next()
        .map(|target| target.id)
        .unwrap_or_else(|| "cursor".to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CollaborationMode {
    Build,
    Plan,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ApprovalPolicy {
    #[serde(rename = "askToEdit")]
    AskToEdit,
    #[serde(rename = "fullAccess")]
    FullAccess,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpenTargetKind {
    #[serde(rename = "app")]
    App,
    #[serde(rename = "command")]
    Command,
    #[serde(rename = "fileManager")]
    FileManager,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub id: String,
    pub label: String,
    pub kind: OpenTargetKind,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub default_model: String,
    pub default_reasoning_effort: ReasoningEffort,
    pub default_collaboration_mode: CollaborationMode,
    pub default_approval_policy: ApprovalPolicy,
    #[serde(default = "default_collapse_work_activity")]
    pub collapse_work_activity: bool,
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
    #[serde(default = "default_open_targets")]
    pub open_targets: Vec<OpenTarget>,
    #[serde(default = "default_open_target_id")]
    pub default_open_target_id: String,
    pub codex_binary_path: Option<String>,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            default_model: "gpt-5.4".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            default_collaboration_mode: CollaborationMode::Build,
            default_approval_policy: ApprovalPolicy::AskToEdit,
            collapse_work_activity: true,
            shortcuts: ShortcutSettings::default(),
            open_targets: default_open_targets(),
            default_open_target_id: default_open_target_id(),
            codex_binary_path: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsPatch {
    pub default_model: Option<String>,
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub default_collaboration_mode: Option<CollaborationMode>,
    pub default_approval_policy: Option<ApprovalPolicy>,
    pub collapse_work_activity: Option<bool>,
    pub shortcuts: Option<ShortcutSettingsPatch>,
    pub open_targets: Option<Vec<OpenTarget>>,
    pub default_open_target_id: Option<String>,
    pub codex_binary_path: Option<Option<String>>,
}

impl GlobalSettings {
    pub fn apply_patch(&mut self, patch: GlobalSettingsPatch) {
        if let Some(default_model) = patch.default_model {
            self.default_model = default_model;
        }
        if let Some(default_reasoning_effort) = patch.default_reasoning_effort {
            self.default_reasoning_effort = default_reasoning_effort;
        }
        if let Some(default_collaboration_mode) = patch.default_collaboration_mode {
            self.default_collaboration_mode = default_collaboration_mode;
        }
        if let Some(default_approval_policy) = patch.default_approval_policy {
            self.default_approval_policy = default_approval_policy;
        }
        if let Some(collapse_work_activity) = patch.collapse_work_activity {
            self.collapse_work_activity = collapse_work_activity;
        }
        if let Some(shortcuts) = patch.shortcuts {
            self.shortcuts.apply_patch(shortcuts);
        }
        if let Some(open_targets) = patch.open_targets {
            self.open_targets = open_targets;
        }
        if let Some(default_open_target_id) = patch.default_open_target_id {
            self.default_open_target_id = default_open_target_id;
        }
        if let Some(codex_binary_path) = patch.codex_binary_path {
            self.codex_binary_path = codex_binary_path;
        }
    }

    pub fn normalize_for_read(&mut self) -> bool {
        self.normalize_open_targets(OpenTargetNormalizationMode::RepairStored)
            .unwrap_or(false)
    }

    pub fn normalize_for_update(&mut self) -> Result<(), String> {
        self.normalize_open_targets(OpenTargetNormalizationMode::RejectInvalid)?;
        Ok(())
    }

    pub fn resolve_open_target(&self, target_id: Option<&str>) -> Result<&OpenTarget, String> {
        let resolved_id = target_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(self.default_open_target_id.as_str());
        self.open_targets
            .iter()
            .find(|target| target.id == resolved_id)
            .ok_or_else(|| format!("Unknown Open In target: {resolved_id}"))
    }

    pub fn validate(&self) -> Result<(), String> {
        self.shortcuts.validate().map_err(|error| error.to_string())?;
        let mut normalized = self.clone();
        normalized.normalize_for_update()?;
        Ok(())
    }

    fn normalize_open_targets(
        &mut self,
        mode: OpenTargetNormalizationMode,
    ) -> Result<bool, String> {
        normalize_open_targets(
            &mut self.open_targets,
            &mut self.default_open_target_id,
            mode,
        )
    }
}

#[derive(Debug, Clone, Copy)]
enum OpenTargetNormalizationMode {
    RepairStored,
    RejectInvalid,
}

impl OpenTarget {
    fn app(id: &str, label: &str, app_name: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: OpenTargetKind::App,
            app_name: Some(app_name.to_string()),
            command: None,
            args: Vec::new(),
        }
    }

    fn file_manager(id: &str, label: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: OpenTargetKind::FileManager,
            app_name: None,
            command: None,
            args: Vec::new(),
        }
    }

    fn normalize(&mut self) -> Result<bool, String> {
        let mut changed = false;

        let id = self.id.trim();
        if id.is_empty() {
            return Err("Target id is required.".to_string());
        }
        if id != self.id {
            self.id = id.to_string();
            changed = true;
        }

        let label = self.label.trim();
        if label.is_empty() {
            return Err("Target label is required.".to_string());
        }
        if label != self.label {
            self.label = label.to_string();
            changed = true;
        }

        let normalized_app_name = normalize_optional_string(self.app_name.clone());
        let normalized_command = normalize_optional_string(self.command.clone());
        let normalized_args = normalize_args(&self.args);
        if self.app_name != normalized_app_name {
            self.app_name = normalized_app_name;
            changed = true;
        }
        if self.command != normalized_command {
            self.command = normalized_command;
            changed = true;
        }
        if self.args != normalized_args {
            self.args = normalized_args;
            changed = true;
        }

        match self.kind {
            OpenTargetKind::App => {
                if self.app_name.is_none() {
                    return Err("App targets require an application name.".to_string());
                }
                if self.command.is_some() {
                    self.command = None;
                    changed = true;
                }
            }
            OpenTargetKind::Command => {
                if self.command.is_none() {
                    return Err("Command targets require a command.".to_string());
                }
                if self.app_name.is_some() {
                    self.app_name = None;
                    changed = true;
                }
            }
            OpenTargetKind::FileManager => {
                if self.app_name.is_some() {
                    self.app_name = None;
                    changed = true;
                }
                if self.command.is_some() {
                    self.command = None;
                    changed = true;
                }
            }
        }

        Ok(changed)
    }
}

fn normalize_open_targets(
    targets: &mut Vec<OpenTarget>,
    default_target_id: &mut String,
    mode: OpenTargetNormalizationMode,
) -> Result<bool, String> {
    let mut changed = false;
    let mut next_targets = Vec::with_capacity(targets.len());

    for (index, mut target) in targets.iter().cloned().enumerate() {
        match target.normalize() {
            Ok(target_changed) => {
                changed |= target_changed;
                next_targets.push(target);
            }
            Err(error) => match mode {
                OpenTargetNormalizationMode::RepairStored => changed = true,
                OpenTargetNormalizationMode::RejectInvalid => {
                    return Err(format!("Open target {}: {error}", index + 1));
                }
            },
        }
    }

    let mut seen_ids = HashSet::new();
    let mut deduped_targets = Vec::with_capacity(next_targets.len());
    for target in next_targets {
        if seen_ids.insert(target.id.clone()) {
            deduped_targets.push(target);
            continue;
        }

        match mode {
            OpenTargetNormalizationMode::RepairStored => changed = true,
            OpenTargetNormalizationMode::RejectInvalid => {
                return Err(format!("Open target ids must be unique: {}", target.id));
            }
        }
    }

    if deduped_targets.is_empty() {
        match mode {
            OpenTargetNormalizationMode::RepairStored => {
                *targets = default_open_targets();
                *default_target_id = default_open_target_id();
                return Ok(true);
            }
            OpenTargetNormalizationMode::RejectInvalid => {
                return Err("At least one Open In target is required.".to_string());
            }
        }
    }

    let trimmed_default_id = default_target_id.trim();
    if trimmed_default_id.is_empty()
        || !deduped_targets
            .iter()
            .any(|target| target.id == trimmed_default_id)
    {
        *default_target_id = deduped_targets[0].id.clone();
        changed = true;
    } else if *default_target_id != trimmed_default_id {
        *default_target_id = trimmed_default_id.to_string();
        changed = true;
    }

    *targets = deduped_targets;
    Ok(changed)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|candidate| candidate.trim().to_string())
        .filter(|candidate| !candidate.is_empty())
}

fn normalize_args(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|argument| argument.trim().to_string())
        .filter(|argument| !argument.is_empty())
        .collect()
}

#[cfg(target_os = "macos")]
fn default_open_targets_for_platform() -> Vec<OpenTarget> {
    vec![
        OpenTarget::app("cursor", "Cursor", "Cursor"),
        OpenTarget::app("vscode", "VS Code", "Visual Studio Code"),
        OpenTarget::app(
            "vscode-insiders",
            "VS Code Insiders",
            "Visual Studio Code - Insiders",
        ),
        OpenTarget::app("vscodium", "VSCodium", "VSCodium"),
        OpenTarget::app("zed", "Zed", "Zed"),
        OpenTarget::app("trae", "Trae", "Trae"),
        OpenTarget::app("idea", "IntelliJ IDEA", "IntelliJ IDEA"),
        OpenTarget::app("antigravity", "Antigravity", "Antigravity"),
        OpenTarget::app("ghostty", "Ghostty", "Ghostty"),
        OpenTarget::app("iterm2", "iTerm2", "iTerm"),
        OpenTarget::app("terminal", "Terminal", "Terminal"),
        OpenTarget::file_manager("file-manager", "Finder"),
    ]
}

#[cfg(not(target_os = "macos"))]
fn default_open_targets_for_platform() -> Vec<OpenTarget> {
    vec![OpenTarget::file_manager("file-manager", "File Manager")]
}

#[cfg(test)]
mod tests {
    use super::{
        ApprovalPolicy, CollaborationMode, GlobalSettings, GlobalSettingsPatch, OpenTarget,
        OpenTargetKind, ReasoningEffort,
    };
    use crate::domain::shortcuts::ShortcutSettingsPatch;

    #[test]
    fn apply_patch_updates_only_provided_fields() {
        let mut settings = GlobalSettings::default();

        settings.apply_patch(GlobalSettingsPatch {
            default_model: Some("gpt-5.3-codex".to_string()),
            default_reasoning_effort: Some(ReasoningEffort::Medium),
            default_collaboration_mode: None,
            default_approval_policy: Some(ApprovalPolicy::FullAccess),
            collapse_work_activity: Some(true),
            shortcuts: Some(ShortcutSettingsPatch {
                toggle_terminal: Some(Some("mod+shift+j".to_string())),
                ..ShortcutSettingsPatch::default()
            }),
            open_targets: Some(vec![OpenTarget {
                id: "zed".to_string(),
                label: "Zed".to_string(),
                kind: OpenTargetKind::App,
                app_name: Some("Zed".to_string()),
                command: None,
                args: Vec::new(),
            }]),
            default_open_target_id: Some("zed".to_string()),
            codex_binary_path: Some(Some("/opt/homebrew/bin/codex".to_string())),
        });

        assert_eq!(settings.default_model, "gpt-5.3-codex");
        assert!(matches!(
            settings.default_reasoning_effort,
            ReasoningEffort::Medium
        ));
        assert!(matches!(
            settings.default_collaboration_mode,
            CollaborationMode::Build
        ));
        assert!(matches!(
            settings.default_approval_policy,
            ApprovalPolicy::FullAccess
        ));
        assert!(settings.collapse_work_activity);
        assert_eq!(settings.shortcuts.toggle_terminal.as_deref(), Some("mod+shift+j"));
        assert_eq!(settings.open_targets.len(), 1);
        assert_eq!(settings.default_open_target_id, "zed");
        assert_eq!(
            settings.codex_binary_path.as_deref(),
            Some("/opt/homebrew/bin/codex")
        );
    }

    #[test]
    fn apply_patch_can_clear_optional_binary_path() {
        let mut settings = GlobalSettings {
            codex_binary_path: Some("/opt/homebrew/bin/codex".to_string()),
            ..GlobalSettings::default()
        };

        settings.apply_patch(GlobalSettingsPatch {
            codex_binary_path: Some(None),
            ..GlobalSettingsPatch::default()
        });

        assert_eq!(settings.codex_binary_path, None);
    }

    #[test]
    fn default_settings_enable_collapsed_work_activity_and_shortcuts() {
        let settings = GlobalSettings::default();

        assert!(settings.collapse_work_activity);
        assert_eq!(settings.shortcuts.toggle_terminal.as_deref(), Some("mod+j"));
    }

    #[test]
    fn deserialize_legacy_settings_defaults_collapse_work_activity_and_shortcuts() {
        let settings: GlobalSettings = serde_json::from_str(
            r#"{
                "defaultModel":"gpt-5.4",
                "defaultReasoningEffort":"high",
                "defaultCollaborationMode":"build",
                "defaultApprovalPolicy":"askToEdit",
                "codexBinaryPath":"/opt/homebrew/bin/codex"
            }"#,
        )
        .expect("legacy settings should deserialize");

        assert!(settings.collapse_work_activity);
        assert_eq!(settings.shortcuts.open_settings.as_deref(), Some("mod+comma"));
        assert!(!settings.open_targets.is_empty());
        assert!(
            settings
                .open_targets
                .iter()
                .any(|target| target.id == settings.default_open_target_id)
        );
    }

    #[test]
    fn validate_uses_shortcut_rules() {
        let mut settings = GlobalSettings::default();
        settings.shortcuts.toggle_terminal = Some("j".to_string());

        assert_eq!(
            settings.validate().expect_err("invalid shortcuts should fail"),
            "Toggle terminal: Shortcut needs a primary modifier unless it is Shift+Tab."
        );
    }

    #[test]
    fn normalize_for_update_trims_targets_and_repairs_default_id() {
        let mut settings = GlobalSettings {
            open_targets: vec![
                OpenTarget {
                    id: " cursor ".to_string(),
                    label: " Cursor ".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some(" Cursor ".to_string()),
                    command: None,
                    args: vec![" --reuse-window ".to_string(), "".to_string()],
                },
                OpenTarget {
                    id: "finder".to_string(),
                    label: " Finder ".to_string(),
                    kind: OpenTargetKind::FileManager,
                    app_name: Some("should-clear".to_string()),
                    command: Some("should-clear".to_string()),
                    args: Vec::new(),
                },
            ],
            default_open_target_id: "missing".to_string(),
            ..GlobalSettings::default()
        };

        settings
            .normalize_for_update()
            .expect("targets should normalize");

        assert_eq!(settings.open_targets[0].id, "cursor");
        assert_eq!(settings.open_targets[0].label, "Cursor");
        assert_eq!(settings.open_targets[0].app_name.as_deref(), Some("Cursor"));
        assert_eq!(settings.open_targets[0].args, vec!["--reuse-window".to_string()]);
        assert_eq!(settings.open_targets[1].label, "Finder");
        assert_eq!(settings.open_targets[1].app_name, None);
        assert_eq!(settings.open_targets[1].command, None);
        assert_eq!(settings.default_open_target_id, "cursor");
    }

    #[test]
    fn normalize_for_update_rejects_invalid_targets() {
        let mut settings = GlobalSettings {
            open_targets: vec![OpenTarget {
                id: "broken".to_string(),
                label: "Broken".to_string(),
                kind: OpenTargetKind::Command,
                app_name: None,
                command: None,
                args: Vec::new(),
            }],
            ..GlobalSettings::default()
        };
        let original_targets = settings.open_targets.clone();
        let original_default_target_id = settings.default_open_target_id.clone();

        assert_eq!(
            settings
                .normalize_for_update()
                .expect_err("invalid command target should fail"),
            "Open target 1: Command targets require a command."
        );
        assert_eq!(settings.open_targets, original_targets);
        assert_eq!(settings.default_open_target_id, original_default_target_id);
    }

    #[test]
    fn normalize_for_read_repairs_invalid_stored_targets() {
        let mut settings = GlobalSettings {
            open_targets: vec![OpenTarget {
                id: " ".to_string(),
                label: " ".to_string(),
                kind: OpenTargetKind::App,
                app_name: None,
                command: None,
                args: Vec::new(),
            }],
            default_open_target_id: "missing".to_string(),
            ..GlobalSettings::default()
        };

        assert!(settings.normalize_for_read());
        assert!(!settings.open_targets.is_empty());
        assert!(
            settings
                .open_targets
                .iter()
                .any(|target| target.id == settings.default_open_target_id)
        );
    }

    #[test]
    fn normalize_for_read_leaves_valid_targets_unchanged() {
        let mut settings = GlobalSettings {
            open_targets: vec![
                OpenTarget {
                    id: "cursor".to_string(),
                    label: "Cursor".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Cursor".to_string()),
                    command: None,
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor-cli".to_string(),
                    label: "Cursor CLI".to_string(),
                    kind: OpenTargetKind::Command,
                    app_name: None,
                    command: Some("cursor".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
            ],
            default_open_target_id: "cursor".to_string(),
            ..GlobalSettings::default()
        };
        let original_targets = settings.open_targets.clone();
        let original_default_target_id = settings.default_open_target_id.clone();

        assert!(!settings.normalize_for_read());
        assert_eq!(settings.open_targets, original_targets);
        assert_eq!(settings.default_open_target_id, original_default_target_id);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_defaults_only_seed_supported_open_targets() {
        let settings = GlobalSettings::default();

        assert_eq!(settings.default_open_target_id, "file-manager");
        assert!(settings
            .open_targets
            .iter()
            .all(|target| target.kind == OpenTargetKind::FileManager));
    }
}
