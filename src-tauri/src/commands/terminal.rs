use serde::Deserialize;
use tauri::State;

use crate::domain::terminal::EnvironmentTerminalSnapshot;
use crate::error::CommandError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEnvironmentTerminalInput {
    pub environment_id: String,
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteEnvironmentTerminalInput {
    pub environment_id: String,
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeEnvironmentTerminalInput {
    pub environment_id: String,
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseEnvironmentTerminalInput {
    pub environment_id: String,
    pub terminal_id: String,
}

#[tauri::command]
pub async fn open_environment_terminal(
    input: OpenEnvironmentTerminalInput,
    state: State<'_, AppState>,
) -> Result<EnvironmentTerminalSnapshot, CommandError> {
    let cwd = state
        .workspace
        .environment_terminal_cwd(&input.environment_id)?;
    Ok(state.terminal.open(input, cwd).await?)
}

#[tauri::command]
pub async fn write_environment_terminal(
    input: WriteEnvironmentTerminalInput,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.terminal.write(input).await?)
}

#[tauri::command]
pub async fn resize_environment_terminal(
    input: ResizeEnvironmentTerminalInput,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.terminal.resize(input).await?)
}

#[tauri::command]
pub async fn close_environment_terminal(
    input: CloseEnvironmentTerminalInput,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    Ok(state.terminal.close(input).await?)
}
