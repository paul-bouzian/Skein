use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::CommandError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTerminalInput {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTerminalResult {
    pub pty_id: String,
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
    let pty_id = state
        .terminal
        .spawn(&app, &input.cwd, input.cols, input.rows)?;
    Ok(SpawnTerminalResult { pty_id })
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
