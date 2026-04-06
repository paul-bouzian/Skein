use base64::Engine;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, ORIGIN, REFERER, USER_AGENT};
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::Deserialize;
use std::time::Duration;

use crate::domain::voice::{
    EnvironmentVoiceStatusSnapshot, EnvironmentVoiceUnavailableReason,
    TranscribeEnvironmentVoiceInput, VoiceAuthMode, VoiceTranscriptionResult,
};
use crate::error::{AppError, AppResult};
use crate::runtime::protocol::{AccountReadAuthTypeWire, AccountReadResponse};
use crate::runtime::session::AppServerAuthStatus;
use crate::runtime::supervisor::RuntimeSupervisor;
use crate::services::workspace::WorkspaceService;

const CHATGPT_TRANSCRIPTIONS_URL: &str = "https://chatgpt.com/backend-api/transcribe";
const MAX_AUDIO_BYTES: usize = 10 * 1024 * 1024;
const MAX_DURATION_MS: u32 = 120_000;
const REQUIRED_SAMPLE_RATE_HZ: u32 = 24_000;
const REQUIRED_CHANNELS: u16 = 1;
const REQUIRED_BITS_PER_SAMPLE: u16 = 16;
const REQUIRED_AUDIO_FORMAT_PCM: u16 = 1;
const TRANSCRIPTION_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TRANSCRIPTION_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const CHATGPT_BROWSER_ACCEPT: &str = "application/json, text/plain, */*";
const CHATGPT_BROWSER_ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";
const CHATGPT_BROWSER_ORIGIN: &str = "https://chatgpt.com";
const CHATGPT_BROWSER_REFERER: &str = "https://chatgpt.com/";
const CHATGPT_BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const UNSUPPORTED_RUNTIME_MESSAGE: &str =
    "Voice transcription requires a Codex app-server build that exposes ChatGPT auth status. Update Codex and try again.";

#[derive(Debug, Clone)]
pub struct VoiceService {
    client: Client,
}

#[derive(Debug, Clone)]
struct TranscriptionAuthContext {
    token: String,
}

