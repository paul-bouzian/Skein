use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::app_identity::{
    PROJECT_ACTION_STATE_EVENT_NAME, TERMINAL_EXIT_EVENT_NAME, TERMINAL_OUTPUT_EVENT_NAME,
};
use crate::error::{AppError, AppResult};

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
    Fish,
    Nu,
    PowerShell,
}

#[derive(Debug, Default)]
struct ManualActionOutputFilter {
    marker_bytes: Option<Vec<u8>>,
    suppress_trailing_newline: bool,
}

impl ManualActionOutputFilter {
    fn process(&mut self, input: &[u8]) -> (Vec<u8>, Vec<i32>) {
        let mut output = Vec::with_capacity(input.len());
        let mut exit_codes = Vec::new();

        for &byte in input {
            let mut current = Some(byte);
            while let Some(value) = current.take() {
                if self.suppress_trailing_newline {
                    if matches!(value, b'\r' | b'\n') {
                        break;
                    }
                    self.suppress_trailing_newline = false;
                    current = Some(value);
                    continue;
                }

                if self.marker_bytes.is_some() {
                    if value == ACTION_MARKER_END {
                        let marker = self.marker_bytes.take().unwrap_or_default();
                        if let Some(exit_code) = parse_action_done_marker(&marker) {
                            exit_codes.push(exit_code);
                            self.suppress_trailing_newline = true;
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
    environment_id: String,
    action_id: String,
    shell_family: ShellFamily,
    state: ProjectActionRunState,
    output_filter: ManualActionOutputFilter,
}

impl ManualActionSession {
    fn new(environment_id: String, action_id: String, shell_family: ShellFamily) -> Self {
        Self {
            environment_id,
            action_id,
            shell_family,
            state: ProjectActionRunState::Idle,
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
    manual_action_id: Option<&'a str>,
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

fn shell_family_for_shell(shell: &str) -> ShellFamily {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match shell_name.as_str() {
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

fn is_manual_action_interrupt_input(bytes: &[u8]) -> bool {
    bytes == [3]
}

fn project_action_wrapper(shell_family: ShellFamily, script: &str) -> String {
    match shell_family {
        ShellFamily::Posix => format!(
            "{{\n{script}\n__skein_action_status=$?\nprintf '\\036{ACTION_DONE_PREFIX}%s\\037\\n' \"$__skein_action_status\"\nunset __skein_action_status\n}}\n"
        ),
        ShellFamily::Fish => format!(
            "begin\n{script}\nset -l __skein_action_status $status\nprintf '\\036{ACTION_DONE_PREFIX}%s\\037\\n' $__skein_action_status\nend\n"
        ),
        ShellFamily::Nu => format!(
            "do {{\n{script}\n}}\nlet __skein_action_status = (if \"LAST_EXIT_CODE\" in $env {{ $env.LAST_EXIT_CODE }} else {{ 0 }})\nprint -n ((char --integer 30) + \"{ACTION_DONE_PREFIX}\" + ($__skein_action_status | into string) + (char --integer 31) + (char newline))\n"
        ),
        ShellFamily::PowerShell => format!(
            "& {{\n{script}\n}}\n$__skeinActionStatus = if (Test-Path variable:LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\n[Console]::Out.Write(\"$([char]30){ACTION_DONE_PREFIX}$($__skeinActionStatus)$([char]31)`n\")\nRemove-Variable __skeinActionStatus -ErrorAction SilentlyContinue\n"
        ),
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
        app: &AppHandle,
        pty_id: &str,
        action_id: &str,
        state: ProjectActionRunState,
        exit_code: Option<i32>,
    ) {
        let _ = app.emit(
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
        app: &AppHandle,
        pty_id: &str,
        manual_action: &mut ManualActionSession,
        state: ProjectActionRunState,
        exit_code: Option<i32>,
    ) {
        manual_action.state = state;
        Self::emit_project_action_state(app, pty_id, &manual_action.action_id, state, exit_code);
    }

    fn dispatch_manual_action(&self, app: &AppHandle, pty_id: &str, script: &str) -> AppResult<()> {
        let session = self.get_session(pty_id)?;
        let Some(manual_action) = session.manual_action.as_ref() else {
            return Err(AppError::Validation(
                "Terminal session is not a project action shell.".to_string(),
            ));
        };

        let shell_family = {
            let mut manual_action = manual_action.lock().unwrap();
            if manual_action.state == ProjectActionRunState::Running {
                return Err(AppError::Validation(
                    "Project action is still running.".to_string(),
                ));
            }
            manual_action.output_filter = ManualActionOutputFilter::default();
            let shell_family = manual_action.shell_family;
            Self::set_manual_action_state(
                app,
                pty_id,
                &mut manual_action,
                ProjectActionRunState::Running,
                None,
            );
            shell_family
        };

        let wrapped_script = project_action_wrapper(shell_family, script);
        let encoded = B64.encode(wrapped_script);
        if let Err(error) = self.write(app, pty_id, &encoded) {
            if let Some(manual_action) = session.manual_action.as_ref() {
                let mut manual_action = manual_action.lock().unwrap();
                Self::set_manual_action_state(
                    app,
                    pty_id,
                    &mut manual_action,
                    ProjectActionRunState::Exited,
                    None,
                );
            }
            let _ = app.emit(
                TERMINAL_EXIT_EVENT_NAME,
                TerminalExitPayload {
                    pty_id: pty_id.to_string(),
                    exit_code: None,
                },
            );
            let _ = self.kill(pty_id);
            return Err(error);
        }

        Ok(())
    }

    pub fn spawn_manual_action(
        &self,
        app: &AppHandle,
        request: ManualActionLaunch<'_>,
    ) -> AppResult<String> {
        let pty_id = self.spawn_internal(
            app,
            TerminalSpawnRequest {
                environment_id: request.environment_id,
                cwd: request.cwd,
                cols: request.cols,
                rows: request.rows,
                env_overrides: request.env_overrides,
                manual_action_id: Some(request.action_id),
            },
        )?;

        if let Err(error) = self.dispatch_manual_action(app, &pty_id, request.script) {
            let _ = self.kill(&pty_id);
            return Err(error);
        }

        Ok(pty_id)
    }

    pub fn rerun_manual_action(
        &self,
        app: &AppHandle,
        pty_id: &str,
        environment_id: &str,
        action_id: &str,
        script: &str,
    ) -> AppResult<()> {
        let session = self.get_session(pty_id)?;
        let Some(manual_action) = session.manual_action.as_ref() else {
            return Err(AppError::Validation(
                "Terminal session is not a project action shell.".to_string(),
            ));
        };

        {
            let manual_action = manual_action.lock().unwrap();
            if manual_action.environment_id != environment_id {
                return Err(AppError::Validation(
                    "Project action terminal belongs to a different environment.".to_string(),
                ));
            }
            if manual_action.action_id != action_id {
                return Err(AppError::Validation(
                    "Project action terminal belongs to a different action.".to_string(),
                ));
            }
        }

        self.dispatch_manual_action(app, pty_id, script)
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
        app: &AppHandle,
        environment_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        self.spawn_with_env(
            app,
            environment_id,
            cwd,
            cols,
            rows,
            std::iter::empty::<(&str, &str)>(),
        )
    }

    pub fn spawn_with_env<I, K, V>(
        &self,
        app: &AppHandle,
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
            app,
            TerminalSpawnRequest {
                environment_id,
                cwd,
                cols,
                rows,
                env_overrides: env_overrides
                    .into_iter()
                    .map(|(key, value)| (key.as_ref().to_string(), value.as_ref().to_string()))
                    .collect(),
                manual_action_id: None,
            },
        )
    }

    fn spawn_internal(
        &self,
        app: &AppHandle,
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
        // Login shell: source .zprofile/.zshrc/etc so PATH/nvm/mise/pyenv work
        // on shells that explicitly support login mode.
        if let Some(login_flag) = login_flag_for_shell(&shell) {
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
            manual_action: request.manual_action_id.map(|action_id| {
                Mutex::new(ManualActionSession::new(
                    request.environment_id.to_string(),
                    action_id.to_string(),
                    shell_family,
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
        let app_for_reader = app.clone();
        let pty_id_for_reader = pty_id.clone();
        let session_for_reader = session.clone();
        let service_for_reader = self.clone();
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
                                    &app_for_reader,
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
                                let _ = app_for_reader.emit(TERMINAL_OUTPUT_EVENT_NAME, payload);
                            }
                        } else {
                            let payload = TerminalOutputPayload {
                                pty_id: pty_id_for_reader.clone(),
                                data_base64: B64.encode(&buf[..n]),
                            };
                            let _ = app_for_reader.emit(TERMINAL_OUTPUT_EVENT_NAME, payload);
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
                        &app_for_reader,
                        &pty_id_for_reader,
                        &mut manual_action,
                        ProjectActionRunState::Exited,
                        exit_code,
                    );
                }
                let _ = app_for_reader.emit(
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

    pub fn write(&self, app: &AppHandle, pty_id: &str, data_base64: &str) -> AppResult<()> {
        let bytes = B64
            .decode(data_base64)
            .map_err(|e| AppError::Runtime(format!("base64 decode: {e}")))?;
        let session = self.get_session(pty_id)?;
        session
            .writer
            .lock()
            .unwrap()
            .write_all(&bytes)
            .map_err(|e| AppError::Runtime(format!("pty write: {e}")))?;
        if is_manual_action_interrupt_input(&bytes) {
            if let Some(manual_action) = session.manual_action.as_ref() {
                let mut manual_action = manual_action.lock().unwrap();
                if manual_action.state == ProjectActionRunState::Running {
                    manual_action.output_filter = ManualActionOutputFilter::default();
                    Self::set_manual_action_state(
                        app,
                        pty_id,
                        &mut manual_action,
                        ProjectActionRunState::Idle,
                        Some(130),
                    );
                }
            }
        }
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
    fn shell_family_matches_supported_shells() {
        assert_eq!(shell_family_for_shell("/bin/zsh"), ShellFamily::Posix);
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
    fn manual_action_interrupt_input_only_matches_ctrl_c() {
        assert!(is_manual_action_interrupt_input(&[3]));
        assert!(!is_manual_action_interrupt_input(&[]));
        assert!(!is_manual_action_interrupt_input(&[3, b'\n']));
        assert!(!is_manual_action_interrupt_input(b"abc"));
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
            "hello world"
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
    fn project_action_wrappers_emit_completion_markers_for_supported_shells() {
        let posix = project_action_wrapper(ShellFamily::Posix, "bun run dev");
        assert!(posix.contains("\\036SKEIN_ACTION_DONE:%s\\037\\n"));
        assert!(posix.contains("__skein_action_status=$?"));

        let fish = project_action_wrapper(ShellFamily::Fish, "bun run dev");
        assert!(fish.contains("set -l __skein_action_status $status"));
        assert!(fish.contains("\\036SKEIN_ACTION_DONE:%s\\037\\n"));

        let nu = project_action_wrapper(ShellFamily::Nu, "bun run dev");
        assert!(nu.contains("LAST_EXIT_CODE"));
        assert!(nu.contains("char --integer 30"));
        assert!(nu.contains(ACTION_DONE_PREFIX));

        let powershell = project_action_wrapper(ShellFamily::PowerShell, "bun run dev");
        assert!(powershell.contains("Test-Path variable:LASTEXITCODE"));
        assert!(powershell.contains("$([char]30)"));
        assert!(powershell.contains(ACTION_DONE_PREFIX));
    }

    #[test]
    fn project_action_wrappers_do_not_embed_raw_marker_bytes() {
        for shell_family in [
            ShellFamily::Posix,
            ShellFamily::Fish,
            ShellFamily::Nu,
            ShellFamily::PowerShell,
        ] {
            let wrapper = project_action_wrapper(shell_family, "bun run dev");
            assert!(!wrapper.as_bytes().contains(&ACTION_MARKER_START));
            assert!(!wrapper.as_bytes().contains(&ACTION_MARKER_END));
        }
    }
}
