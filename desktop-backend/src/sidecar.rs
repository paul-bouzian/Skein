use std::path::PathBuf;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinSet;
use tracing::warn;

use crate::app_identity::prepare_storage_paths_for_host;
use crate::commands::{
    conversation::{
        self, PersistThreadComposerDraftInput, SearchComposerFilesInput, SendThreadMessageInput,
    },
    git_review::{
        self, CommitGitInput, GitFileDiffInput, GitFileInput, GitRevertFileInput, GitScopeInput,
    },
    system,
    terminal::{
        self, KillTerminalInput, ResizeTerminalInput, SpawnTerminalInput, WriteTerminalInput,
    },
    voice,
    workspace::{self, OpenEnvironmentInput, RunProjectActionInput, SaveDraftThreadStateInput},
};
use crate::domain::conversation::{
    ComposerTarget, RespondToApprovalRequestInput, RespondToUserInputRequestInput,
    SubmitPlanDecisionInput,
};
use crate::domain::settings::GlobalSettingsPatch;
use crate::domain::voice::TranscribeEnvironmentVoiceInput;
use crate::error::{AppError, CommandError};
use crate::events::{EmittedEvent, EventSink};
use crate::services::workspace::{
    AddProjectRequest, ArchiveThreadRequest, CreateChatThreadRequest, CreateManagedWorktreeRequest,
    CreateThreadRequest, RenameProjectRequest, RenameThreadRequest, ReorderProjectsRequest,
    SetProjectSidebarCollapsedRequest, UpdateProjectSettingsRequest,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct CliArgs {
    #[serde(rename = "appDataDir")]
    app_data_dir: PathBuf,
    #[serde(rename = "homeDir")]
    home_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarInboundMessage {
    Request {
        id: u64,
        method: String,
        params: Option<Value>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarOutboundMessage {
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<SidecarError>,
    },
    Event {
        name: String,
        payload: Value,
    },
}

#[derive(Debug, Serialize)]
struct SidecarError {
    message: String,
}

pub fn run() {
    crate::runtime::codex_paths::sync_process_path_from_login_shell();

    tracing_subscriber::fmt()
        .with_target(false)
        .with_writer(std::io::stderr)
        .compact()
        .init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("sidecar runtime should initialize");

    runtime.block_on(async {
        if let Err(error) = run_async().await {
            let _ = writeln_stderr(&error.to_string()).await;
            std::process::exit(1);
        }
    });
}

async fn run_async() -> Result<(), AppError> {
    let args = parse_cli_args()?;
    let storage_paths = prepare_storage_paths_for_host(args.app_data_dir, args.home_dir)?;
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<EmittedEvent>();
    let state = Arc::new(AppState::from_storage_paths(
        storage_paths,
        EventSink::channel(event_tx),
    )?);
    let idle_reaper_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(crate::runtime::supervisor::RUNTIME_IDLE_REAPER_INTERVAL).await;
            if let Err(error) = idle_reaper_state
                .runtime
                .evict_idle_runtimes(crate::runtime::supervisor::RUNTIME_IDLE_TIMEOUT)
                .await
            {
                warn!("failed to evict idle runtimes: {error}");
            }
        }
    });

    let stdout = Arc::new(Mutex::new(io::stdout()));
    let writer = stdout.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if let Err(error) = write_message(
                &writer,
                &SidecarOutboundMessage::Event {
                    name: event.name,
                    payload: event.payload,
                },
            )
            .await
            {
                warn!("failed to write sidecar event: {error}");
                break;
            }
        }
    });

    let mut request_tasks = JoinSet::new();
    let mut lines = BufReader::new(io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let message = line.trim();
        if message.is_empty() {
            continue;
        }

        let inbound = match serde_json::from_str::<SidecarInboundMessage>(message) {
            Ok(inbound) => inbound,
            Err(error) => {
                warn!("failed to decode sidecar request: {error}");
                continue;
            }
        };

        let SidecarInboundMessage::Request { id, method, params } = inbound;
        let state = state.clone();
        let stdout = stdout.clone();
        request_tasks.spawn(async move {
            let outbound = match dispatch_request(&state, &method, params).await {
                Ok(result) => SidecarOutboundMessage::Response {
                    id,
                    ok: true,
                    result: Some(result),
                    error: None,
                },
                Err(error) => SidecarOutboundMessage::Response {
                    id,
                    ok: false,
                    result: None,
                    error: Some(SidecarError {
                        message: error.message,
                    }),
                },
            };

            if let Err(error) = write_message(&stdout, &outbound).await {
                warn!(request_id = id, "failed to write sidecar response: {error}");
            }
        });

        while let Some(result) = request_tasks.try_join_next() {
            if let Err(error) = result {
                warn!("sidecar request task failed: {error}");
            }
        }
    }

    while let Some(result) = request_tasks.join_next().await {
        if let Err(error) = result {
            warn!("sidecar request task failed during shutdown: {error}");
        }
    }

    state.terminal.shutdown_all();
    Ok(())
}

