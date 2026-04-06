use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::error;

use crate::commands::terminal::{
    CloseEnvironmentTerminalInput, OpenEnvironmentTerminalInput, ResizeEnvironmentTerminalInput,
    WriteEnvironmentTerminalInput,
};
use crate::domain::terminal::{EnvironmentTerminalSnapshot, TerminalEventPayload, TerminalStatus};
use crate::error::{AppError, AppResult};

pub const TERMINAL_EVENT_NAME: &str = "threadex://terminal-event";

const MAX_TERMINAL_HISTORY_BYTES: usize = 512 * 1024;
const MIN_TERMINAL_COLS: u16 = 2;
const MIN_TERMINAL_ROWS: u16 = 2;
const DEFAULT_TERMINAL_COLS: u16 = 80;
const DEFAULT_TERMINAL_ROWS: u16 = 24;

#[derive(Clone)]
pub struct TerminalService {
    app: AppHandle,
    revisions: Arc<Mutex<HashMap<String, u64>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

struct TerminalSession {
    environment_id: String,
    terminal_id: String,
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    state: Mutex<TerminalSessionState>,
}

#[derive(Debug)]
struct TerminalSessionState {
    status: TerminalStatus,
    history: String,
    pid: Option<u32>,
    exit_code: Option<i32>,
    updated_at: DateTime<Utc>,
}

impl TerminalService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            revisions: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open(
        &self,
        input: OpenEnvironmentTerminalInput,
        cwd: String,
    ) -> AppResult<EnvironmentTerminalSnapshot> {
        let environment_id =
            normalize_terminal_identifier(&input.environment_id, "Environment id")?;
        let terminal_id = normalize_terminal_identifier(&input.terminal_id, "Terminal id")?;
        let cwd = validate_terminal_cwd(&cwd)?;
        let size = normalize_terminal_size(input.cols, input.rows);
        let key = terminal_session_key(&environment_id, &terminal_id);

        if let Some(existing) = self.sessions.lock().await.get(&key).cloned() {
            return Ok(existing.snapshot().await);
        }
        let open_revision = {
            let mut revisions = self.revisions.lock().await;
            advance_terminal_revision(&mut revisions, &key)
        };

        let session = spawn_terminal_session(
            self.app.clone(),
            environment_id.clone(),
            terminal_id.clone(),
            cwd,
            size,
        )?;
        let snapshot = session.snapshot().await;

        let revisions = self.revisions.lock().await;
        if revisions.get(&key).copied() != Some(open_revision) {
            drop(revisions);
            kill_terminal_session(&session).await;
            return Err(AppError::Runtime(
                "Terminal session was closed while opening.".to_string(),
            ));
        }

        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(&key).cloned() {
            drop(revisions);
            drop(sessions);
            kill_terminal_session(&session).await;
            return Ok(existing.snapshot().await);
        }
        sessions.insert(key, Arc::clone(&session));
        drop(sessions);
        drop(revisions);

        emit_terminal_event(
            &self.app,
            TerminalEventPayload::Started {
                environment_id,
                terminal_id,
                created_at: Utc::now(),
                snapshot: snapshot.clone(),
            },
        );

        Ok(snapshot)
    }

