use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::app_identity::{
    PROJECT_ACTION_STATE_EVENT_NAME, TERMINAL_EXIT_EVENT_NAME, TERMINAL_OUTPUT_EVENT_NAME,
};
use crate::error::{AppError, AppResult};
use crate::events::EventSink;

const ACTION_MARKER_START: u8 = 0x1e;
const ACTION_MARKER_END: u8 = 0x1f;
const ACTION_DONE_PREFIX: &str = "SKEIN_ACTION_DONE:";
const ACTION_MARKER_MAX_BYTES: usize = 128;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputPayload {
    pub pty_id: String,
    pub data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitPayload {
    pub pty_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectActionRunState {
    Running,
    Idle,
    Exited,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActionStatePayload {
    pub pty_id: String,
    pub action_id: String,
    pub state: ProjectActionRunState,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellFamily {
    Posix,
    Zsh,
    Fish,
    Nu,
    PowerShell,
}

#[derive(Debug, Default)]
struct ManualActionOutputFilter {
    marker_bytes: Option<Vec<u8>>,
}

impl ManualActionOutputFilter {
    fn process(&mut self, input: &[u8]) -> (Vec<u8>, Vec<i32>) {
        let mut output = Vec::with_capacity(input.len());
        let mut exit_codes = Vec::new();

        for &byte in input {
            let mut current = Some(byte);
            while let Some(value) = current.take() {
                if self.marker_bytes.is_some() {
                    if value == ACTION_MARKER_END {
                        let marker = self.marker_bytes.take().unwrap_or_default();
                        if let Some(exit_code) = parse_action_done_marker(&marker) {
                            exit_codes.push(exit_code);
                        } else {
                            output.push(ACTION_MARKER_START);
                            output.extend_from_slice(&marker);
                            output.push(ACTION_MARKER_END);
                        }
                        break;
                    }

                    let marker_bytes = self.marker_bytes.as_mut().expect("marker bytes");
                    marker_bytes.push(value);
                    if marker_bytes.len() >= ACTION_MARKER_MAX_BYTES {
                        let marker = self.marker_bytes.take().unwrap_or_default();
                        output.push(ACTION_MARKER_START);
                        output.extend_from_slice(&marker);
                    }
                    break;
                }

                if value == ACTION_MARKER_START {
                    self.marker_bytes = Some(Vec::new());
                    break;
                }

                output.push(value);
            }
        }

        (output, exit_codes)
    }
}

#[derive(Debug)]
struct ManualActionSession {
    action_id: String,
    state: ProjectActionRunState,
    output_filter: ManualActionOutputFilter,
}

impl ManualActionSession {
    fn new_running(action_id: String) -> Self {
        Self {
            action_id,
            state: ProjectActionRunState::Running,
            output_filter: ManualActionOutputFilter::default(),
        }
    }
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    manual_action: Option<Mutex<ManualActionSession>>,
}

struct RegisteredSession {
    environment_id: String,
    session: Arc<Session>,
}

type EnvOverride = (String, String);

struct TerminalSpawnRequest<'a> {
    environment_id: &'a str,
    cwd: &'a str,
    cols: u16,
    rows: u16,
    env_overrides: Vec<EnvOverride>,
    manual_action: Option<ManualActionSpawnRequest<'a>>,
}

struct ManualActionSpawnRequest<'a> {
    action_id: &'a str,
    script: &'a str,
}

pub struct ManualActionLaunch<'a> {
    pub environment_id: &'a str,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub env_overrides: Vec<EnvOverride>,
    pub action_id: &'a str,
    pub script: &'a str,
}

#[derive(Default)]
struct TerminalRegistry {
    sessions: HashMap<String, RegisteredSession>,
    sessions_by_environment: HashMap<String, HashSet<String>>,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn login_flag_for_shell(shell: &str) -> Option<&'static str> {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())?;
    match shell_name {
        "sh" | "bash" | "zsh" | "ksh" | "mksh" | "fish" | "nu" => Some("-l"),
        _ => None,
    }
}

fn login_flag_for_shell_family(shell: &str, shell_family: ShellFamily) -> Option<&'static str> {
    match shell_family {
        ShellFamily::PowerShell => Some("-Login"),
        _ => login_flag_for_shell(shell),
    }
}

fn interactive_flag_for_shell(shell: &str) -> Option<&'static str> {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())?;
    match shell_name {
        "sh" | "bash" | "zsh" | "ksh" | "mksh" | "fish" => Some("-i"),
        _ => None,
    }
}