async fn dispatch_request(
    state: &AppState,
    method: &str,
    params: Option<Value>,
) -> Result<Value, CommandError> {
    match method {
        "get_bootstrap_status" => encode_result(system::get_bootstrap_status_impl(state).await),
        "get_workspace_snapshot" => {
            encode_result(workspace::get_workspace_snapshot_impl(state).await)
        }
        "get_draft_thread_state" => {
            let payload: TargetEnvelope<crate::domain::workspace::DraftThreadTarget> =
                decode_params(params)?;
            encode_result(workspace::get_draft_thread_state_impl(
                payload.target,
                state,
            ))
        }
        "save_draft_thread_state" => {
            let payload: InputEnvelope<SaveDraftThreadStateInput> = decode_params(params)?;
            encode_result(workspace::save_draft_thread_state_impl(
                payload.input,
                state,
            ))
        }
        "get_shortcut_defaults" => encode_result(Ok(workspace::get_shortcut_defaults_impl())),
        "get_git_review_snapshot" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::get_git_review_snapshot_impl(state, payload.input).await)
        }
        "get_git_file_diff" => {
            let payload: InputEnvelope<GitFileDiffInput> = decode_params(params)?;
            encode_result(git_review::get_git_file_diff_impl(state, payload.input).await)
        }
        "stage_git_file" => {
            let payload: InputEnvelope<GitFileInput> = decode_params(params)?;
            encode_result(git_review::stage_git_file_impl(state, payload.input).await)
        }
        "stage_git_all" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::stage_git_all_impl(state, payload.input).await)
        }
        "unstage_git_file" => {
            let payload: InputEnvelope<GitFileInput> = decode_params(params)?;
            encode_result(git_review::unstage_git_file_impl(state, payload.input).await)
        }
        "unstage_git_all" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::unstage_git_all_impl(state, payload.input).await)
        }
        "revert_git_file" => {
            let payload: InputEnvelope<GitRevertFileInput> = decode_params(params)?;
            encode_result(git_review::revert_git_file_impl(state, payload.input).await)
        }
        "revert_git_all" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::revert_git_all_impl(state, payload.input).await)
        }
        "commit_git" => {
            let payload: InputEnvelope<CommitGitInput> = decode_params(params)?;
            encode_result(git_review::commit_git_impl(state, payload.input).await)
        }
        "fetch_git" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::fetch_git_impl(state, payload.input).await)
        }
        "pull_git" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::pull_git_impl(state, payload.input).await)
        }
        "push_git" => {
            let payload: InputEnvelope<GitScopeInput> = decode_params(params)?;
            encode_result(git_review::push_git_impl(state, payload.input).await)
        }
        "generate_git_commit_message" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                git_review::generate_git_commit_message_impl(state, &payload.environment_id).await,
            )
        }
        "open_thread_conversation" => {
            let payload: ThreadIdEnvelope = decode_params(params)?;
            encode_result(
                conversation::open_thread_conversation_impl(state, payload.thread_id).await,
            )
        }
        "save_thread_composer_draft" => {
            let payload: InputEnvelope<PersistThreadComposerDraftInput> = decode_params(params)?;
            encode_result(conversation::save_thread_composer_draft_impl(
                state,
                payload.input,
            ))
        }
        "refresh_thread_conversation" => {
            let payload: ThreadIdEnvelope = decode_params(params)?;
            encode_result(
                conversation::refresh_thread_conversation_impl(state, payload.thread_id).await,
            )
        }
        "get_composer_catalog" => {
            let payload: TargetEnvelope<ComposerTarget> = decode_params(params)?;
            encode_result(conversation::get_composer_catalog_impl(state, payload.target).await)
        }
        "search_composer_files" => {
            let payload: InputEnvelope<SearchComposerFilesInput> = decode_params(params)?;
            encode_result(conversation::search_composer_files_impl(state, payload.input).await)
        }
        "send_thread_message" => {
            let payload: InputEnvelope<SendThreadMessageInput> = decode_params(params)?;
            encode_result(conversation::send_thread_message_impl(state, payload.input).await)
        }
        "read_image_as_data_url" => {
            let payload: PathEnvelope = decode_params(params)?;
            encode_result(system::read_image_as_data_url_impl(&payload.path))
        }
        "interrupt_thread_turn" => {
            let payload: ThreadIdEnvelope = decode_params(params)?;
            encode_result(conversation::interrupt_thread_turn_impl(state, payload.thread_id).await)
        }
        "respond_to_approval_request" => {
            let payload: InputEnvelope<RespondToApprovalRequestInput> = decode_params(params)?;
            encode_result(
                conversation::respond_to_approval_request_impl(state, payload.input).await,
            )
        }
        "respond_to_user_input_request" => {
            let payload: InputEnvelope<RespondToUserInputRequestInput> = decode_params(params)?;
            encode_result(
                conversation::respond_to_user_input_request_impl(state, payload.input).await,
            )
        }
        "submit_plan_decision" => {
            let payload: InputEnvelope<SubmitPlanDecisionInput> = decode_params(params)?;
            encode_result(conversation::submit_plan_decision_impl(state, payload.input).await)
        }
        "get_environment_codex_rate_limits" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                workspace::get_environment_codex_rate_limits_impl(payload.environment_id, state)
                    .await,
            )
        }
        "get_environment_capabilities" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                workspace::get_environment_capabilities_impl(payload.environment_id, state).await,
            )
        }
        "get_environment_voice_status" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                voice::get_environment_voice_status_impl(state, &payload.environment_id).await,
            )
        }
        "transcribe_environment_voice" => {
            let payload: InputEnvelope<TranscribeEnvironmentVoiceInput> = decode_params(params)?;
            encode_result(voice::transcribe_environment_voice_impl(state, payload.input).await)
        }
        "update_global_settings" => {
            let payload: PatchEnvelope<GlobalSettingsPatch> = decode_params(params)?;
            encode_result(workspace::update_global_settings_impl(payload.patch, state))
        }
        "open_environment" => {
            let payload: InputEnvelope<OpenEnvironmentInput> = decode_params(params)?;
            encode_result(workspace::open_environment_impl(payload.input, state))
        }
        "add_project" => {
            let payload: InputEnvelope<AddProjectRequest> = decode_params(params)?;
            encode_result(workspace::add_project_impl(payload.input, state))
        }
        "rename_project" => {
            let payload: InputEnvelope<RenameProjectRequest> = decode_params(params)?;
            encode_result(workspace::rename_project_impl(payload.input, state))
        }
        "update_project_settings" => {
            let payload: InputEnvelope<UpdateProjectSettingsRequest> = decode_params(params)?;
            encode_result(workspace::update_project_settings_impl(
                payload.input,
                state,
            ))
        }
        "run_project_action" => {
            let payload: InputEnvelope<RunProjectActionInput> = decode_params(params)?;
            encode_result(workspace::run_project_action_impl(payload.input, state))
        }
        "reorder_projects" => {
            let payload: InputEnvelope<ReorderProjectsRequest> = decode_params(params)?;
            encode_result(workspace::reorder_projects_impl(payload.input, state))
        }
        "set_project_sidebar_collapsed" => {
            let payload: InputEnvelope<SetProjectSidebarCollapsedRequest> = decode_params(params)?;
            encode_result(workspace::set_project_sidebar_collapsed_impl(
                payload.input,
                state,
            ))
        }
        "ensure_project_can_be_removed" => {
            let payload: ProjectIdEnvelope = decode_params(params)?;
            encode_result(workspace::ensure_project_can_be_removed_impl(
                payload.project_id,
                state,
            ))
        }
        "remove_project" => {
            let payload: ProjectIdEnvelope = decode_params(params)?;
            encode_result(workspace::remove_project_impl(payload.project_id, state).await)
        }
        "create_managed_worktree" => {
            let payload: InputEnvelope<CreateManagedWorktreeRequest> = decode_params(params)?;
            encode_result(workspace::create_managed_worktree_impl(
                payload.input,
                state,
            ))
        }
        "list_project_branches" => {
            let payload: ProjectIdEnvelope = decode_params(params)?;
            encode_result(workspace::list_project_branches_impl(
                payload.project_id,
                state,
            ))
        }
        "delete_worktree_environment" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                workspace::delete_worktree_environment_impl(payload.environment_id, state).await,
            )
        }
        "create_thread" => {
            let payload: InputEnvelope<CreateThreadRequest> = decode_params(params)?;
            encode_result(workspace::create_thread_impl(payload.input, state))
        }
        "create_chat_thread" => {
            let payload: InputEnvelope<CreateChatThreadRequest> = decode_params(params)?;
            encode_result(workspace::create_chat_thread_impl(payload.input, state))
        }
        "rename_thread" => {
            let payload: InputEnvelope<RenameThreadRequest> = decode_params(params)?;
            encode_result(workspace::rename_thread_impl(payload.input, state))
        }
        "archive_thread" => {
            let payload: InputEnvelope<ArchiveThreadRequest> = decode_params(params)?;
            encode_result(workspace::archive_thread_impl(payload.input, state).await)
        }
        "start_environment_runtime" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                workspace::start_environment_runtime_impl(payload.environment_id, state).await,
            )
        }
        "stop_environment_runtime" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                workspace::stop_environment_runtime_impl(payload.environment_id, state).await,
            )
        }
        "touch_environment_runtime" => {
            let payload: EnvironmentIdEnvelope = decode_params(params)?;
            encode_result(
                workspace::touch_environment_runtime_impl(payload.environment_id, state).await,
            )
        }
        "get_project_icon" => {
            let payload: RootPathEnvelope = decode_params(params)?;
            encode_result(Ok(system::get_project_icon_impl(&payload.root_path)))
        }
        "terminal_spawn" => {
            let payload: InputEnvelope<SpawnTerminalInput> = decode_params(params)?;
            encode_result(terminal::terminal_spawn_impl(state, payload.input))
        }
        "terminal_write" => {
            let payload: InputEnvelope<WriteTerminalInput> = decode_params(params)?;
            encode_result(terminal::terminal_write_impl(state, payload.input))
        }
        "terminal_resize" => {
            let payload: InputEnvelope<ResizeTerminalInput> = decode_params(params)?;
            encode_result(terminal::terminal_resize_impl(state, payload.input))
        }
        "terminal_kill" => {
            let payload: InputEnvelope<KillTerminalInput> = decode_params(params)?;
            encode_result(terminal::terminal_kill_impl(state, payload.input))
        }
        "system.shutdown" => {
            state.terminal.shutdown_all();
            Ok(Value::Null)
        }
        other => {
            let _ = params;
            Err(AppError::Runtime(format!(
                "Electron sidecar command `{other}` is not implemented yet."
            ))
            .into())
        }
    }
}