    pub async fn write(&self, input: WriteEnvironmentTerminalInput) -> AppResult<()> {
        if input.data.is_empty() {
            return Err(AppError::Validation(
                "Terminal input cannot be empty.".to_string(),
            ));
        }
        let session = self
            .session(&input.environment_id, &input.terminal_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Terminal session not found.".to_string()))?;
        if session.status().await != TerminalStatus::Running {
            return Err(AppError::Validation("Terminal is not running.".to_string()));
        }

        let mut writer = session.writer.lock().await;
        writer
            .write_all(input.data.as_bytes())
            .map_err(|error| AppError::Runtime(format!("Failed to write to terminal: {error}")))?;
        writer.flush().map_err(|error| {
            AppError::Runtime(format!("Failed to flush terminal input: {error}"))
        })?;
        Ok(())
    }

    pub async fn resize(&self, input: ResizeEnvironmentTerminalInput) -> AppResult<()> {
        let Some(session) = self
            .session(&input.environment_id, &input.terminal_id)
            .await?
        else {
            return Ok(());
        };
        if session.status().await != TerminalStatus::Running {
            return Ok(());
        }

        let master = session.master.lock().await;
        master
            .resize(normalize_terminal_size(input.cols, input.rows))
            .map_err(|error| AppError::Runtime(format!("Failed to resize terminal: {error}")))?;
        Ok(())
    }

    pub async fn close(&self, input: CloseEnvironmentTerminalInput) -> AppResult<()> {
        let environment_id =
            normalize_terminal_identifier(&input.environment_id, "Environment id")?;
        let terminal_id = normalize_terminal_identifier(&input.terminal_id, "Terminal id")?;
        let key = terminal_session_key(&environment_id, &terminal_id);
        let session = {
            let mut revisions = self.revisions.lock().await;
            advance_terminal_revision(&mut revisions, &key);
            self.sessions.lock().await.remove(&key)
        };
        if let Some(session) = session {
            kill_terminal_session(&session).await;
        }
        Ok(())
    }

    pub async fn close_all_for_environment(&self, environment_id: &str) {
        let Some(environment_id) = non_empty_trimmed(environment_id) else {
            return;
        };
        let key_prefix = format!("{environment_id}::");
        let removed = {
            let mut revisions = self.revisions.lock().await;
            for (key, revision) in revisions.iter_mut() {
                if key.starts_with(&key_prefix) {
                    *revision += 1;
                }
            }
            let mut sessions = self.sessions.lock().await;
            let keys = sessions
                .keys()
                .filter(|key| key.starts_with(&key_prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| sessions.remove(&key))
                .collect::<Vec<_>>()
        };

        for session in removed {
            kill_terminal_session(&session).await;
        }

        let mut revisions = self.revisions.lock().await;
        revisions.retain(|key, _| !key.starts_with(&key_prefix));
    }

    async fn session(
        &self,
        environment_id: &str,
        terminal_id: &str,
    ) -> AppResult<Option<Arc<TerminalSession>>> {
        let environment_id = normalize_terminal_identifier(environment_id, "Environment id")?;
        let terminal_id = normalize_terminal_identifier(terminal_id, "Terminal id")?;
        let key = terminal_session_key(&environment_id, &terminal_id);
        Ok(self.sessions.lock().await.get(&key).cloned())
    }
}

impl Drop for TerminalService {
    fn drop(&mut self) {
        let mut sessions = self.sessions.blocking_lock();
        for (_, session) in sessions.drain() {
            let mut killer = session.killer.blocking_lock();
            let _ = killer.kill();
        }
    }
}

impl TerminalSession {
    async fn snapshot(&self) -> EnvironmentTerminalSnapshot {
        let state = self.state.lock().await;
        EnvironmentTerminalSnapshot {
            environment_id: self.environment_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            status: state.status,
            history: state.history.clone(),
            pid: state.pid,
            exit_code: state.exit_code,
            updated_at: state.updated_at,
        }
    }

    async fn status(&self) -> TerminalStatus {
        self.state.lock().await.status
    }
}

fn spawn_terminal_session(
    app: AppHandle,
    environment_id: String,
    terminal_id: String,
    cwd: String,
    size: PtySize,
) -> AppResult<Arc<TerminalSession>> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| AppError::Runtime(format!("Failed to open terminal PTY: {error}")))?;

    let shell = resolve_terminal_shell();
    let mut command = CommandBuilder::new(&shell.program);
    for argument in shell.args {
        command.arg(argument);
    }
    command.cwd(PathBuf::from(&cwd));
    command.env("TERM", "xterm-256color");
    let locale = resolve_utf8_locale();
    command.env("LANG", locale.as_str());
    command.env("LC_ALL", locale.as_str());
    command.env("LC_CTYPE", locale.as_str());

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| AppError::Runtime(format!("Failed to spawn terminal shell: {error}")))?;
    let pid = child.process_id();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| AppError::Runtime(format!("Failed to clone terminal reader: {error}")))?;
    let writer = pair.master.take_writer().map_err(|error| {
        AppError::Runtime(format!("Failed to acquire terminal writer: {error}"))
    })?;
    let killer = child.clone_killer();
    let session = Arc::new(TerminalSession {
        environment_id: environment_id.clone(),
        terminal_id: terminal_id.clone(),
        cwd,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        state: Mutex::new(TerminalSessionState {
            status: TerminalStatus::Running,
            history: String::new(),
            pid,
            exit_code: None,
            updated_at: Utc::now(),
        }),
    });

    spawn_terminal_reader(
        app.clone(),
        Arc::clone(&session),
        environment_id.clone(),
        terminal_id.clone(),
        reader,
    );
    spawn_terminal_waiter(app, session.clone(), environment_id, terminal_id, child);

    Ok(session)
}

