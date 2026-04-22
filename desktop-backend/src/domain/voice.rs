use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VoiceAuthMode {
    ApiKey,
    Chatgpt,
    ChatgptAuthTokens,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentVoiceUnavailableReason {
    ChatgptRequired,
    TokenMissing,
    RuntimeUnavailable,
    UnsupportedRuntime,
    PlatformUnsupported,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentVoiceStatusSnapshot {
    pub environment_id: String,
    pub available: bool,
    pub auth_mode: Option<VoiceAuthMode>,
    pub unavailable_reason: Option<EnvironmentVoiceUnavailableReason>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeEnvironmentVoiceInput {
    pub environment_id: String,
    pub mime_type: String,
    pub sample_rate_hz: u32,
    pub duration_ms: u32,
    pub audio_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptionResult {
    pub text: String,
}