fn shell_family_for_shell(shell: &str) -> ShellFamily {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match shell_name.as_str() {
        "zsh" => ShellFamily::Zsh,
        "fish" => ShellFamily::Fish,
        "nu" | "nu.exe" => ShellFamily::Nu,
        "pwsh" | "powershell" | "powershell.exe" | "pwsh.exe" => ShellFamily::PowerShell,
        _ => ShellFamily::Posix,
    }
}

fn parse_action_done_marker(marker: &[u8]) -> Option<i32> {
    let marker = std::str::from_utf8(marker).ok()?;
    marker
        .strip_prefix(ACTION_DONE_PREFIX)?
        .trim()
        .parse::<i32>()
        .ok()
}

fn posix_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn fish_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn powershell_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn nushell_raw_string(value: &str) -> String {
    for hash_count in 1.. {
        let hashes = "#".repeat(hash_count);
        let terminator = format!("'{}", hashes);
        if !value.contains(&terminator) {
            return format!("r{hashes}'{value}'{hashes}");
        }
    }

    unreachable!("hash count is unbounded")
}

fn posix_shell_reentry(shell: &str) -> String {
    let mut command = format!("exec {}", posix_shell_quote(shell));
    if let Some(login_flag) = login_flag_for_shell(shell) {
        command.push(' ');
        command.push_str(login_flag);
    }
    command.push('\n');
    command
}

fn fish_shell_reentry(shell: &str) -> String {
    let mut command = format!("exec {}", fish_shell_quote(shell));
    if let Some(login_flag) = login_flag_for_shell(shell) {
        command.push(' ');
        command.push_str(login_flag);
    }
    command.push('\n');
    command
}

fn nushell_login_argument(shell: &str) -> String {
    login_flag_for_shell(shell)
        .map(|flag| format!(" {}", nushell_raw_string(flag)))
        .unwrap_or_default()
}

fn powershell_child_invocation(shell: &str, script_reference: &str) -> String {
    let mut command = format!("& {}", powershell_shell_quote(shell));
    if let Some(login_flag) = login_flag_for_shell_family(shell, ShellFamily::PowerShell) {
        command.push(' ');
        command.push_str(login_flag);
    }
    command.push_str(" -Interactive -Command ");
    command.push_str(script_reference);
    command
}

fn manual_action_startup_command(shell: &str, shell_family: ShellFamily, script: &str) -> String {
    match shell_family {
        ShellFamily::Posix => format!(
            "__skein_action_script={script}\n(\neval \"$__skein_action_script\"\n)\n__skein_action_status=$?\nprintf '\\036{ACTION_DONE_PREFIX}%s\\037\\n' \"$__skein_action_status\"\nunset __skein_action_script\n{reentry}",
            script = posix_shell_quote(script),
            reentry = posix_shell_reentry(shell),
        ),
        ShellFamily::Zsh => format!(
            "__skein_action_script={script}\n{{\n(\neval \"$__skein_action_script\"\n)\n}} always {{\n__skein_action_status=$?\nprintf '\\036{ACTION_DONE_PREFIX}%s\\037\\n' \"$__skein_action_status\"\nunset __skein_action_script\n{reentry}}}\n",
            script = posix_shell_quote(script),
            reentry = posix_shell_reentry(shell),
        ),
        ShellFamily::Fish => format!(
            "set -l __skein_action_script {script}\n{shell} -l -c $__skein_action_script\nset -l __skein_action_status $status\nprintf '\\036{ACTION_DONE_PREFIX}%s\\037\\n' $__skein_action_status\nset -e __skein_action_script\n{reentry}",
            script = fish_shell_quote(script),
            shell = fish_shell_quote(shell),
            reentry = fish_shell_reentry(shell),
        ),
        ShellFamily::Nu => format!(
            "let __skein_action_script = {script}\nlet __skein_action_error = (try {{\n  run-external {shell}{login_flag} \"-c\" $__skein_action_script\n  null\n}} catch {{ |err| $err }})\nlet __skein_action_status = if $__skein_action_error == null {{\n  if \"LAST_EXIT_CODE\" in $env {{ $env.LAST_EXIT_CODE }} else {{ 0 }}\n}} else {{\n  $__skein_action_error.exit_code? | default 1\n}}\nprint -n ((char --integer 30) + \"{ACTION_DONE_PREFIX}\" + ($__skein_action_status | into string) + (char --integer 31) + (char newline))\nexec {shell}{login_flag}\n",
            script = nushell_raw_string(script),
            shell = nushell_raw_string(shell),
            login_flag = nushell_login_argument(shell),
        ),
        ShellFamily::PowerShell => format!(
            "$__skeinActionScript = {script}\ntry {{\n  {child_command}\n}}\nfinally {{\n  $__skeinActionStatus = if (Test-Path variable:LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\n  [Console]::Out.Write(\"$([char]30){ACTION_DONE_PREFIX}$($__skeinActionStatus)$([char]31)`n\")\n  Remove-Variable __skeinActionStatus -ErrorAction SilentlyContinue\n  Remove-Variable __skeinActionScript -ErrorAction SilentlyContinue\n}}\n",
            script = powershell_shell_quote(script),
            child_command = powershell_child_invocation(shell, "$__skeinActionScript"),
        ),
    }
}

