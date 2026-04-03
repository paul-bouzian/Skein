use serde::Deserialize;
use tauri::State;

use crate::domain::conversation::{
    ConversationComposerSettings, ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::error::CommandError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendThreadMessageInput {
    pub thread_id: String,
    pub text: String,
    pub composer: Option<ConversationComposerSettings>,
}

#[tauri::command]
pub async fn open_thread_conversation(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<ThreadConversationOpenResponse, CommandError> {
    let context = state.workspace.thread_runtime_context(&thread_id)?;
    Ok(state.runtime.open_thread(context).await?)
}

#[tauri::command]
pub async fn send_thread_message(
    input: SendThreadMessageInput,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let mut context = state.workspace.thread_runtime_context(&input.thread_id)?;
    if let Some(composer) = input.composer.clone() {
        state
            .workspace
            .persist_thread_composer_settings(&input.thread_id, &composer)?;
        context.composer = composer;
    }
    let result = state
        .runtime
        .send_thread_message(context, input.text)
        .await?;

    if let Some(codex_thread_id) = result.new_codex_thread_id {
        state
            .workspace
            .persist_codex_thread_id(&input.thread_id, &codex_thread_id)?;
    }

    Ok(result.snapshot)
}

#[tauri::command]
pub async fn interrupt_thread_turn(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let context = state.workspace.thread_runtime_context(&thread_id)?;
    Ok(state.runtime.interrupt_thread(context).await?)
}