fn parse_cli_args() -> Result<CliArgs, AppError> {
    let mut app_data_dir: Option<PathBuf> = None;
    let mut home_dir: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--app-data-dir" => {
                app_data_dir = args.next().map(PathBuf::from);
            }
            "--home-dir" => {
                home_dir = args.next().map(PathBuf::from);
            }
            other => {
                return Err(AppError::Validation(format!(
                    "Unknown sidecar argument: {other}"
                )));
            }
        }
    }

    Ok(CliArgs {
        app_data_dir: app_data_dir.ok_or_else(|| {
            AppError::Validation("Missing --app-data-dir for sidecar bootstrap.".to_string())
        })?,
        home_dir: home_dir.ok_or_else(|| {
            AppError::Validation("Missing --home-dir for sidecar bootstrap.".to_string())
        })?,
    })
}

async fn write_message(
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    message: &SidecarOutboundMessage,
) -> Result<(), AppError> {
    let mut stdout = stdout.lock().await;
    let encoded = serde_json::to_vec(message).map_err(sidecar_serialize_error)?;
    stdout.write_all(&encoded).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

async fn writeln_stderr(message: &str) -> io::Result<()> {
    let mut stderr = io::stderr();
    stderr.write_all(message.as_bytes()).await?;
    stderr.write_all(b"\n").await?;
    stderr.flush().await
}

fn sidecar_serialize_error(error: serde_json::Error) -> AppError {
    AppError::Runtime(format!("Failed to serialize sidecar payload: {error}"))
}

fn decode_params<T: DeserializeOwned>(params: Option<Value>) -> Result<T, CommandError> {
    serde_json::from_value(params.unwrap_or_else(|| Value::Object(serde_json::Map::new()))).map_err(
        |error| AppError::Validation(format!("Invalid sidecar params payload: {error}")).into(),
    )
}

fn encode_result<T>(result: Result<T, CommandError>) -> Result<Value, CommandError>
where
    T: Serialize,
{
    let value = result?;
    serde_json::to_value(value).map_err(|error| CommandError::from(sidecar_serialize_error(error)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputEnvelope<T> {
    input: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchEnvelope<T> {
    patch: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetEnvelope<T> {
    target: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdEnvelope {
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentIdEnvelope {
    environment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIdEnvelope {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathEnvelope {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPathEnvelope {
    root_path: String,
}
