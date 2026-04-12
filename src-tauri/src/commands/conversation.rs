use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tracing::warn;

use crate::app_identity::{FIRST_PROMPT_RENAME_FAILURE_EVENT_NAME, WORKSPACE_EVENT_NAME};
use crate::domain::conversation::{
    ComposerFileSearchResult, ComposerMentionBindingInput, ConversationComposerDraft,
    ConversationComposerSettings, ConversationImageAttachment, RespondToApprovalRequestInput,
    RespondToUserInputRequestInput, SubmitPlanDecisionInput, ThreadComposerCatalog,
    ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::domain::workspace::{WorkspaceEvent, WorkspaceEventKind};
use crate::error::{AppError, CommandError};
use crate::services::workspace::{AutoRenameFirstPromptRequest, WorkspaceService};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendThreadMessageInput {
    pub thread_id: String,
    pub text: String,
    pub composer: Option<ConversationComposerSettings>,
    pub images: Option<Vec<ConversationImageAttachment>>,
    pub mention_bindings: Option<Vec<ComposerMentionBindingInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchThreadFilesInput {
    pub thread_id: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistThreadComposerDraftInput {
    pub thread_id: String,
    pub draft: Option<ConversationComposerDraft>,
}

#[tauri::command]
pub async fn open_thread_conversation(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<ThreadConversationOpenResponse, CommandError> {
    let context = state.workspace.thread_runtime_context(&thread_id)?;
    let composer_draft = state.workspace.thread_composer_draft(&thread_id)?;
    let mut response = state.runtime.open_thread(context).await?;
    response.composer_draft = composer_draft;
    Ok(response)
}

#[tauri::command]
pub fn save_thread_composer_draft(
    input: PersistThreadComposerDraftInput,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    validate_non_blank_thread_id(&input.thread_id)?;
    validate_thread_composer_draft(input.draft.as_ref())?;
    state
        .workspace
        .persist_thread_composer_draft(&input.thread_id, input.draft.as_ref())?;
    Ok(())
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ThreadConversationSnapshot, CommandError> {
    let mut context = state.workspace.thread_runtime_context(&input.thread_id)?;
    let should_auto_rename = state.workspace.thread_needs_auto_title(&input.thread_id)?;
    let requested_composer = input.composer.clone();
    let message_text = input.text;
    if let Some(composer) = requested_composer.clone() {
        context.composer = composer;
    }
    let rename_result = if !message_text.trim().is_empty() {
        let workspace = state.workspace.clone();
        let rename_request = AutoRenameFirstPromptRequest {
            thread_id: input.thread_id.clone(),
            message: message_text.clone(),
            codex_binary_path: context.codex_binary_path.clone(),
        };
        match spawn_blocking(move || {
            workspace.maybe_auto_rename_first_prompt_environment(rename_request)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let message = error.message.clone();
                let thread_id = input.thread_id.clone();
                warn!(
                    thread_id,
                    "failed to auto-rename first prompt environment: {message}"
                );
                emit_first_prompt_rename_failure_event(&app, &state.workspace, &thread_id, message);
                None
            }
        }
    } else {
        None
    };

    if let Some(rename) = rename_result.as_ref() {
        if rename.environment_renamed {
            state.pull_requests.clear_snapshot(&rename.environment_id);
            emit_workspace_event(
                &app,
                WorkspaceEvent {
                    kind: WorkspaceEventKind::EnvironmentRenamed,
                    project_id: Some(rename.project_id.clone()),
                    environment_id: Some(rename.environment_id.clone()),
                    thread_id: Some(rename.thread_id.clone()),
                },
            );
            state.pull_requests.refresh_now();
            if let Err(error) = state.runtime.stop(&rename.environment_id).await {
                warn!(
                    environment_id = rename.environment_id,
                    "failed to stop runtime after first prompt rename: {error}"
                );
            }
            context = state.workspace.thread_runtime_context(&input.thread_id)?;
            if let Some(composer) = requested_composer.clone() {
                context.composer = composer;
            }
        }
        if rename.thread_renamed && !rename.environment_renamed {
            emit_workspace_event(
                &app,
                WorkspaceEvent {
                    kind: WorkspaceEventKind::ThreadAutoRenamed,
                    project_id: Some(rename.project_id.clone()),
                    environment_id: Some(rename.environment_id.clone()),
                    thread_id: Some(rename.thread_id.clone()),
                },
            );
        }
    }

    let result = state
        .runtime
        .send_thread_message(
            context,
            message_text.clone(),
            input.images.unwrap_or_default(),
            input.mention_bindings.unwrap_or_default(),
        )
        .await?;

    if should_auto_rename
        && !rename_result
            .as_ref()
            .is_some_and(|rename| rename.thread_renamed)
        && state
            .workspace
            .auto_rename_thread_from_message(&input.thread_id, &message_text)?
            .is_some()
    {
        emit_workspace_event(
            &app,
            WorkspaceEvent {
                kind: WorkspaceEventKind::ThreadAutoRenamed,
                project_id: None,
                environment_id: Some(result.snapshot.environment_id.clone()),
                thread_id: Some(input.thread_id.clone()),
            },
        );
    }
    if let Some(codex_thread_id) = result.new_codex_thread_id {
        state
            .workspace
            .persist_codex_thread_id(&input.thread_id, &codex_thread_id)?;
    }
    state
        .workspace
        .persist_thread_composer_settings(&result.snapshot.thread_id, &result.snapshot.composer)?;
    if let Err(error) = state
        .workspace
        .clear_thread_composer_draft(&result.snapshot.thread_id)
    {
        warn!(
            thread_id = %result.snapshot.thread_id,
            "failed to clear persisted thread composer draft after successful send: {error}"
        );
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
    if let Err(error) = state
        .workspace
        .clear_thread_composer_draft(&result.snapshot.thread_id)
    {
        warn!(
            thread_id = %result.snapshot.thread_id,
            "failed to clear persisted thread composer draft after successful plan decision: {error}"
        );
    }

    Ok(result.snapshot)
}

fn validate_non_blank_thread_id(thread_id: &str) -> Result<(), CommandError> {
    if thread_id.trim().is_empty() {
        return Err(AppError::Validation("Thread id cannot be empty.".to_string()).into());
    }

    Ok(())
}

fn validate_thread_composer_draft(
    draft: Option<&ConversationComposerDraft>,
) -> Result<(), CommandError> {
    let Some(draft) = draft else {
        return Ok(());
    };

    for attachment in &draft.images {
        match attachment {
            ConversationImageAttachment::Image { url } if url.trim().is_empty() => {
                return Err(
                    AppError::Validation("Draft image URL cannot be empty.".to_string()).into(),
                );
            }
            ConversationImageAttachment::LocalImage { path } if path.trim().is_empty() => {
                return Err(
                    AppError::Validation("Draft image path cannot be empty.".to_string()).into(),
                );
            }
            _ => {}
        }
    }

    for binding in &draft.mention_bindings {
        if binding.mention.trim().is_empty() {
            return Err(
                AppError::Validation("Draft mention name cannot be empty.".to_string()).into(),
            );
        }
        if binding.path.trim().is_empty() {
            return Err(
                AppError::Validation("Draft mention path cannot be empty.".to_string()).into(),
            );
        }
        if binding.start >= binding.end {
            return Err(
                AppError::Validation(
                    "Draft mention binding ranges must have start before end.".to_string(),
                )
                .into(),
            );
        }
    }

    Ok(())
}

fn emit_workspace_event(app: &AppHandle, payload: WorkspaceEvent) {
    if let Err(error) = app.emit(WORKSPACE_EVENT_NAME, payload) {
        warn!("failed to emit workspace event: {error}");
    }
}

fn emit_first_prompt_rename_failure_event(
    app: &AppHandle,
    workspace: &WorkspaceService,
    thread_id: &str,
    message: String,
) {
    match workspace.first_prompt_rename_failure_event(thread_id, message) {
        Ok(payload) => {
            if let Err(error) = app.emit(FIRST_PROMPT_RENAME_FAILURE_EVENT_NAME, payload) {
                warn!("failed to emit first prompt rename failure event: {error}");
            }
        }
        Err(error) => {
            warn!(
                thread_id,
                "failed to build first prompt rename failure event: {error}"
            );
        }
    }
}

async fn spawn_blocking<T, F>(operation: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, crate::error::AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| CommandError::from(crate::error::AppError::Runtime(error.to_string())))?
        .map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use super::{validate_non_blank_thread_id, validate_thread_composer_draft};
    use crate::domain::conversation::{
        ComposerDraftMentionBinding, ComposerMentionBindingKind, ConversationComposerDraft,
        ConversationImageAttachment,
    };

    #[test]
    fn save_thread_composer_draft_rejects_blank_thread_ids() {
        let error = validate_non_blank_thread_id("   ").expect_err("blank thread id should fail");

        assert_eq!(error.code, "validation_error");
        assert!(error.message.contains("Thread id cannot be empty"));
    }

    #[test]
    fn save_thread_composer_draft_rejects_invalid_payloads() {
        let error = validate_thread_composer_draft(Some(&ConversationComposerDraft {
            text: "Review this".to_string(),
            images: vec![ConversationImageAttachment::LocalImage {
                path: "/tmp/screenshot.png".to_string(),
            }],
            mention_bindings: vec![ComposerDraftMentionBinding {
                mention: "github".to_string(),
                kind: ComposerMentionBindingKind::App,
                path: "app://github".to_string(),
                start: 8,
                end: 8,
            }],
            is_refining_plan: false,
        }))
        .expect_err("invalid draft should fail");

        assert_eq!(error.code, "validation_error");
        assert!(error.message.contains("start before end"));
    }
}