#[derive(Debug, Clone)]
struct ValidatedVoiceUpload {
    environment_id: String,
    mime_type: String,
    audio_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
enum TranscriptionFailure {
    Unauthorized(String),
    Provider(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTranscriptionPayload {
    text: Option<String>,
    transcript: Option<String>,
    message: Option<String>,
    error: Option<ProviderErrorPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderErrorPayload {
    message: Option<String>,
}

impl VoiceService {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(TRANSCRIPTION_CONNECT_TIMEOUT)
                .timeout(TRANSCRIPTION_REQUEST_TIMEOUT)
                .build()
                .expect("voice transcription client should build"),
        }
    }

    pub async fn get_environment_voice_status(
        &self,
        workspace: &WorkspaceService,
        runtime: &RuntimeSupervisor,
        environment_id: &str,
    ) -> AppResult<EnvironmentVoiceStatusSnapshot> {
        let (environment_path, codex_binary_path) =
            workspace.environment_runtime_target(environment_id)?;
        match runtime
            .read_auth_status(
                environment_id,
                &environment_path,
                codex_binary_path.clone(),
                false,
                false,
            )
            .await
        {
            Ok(status) => Ok(voice_status_snapshot_from_auth_status(
                environment_id,
                &status,
            )),
            Err(error) if is_get_auth_status_unavailable(&error) => {
                let account = runtime
                    .read_account(environment_id, &environment_path, codex_binary_path, false)
                    .await?;
                Ok(voice_status_snapshot_from_account(environment_id, &account))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn transcribe_environment_voice(
        &self,
        workspace: &WorkspaceService,
        runtime: &RuntimeSupervisor,
        input: TranscribeEnvironmentVoiceInput,
    ) -> AppResult<VoiceTranscriptionResult> {
        let upload = validate_transcription_input(input)?;
        let (environment_path, codex_binary_path) =
            workspace.environment_runtime_target(&upload.environment_id)?;

        let auth_context = self
            .load_auth_context(
                runtime,
                &upload.environment_id,
                &environment_path,
                codex_binary_path.clone(),
            )
            .await?;

        match self.request_transcription(&auth_context, &upload).await {
            Ok(text) => Ok(VoiceTranscriptionResult { text }),
            Err(TranscriptionFailure::Unauthorized(_)) => {
                let refreshed_auth_context = self
                    .load_auth_context(
                        runtime,
                        &upload.environment_id,
                        &environment_path,
                        codex_binary_path,
                    )
                    .await?;
                self.request_transcription(&refreshed_auth_context, &upload)
                    .await
                    .map(|text| VoiceTranscriptionResult { text })
                    .map_err(transcription_failure_to_error)
            }
            Err(error) => Err(transcription_failure_to_error(error)),
        }
    }

    async fn load_auth_context(
        &self,
        runtime: &RuntimeSupervisor,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<TranscriptionAuthContext> {
        // ChatGPT-authenticated Codex builds reject `thread/realtime/*` with
        // "realtime conversation requires API key auth", so dictation only
        // requests a ChatGPT bearer token at transcription time.
        let auth_status = match runtime
            .read_auth_status(
                environment_id,
                environment_path,
                codex_binary_path.clone(),
                true,
                true,
            )
            .await
        {
            Ok(status) => status,
            Err(error) if is_get_auth_status_unavailable(&error) => {
                let account = runtime
                    .read_account(environment_id, environment_path, codex_binary_path, true)
                    .await?;
                return Err(transcription_unsupported_error_from_account(account));
            }
            Err(error) => return Err(error),
        };
        resolve_transcription_auth(auth_status)
    }

    async fn request_transcription(
        &self,
        auth_context: &TranscriptionAuthContext,
        upload: &ValidatedVoiceUpload,
    ) -> Result<String, TranscriptionFailure> {
        let part = Part::bytes(upload.audio_bytes.clone())
            .file_name("voice.wav")
            .mime_str(&upload.mime_type)
            .map_err(|error| TranscriptionFailure::Provider(error.to_string()))?;
        let form = Form::new().part("file", part);

        let response = transcription_request(&self.client, &auth_context.token)
            .multipart(form)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    return TranscriptionFailure::Provider(
                        "Voice transcription timed out. Try a shorter recording or try again."
                            .to_string(),
                    );
                }
                TranscriptionFailure::Provider(error.to_string())
            })?;

        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            let message = provider_error_message(response).await.unwrap_or_else(|| {
                "Your ChatGPT session has expired. Sign in again before using voice transcription."
                    .to_string()
            });
            return Err(TranscriptionFailure::Unauthorized(message));
        }

        if !response.status().is_success() {
            let message = provider_error_message(response).await.unwrap_or_else(|| {
                "Voice transcription failed while processing the recorded audio.".to_string()
            });
            return Err(TranscriptionFailure::Provider(message));
        }

        let payload = response
            .json::<ProviderTranscriptionPayload>()
            .await
            .map_err(|error| TranscriptionFailure::Provider(error.to_string()))?;
        read_provider_text(payload).ok_or_else(|| {
            TranscriptionFailure::Provider(
                "No speech was detected in the recording. Try again and speak a bit closer to the microphone."
                    .to_string(),
            )
        })
    }
}

fn transcription_request(client: &Client, token: &str) -> RequestBuilder {
    client
        .post(CHATGPT_TRANSCRIPTIONS_URL)
        .header(ACCEPT, CHATGPT_BROWSER_ACCEPT)
        .header(ACCEPT_LANGUAGE, CHATGPT_BROWSER_ACCEPT_LANGUAGE)
        .header(ORIGIN, CHATGPT_BROWSER_ORIGIN)
        .header(REFERER, CHATGPT_BROWSER_REFERER)
        .header(USER_AGENT, CHATGPT_BROWSER_USER_AGENT)
        .bearer_auth(token)
}

async fn provider_error_message(response: reqwest::Response) -> Option<String> {
    response
        .json::<ProviderTranscriptionPayload>()
        .await
        .ok()
        .and_then(|payload| {
            payload
                .error
                .and_then(|error| read_non_empty_text(error.message))
                .or_else(|| read_non_empty_text(payload.message))
        })
}

fn read_provider_text(payload: ProviderTranscriptionPayload) -> Option<String> {
    read_non_empty_text(payload.text).or_else(|| read_non_empty_text(payload.transcript))
}

fn resolve_transcription_auth(
    auth_status: AppServerAuthStatus,
) -> AppResult<TranscriptionAuthContext> {
    let auth_mode = auth_status.auth_method;
    let token = read_non_empty_text(auth_status.auth_token);
    let is_chatgpt = matches!(
        auth_mode,
        Some(VoiceAuthMode::Chatgpt | VoiceAuthMode::ChatgptAuthTokens)
    );

    if !is_chatgpt {
        return Err(AppError::Validation(
            "Voice transcription requires Sign in with ChatGPT. API-key auth is not supported."
                .to_string(),
        ));
    }

    let token = token.ok_or_else(|| {
        AppError::Validation("Sign in with ChatGPT before using voice transcription.".to_string())
    })?;

    Ok(TranscriptionAuthContext { token })
}

fn voice_status_snapshot_from_auth_status(
    environment_id: &str,
    auth_status: &AppServerAuthStatus,
) -> EnvironmentVoiceStatusSnapshot {
    let auth_mode = auth_status.auth_method;
    let is_chatgpt = matches!(
        auth_mode,
        Some(VoiceAuthMode::Chatgpt | VoiceAuthMode::ChatgptAuthTokens)
    );
    let requires_openai_auth = auth_status.requires_openai_auth.unwrap_or(false);

    if is_chatgpt && !requires_openai_auth {
        return EnvironmentVoiceStatusSnapshot {
            environment_id: environment_id.to_string(),
            available: true,
            auth_mode,
            unavailable_reason: None,
            message: None,
        };
    }

    let (unavailable_reason, message) = match auth_mode {
        Some(VoiceAuthMode::ApiKey) => (
            EnvironmentVoiceUnavailableReason::ChatgptRequired,
            "Voice transcription requires Sign in with ChatGPT. API-key auth is not supported.",
        ),
        Some(VoiceAuthMode::Chatgpt | VoiceAuthMode::ChatgptAuthTokens) => (
            EnvironmentVoiceUnavailableReason::TokenMissing,
            "Sign in with ChatGPT before using voice transcription.",
        ),
        None if requires_openai_auth => (
            EnvironmentVoiceUnavailableReason::TokenMissing,
            "Sign in with ChatGPT before using voice transcription.",
        ),
        None => (
            EnvironmentVoiceUnavailableReason::Unknown,
            "Voice transcription is unavailable for this Codex runtime session.",
        ),
    };

    EnvironmentVoiceStatusSnapshot {
        environment_id: environment_id.to_string(),
        available: false,
        auth_mode,
        unavailable_reason: Some(unavailable_reason),
        message: Some(message.to_string()),
    }
}

fn voice_status_snapshot_from_account(
    environment_id: &str,
    account: &AccountReadResponse,
) -> EnvironmentVoiceStatusSnapshot {
    let auth_mode = account
        .account
        .as_ref()
        .and_then(|account| voice_auth_mode_from_account_type(account.auth_type));

    let (unavailable_reason, message) = match auth_mode {
        Some(VoiceAuthMode::ApiKey) => (
            EnvironmentVoiceUnavailableReason::ChatgptRequired,
            "Voice transcription requires Sign in with ChatGPT. API-key auth is not supported.",
        ),
        Some(VoiceAuthMode::Chatgpt) if account.requires_openai_auth => (
            EnvironmentVoiceUnavailableReason::TokenMissing,
            "Sign in with ChatGPT before using voice transcription.",
        ),
        Some(VoiceAuthMode::Chatgpt) => (
            EnvironmentVoiceUnavailableReason::UnsupportedRuntime,
            UNSUPPORTED_RUNTIME_MESSAGE,
        ),
        None if account.requires_openai_auth => (
            EnvironmentVoiceUnavailableReason::TokenMissing,
            "Sign in with ChatGPT before using voice transcription.",
        ),
        None => (
            EnvironmentVoiceUnavailableReason::Unknown,
            "Voice transcription is unavailable for this Codex runtime session.",
        ),
        Some(VoiceAuthMode::ChatgptAuthTokens) => (
            EnvironmentVoiceUnavailableReason::UnsupportedRuntime,
            UNSUPPORTED_RUNTIME_MESSAGE,
        ),
    };

    EnvironmentVoiceStatusSnapshot {
        environment_id: environment_id.to_string(),
        available: false,
        auth_mode,
        unavailable_reason: Some(unavailable_reason),
        message: Some(message.to_string()),
    }
}

fn voice_auth_mode_from_account_type(
    account_type: AccountReadAuthTypeWire,
) -> Option<VoiceAuthMode> {
    match account_type {
        AccountReadAuthTypeWire::ApiKey => Some(VoiceAuthMode::ApiKey),
        AccountReadAuthTypeWire::Chatgpt => Some(VoiceAuthMode::Chatgpt),
        AccountReadAuthTypeWire::Unknown => None,
    }
}

fn transcription_unsupported_error_from_account(account: AccountReadResponse) -> AppError {
    match account
        .account
        .as_ref()
        .and_then(|account| voice_auth_mode_from_account_type(account.auth_type))
    {
        Some(VoiceAuthMode::ApiKey) => AppError::Validation(
            "Voice transcription requires Sign in with ChatGPT. API-key auth is not supported."
                .to_string(),
        ),
        Some(VoiceAuthMode::Chatgpt) if account.requires_openai_auth => AppError::Validation(
            "Sign in with ChatGPT before using voice transcription.".to_string(),
        ),
        Some(VoiceAuthMode::Chatgpt) | Some(VoiceAuthMode::ChatgptAuthTokens) => {
            AppError::Runtime(UNSUPPORTED_RUNTIME_MESSAGE.to_string())
        }
        None if account.requires_openai_auth => AppError::Validation(
            "Sign in with ChatGPT before using voice transcription.".to_string(),
        ),
        None => AppError::Runtime(UNSUPPORTED_RUNTIME_MESSAGE.to_string()),
    }
}

fn is_get_auth_status_unavailable(error: &AppError) -> bool {
    let AppError::Runtime(message) = error else {
        return false;
    };

    message.contains("unknown variant `getAuthStatus`")
        || message.contains("unsupported method: getAuthStatus")
        || (message.contains("Method not found") && message.contains("getAuthStatus"))
}

fn transcription_failure_to_error(error: TranscriptionFailure) -> AppError {
    match error {
        TranscriptionFailure::Unauthorized(message) => AppError::Validation(message),
        TranscriptionFailure::Provider(message) => AppError::Runtime(message),
    }
}

fn validate_transcription_input(
    input: TranscribeEnvironmentVoiceInput,
) -> AppResult<ValidatedVoiceUpload> {
    let environment_id = input.environment_id.trim().to_string();
    if environment_id.is_empty() {
        return Err(AppError::Validation(
            "Environment id is required for voice transcription.".to_string(),
        ));
    }

    if input.mime_type.trim() != "audio/wav" {
        return Err(AppError::Validation(
            "Only WAV audio is supported for voice transcription.".to_string(),
        ));
    }

    if input.sample_rate_hz != REQUIRED_SAMPLE_RATE_HZ {
        return Err(AppError::Validation(
            "Voice transcription requires 24 kHz mono WAV audio.".to_string(),
        ));
    }

    if input.duration_ms == 0 {
        return Err(AppError::Validation(
            "Voice messages must include a positive duration.".to_string(),
        ));
    }

    if input.duration_ms > MAX_DURATION_MS {
        return Err(AppError::Validation(
            "Voice messages are limited to 2 minutes.".to_string(),
        ));
    }

    let audio_bytes = decode_audio_base64(&input.audio_base64)?;
    if audio_bytes.len() > MAX_AUDIO_BYTES {
        return Err(AppError::Validation(
            "Voice messages are limited to 10 MB.".to_string(),
        ));
    }
    validate_wav_buffer(&audio_bytes, input.sample_rate_hz)?;

    Ok(ValidatedVoiceUpload {
        environment_id,
        mime_type: input.mime_type,
        audio_bytes,
    })
}

fn decode_audio_base64(audio_base64: &str) -> AppResult<Vec<u8>> {
    let normalized_len = audio_base64
        .chars()
        .filter(|character| !character.is_whitespace())
        .count();
    if normalized_len == 0 {
        return Err(AppError::Validation(
            "The voice request did not include any audio.".to_string(),
        ));
    }
    if estimated_decoded_base64_len(normalized_len)? > MAX_AUDIO_BYTES {
        return Err(AppError::Validation(
            "Voice messages are limited to 10 MB.".to_string(),
        ));
    }

    let mut normalized = String::with_capacity(normalized_len);
    for character in audio_base64.chars() {
        if !character.is_whitespace() {
            normalized.push(character);
        }
    }

    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(normalized)
        .map_err(|_| {
            AppError::Validation("The recorded audio could not be decoded.".to_string())
        })?;
    if audio_bytes.is_empty() {
        return Err(AppError::Validation(
            "The recorded audio could not be decoded.".to_string(),
        ));
    }

    Ok(audio_bytes)
}

fn estimated_decoded_base64_len(normalized_len: usize) -> AppResult<usize> {
    normalized_len
        .div_ceil(4)
        .checked_mul(3)
        .ok_or_else(|| AppError::Validation("Voice messages are limited to 10 MB.".to_string()))
}

fn validate_wav_buffer(audio_bytes: &[u8], expected_sample_rate_hz: u32) -> AppResult<()> {
    if audio_bytes.len() < 44 {
        return Err(AppError::Validation(
            "The recorded audio is not a valid WAV file.".to_string(),
        ));
    }

    if &audio_bytes[0..4] != b"RIFF" || &audio_bytes[8..12] != b"WAVE" {
        return Err(AppError::Validation(
            "The recorded audio is not a valid WAV file.".to_string(),
        ));
    }

    if &audio_bytes[12..16] != b"fmt " || &audio_bytes[36..40] != b"data" {
        return Err(AppError::Validation(
            "The recorded audio is not a valid WAV file.".to_string(),
        ));
    }

    let audio_format = read_u16_le(audio_bytes, 20)?;
    let channels = read_u16_le(audio_bytes, 22)?;
    let sample_rate_hz = read_u32_le(audio_bytes, 24)?;
    let bits_per_sample = read_u16_le(audio_bytes, 34)?;
    let data_size = read_u32_le(audio_bytes, 40)? as usize;

    if audio_format != REQUIRED_AUDIO_FORMAT_PCM
        || channels != REQUIRED_CHANNELS
        || sample_rate_hz != expected_sample_rate_hz
        || bits_per_sample != REQUIRED_BITS_PER_SAMPLE
    {
        return Err(AppError::Validation(
            "Voice transcription requires 24 kHz mono 16-bit PCM WAV audio.".to_string(),
        ));
    }

    let expected_total_size = 44usize.checked_add(data_size).ok_or_else(|| {
        AppError::Validation("The recorded audio is not a valid WAV file.".to_string())
    })?;
    if expected_total_size != audio_bytes.len() {
        return Err(AppError::Validation(
            "The recorded audio is not a valid WAV file.".to_string(),
        ));
    }

    if wav_duration_ms(data_size, channels, bits_per_sample, sample_rate_hz)? > MAX_DURATION_MS {
        return Err(AppError::Validation(
            "Voice messages are limited to 2 minutes.".to_string(),
        ));
    }

    Ok(())
}

fn read_u16_le(audio_bytes: &[u8], offset: usize) -> AppResult<u16> {
    let bytes = audio_bytes.get(offset..offset + 2).ok_or_else(|| {
        AppError::Validation("The recorded audio is not a valid WAV file.".to_string())
    })?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32_le(audio_bytes: &[u8], offset: usize) -> AppResult<u32> {
    let bytes = audio_bytes.get(offset..offset + 4).ok_or_else(|| {
        AppError::Validation("The recorded audio is not a valid WAV file.".to_string())
    })?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_non_empty_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn wav_duration_ms(
    data_size: usize,
    channels: u16,
    bits_per_sample: u16,
    sample_rate_hz: u32,
) -> AppResult<u32> {
    let bytes_per_frame = usize::from(channels)
        .checked_mul(usize::from(bits_per_sample / 8))
        .ok_or_else(|| {
            AppError::Validation("The recorded audio is not a valid WAV file.".to_string())
        })?;
    if bytes_per_frame == 0 || sample_rate_hz == 0 || !data_size.is_multiple_of(bytes_per_frame) {
        return Err(AppError::Validation(
            "The recorded audio is not a valid WAV file.".to_string(),
        ));
    }

    let sample_count = data_size / bytes_per_frame;
    let duration_ms = (sample_count as u128)
        .checked_mul(1000)
        .and_then(|value| value.checked_div(u128::from(sample_rate_hz)))
        .ok_or_else(|| {
            AppError::Validation("The recorded audio is not a valid WAV file.".to_string())
        })?;

    u32::try_from(duration_ms).map_err(|_| {
        AppError::Validation("The recorded audio is not a valid WAV file.".to_string())
    })
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::{
        resolve_transcription_auth, transcription_request, validate_transcription_input,
        voice_status_snapshot_from_account, voice_status_snapshot_from_auth_status,
        AccountReadAuthTypeWire, AccountReadResponse, AppServerAuthStatus,
        EnvironmentVoiceUnavailableReason, TranscribeEnvironmentVoiceInput, VoiceAuthMode,
        CHATGPT_BROWSER_ACCEPT, CHATGPT_BROWSER_ACCEPT_LANGUAGE, CHATGPT_BROWSER_ORIGIN,
        CHATGPT_BROWSER_REFERER, CHATGPT_BROWSER_USER_AGENT, CHATGPT_TRANSCRIPTIONS_URL,
        MAX_AUDIO_BYTES,
    };
    use crate::error::AppError;
    use crate::runtime::protocol::AccountReadAccountWire;

    #[test]
    fn marks_chatgpt_status_without_token_as_available() {
        let snapshot = voice_status_snapshot_from_auth_status(
            "env-1",
            &AppServerAuthStatus {
                auth_method: Some(VoiceAuthMode::Chatgpt),
                auth_token: None,
                requires_openai_auth: Some(false),
            },
        );

        assert!(snapshot.available);
        assert_eq!(snapshot.auth_mode, Some(VoiceAuthMode::Chatgpt));
        assert_eq!(snapshot.unavailable_reason, None);
    }

    #[test]
    fn rejects_api_key_auth_for_transcription() {
        let error = resolve_transcription_auth(AppServerAuthStatus {
            auth_method: Some(VoiceAuthMode::ApiKey),
            auth_token: Some("sk-test".to_string()),
            requires_openai_auth: Some(false),
        })
        .unwrap_err();

        assert!(matches!(
            error,
            AppError::Validation(message)
                if message.contains("Sign in with ChatGPT")
        ));
    }

    #[test]
    fn validates_wav_upload_constraints() {
        let result = validate_transcription_input(TranscribeEnvironmentVoiceInput {
            environment_id: "env-1".to_string(),
            mime_type: "audio/wav".to_string(),
            sample_rate_hz: 24_000,
            duration_ms: 1_250,
            audio_base64: make_test_wav_base64(),
        })
        .expect("valid wav upload should parse");

        assert_eq!(result.environment_id, "env-1");
        assert_eq!(result.mime_type, "audio/wav");
        assert!(!result.audio_bytes.is_empty());
        assert_eq!(
            CHATGPT_TRANSCRIPTIONS_URL,
            "https://chatgpt.com/backend-api/transcribe"
        );
    }

    #[test]
    fn rejects_invalid_wav_uploads() {
        let error = validate_transcription_input(TranscribeEnvironmentVoiceInput {
            environment_id: "env-1".to_string(),
            mime_type: "audio/wav".to_string(),
            sample_rate_hz: 24_000,
            duration_ms: 500,
            audio_base64: base64::engine::general_purpose::STANDARD.encode("not-a-wav"),
        })
        .unwrap_err();

        assert!(matches!(
            error,
            AppError::Validation(message)
                if message.contains("valid WAV")
        ));
    }

    #[test]
    fn rejects_wav_uploads_longer_than_two_minutes() {
        let error = validate_transcription_input(TranscribeEnvironmentVoiceInput {
            environment_id: "env-1".to_string(),
            mime_type: "audio/wav".to_string(),
            sample_rate_hz: 24_000,
            duration_ms: 120_000,
            audio_base64: make_test_wav_base64_with_duration_ms(121_000),
        })
        .unwrap_err();

        assert!(matches!(
            error,
            AppError::Validation(message)
                if message.contains("2 minutes")
        ));
    }

    #[test]
    fn marks_missing_tokens_as_token_missing() {
        let snapshot = voice_status_snapshot_from_auth_status(
            "env-1",
            &AppServerAuthStatus {
                auth_method: Some(VoiceAuthMode::Chatgpt),
                auth_token: None,
                requires_openai_auth: Some(true),
            },
        );

        assert!(!snapshot.available);
        assert_eq!(
            snapshot.unavailable_reason,
            Some(EnvironmentVoiceUnavailableReason::TokenMissing)
        );
    }

    #[test]
    fn marks_account_fallback_as_unsupported_runtime_when_chatgpt_is_ready() {
        let snapshot = voice_status_snapshot_from_account(
            "env-1",
            &AccountReadResponse {
                account: Some(AccountReadAccountWire {
                    auth_type: AccountReadAuthTypeWire::Chatgpt,
                }),
                requires_openai_auth: false,
            },
        );

        assert!(!snapshot.available);
        assert_eq!(snapshot.auth_mode, Some(VoiceAuthMode::Chatgpt));
        assert_eq!(
            snapshot.unavailable_reason,
            Some(EnvironmentVoiceUnavailableReason::UnsupportedRuntime)
        );
    }

    #[test]
    fn rejects_base64_payloads_that_exceed_the_audio_limit_before_decoding() {
        let oversized_base64_len = (MAX_AUDIO_BYTES + 1).div_ceil(3) * 4;
        let error = validate_transcription_input(TranscribeEnvironmentVoiceInput {
            environment_id: "env-1".to_string(),
            mime_type: "audio/wav".to_string(),
            sample_rate_hz: 24_000,
            duration_ms: 500,
            audio_base64: "A".repeat(oversized_base64_len),
        })
        .unwrap_err();

        assert!(matches!(
            error,
            AppError::Validation(message) if message.contains("10 MB")
        ));
    }

    #[test]
    fn transcription_request_uses_browser_context_headers() {
        let request = transcription_request(&reqwest::Client::new(), "token-123")
            .build()
            .expect("request should build");

        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().as_str(), CHATGPT_TRANSCRIPTIONS_URL);
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::ACCEPT)
                .and_then(|value| value.to_str().ok()),
            Some(CHATGPT_BROWSER_ACCEPT)
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::ACCEPT_LANGUAGE)
                .and_then(|value| value.to_str().ok()),
            Some(CHATGPT_BROWSER_ACCEPT_LANGUAGE)
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::ORIGIN)
                .and_then(|value| value.to_str().ok()),
            Some(CHATGPT_BROWSER_ORIGIN)
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::REFERER)
                .and_then(|value| value.to_str().ok()),
            Some(CHATGPT_BROWSER_REFERER)
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some(CHATGPT_BROWSER_USER_AGENT)
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer token-123")
        );
    }

    fn make_test_wav_base64() -> String {
        make_test_wav_base64_with_duration_ms(1)
    }

    fn make_test_wav_base64_with_duration_ms(duration_ms: u32) -> String {
        let sample_count = ((duration_ms as u64) * 24_000).div_ceil(1000) as usize;
        let data_size = sample_count * 2;
        let mut wav = Vec::with_capacity(44 + 32);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + data_size) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&(16_u32).to_le_bytes());
        wav.extend_from_slice(&(1_u16).to_le_bytes());
        wav.extend_from_slice(&(1_u16).to_le_bytes());
        wav.extend_from_slice(&(24_000_u32).to_le_bytes());
        wav.extend_from_slice(&(48_000_u32).to_le_bytes());
        wav.extend_from_slice(&(2_u16).to_le_bytes());
        wav.extend_from_slice(&(16_u16).to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data_size as u32).to_le_bytes());
        wav.resize(44 + data_size, 0);
        base64::engine::general_purpose::STANDARD.encode(wav)
    }
}
