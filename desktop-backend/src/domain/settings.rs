use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize};

use super::shortcuts::{ShortcutSettings, ShortcutSettingsPatch};
use crate::serde_helpers::deserialize_explicit_optional;

fn default_collapse_work_activity() -> bool {
    true
}

fn default_open_targets() -> Vec<OpenTarget> {
    default_open_targets_for_platform()
}

fn default_open_target_id() -> String {
    preferred_default_open_target_id(&default_open_targets())
}

fn default_desktop_notifications_enabled() -> bool {
    false
}

fn default_stream_assistant_responses() -> bool {
    true
}

const MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS: u8 = 1;
const MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS: u8 = 6;

fn default_multi_agent_nudge_enabled() -> bool {
    false
}

fn default_multi_agent_nudge_max_subagents() -> u8 {
    4
}

fn default_attention_notification_sound() -> NotificationSoundId {
    NotificationSoundId::Glass
}

fn default_completion_notification_sound() -> NotificationSoundId {
    NotificationSoundId::Polite
}

fn default_attention_notification_sound_settings() -> NotificationSoundChannelSettings {
    NotificationSoundChannelSettings::new(default_attention_notification_sound())
}

fn default_completion_notification_sound_settings() -> NotificationSoundChannelSettings {
    NotificationSoundChannelSettings::new(default_completion_notification_sound())
}