fn spawn_terminal_reader(
    app: AppHandle,
    session: Arc<TerminalSession>,
    environment_id: String,
    terminal_id: String,
    mut reader: Box<dyn std::io::Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::<u8>::new();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    while !pending.is_empty() {
                        match std::str::from_utf8(&pending) {
                            Ok(decoded) => {
                                if !decoded.is_empty() {
                                    append_terminal_output(
                                        &session,
                                        &app,
                                        &environment_id,
                                        &terminal_id,
                                        decoded,
                                    );
                                }
                                pending.clear();
                            }
                            Err(error) => {
                                let valid_up_to = error.valid_up_to();
                                if valid_up_to > 0 {
                                    let decoded = String::from_utf8_lossy(&pending[..valid_up_to])
                                        .to_string();
                                    append_terminal_output(
                                        &session,
                                        &app,
                                        &environment_id,
                                        &terminal_id,
                                        decoded.as_str(),
                                    );
                                    pending.drain(..valid_up_to);
                                }
                                if error.error_len().is_none() {
                                    break;
                                }
                                let invalid_len = error.error_len().unwrap_or(1);
                                pending.drain(..invalid_len.min(pending.len()));
                            }
                        }
                    }
                }
                Err(error) => {
                    let message = error.to_string().to_ascii_lowercase();
                    if !message.contains("input/output error")
                        && !message.contains("broken pipe")
                        && !message.contains("resource temporarily unavailable")
                    {
                        emit_terminal_event(
                            &app,
                            TerminalEventPayload::Error {
                                environment_id: environment_id.clone(),
                                terminal_id: terminal_id.clone(),
                                created_at: Utc::now(),
                                message: format!("Terminal output stream failed: {error}"),
                            },
                        );
                    }
                    break;
                }
            }
        }
    });
}

fn spawn_terminal_waiter(
    app: AppHandle,
    session: Arc<TerminalSession>,
    environment_id: String,
    terminal_id: String,
    mut child: Box<dyn Child + Send + Sync>,
) {
    std::thread::spawn(move || match child.wait() {
        Ok(status) => {
            let exit_code = terminal_exit_code(&status);
            let mut state = session.state.blocking_lock();
            state.status = TerminalStatus::Exited;
            state.exit_code = exit_code;
            state.updated_at = Utc::now();
            drop(state);

            emit_terminal_event(
                &app,
                TerminalEventPayload::Exited {
                    environment_id,
                    terminal_id,
                    created_at: Utc::now(),
                    exit_code,
                },
            );
        }
        Err(error) => {
            let message = format!("Failed to wait for terminal exit: {error}");
            let mut state = session.state.blocking_lock();
            state.status = TerminalStatus::Error;
            state.updated_at = Utc::now();
            drop(state);

            emit_terminal_event(
                &app,
                TerminalEventPayload::Error {
                    environment_id,
                    terminal_id,
                    created_at: Utc::now(),
                    message,
                },
            );
        }
    });
}

fn append_terminal_output(
    session: &Arc<TerminalSession>,
    app: &AppHandle,
    environment_id: &str,
    terminal_id: &str,
    data: &str,
) {
    {
        let mut state = session.state.blocking_lock();
        push_terminal_history(&mut state.history, data);
        state.updated_at = Utc::now();
    }

    emit_terminal_event(
        app,
        TerminalEventPayload::Output {
            environment_id: environment_id.to_string(),
            terminal_id: terminal_id.to_string(),
            created_at: Utc::now(),
            data: data.to_string(),
        },
    );
}