fn configure_manual_action_command(
    cmd: &mut CommandBuilder,
    shell: &str,
    shell_family: ShellFamily,
    script: &str,
) {
    let command = manual_action_startup_command(shell, shell_family, script);

    match shell_family {
        ShellFamily::PowerShell => {
            if let Some(login_flag) = login_flag_for_shell_family(shell, shell_family) {
                cmd.arg(login_flag);
            }
            cmd.arg("-NoExit");
            cmd.arg("-Interactive");
            cmd.arg("-Command");
            cmd.arg(command);
        }
        _ => {
            if let Some(login_flag) = login_flag_for_shell_family(shell, shell_family) {
                cmd.arg(login_flag);
            }
            if shell_family != ShellFamily::Fish {
                if let Some(interactive_flag) = interactive_flag_for_shell(shell) {
                    cmd.arg(interactive_flag);
                }
            }
            cmd.arg("-c");
            cmd.arg(command);
        }
    }
}

#[derive(Clone, Default)]
pub struct TerminalService {
    registry: Arc<Mutex<TerminalRegistry>>,
}

impl TerminalService {
    fn get_session(&self, pty_id: &str) -> AppResult<Arc<Session>> {
        self.registry
            .lock()
            .unwrap()
            .sessions
            .get(pty_id)
            .map(|registered| registered.session.clone())
            .ok_or_else(|| AppError::NotFound("terminal session not found".into()))
    }

    fn emit_project_action_state(
        events: &EventSink,
        pty_id: &str,
        action_id: &str,
        state: ProjectActionRunState,
        exit_code: Option<i32>,
    ) {
        events.emit(
            PROJECT_ACTION_STATE_EVENT_NAME,
            ProjectActionStatePayload {
                pty_id: pty_id.to_string(),
                action_id: action_id.to_string(),
                state,
                exit_code,
            },
        );
    }

    fn set_manual_action_state(
        events: &EventSink,
        pty_id: &str,
        manual_action: &mut ManualActionSession,
        state: ProjectActionRunState,
        exit_code: Option<i32>,
    ) {
        manual_action.state = state;
        Self::emit_project_action_state(events, pty_id, &manual_action.action_id, state, exit_code);
    }

    pub fn spawn_manual_action(
        &self,
        events: &EventSink,
        request: ManualActionLaunch<'_>,
    ) -> AppResult<String> {
        let environment_id = request.environment_id.trim();
        if environment_id.is_empty() {
            return Err(AppError::Validation(
                "Environment id is required.".to_string(),
            ));
        }

        let action_id = request.action_id.trim();
        if action_id.is_empty() {
            return Err(AppError::Validation("Action id is required.".to_string()));
        }

        self.spawn_internal(
            events,
            TerminalSpawnRequest {
                environment_id,
                cwd: request.cwd,
                cols: request.cols,
                rows: request.rows,
                env_overrides: request.env_overrides,
                manual_action: Some(ManualActionSpawnRequest {
                    action_id,
                    script: request.script,
                }),
            },
        )
    }

    fn register_session(&self, environment_id: String, pty_id: String, session: Arc<Session>) {
        let mut registry = self.registry.lock().unwrap();
        registry
            .sessions_by_environment
            .entry(environment_id.clone())
            .or_default()
            .insert(pty_id.clone());
        registry.sessions.insert(
            pty_id,
            RegisteredSession {
                environment_id,
                session,
            },
        );
    }

    fn take_session(&self, pty_id: &str) -> Option<RegisteredSession> {
        let mut registry = self.registry.lock().unwrap();
        let registered = registry.sessions.remove(pty_id)?;
        let should_remove_environment = registry
            .sessions_by_environment
            .get_mut(&registered.environment_id)
            .is_some_and(|pty_ids| {
                pty_ids.remove(pty_id);
                pty_ids.is_empty()
            });
        if should_remove_environment {
            registry
                .sessions_by_environment
                .remove(&registered.environment_id);
        }
        Some(registered)
    }

