use crate::domain::voice::{
    EnvironmentVoiceStatusSnapshot, TranscribeEnvironmentVoiceInput, VoiceTranscriptionResult,
};
use crate::error::CommandError;
use crate::state::AppState;

pub(crate) async fn get_environment_voice_status_impl(
    state: &AppState,
    environment_id: &str,
) -> Result<EnvironmentVoiceStatusSnapshot, CommandError> {
    Ok(state
        .voice
        .get_environment_voice_status(&state.workspace, &state.runtime, environment_id)
        .await?)
}

pub(crate) async fn transcribe_environment_voice_impl(
    state: &AppState,
    input: TranscribeEnvironmentVoiceInput,
) -> Result<VoiceTranscriptionResult, CommandError> {
    Ok(state
        .voice
        .transcribe_environment_voice(&state.workspace, &state.runtime, input)
        .await?)
}