async fn kill_terminal_session(session: &Arc<TerminalSession>) {
    let mut killer = session.killer.lock().await;
    let _ = killer.kill();
}

fn emit_terminal_event(app: &AppHandle, payload: TerminalEventPayload) {
    if let Err(error) = app.emit(TERMINAL_EVENT_NAME, payload) {
        error!("failed to emit terminal event: {error}");
    }
}

fn normalize_terminal_identifier(value: &str, label: &str) -> AppResult<String> {
    non_empty_trimmed(value).ok_or_else(|| AppError::Validation(format!("{label} is required.")))
}

fn validate_terminal_cwd(value: &str) -> AppResult<String> {
    let Some(trimmed) = non_empty_trimmed(value) else {
        return Err(AppError::Validation(
            "Terminal working directory is required.".to_string(),
        ));
    };
    let path = Path::new(&trimmed);
    let metadata = std::fs::metadata(path).map_err(|error| {
        AppError::Validation(format!(
            "Terminal working directory is not accessible: {error}"
        ))
    })?;
    if !metadata.is_dir() {
        return Err(AppError::Validation(
            "Terminal working directory must be a directory.".to_string(),
        ));
    }
    Ok(trimmed)
}

fn non_empty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn normalize_terminal_size(cols: u16, rows: u16) -> PtySize {
    let cols = if cols == 0 {
        DEFAULT_TERMINAL_COLS
    } else {
        cols.max(MIN_TERMINAL_COLS)
    };
    let rows = if rows == 0 {
        DEFAULT_TERMINAL_ROWS
    } else {
        rows.max(MIN_TERMINAL_ROWS)
    };

    PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn resolve_terminal_shell() -> TerminalShell {
    #[cfg(target_os = "windows")]
    {
        let program = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string());
        return TerminalShell {
            program,
            args: vec!["/K".to_string()],
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        TerminalShell {
            program,
            args: vec!["-l".to_string()],
        }
    }
}

fn resolve_utf8_locale() -> String {
    let candidate = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_else(|_| "en_US.UTF-8".to_string());
    let lower = candidate.to_ascii_lowercase();
    if lower.contains("utf-8") || lower.contains("utf8") {
        candidate
    } else {
        "en_US.UTF-8".to_string()
    }
}

fn push_terminal_history(history: &mut String, chunk: &str) {
    history.push_str(chunk);
    if history.len() <= MAX_TERMINAL_HISTORY_BYTES {
        return;
    }

    let overflow = history.len() - MAX_TERMINAL_HISTORY_BYTES;
    let drain_until = history
        .char_indices()
        .find(|(index, _)| *index >= overflow)
        .map(|(index, _)| index)
        .unwrap_or(history.len());
    history.drain(..drain_until);
}

fn terminal_exit_code(status: &ExitStatus) -> Option<i32> {
    i32::try_from(status.exit_code()).ok()
}

fn terminal_session_key(environment_id: &str, terminal_id: &str) -> String {
    format!("{environment_id}::{terminal_id}")
}

fn advance_terminal_revision(revisions: &mut HashMap<String, u64>, key: &str) -> u64 {
    let next = revisions.get(key).copied().unwrap_or(0) + 1;
    revisions.insert(key.to_string(), next);
    next
}

struct TerminalShell {
    program: String,
    args: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{push_terminal_history, resolve_utf8_locale, terminal_session_key};

    #[test]
    fn terminal_history_limit_preserves_utf8_boundaries() {
        let mut history = String::new();
        let large_chunk = "é".repeat(400_000);
        push_terminal_history(&mut history, large_chunk.as_str());
        push_terminal_history(&mut history, "terminal");

        assert!(history.is_char_boundary(0));
        assert!(history.ends_with("terminal"));
        assert!(history.len() <= 512 * 1024);
    }

    #[test]
    fn terminal_session_key_is_environment_scoped() {
        assert_eq!(terminal_session_key("env-1", "tab-1"), "env-1::tab-1");
    }

    #[test]
    fn locale_falls_back_to_utf8() {
        let locale = resolve_utf8_locale();
        assert!(
            locale.to_ascii_lowercase().contains("utf-8")
                || locale.to_ascii_lowercase().contains("utf8")
        );
    }
}