    fn take_environment_sessions(&self, environment_id: &str) -> Vec<RegisteredSession> {
        let mut registry = self.registry.lock().unwrap();
        let Some(pty_ids) = registry.sessions_by_environment.remove(environment_id) else {
            return Vec::new();
        };

        pty_ids
            .into_iter()
            .filter_map(|pty_id| registry.sessions.remove(&pty_id))
            .collect()
    }

    fn take_all_sessions(&self) -> Vec<RegisteredSession> {
        let mut registry = self.registry.lock().unwrap();
        let sessions = registry
            .sessions
            .drain()
            .map(|(_, session)| session)
            .collect();
        registry.sessions_by_environment.clear();
        sessions
    }

    fn finalize_exited_session(&self, pty_id: &str) -> Option<RegisteredSession> {
        self.take_session(pty_id)
    }

    pub fn spawn(
        &self,
        events: &EventSink,
        environment_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        self.spawn_with_env(
            events,
            environment_id,
            cwd,
            cols,
            rows,
            std::iter::empty::<(&str, &str)>(),
        )
    }

    pub fn spawn_with_env<I, K, V>(
        &self,
        events: &EventSink,
        environment_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        env_overrides: I,
    ) -> AppResult<String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        self.spawn_internal(
            events,
            TerminalSpawnRequest {
                environment_id,
                cwd,
                cols,
                rows,
                env_overrides: env_overrides
                    .into_iter()
                    .map(|(key, value)| (key.as_ref().to_string(), value.as_ref().to_string()))
                    .collect(),
                manual_action: None,
            },
        )
    }

    fn spawn_internal(
        &self,
        events: &EventSink,
        request: TerminalSpawnRequest<'_>,
    ) -> AppResult<String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(request.cols, request.rows))
            .map_err(|e| AppError::Runtime(format!("openpty: {e}")))?;

        // Resolve cwd: explicit path > $HOME > "/".
        let resolved_cwd = if request.cwd.trim().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        } else {
            request.cwd.to_string()
        };

        // Resolve shell: $SHELL > /bin/zsh > /bin/sh. Reject SHELL when it is
        // empty or points to a non-existent binary, otherwise spawn_command
        // fails later with a cryptic error.
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|value| {
                let trimmed = value.trim();
                !trimmed.is_empty() && std::path::Path::new(trimmed).exists()
            })
            .unwrap_or_else(|| {
                if std::path::Path::new("/bin/zsh").exists() {
                    "/bin/zsh".to_string()
                } else {
                    "/bin/sh".to_string()
                }
            });
        let shell_family = shell_family_for_shell(&shell);

        let mut cmd = CommandBuilder::new(&shell);
        if let Some(manual_action) = request.manual_action.as_ref() {
            configure_manual_action_command(&mut cmd, &shell, shell_family, manual_action.script);
        } else if let Some(login_flag) = login_flag_for_shell_family(&shell, shell_family) {
            // Login shell: source .zprofile/.zshrc/etc so PATH/nvm/mise/pyenv work
            // on shells that explicitly support login mode.
            cmd.arg(login_flag);
        }
        cmd.cwd(&resolved_cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (key, value) in request.env_overrides {
            cmd.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Runtime(format!("spawn shell: {e}")))?;
        // Release the slave fd in this process so the child owns it exclusively.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Runtime(format!("take_writer: {e}")))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Runtime(format!("clone_reader: {e}")))?;

        let pty_id = uuid::Uuid::now_v7().to_string();

        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            manual_action: request.manual_action.as_ref().map(|manual_action| {
                Mutex::new(ManualActionSession::new_running(
                    manual_action.action_id.to_string(),
                ))
            }),
        });

        self.register_session(
            request.environment_id.to_string(),
            pty_id.clone(),
            session.clone(),
        );

        // Reader loop on a dedicated OS thread. portable-pty Read is blocking;
        // we don't want this loop to occupy a tokio blocking-pool slot for the
        // app's lifetime.
        let events_for_reader = events.clone();
        let pty_id_for_reader = pty_id.clone();
        let session_for_reader = session.clone();
        let service_for_reader = self.clone();
        if let Some(manual_action) = session.manual_action.as_ref() {
            let manual_action = manual_action.lock().unwrap();
            Self::emit_project_action_state(
                events,
                &pty_id,
                &manual_action.action_id,
                manual_action.state,
                None,
            );
        }
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(manual_action) = session_for_reader.manual_action.as_ref() {
                            let mut manual_action = manual_action.lock().unwrap();
                            let (output, exit_codes) =
                                manual_action.output_filter.process(&buf[..n]);
                            for exit_code in exit_codes {
                                TerminalService::set_manual_action_state(
                                    &events_for_reader,
                                    &pty_id_for_reader,
                                    &mut manual_action,
                                    ProjectActionRunState::Idle,
                                    Some(exit_code),
                                );
                            }
                            if !output.is_empty() {
                                let payload = TerminalOutputPayload {
                                    pty_id: pty_id_for_reader.clone(),
                                    data_base64: B64.encode(output),
                                };
                                events_for_reader.emit(TERMINAL_OUTPUT_EVENT_NAME, payload);
                            }
                        } else {
                            let payload = TerminalOutputPayload {
                                pty_id: pty_id_for_reader.clone(),
                                data_base64: B64.encode(&buf[..n]),
                            };
                            events_for_reader.emit(TERMINAL_OUTPUT_EVENT_NAME, payload);
                        }
                    }
                    Err(_) => break,
                }
            }
            // Reader EOF / error => child has likely exited. Use try_wait so
            // we never hold the child mutex through a blocking wait(): that
            // would deadlock shutdown_all() on CloseRequested if a child
            // closes its tty without exiting (rare but possible).
            let exit_code = session_for_reader
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok().flatten())
                .and_then(|s| i32::try_from(s.exit_code()).ok());
            if let Some(registered) = service_for_reader.finalize_exited_session(&pty_id_for_reader)
            {
                if let Some(manual_action) = registered.session.manual_action.as_ref() {
                    let mut manual_action = manual_action.lock().unwrap();
                    TerminalService::set_manual_action_state(
                        &events_for_reader,
                        &pty_id_for_reader,
                        &mut manual_action,
                        ProjectActionRunState::Exited,
                        exit_code,
                    );
                }
                events_for_reader.emit(
                    TERMINAL_EXIT_EVENT_NAME,
                    TerminalExitPayload {
                        pty_id: pty_id_for_reader,
                        exit_code,
                    },
                );
            }
        });

        Ok(pty_id)
    }

    pub fn write(&self, pty_id: &str, data_base64: &str) -> AppResult<()> {
        let bytes = B64
            .decode(data_base64)
            .map_err(|e| AppError::Runtime(format!("base64 decode: {e}")))?;
        self.get_session(pty_id)?
            .writer
            .lock()
            .unwrap()
            .write_all(&bytes)
            .map_err(|e| AppError::Runtime(format!("pty write: {e}")))?;
        Ok(())
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.get_session(pty_id)?
            .master
            .lock()
            .unwrap()
            .resize(pty_size(cols, rows))
            .map_err(|e| AppError::Runtime(format!("pty resize: {e}")))?;
        Ok(())
    }

    pub fn kill(&self, pty_id: &str) -> AppResult<()> {
        if let Some(registered) = self.take_session(pty_id) {
            let _ = registered.session.child.lock().unwrap().kill();
        }
        Ok(())
    }

    pub fn kill_environment(&self, environment_id: &str) -> AppResult<()> {
        for registered in self.take_environment_sessions(environment_id) {
            let _ = registered.session.child.lock().unwrap().kill();
        }
        Ok(())
    }

    pub fn kill_environments<'a, I>(&self, environment_ids: I) -> AppResult<()>
    where
        I: IntoIterator<Item = &'a str>,
    {
        for environment_id in environment_ids {
            self.kill_environment(environment_id)?;
        }
        Ok(())
    }

    pub fn shutdown_all(&self) {
        for registered in self.take_all_sessions() {
            let _ = registered.session.child.lock().unwrap().kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io::{Cursor, Result as IoResult};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use anyhow::Error;
    use portable_pty::{ChildKiller, ExitStatus};

    use super::*;

    #[derive(Debug)]
    struct FakeChild {
        kill_count: Arc<AtomicUsize>,
        exit_status: Option<ExitStatus>,
    }

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> IoResult<()> {
            self.kill_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeChild {
                kill_count: self.kill_count.clone(),
                exit_status: self.exit_status.clone(),
            })
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
            Ok(self.exit_status.clone())
        }

        fn wait(&mut self) -> IoResult<ExitStatus> {
            Ok(self
                .exit_status
                .clone()
                .unwrap_or_else(|| ExitStatus::with_exit_code(0)))
        }

        fn process_id(&self) -> Option<u32> {
            Some(1234)
        }
    }

    struct FakeMasterPty;

    impl MasterPty for FakeMasterPty {
        fn resize(&self, _size: PtySize) -> Result<(), Error> {
            Ok(())
        }

        fn get_size(&self) -> Result<PtySize, Error> {
            Ok(PtySize::default())
        }

        fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, Error> {
            Ok(Box::new(Cursor::new(Vec::<u8>::new())))
        }

        fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, Error> {
            Ok(Box::new(std::io::sink()))
        }

        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<i32> {
            None
        }

        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<portable_pty::unix::RawFd> {
            None
        }

        #[cfg(unix)]
        fn tty_name(&self) -> Option<std::path::PathBuf> {
            None
        }
    }

    fn fake_session(kill_count: Arc<AtomicUsize>) -> Arc<Session> {
        Arc::new(Session {
            master: Mutex::new(Box::new(FakeMasterPty)),
            writer: Mutex::new(Box::new(std::io::sink())),
            child: Mutex::new(Box::new(FakeChild {
                kill_count,
                exit_status: Some(ExitStatus::with_exit_code(0)),
            })),
            manual_action: None,
        })
    }

    #[test]
    fn finalize_exited_session_removes_the_session_and_environment_index() {
        let service = TerminalService::default();
        let kill_count = Arc::new(AtomicUsize::new(0));

        service.register_session(
            "env-1".to_string(),
            "pty-1".to_string(),
            fake_session(kill_count),
        );

        assert!(service.finalize_exited_session("pty-1").is_some());

        let registry = service.registry.lock().unwrap();
        assert!(registry.sessions.is_empty());
        assert!(registry.sessions_by_environment.is_empty());
    }

    #[test]
    fn kill_environment_removes_only_that_environments_sessions() {
        let service = TerminalService::default();
        let env_one_first = Arc::new(AtomicUsize::new(0));
        let env_one_second = Arc::new(AtomicUsize::new(0));
        let env_two = Arc::new(AtomicUsize::new(0));

        service.register_session(
            "env-1".to_string(),
            "pty-1".to_string(),
            fake_session(env_one_first.clone()),
        );
        service.register_session(
            "env-1".to_string(),
            "pty-2".to_string(),
            fake_session(env_one_second.clone()),
        );
        service.register_session(
            "env-2".to_string(),
            "pty-3".to_string(),
            fake_session(env_two.clone()),
        );

        service
            .kill_environment("env-1")
            .expect("kill should succeed");

        let registry = service.registry.lock().unwrap();
        assert_eq!(registry.sessions.len(), 1);
        assert!(registry.sessions.contains_key("pty-3"));
        assert!(!registry.sessions_by_environment.contains_key("env-1"));
        assert_eq!(
            registry
                .sessions_by_environment
                .get("env-2")
                .map(HashSet::len),
            Some(1)
        );
        drop(registry);

        assert_eq!(env_one_first.load(Ordering::SeqCst), 1);
        assert_eq!(env_one_second.load(Ordering::SeqCst), 1);
        assert_eq!(env_two.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn kill_environments_removes_every_targeted_environment() {
        let service = TerminalService::default();
        let env_one = Arc::new(AtomicUsize::new(0));
        let env_two = Arc::new(AtomicUsize::new(0));
        let env_three = Arc::new(AtomicUsize::new(0));

        service.register_session(
            "env-1".to_string(),
            "pty-1".to_string(),
            fake_session(env_one.clone()),
        );
        service.register_session(
            "env-2".to_string(),
            "pty-2".to_string(),
            fake_session(env_two.clone()),
        );
        service.register_session(
            "env-3".to_string(),
            "pty-3".to_string(),
            fake_session(env_three.clone()),
        );

        service
            .kill_environments(["env-1", "env-3"])
            .expect("kill should succeed");

        let registry = service.registry.lock().unwrap();
        assert_eq!(registry.sessions.len(), 1);
        assert!(registry.sessions.contains_key("pty-2"));
        assert_eq!(env_one.load(Ordering::SeqCst), 1);
        assert_eq!(env_two.load(Ordering::SeqCst), 0);
        assert_eq!(env_three.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn login_flag_only_targets_supported_shells() {
        assert_eq!(login_flag_for_shell("/bin/zsh"), Some("-l"));
        assert_eq!(login_flag_for_shell("/opt/homebrew/bin/fish"), Some("-l"));
        assert_eq!(login_flag_for_shell("/opt/homebrew/bin/nu"), Some("-l"));
        assert_eq!(login_flag_for_shell("/usr/local/bin/elvish"), None);
        assert_eq!(login_flag_for_shell(""), None);
    }

    #[test]
    fn login_flag_uses_shell_specific_overrides() {
        assert_eq!(
            login_flag_for_shell_family("/bin/zsh", ShellFamily::Zsh),
            Some("-l")
        );
        assert_eq!(
            login_flag_for_shell_family("/usr/local/bin/pwsh", ShellFamily::PowerShell),
            Some("-Login")
        );
    }

    #[test]
    fn interactive_flag_only_targets_supported_shells() {
        assert_eq!(interactive_flag_for_shell("/bin/zsh"), Some("-i"));
        assert_eq!(
            interactive_flag_for_shell("/opt/homebrew/bin/fish"),
            Some("-i")
        );
        assert_eq!(interactive_flag_for_shell("/opt/homebrew/bin/nu"), None);
        assert_eq!(interactive_flag_for_shell("/usr/local/bin/pwsh"), None);
        assert_eq!(interactive_flag_for_shell(""), None);
    }

    #[test]
    fn shell_family_matches_supported_shells() {
        assert_eq!(shell_family_for_shell("/bin/zsh"), ShellFamily::Zsh);
        assert_eq!(
            shell_family_for_shell("/opt/homebrew/bin/fish"),
            ShellFamily::Fish
        );
        assert_eq!(
            shell_family_for_shell("/opt/homebrew/bin/nu"),
            ShellFamily::Nu
        );
        assert_eq!(
            shell_family_for_shell("C:/Program Files/Nushell/bin/nu.exe"),
            ShellFamily::Nu
        );
        assert_eq!(
            shell_family_for_shell("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
            ShellFamily::PowerShell
        );
        assert_eq!(shell_family_for_shell("pwsh"), ShellFamily::PowerShell);
    }

    #[test]
    fn parse_action_done_marker_accepts_valid_exit_codes() {
        assert_eq!(parse_action_done_marker(b"SKEIN_ACTION_DONE:0"), Some(0));
        assert_eq!(
            parse_action_done_marker(b"SKEIN_ACTION_DONE:130"),
            Some(130)
        );
        assert_eq!(parse_action_done_marker(b"SKEIN_ACTION_DONE: 7"), Some(7));
        assert_eq!(parse_action_done_marker(b"nope"), None);
    }

    #[test]
    fn wrapper_literal_helpers_escape_values() {
        assert_eq!(posix_shell_quote("a'b"), "'a'\"'\"'b'");
        assert_eq!(fish_shell_quote("a'b"), "'a\\'b'");
        assert_eq!(powershell_shell_quote("a'b"), "'a''b'");
        assert_eq!(nushell_raw_string("value"), "r#'value'#");
        assert_eq!(nushell_raw_string("a'#b"), "r##'a'#b'##");
    }

    #[test]
    fn manual_action_output_filter_strips_markers_and_collects_exit_codes() {
        let mut filter = ManualActionOutputFilter::default();
        let marker = format!(
            "hello {start}{prefix}42{end}\nworld",
            start = ACTION_MARKER_START as char,
            prefix = ACTION_DONE_PREFIX,
            end = ACTION_MARKER_END as char,
        );

        let (output, exit_codes) = filter.process(marker.as_bytes());

        assert_eq!(
            String::from_utf8(output).expect("utf8 output"),
            "hello \nworld"
        );
        assert_eq!(exit_codes, vec![42]);
    }

    #[test]
    fn manual_action_output_filter_handles_split_markers() {
        let mut filter = ManualActionOutputFilter::default();
        let first = format!("before {}", ACTION_MARKER_START as char);
        let second = format!("{ACTION_DONE_PREFIX}17{}", ACTION_MARKER_END as char);

        let (first_output, first_exit_codes) = filter.process(first.as_bytes());
        let (second_output, second_exit_codes) = filter.process(second.as_bytes());

        assert_eq!(
            String::from_utf8(first_output).expect("utf8 output"),
            "before "
        );
        assert!(first_exit_codes.is_empty());
        assert!(second_output.is_empty());
        assert_eq!(second_exit_codes, vec![17]);
    }

    #[test]
    fn manual_action_output_filter_preserves_unknown_markers() {
        let mut filter = ManualActionOutputFilter::default();
        let marker = format!(
            "{}NOT_A_SKEIN_MARKER{}",
            ACTION_MARKER_START as char, ACTION_MARKER_END as char
        );

        let (output, exit_codes) = filter.process(marker.as_bytes());

        assert_eq!(String::from_utf8(output).expect("utf8 output"), marker);
        assert!(exit_codes.is_empty());
    }

    #[test]
    fn manual_action_startup_commands_emit_completion_markers_and_reenter_shells() {
        let posix = manual_action_startup_command("/bin/sh", ShellFamily::Posix, "bun run dev");
        assert!(posix.contains("\\036SKEIN_ACTION_DONE:%s\\037\\n"));
        assert!(posix.contains("__skein_action_status=$?"));
        assert!(posix.contains("__skein_action_script='bun run dev'"));
        assert!(posix.contains("exec '/bin/sh' -l"));
        assert!(!posix.contains("export "));

        let zsh = manual_action_startup_command("/bin/zsh", ShellFamily::Zsh, "bun run dev");
        assert!(zsh.contains("eval \"$__skein_action_script\""));
        assert!(
            zsh.contains("printf '\\036SKEIN_ACTION_DONE:%s\\037\\n' \"$__skein_action_status\"")
        );
        assert!(zsh.contains("exec '/bin/zsh' -l"));
        assert!(zsh.contains("} always {"));

        let fish = manual_action_startup_command(
            "/opt/homebrew/bin/fish",
            ShellFamily::Fish,
            "bun run dev",
        );
        assert!(fish.contains("set -l __skein_action_status $status"));
        assert!(fish.contains("\\036SKEIN_ACTION_DONE:%s\\037\\n"));
        assert!(fish.contains("set -l __skein_action_script 'bun run dev'"));
        assert!(fish.contains("'/opt/homebrew/bin/fish' -l -c $__skein_action_script"));
        assert!(fish.contains("exec '/opt/homebrew/bin/fish' -l"));
        assert!(!fish.contains("set -lx "));

        let nu =
            manual_action_startup_command("/opt/homebrew/bin/nu", ShellFamily::Nu, "bun run dev");
        assert!(nu.contains("let __skein_action_error = (try {"));
        assert!(nu.contains("catch { |err| $err }"));
        assert!(nu.contains(
            "run-external r#'/opt/homebrew/bin/nu'# r#'-l'# \"-c\" $__skein_action_script"
        ));
        assert!(nu.contains("char --integer 30"));
        assert!(nu.contains(ACTION_DONE_PREFIX));
        assert!(nu.contains("exec r#'/opt/homebrew/bin/nu'# r#'-l'#"));

        let powershell = manual_action_startup_command(
            "/usr/local/bin/pwsh",
            ShellFamily::PowerShell,
            "bun run dev",
        );
        assert!(powershell.contains("$__skeinActionScript = 'bun run dev'"));
        assert!(powershell.contains("try {"));
        assert!(powershell
            .contains("& '/usr/local/bin/pwsh' -Login -Interactive -Command $__skeinActionScript"));
        assert!(powershell.contains("Test-Path variable:LASTEXITCODE"));
        assert!(powershell.contains("$([char]30)"));
        assert!(powershell.contains(ACTION_DONE_PREFIX));
        assert!(!powershell.contains("Invoke-Expression $__skeinActionScript"));
        assert!(powershell.contains("Remove-Variable __skeinActionScript"));
    }

    #[test]
    fn configure_manual_action_command_uses_shell_specific_boot_flags() {
        let mut zsh = CommandBuilder::new("/bin/zsh");
        configure_manual_action_command(&mut zsh, "/bin/zsh", ShellFamily::Zsh, "bun run dev");
        assert_eq!(
            zsh.get_argv(),
            &vec![
                OsString::from("/bin/zsh"),
                OsString::from("-l"),
                OsString::from("-i"),
                OsString::from("-c"),
                OsString::from(manual_action_startup_command(
                    "/bin/zsh",
                    ShellFamily::Zsh,
                    "bun run dev",
                )),
            ]
        );

        let mut powershell = CommandBuilder::new("/usr/local/bin/pwsh");
        configure_manual_action_command(
            &mut powershell,
            "/usr/local/bin/pwsh",
            ShellFamily::PowerShell,
            "bun run dev",
        );
        assert_eq!(
            powershell.get_argv(),
            &vec![
                OsString::from("/usr/local/bin/pwsh"),
                OsString::from("-Login"),
                OsString::from("-NoExit"),
                OsString::from("-Interactive"),
                OsString::from("-Command"),
                OsString::from(manual_action_startup_command(
                    "/usr/local/bin/pwsh",
                    ShellFamily::PowerShell,
                    "bun run dev",
                )),
            ]
        );
    }

    #[test]
    fn manual_action_startup_commands_do_not_embed_raw_marker_bytes() {
        for (shell, shell_family) in [
            ("/bin/sh", ShellFamily::Posix),
            ("/bin/zsh", ShellFamily::Zsh),
            ("/opt/homebrew/bin/fish", ShellFamily::Fish),
            ("/opt/homebrew/bin/nu", ShellFamily::Nu),
            ("/usr/local/bin/pwsh", ShellFamily::PowerShell),
        ] {
            let command = manual_action_startup_command(shell, shell_family, "bun run dev");
            assert!(!command.as_bytes().contains(&ACTION_MARKER_START));
            assert!(!command.as_bytes().contains(&ACTION_MARKER_END));
        }
    }
}
