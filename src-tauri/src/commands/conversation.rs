use serde::Deserialize;
use tauri::State;

use crate::domain::conversation::{
    ComposerFileSearchResult, ComposerMentionBindingInput, ConversationComposerSettings,
    RespondToApprovalRequestInput, RespondToUserInputRequestInput, SubmitPlanDecisionInput,
    ThreadComposerCatalog, ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::error::CommandError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendThreadMessageInput {
    pub thread_id: String,
    pub text: String,
    pub composer: Option<ConversationComposerSettings>,
    pub mention_bindings: Option<Vec<ComposerMentionBindingInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchThreadFilesInput {
    pub thread_id: String,
    pub query: String,
    pub limit: Option<usize>,
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
pub async fn refresh_thread_conversation(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let context = state.workspace.thread_runtime_context(&thread_id)?;
    Ok(state.runtime.refresh_thread(context).await?)
}

#[tauri::command]
pub async fn get_thread_composer_catalog(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<ThreadComposerCatalog, CommandError> {
    let context = state.workspace.thread_runtime_context(&thread_id)?;
    Ok(state.runtime.get_thread_composer_catalog(context).await?)
}

#[tauri::command]
pub async fn search_thread_files(
    input: SearchThreadFilesInput,
    state: State<'_, AppState>,
) -> Result<Vec<ComposerFileSearchResult>, CommandError> {
    let context = state.workspace.thread_runtime_context(&input.thread_id)?;
    let limit = input.limit.unwrap_or(50).min(200);
    Ok(state
        .runtime
        .search_thread_files(context, input.query, limit)
        .await?)
}

#[tauri::command]
pub async fn send_thread_message(
    input: SendThreadMessageInput,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let mut context = state.workspace.thread_runtime_context(&input.thread_id)?;
    let should_auto_rename = state.workspace.thread_needs_auto_title(&input.thread_id)?;
    let message_text = input.text;
    if let Some(composer) = input.composer.clone() {
        context.composer = composer;
    }
    let result = state
        .runtime
        .send_thread_message(
            context,
            message_text.clone(),
            input.mention_bindings.unwrap_or_default(),
        )
        .await?;

    if should_auto_rename {
        state
            .workspace
            .auto_rename_thread_from_message(&input.thread_id, &message_text)?;
    }
    if let Some(codex_thread_id) = result.new_codex_thread_id {
        state
            .workspace
            .persist_codex_thread_id(&input.thread_id, &codex_thread_id)?;
    }
    state
        .workspace
        .persist_thread_composer_settings(&result.snapshot.thread_id, &result.snapshot.composer)?;

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

#[tauri::command]
pub async fn respond_to_approval_request(
    input: RespondToApprovalRequestInput,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let context = state.workspace.thread_runtime_context(&input.thread_id)?;
    Ok(state
        .runtime
        .respond_to_approval_request(context, &input.interaction_id, input.response)
        .await?)
}

#[tauri::command]
pub async fn respond_to_user_input_request(
    input: RespondToUserInputRequestInput,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let context = state.workspace.thread_runtime_context(&input.thread_id)?;
    Ok(state
        .runtime
        .respond_to_user_input_request(context, input)
        .await?)
}

#[tauri::command]
pub async fn submit_plan_decision(
    input: SubmitPlanDecisionInput,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let mut context = state.workspace.thread_runtime_context(&input.thread_id)?;
    if let Some(composer) = input.composer.clone() {
        context.composer = composer;
    }

    let result = state.runtime.submit_plan_decision(context, input).await?;

    if let Some(codex_thread_id) = result.new_codex_thread_id {
        state
            .workspace
            .persist_codex_thread_id(&result.snapshot.thread_id, &codex_thread_id)?;
    }
    state
        .workspace
        .persist_thread_composer_settings(&result.snapshot.thread_id, &result.snapshot.composer)?;

    Ok(result.snapshot)
}
