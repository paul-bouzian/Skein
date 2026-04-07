use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::CommandError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTerminalInput {
    pub environment_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTerminalResult {
    pub pty_id: String,
    pub cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTerminalInput {
    pub pty_id: String,
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeTerminalInput {
    pub pty_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillTerminalInput {
    pub pty_id: String,
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SpawnTerminalInput,
) -> Result<SpawnTerminalResult, CommandError> {
    // Resolve cwd from the workspace database, not the renderer. This both
    // validates that the env exists and ensures the shell only spawns inside a
    // managed worktree path — the renderer cannot point a PTY at /etc.
    let cwd = state.workspace.environment_path(&input.environment_id)?;
    let pty_id = state
        .terminal
        .spawn(&app, &input.environment_id, &cwd, input.cols, input.rows)?;
    Ok(SpawnTerminalResult { pty_id, cwd })
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    input: WriteTerminalInput,
) -> Result<(), CommandError> {
    state.terminal.write(&input.pty_id, &input.data_base64)?;
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    input: ResizeTerminalInput,
) -> Result<(), CommandError> {
    state
        .terminal
        .resize(&input.pty_id, input.cols, input.rows)?;
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(
    state: State<'_, AppState>,
    input: KillTerminalInput,
) -> Result<(), CommandError> {
    state.terminal.kill(&input.pty_id)?;
    Ok(())
}