fn default_notification_sounds() -> NotificationSoundSettings {
    NotificationSoundSettings::default()
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    #[default]
    Codex,
    Claude,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
    Max,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CollaborationMode {
    Build,
    Plan,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceTier {
    Fast,
    Flex,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum DefaultDraftEnvironment {
    #[default]
    Local,
    NewWorktree,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ApprovalPolicy {
    #[serde(rename = "askToEdit")]
    AskToEdit,
    #[serde(rename = "autoReview")]
    AutoReview,
    #[serde(rename = "fullAccess")]
    FullAccess,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotificationSoundId {
    Glass,
    Chord,
    Polite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpenTargetKind {
    #[serde(rename = "app")]
    App,
    // Keep the legacy variant so stored settings can be repaired on read.
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
    // Legacy storage only. Launch behavior no longer consumes user-provided args.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundChannelSettings {
    pub enabled: bool,
    pub sound: NotificationSoundId,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundSettings {
    #[serde(default = "default_attention_notification_sound_settings")]
    pub attention: NotificationSoundChannelSettings,
    #[serde(default = "default_completion_notification_sound_settings")]
    pub completion: NotificationSoundChannelSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    #[serde(default)]
    pub default_provider: ProviderKind,
    pub default_model: String,
    pub default_reasoning_effort: ReasoningEffort,
    pub default_collaboration_mode: CollaborationMode,
    pub default_approval_policy: ApprovalPolicy,
    pub default_service_tier: Option<ServiceTier>,
    #[serde(default)]
    pub default_draft_environment: DefaultDraftEnvironment,
    #[serde(default = "default_collapse_work_activity")]
    pub collapse_work_activity: bool,
    #[serde(default = "default_desktop_notifications_enabled")]
    pub desktop_notifications_enabled: bool,
    #[serde(default = "default_stream_assistant_responses")]
    pub stream_assistant_responses: bool,
    #[serde(default = "default_multi_agent_nudge_enabled")]
    pub multi_agent_nudge_enabled: bool,
    #[serde(default = "default_multi_agent_nudge_max_subagents")]
    pub multi_agent_nudge_max_subagents: u8,
    #[serde(default = "default_notification_sounds")]
    pub notification_sounds: NotificationSoundSettings,
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
    #[serde(default = "default_open_targets")]
    pub open_targets: Vec<OpenTarget>,
    #[serde(default = "default_open_target_id")]
    pub default_open_target_id: String,
    pub codex_binary_path: Option<String>,
    #[serde(default)]
    pub claude_binary_path: Option<String>,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            default_provider: ProviderKind::Codex,
            default_model: "gpt-5.4".to_string(),
            default_reasoning_effort: ReasoningEffort::High,
            default_collaboration_mode: CollaborationMode::Build,
            default_approval_policy: ApprovalPolicy::AskToEdit,
            default_service_tier: None,
            default_draft_environment: DefaultDraftEnvironment::Local,
            collapse_work_activity: true,
            desktop_notifications_enabled: false,
            stream_assistant_responses: true,
            multi_agent_nudge_enabled: false,
            multi_agent_nudge_max_subagents: default_multi_agent_nudge_max_subagents(),
            notification_sounds: NotificationSoundSettings::default(),
            shortcuts: ShortcutSettings::default(),
            open_targets: default_open_targets(),
            default_open_target_id: default_open_target_id(),
            codex_binary_path: None,
            claude_binary_path: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsPatch {
    pub default_provider: Option<ProviderKind>,
    pub default_model: Option<String>,
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub default_collaboration_mode: Option<CollaborationMode>,
    pub default_approval_policy: Option<ApprovalPolicy>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    pub default_service_tier: Option<Option<ServiceTier>>,
    pub default_draft_environment: Option<DefaultDraftEnvironment>,
    pub collapse_work_activity: Option<bool>,
    pub desktop_notifications_enabled: Option<bool>,
    pub stream_assistant_responses: Option<bool>,
    pub multi_agent_nudge_enabled: Option<bool>,
    pub multi_agent_nudge_max_subagents: Option<u8>,
    pub notification_sounds: Option<NotificationSoundSettingsPatch>,
    pub shortcuts: Option<ShortcutSettingsPatch>,
    pub open_targets: Option<Vec<OpenTarget>>,
    pub default_open_target_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    pub codex_binary_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    pub claude_binary_path: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundChannelSettingsPatch {
    pub enabled: Option<bool>,
    pub sound: Option<NotificationSoundId>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundSettingsPatch {
    pub attention: Option<NotificationSoundChannelSettingsPatch>,
    pub completion: Option<NotificationSoundChannelSettingsPatch>,
}

impl GlobalSettings {
    pub fn apply_patch(&mut self, patch: GlobalSettingsPatch) {
        if let Some(default_provider) = patch.default_provider {
            self.default_provider = default_provider;
        }
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
        if let Some(default_service_tier) = patch.default_service_tier {
            self.default_service_tier = default_service_tier;
        }
        if let Some(default_draft_environment) = patch.default_draft_environment {
            self.default_draft_environment = default_draft_environment;
        }
        if let Some(collapse_work_activity) = patch.collapse_work_activity {
            self.collapse_work_activity = collapse_work_activity;
        }
        if let Some(desktop_notifications_enabled) = patch.desktop_notifications_enabled {
            self.desktop_notifications_enabled = desktop_notifications_enabled;
        }
        if let Some(stream_assistant_responses) = patch.stream_assistant_responses {
            self.stream_assistant_responses = stream_assistant_responses;
        }
        if let Some(multi_agent_nudge_enabled) = patch.multi_agent_nudge_enabled {
            self.multi_agent_nudge_enabled = multi_agent_nudge_enabled;
        }
        if let Some(multi_agent_nudge_max_subagents) = patch.multi_agent_nudge_max_subagents {
            self.multi_agent_nudge_max_subagents = multi_agent_nudge_max_subagents;
        }
        if let Some(notification_sounds) = patch.notification_sounds {
            self.notification_sounds.apply_patch(notification_sounds);
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
        if let Some(claude_binary_path) = patch.claude_binary_path {
            self.claude_binary_path = claude_binary_path;
        }
    }

    pub fn normalize_for_read(&mut self) -> bool {
        let mut repaired =
            repair_stored_open_targets(&mut self.open_targets, &mut self.default_open_target_id);
        if self.shortcuts.validate().is_err() {
            self.shortcuts = ShortcutSettings::default();
            repaired = true;
        }
        if !multi_agent_nudge_max_subagents_is_valid(self.multi_agent_nudge_max_subagents) {
            self.multi_agent_nudge_max_subagents = default_multi_agent_nudge_max_subagents();
            repaired = true;
        }
        repaired
    }

    pub fn normalize_for_update(&mut self) -> Result<(), String> {
        normalize_open_targets_for_update(
            &mut self.open_targets,
            &mut self.default_open_target_id,
        )?;
        Ok(())
    }

    pub fn normalize_default_open_target_for_update(&mut self) -> Result<(), String> {
        normalize_default_open_target_for_update(
            &self.open_targets,
            &mut self.default_open_target_id,
        )
    }

    pub fn projected_for_client(&self) -> Self {
        let mut projected = self.clone();
        let (open_targets, default_open_target_id) =
            project_open_targets(&self.open_targets, &self.default_open_target_id);
        projected.open_targets = open_targets;
        projected.default_open_target_id = default_open_target_id;
        projected
    }

    pub fn resolve_open_target(&self, target_id: Option<&str>) -> Result<OpenTarget, String> {
        let (projected_targets, projected_default_target_id) =
            project_open_targets(&self.open_targets, &self.default_open_target_id);
        let resolved_id = target_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(projected_default_target_id.as_str());
        projected_targets
            .into_iter()
            .find(|target| target.id == resolved_id)
            .ok_or_else(|| format!("Unknown Open In target: {resolved_id}"))
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_multi_agent_nudge_max_subagents(self.multi_agent_nudge_max_subagents)?;
        validate_provider_model_defaults(
            self.default_provider,
            &self.default_model,
            self.default_reasoning_effort,
        )?;
        self.shortcuts.validate().map_err(|error| error.to_string())
    }
}

fn validate_provider_model_defaults(
    provider: ProviderKind,
    model: &str,
    reasoning_effort: ReasoningEffort,
) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("Default model cannot be empty.".to_string());
    }
    if matches!(provider, ProviderKind::Codex) && matches!(reasoning_effort, ReasoningEffort::Max) {
        return Err("Codex default reasoning does not support max.".to_string());
    }
    Ok(())
}

fn multi_agent_nudge_max_subagents_is_valid(value: u8) -> bool {
    (MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS..=MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS).contains(&value)
}

fn validate_multi_agent_nudge_max_subagents(value: u8) -> Result<(), String> {
    if multi_agent_nudge_max_subagents_is_valid(value) {
        return Ok(());
    }

    Err(format!(
        "Multi-agent max subagents must be between {MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS} and {MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS}."
    ))
}

impl NotificationSoundChannelSettings {
    fn new(sound: NotificationSoundId) -> Self {
        Self {
            enabled: false,
            sound,
        }
    }

    fn from_stored_value(
        value: Option<&serde_json::Value>,
        default_sound: NotificationSoundId,
    ) -> Self {
        let mut settings = Self::new(default_sound);
        let Some(serde_json::Value::Object(channel)) = value else {
            return settings;
        };

        if let Some(enabled) = channel.get("enabled").and_then(serde_json::Value::as_bool) {
            settings.enabled = enabled;
        }
        if let Some(sound) = channel
            .get("sound")
            .and_then(serde_json::Value::as_str)
            .and_then(NotificationSoundId::from_stored_value)
        {
            settings.sound = sound;
        }

        settings
    }

    fn apply_patch(&mut self, patch: NotificationSoundChannelSettingsPatch) {
        if let Some(enabled) = patch.enabled {
            self.enabled = enabled;
        }
        if let Some(sound) = patch.sound {
            self.sound = sound;
        }
    }
}

impl Default for NotificationSoundSettings {
    fn default() -> Self {
        Self {
            attention: default_attention_notification_sound_settings(),
            completion: default_completion_notification_sound_settings(),
        }
    }
}

impl NotificationSoundSettings {
    fn from_stored_value(value: serde_json::Value) -> Self {
        let serde_json::Value::Object(notification_sounds) = value else {
            return Self::default();
        };

        Self {
            attention: NotificationSoundChannelSettings::from_stored_value(
                notification_sounds.get("attention"),
                default_attention_notification_sound(),
            ),
            completion: NotificationSoundChannelSettings::from_stored_value(
                notification_sounds.get("completion"),
                default_completion_notification_sound(),
            ),
        }
    }

    fn apply_patch(&mut self, patch: NotificationSoundSettingsPatch) {
        if let Some(attention) = patch.attention {
            self.attention.apply_patch(attention);
        }
        if let Some(completion) = patch.completion {
            self.completion.apply_patch(completion);
        }
    }
}

impl NotificationSoundId {
    fn from_stored_value(value: &str) -> Option<Self> {
        match value {
            "glass" => Some(Self::Glass),
            "chord" => Some(Self::Chord),
            "polite" => Some(Self::Polite),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for NotificationSoundSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(Self::from_stored_value(value))
    }
}

impl OpenTarget {
    fn app(id: &str, label: &str, app_name: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: OpenTargetKind::App,
            app_name: Some(app_name.to_string()),
            args: Vec::new(),
        }
    }

    fn file_manager(id: &str, label: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: OpenTargetKind::FileManager,
            app_name: None,
            args: Vec::new(),
        }
    }
}

#[cfg(target_os = "macos")]
const CURATED_OPEN_TARGET_IDS: &[&str] = &[
    "cursor",
    "vscode",
    "zed",
    "idea",
    "antigravity",
    "ghostty",
    "iterm2",
    "terminal",
    "file-manager",
];

#[cfg(not(target_os = "macos"))]
const CURATED_OPEN_TARGET_IDS: &[&str] = &["file-manager"];

fn repair_stored_open_targets(
    targets: &mut Vec<OpenTarget>,
    default_target_id: &mut String,
) -> bool {
    if targets.is_empty() {
        *targets = default_open_targets();
        *default_target_id = default_open_target_id();
        return true;
    }

    false
}

fn normalize_open_targets_for_update(
    targets: &mut Vec<OpenTarget>,
    default_target_id: &mut String,
) -> Result<bool, String> {
    let mut changed = false;
    let mut next_targets = Vec::with_capacity(targets.len());

    for (index, target) in targets.iter().enumerate() {
        let canonical_target = canonical_open_target_for_update(target)
            .map_err(|error| format!("Open target {}: {error}", index + 1))?;
        changed |= target != &canonical_target;
        next_targets.push(canonical_target);
    }

    let mut seen_ids = HashSet::new();
    let mut deduped_targets = Vec::with_capacity(next_targets.len());
    for target in next_targets {
        if seen_ids.insert(target.id.clone()) {
            deduped_targets.push(target);
            continue;
        }

        return Err(format!("Open target ids must be unique: {}", target.id));
    }

    if deduped_targets.is_empty() {
        return Err("At least one Open In target is required.".to_string());
    }

    changed |= normalize_projected_default_target_id(default_target_id, &deduped_targets);

    *targets = deduped_targets;
    Ok(changed)
}

fn normalize_default_open_target_for_update(
    targets: &[OpenTarget],
    default_target_id: &mut String,
) -> Result<(), String> {
    let (projected_targets, repaired_default_target_id) =
        project_open_targets(targets, default_target_id);
    let trimmed_default_id = default_target_id.trim();
    if trimmed_default_id.is_empty() {
        *default_target_id = repaired_default_target_id;
        return Ok(());
    }

    if projected_targets
        .iter()
        .any(|target| target.id == trimmed_default_id)
    {
        if *default_target_id != trimmed_default_id {
            *default_target_id = trimmed_default_id.to_string();
        }
        return Ok(());
    }

    Err(format!("Unknown Open In target: {trimmed_default_id}"))
}

fn project_open_targets(
    targets: &[OpenTarget],
    default_target_id: &str,
) -> (Vec<OpenTarget>, String) {
    let mut seen_ids = HashSet::new();
    let mut projected_targets = Vec::with_capacity(targets.len());
    for target in targets {
        let Some(projected_target) = project_stored_open_target(target) else {
            continue;
        };
        if seen_ids.insert(projected_target.id.clone()) {
            projected_targets.push(projected_target);
        }
    }

    if projected_targets.is_empty() {
        projected_targets = default_open_targets();
    }

    let default_target_id = normalized_default_target_id(default_target_id, &projected_targets);
    (projected_targets, default_target_id)
}

fn project_stored_open_target(target: &OpenTarget) -> Option<OpenTarget> {
    if matches!(target.kind, OpenTargetKind::Command) {
        return None;
    }

    let target_id = target.id.trim();
    if target_id.is_empty() {
        return None;
    }

    curated_open_target_by_id(target_id)
}

fn canonical_open_target_for_update(target: &OpenTarget) -> Result<OpenTarget, String> {
    if matches!(target.kind, OpenTargetKind::Command) {
        return Err("Command-based Open In targets are no longer supported.".to_string());
    }

    let target_id = target.id.trim();
    if target_id.is_empty() {
        return Err("Target id is required.".to_string());
    }

    curated_open_target_by_id(target_id)
        .ok_or_else(|| format!("Unknown Open In target: {target_id}"))
}

fn normalize_projected_default_target_id(
    default_target_id: &mut String,
    targets: &[OpenTarget],
) -> bool {
    let normalized_default_target_id = normalized_default_target_id(default_target_id, targets);
    if *default_target_id == normalized_default_target_id {
        return false;
    }

    *default_target_id = normalized_default_target_id;
    true
}

fn normalized_default_target_id(default_target_id: &str, targets: &[OpenTarget]) -> String {
    let trimmed_default_id = default_target_id.trim();
    if !trimmed_default_id.is_empty()
        && targets.iter().any(|target| target.id == trimmed_default_id)
    {
        return trimmed_default_id.to_string();
    }

    preferred_default_open_target_id(targets)
}

fn preferred_default_open_target_id(targets: &[OpenTarget]) -> String {
    targets
        .iter()
        .find(|target| target.kind == OpenTargetKind::FileManager)
        .or_else(|| targets.first())
        .map(|target| target.id.clone())
        .unwrap_or_else(|| "file-manager".to_string())
}

fn curated_open_target_by_id(target_id: &str) -> Option<OpenTarget> {
    #[cfg(target_os = "macos")]
    {
        match target_id {
            "cursor" => Some(OpenTarget::app("cursor", "Cursor", "Cursor")),
            "vscode" => Some(OpenTarget::app("vscode", "VS Code", "Visual Studio Code")),
            "zed" => Some(OpenTarget::app("zed", "Zed", "Zed")),
            "idea" => Some(OpenTarget::app("idea", "IntelliJ IDEA", "IntelliJ IDEA")),
            "antigravity" => Some(OpenTarget::app("antigravity", "Antigravity", "Antigravity")),
            "ghostty" => Some(OpenTarget::app("ghostty", "Ghostty", "Ghostty")),
            "iterm2" => Some(OpenTarget::app("iterm2", "iTerm2", "iTerm")),
            "terminal" => Some(OpenTarget::app("terminal", "Terminal", "Terminal")),
            "file-manager" => Some(OpenTarget::file_manager("file-manager", "Finder")),
            _ => None,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        match target_id {
            "file-manager" => Some(OpenTarget::file_manager("file-manager", "File Manager")),
            _ => None,
        }
    }
}

fn default_open_targets_for_platform() -> Vec<OpenTarget> {
    CURATED_OPEN_TARGET_IDS
        .iter()
        .filter_map(|target_id| curated_open_target_by_id(target_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        ApprovalPolicy, CollaborationMode, DefaultDraftEnvironment, GlobalSettings,
        GlobalSettingsPatch, NotificationSoundId, NotificationSoundSettingsPatch, OpenTarget,
        OpenTargetKind, ReasoningEffort, ServiceTier,
    };
    use crate::domain::shortcuts::ShortcutSettingsPatch;

    #[test]
    fn apply_patch_updates_only_provided_fields() {
        let mut settings = GlobalSettings::default();

        settings.apply_patch(GlobalSettingsPatch {
            default_provider: None,
            default_model: Some("gpt-5.3-codex".to_string()),
            default_reasoning_effort: Some(ReasoningEffort::Medium),
            default_collaboration_mode: None,
            default_approval_policy: Some(ApprovalPolicy::FullAccess),
            default_service_tier: Some(Some(ServiceTier::Fast)),
            default_draft_environment: Some(DefaultDraftEnvironment::NewWorktree),
            collapse_work_activity: Some(true),
            desktop_notifications_enabled: Some(true),
            stream_assistant_responses: Some(false),
            multi_agent_nudge_enabled: Some(true),
            multi_agent_nudge_max_subagents: Some(6),
            notification_sounds: Some(NotificationSoundSettingsPatch {
                attention: Some(super::NotificationSoundChannelSettingsPatch {
                    enabled: Some(true),
                    sound: Some(NotificationSoundId::Chord),
                }),
                completion: Some(super::NotificationSoundChannelSettingsPatch {
                    enabled: Some(true),
                    sound: Some(NotificationSoundId::Glass),
                }),
            }),
            shortcuts: Some(ShortcutSettingsPatch {
                toggle_terminal: Some(Some("mod+shift+j".to_string())),
                ..ShortcutSettingsPatch::default()
            }),
            open_targets: Some(vec![OpenTarget {
                id: "zed".to_string(),
                label: "Zed".to_string(),
                kind: OpenTargetKind::App,
                app_name: Some("Zed".to_string()),
                args: Vec::new(),
            }]),
            default_open_target_id: Some("zed".to_string()),
            codex_binary_path: Some(Some("/opt/homebrew/bin/codex".to_string())),
            claude_binary_path: None,
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
        assert_eq!(settings.default_service_tier, Some(ServiceTier::Fast));
        assert_eq!(
            settings.default_draft_environment,
            DefaultDraftEnvironment::NewWorktree
        );
        assert!(settings.collapse_work_activity);
        assert!(settings.desktop_notifications_enabled);
        assert!(!settings.stream_assistant_responses);
        assert!(settings.multi_agent_nudge_enabled);
        assert_eq!(settings.multi_agent_nudge_max_subagents, 6);
        assert!(settings.notification_sounds.attention.enabled);
        assert_eq!(
            settings.notification_sounds.attention.sound,
            NotificationSoundId::Chord
        );
        assert!(settings.notification_sounds.completion.enabled);
        assert_eq!(
            settings.notification_sounds.completion.sound,
            NotificationSoundId::Glass
        );
        assert_eq!(
            settings.shortcuts.toggle_terminal.as_deref(),
            Some("mod+shift+j")
        );
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
    fn apply_patch_can_clear_optional_service_tier() {
        let mut settings = GlobalSettings {
            default_service_tier: Some(ServiceTier::Fast),
            ..GlobalSettings::default()
        };

        settings.apply_patch(GlobalSettingsPatch {
            default_service_tier: Some(None),
            ..GlobalSettingsPatch::default()
        });

        assert_eq!(settings.default_service_tier, None);
    }

    #[test]
    fn deserializes_null_service_tier_patch_as_explicit_clear() {
        let patch: GlobalSettingsPatch = serde_json::from_str(r#"{"defaultServiceTier":null}"#)
            .expect("service tier patch should deserialize");

        assert_eq!(patch.default_service_tier, Some(None));
    }

    #[test]
    fn deserializes_missing_draft_environment_as_local() {
        let settings: GlobalSettings = serde_json::from_str(
            r#"{
                "defaultProvider":"codex",
                "defaultModel":"gpt-5.4",
                "defaultReasoningEffort":"high",
                "defaultCollaborationMode":"build",
                "defaultApprovalPolicy":"askToEdit",
                "defaultServiceTier":null
            }"#,
        )
        .expect("legacy settings should deserialize");

        assert_eq!(
            settings.default_draft_environment,
            DefaultDraftEnvironment::Local
        );
    }

    #[test]
    fn deserializes_auto_review_approval_policy() {
        let settings: GlobalSettings = serde_json::from_str(
            r#"{
                "defaultProvider":"codex",
                "defaultModel":"gpt-5.4",
                "defaultReasoningEffort":"high",
                "defaultCollaborationMode":"build",
                "defaultApprovalPolicy":"autoReview",
                "defaultServiceTier":null
            }"#,
        )
        .expect("auto review settings should deserialize");

        assert_eq!(settings.default_approval_policy, ApprovalPolicy::AutoReview);
    }

    #[test]
    fn deserializes_null_codex_binary_path_patch_as_explicit_clear() {
        let patch: GlobalSettingsPatch = serde_json::from_str(r#"{"codexBinaryPath":null}"#)
            .expect("codex binary path patch should deserialize");

        assert_eq!(patch.codex_binary_path, Some(None));
    }

    #[test]
    fn default_settings_enable_collapsed_work_activity_and_shortcuts() {
        let settings = GlobalSettings::default();

        assert!(settings.collapse_work_activity);
        assert!(!settings.desktop_notifications_enabled);
        assert!(settings.stream_assistant_responses);
        assert!(!settings.multi_agent_nudge_enabled);
        assert_eq!(settings.multi_agent_nudge_max_subagents, 4);
        assert_eq!(
            settings.notification_sounds.attention.sound,
            NotificationSoundId::Glass
        );
        assert_eq!(
            settings.notification_sounds.completion.sound,
            NotificationSoundId::Polite
        );
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
                "defaultServiceTier":"fast",
                "codexBinaryPath":"/opt/homebrew/bin/codex"
            }"#,
        )
        .expect("legacy settings should deserialize");

        assert!(settings.collapse_work_activity);
        assert!(!settings.desktop_notifications_enabled);
        assert!(settings.stream_assistant_responses);
        assert!(!settings.multi_agent_nudge_enabled);
        assert_eq!(settings.multi_agent_nudge_max_subagents, 4);
        assert!(!settings.notification_sounds.attention.enabled);
        assert_eq!(
            settings.notification_sounds.attention.sound,
            NotificationSoundId::Glass
        );
        assert!(!settings.notification_sounds.completion.enabled);
        assert_eq!(
            settings.notification_sounds.completion.sound,
            NotificationSoundId::Polite
        );
        assert_eq!(
            settings.shortcuts.open_settings.as_deref(),
            Some("mod+comma")
        );
        assert!(!settings.open_targets.is_empty());
        assert!(settings
            .open_targets
            .iter()
            .any(|target| target.id == settings.default_open_target_id));
        assert_eq!(settings.default_service_tier, Some(ServiceTier::Fast));
    }

    #[test]
    fn deserialize_notification_sounds_repairs_partial_channels() {
        let settings: GlobalSettings = serde_json::from_str(
            r#"{
                "defaultModel":"gpt-5.4",
                "defaultReasoningEffort":"high",
                "defaultCollaborationMode":"build",
                "defaultApprovalPolicy":"askToEdit",
                "notificationSounds":{
                    "attention":{"enabled":true},
                    "completion":{"sound":"chord"}
                }
            }"#,
        )
        .expect("partial notification sound payload should deserialize");

        assert!(settings.notification_sounds.attention.enabled);
        assert_eq!(
            settings.notification_sounds.attention.sound,
            NotificationSoundId::Glass
        );
        assert!(!settings.notification_sounds.completion.enabled);
        assert_eq!(
            settings.notification_sounds.completion.sound,
            NotificationSoundId::Chord
        );
    }

    #[test]
    fn deserialize_notification_sounds_repairs_unknown_sound_ids() {
        let settings: GlobalSettings = serde_json::from_str(
            r#"{
                "defaultModel":"gpt-5.4",
                "defaultReasoningEffort":"high",
                "defaultCollaborationMode":"build",
                "defaultApprovalPolicy":"askToEdit",
                "notificationSounds":{
                    "attention":{"enabled":true,"sound":"future-bell"},
                    "completion":{"enabled":true,"sound":"future-chime"}
                }
            }"#,
        )
        .expect("unknown notification sound ids should deserialize");

        assert!(settings.notification_sounds.attention.enabled);
        assert_eq!(
            settings.notification_sounds.attention.sound,
            NotificationSoundId::Glass
        );
        assert!(settings.notification_sounds.completion.enabled);
        assert_eq!(
            settings.notification_sounds.completion.sound,
            NotificationSoundId::Polite
        );
    }

    #[test]
    fn validate_uses_shortcut_rules() {
        let mut settings = GlobalSettings::default();
        settings.shortcuts.toggle_terminal = Some("j".to_string());

        assert_eq!(
            settings
                .validate()
                .expect_err("invalid shortcuts should fail"),
            "Toggle terminal: Shortcut needs a primary modifier unless it is Shift+Tab."
        );
    }

    #[test]
    fn validate_rejects_out_of_range_multi_agent_nudge_limit() {
        let settings = GlobalSettings {
            multi_agent_nudge_max_subagents: 0,
            ..GlobalSettings::default()
        };

        assert_eq!(
            settings
                .validate()
                .expect_err("out-of-range nudge limit should fail"),
            "Multi-agent max subagents must be between 1 and 6."
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
                    args: vec![" --reuse-window ".to_string(), "".to_string()],
                },
                OpenTarget {
                    id: " file-manager ".to_string(),
                    label: " Finder ".to_string(),
                    kind: OpenTargetKind::FileManager,
                    app_name: Some("should-clear".to_string()),
                    args: vec!["should-clear".to_string()],
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
        assert!(settings.open_targets[0].args.is_empty());
        assert_eq!(settings.open_targets[1].label, "Finder");
        assert_eq!(settings.open_targets[1].app_name, None);
        assert!(settings.open_targets[1].args.is_empty());
        assert_eq!(settings.default_open_target_id, "file-manager");
    }

    #[test]
    fn normalize_for_update_rejects_legacy_command_targets() {
        let mut settings = GlobalSettings {
            open_targets: vec![OpenTarget {
                id: "broken".to_string(),
                label: "Broken".to_string(),
                kind: OpenTargetKind::Command,
                app_name: None,
                args: Vec::new(),
            }],
            ..GlobalSettings::default()
        };
        let original_targets = settings.open_targets.clone();
        let original_default_target_id = settings.default_open_target_id.clone();

        assert_eq!(
            settings
                .normalize_for_update()
                .expect_err("legacy command target should fail"),
            "Open target 1: Command-based Open In targets are no longer supported."
        );
        assert_eq!(settings.open_targets, original_targets);
        assert_eq!(settings.default_open_target_id, original_default_target_id);
    }

    #[test]
    fn normalize_for_read_repairs_invalid_stored_targets() {
        let mut settings = GlobalSettings {
            open_targets: Vec::new(),
            default_open_target_id: "missing".to_string(),
            ..GlobalSettings::default()
        };

        assert!(settings.normalize_for_read());
        assert!(!settings.open_targets.is_empty());
        assert!(settings
            .open_targets
            .iter()
            .any(|target| target.id == settings.default_open_target_id));
    }

    #[test]
    fn normalize_for_read_repairs_invalid_multi_agent_nudge_limit() {
        let mut settings = GlobalSettings {
            multi_agent_nudge_enabled: true,
            multi_agent_nudge_max_subagents: 9,
            ..GlobalSettings::default()
        };

        assert!(settings.normalize_for_read());
        assert!(settings.multi_agent_nudge_enabled);
        assert_eq!(settings.multi_agent_nudge_max_subagents, 4);
    }

    #[test]
    fn projected_for_client_hides_legacy_targets_without_mutating_storage() {
        let settings = GlobalSettings {
            open_targets: vec![
                OpenTarget {
                    id: "cursor".to_string(),
                    label: "Cursor".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Malicious Cursor".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor-cli".to_string(),
                    label: "Cursor CLI".to_string(),
                    kind: OpenTargetKind::Command,
                    app_name: None,
                    args: vec!["--reuse-window".to_string()],
                },
            ],
            default_open_target_id: "cursor-cli".to_string(),
            ..GlobalSettings::default()
        };

        let projected = settings.projected_for_client();

        assert_eq!(projected.open_targets.len(), 1);
        assert_eq!(projected.open_targets[0].id, "cursor");
        assert_eq!(
            projected.open_targets[0].app_name.as_deref(),
            Some("Cursor")
        );
        assert!(projected.open_targets[0].args.is_empty());
        assert_eq!(projected.default_open_target_id, "cursor");

        assert_eq!(settings.open_targets.len(), 2);
        assert_eq!(
            settings.open_targets[0].app_name.as_deref(),
            Some("Malicious Cursor")
        );
        assert_eq!(settings.open_targets[1].id, "cursor-cli");
        assert_eq!(settings.default_open_target_id, "cursor-cli");
    }

    #[test]
    fn normalize_for_update_rejects_unknown_targets() {
        let mut settings = GlobalSettings {
            open_targets: vec![OpenTarget {
                id: "custom-app".to_string(),
                label: "Custom App".to_string(),
                kind: OpenTargetKind::App,
                app_name: Some("Custom App".to_string()),
                args: vec!["--anything".to_string()],
            }],
            ..GlobalSettings::default()
        };

        assert_eq!(
            settings
                .normalize_for_update()
                .expect_err("unknown target should fail"),
            "Open target 1: Unknown Open In target: custom-app"
        );
    }

    #[test]
    fn projected_for_client_hides_deprecated_seeded_targets() {
        let settings = GlobalSettings {
            open_targets: vec![
                OpenTarget::app("cursor", "Cursor", "Cursor"),
                OpenTarget::app(
                    "vscode-insiders",
                    "VS Code Insiders",
                    "Visual Studio Code - Insiders",
                ),
                OpenTarget::app("vscodium", "VSCodium", "VSCodium"),
                OpenTarget::app("trae", "Trae", "Trae"),
                OpenTarget::file_manager("file-manager", "Finder"),
            ],
            default_open_target_id: "vscode-insiders".to_string(),
            ..GlobalSettings::default()
        };

        let projected = settings.projected_for_client();
        assert_eq!(
            projected
                .open_targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cursor", "file-manager"]
        );
        assert_eq!(projected.default_open_target_id, "file-manager");
        assert_eq!(settings.default_open_target_id, "vscode-insiders");
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_defaults_prefer_finder_for_the_primary_open_action() {
        let settings = GlobalSettings::default();

        assert_eq!(settings.default_open_target_id, "file-manager");
        assert_eq!(
            settings
                .open_targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "cursor",
                "vscode",
                "zed",
                "idea",
                "antigravity",
                "ghostty",
                "iterm2",
                "terminal",
                "file-manager",
            ]
        );
        assert!(settings
            .open_targets
            .iter()
            .any(|target| target.kind == OpenTargetKind::FileManager));
    }
}
