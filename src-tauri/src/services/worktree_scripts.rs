use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tracing::{error, warn};

use crate::app_identity::WORKTREE_SCRIPT_FAILURE_EVENT_NAME;
use crate::domain::workspace::{WorktreeScriptFailureEvent, WorktreeScriptTrigger};
use crate::services::git;
const WORKTREE_SCRIPT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const WORKTREE_SCRIPT_POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub struct WorktreeScriptService {
    app: Option<AppHandle>,
    logs_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct WorktreeScriptRequest {
    pub trigger: WorktreeScriptTrigger,
    pub script: String,
    pub project_id: String,
    pub project_name: String,
    pub project_root: PathBuf,
    pub worktree_id: String,
    pub worktree_name: String,
    pub worktree_branch: String,
    pub worktree_path: PathBuf,
}

impl WorktreeScriptService {
    pub fn new(app: AppHandle, app_data_dir: PathBuf) -> Self {
        Self {
            app: Some(app),
            logs_root: app_data_dir.join("logs").join("worktree-scripts"),
        }
    }

    #[cfg(test)]
    pub fn for_test(app_data_dir: PathBuf) -> Self {
        Self {
            app: None,
            logs_root: app_data_dir.join("logs").join("worktree-scripts"),
        }
    }

    pub fn run(&self, request: WorktreeScriptRequest) {
        let Some(script) = normalize_script(&request.script) else {
            return;
        };

        let shell = resolve_script_shell();
        let cwd = execution_directory(&request).to_path_buf();
        let log_path = self.log_path(&request);
        if let Err(error) = std::fs::create_dir_all(&self.logs_root) {
            self.emit_failure(
                &request,
                &log_path,
                None,
                format!("Failed to prepare worktree script log directory: {error}"),
            );
            return;
        }

        let mut log_file = match OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(file) => file,
            Err(error) => {
                self.emit_failure(
                    &request,
                    &log_path,
                    None,
                    format!("Failed to open worktree script log file: {error}"),
                );
                return;
            }
        };
        if let Err(error) = write_log_header(&mut log_file, &request, &shell, &cwd) {
            self.emit_failure(
                &request,
                &log_path,
                None,
                format!("Failed to initialize worktree script log: {error}"),
            );
            return;
        }

        let stdout = match log_file.try_clone() {
            Ok(file) => file,
            Err(error) => {
                self.emit_failure(
                    &request,
                    &log_path,
                    None,
                    format!("Failed to prepare script stdout log stream: {error}"),
                );
                return;
            }
        };
        let stderr = match log_file.try_clone() {
            Ok(file) => file,
            Err(error) => {
                self.emit_failure(
                    &request,
                    &log_path,
                    None,
                    format!("Failed to prepare script stderr log stream: {error}"),
                );
                return;
            }
        };

        let mut command = Command::new(&shell.path);
        if shell.is_login {
            command.arg("-l");
        }
        for argument in shell.initial_args {
            command.arg(argument);
        }
        command
            .arg(shell.command_arg)
            .arg(&script)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        apply_script_environment(&mut command, &request);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("Failed to start worktree script: {error}");
                if let Err(log_error) = append_log_message(&log_path, &message) {
                    warn!("failed to append worktree script launch error: {log_error}");
                }
                self.emit_failure(&request, &log_path, None, message);
                return;
            }
        };

        let app = self.app.clone();
        let log_path_for_thread = log_path.clone();
        std::thread::spawn(move || {
            let started_at = Instant::now();
            let completion = loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        break WorktreeScriptCompletion {
                            exit_code: status.code(),
                            success: status.success(),
                        };
                    }
                    Ok(None) if started_at.elapsed() < WORKTREE_SCRIPT_TIMEOUT => {
                        std::thread::sleep(WORKTREE_SCRIPT_POLL_INTERVAL);
                    }
                    Ok(None) => {
                        let message = timeout_message(
                            request.trigger,
                            &request.worktree_name,
                            WORKTREE_SCRIPT_TIMEOUT,
                        );
                        if let Err(log_error) = append_log_message(&log_path_for_thread, &message) {
                            warn!("failed to append worktree script timeout: {log_error}");
                        }
                        if let Err(error) = child.kill() {
                            warn!("failed to stop timed out worktree script: {error}");
                        }
                        let _ = child.wait();
                        emit_failure(app.as_ref(), &request, &log_path_for_thread, None, message);
                        break WorktreeScriptCompletion {
                            exit_code: None,
                            success: false,
                        };
                    }
                    Err(error) => {
                        let message =
                            format!("Worktree script process failed to complete: {error}");
                        if let Err(log_error) = append_log_message(&log_path_for_thread, &message) {
                            warn!("failed to append worktree script wait error: {log_error}");
                        }
                        emit_failure(app.as_ref(), &request, &log_path_for_thread, None, message);
                        return;
                    }
                }
            };

            if let Err(error) = append_log_footer(&log_path_for_thread, &completion) {
                warn!("failed to append worktree script footer: {error}");
            }

            if completion.success {
                if let Err(error) = std::fs::remove_file(&log_path_for_thread) {
                    warn!("failed to remove successful worktree script log: {error}");
                }
                return;
            }

            if completion.exit_code.is_some() {
                emit_failure(
                    app.as_ref(),
                    &request,
                    &log_path_for_thread,
                    completion.exit_code,
                    failure_message(
                        request.trigger,
                        &request.worktree_name,
                        completion.exit_code,
                    ),
                );
            }
        });
    }

    fn emit_failure(
        &self,
        request: &WorktreeScriptRequest,
        log_path: &Path,
        exit_code: Option<i32>,
        message: String,
    ) {
        emit_failure(self.app.as_ref(), request, log_path, exit_code, message);
    }

    fn log_path(&self, request: &WorktreeScriptRequest) -> PathBuf {
        let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
        let trigger = match request.trigger {
            WorktreeScriptTrigger::Setup => "setup",
            WorktreeScriptTrigger::Teardown => "teardown",
        };
        let project = git::sanitize_path_component(&request.project_name, "project");
        let worktree = git::sanitize_path_component(&request.worktree_name, "worktree");
        self.logs_root.join(format!(
            "{timestamp}-{trigger}-{project}-{worktree}-{}.log",
            short_identifier(&request.worktree_id)
        ))
    }
}

#[derive(Debug, Clone)]
struct ScriptShell {
    path: PathBuf,
    is_login: bool,
    command_arg: &'static str,
    initial_args: &'static [&'static str],
}

#[derive(Debug)]
struct WorktreeScriptCompletion {
    exit_code: Option<i32>,
    success: bool,
}

fn normalize_script(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn execution_directory(request: &WorktreeScriptRequest) -> &Path {
    match request.trigger {
        WorktreeScriptTrigger::Setup => request.worktree_path.as_path(),
        WorktreeScriptTrigger::Teardown => request.project_root.as_path(),
    }
}

fn resolve_script_shell() -> ScriptShell {
    let candidate = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists());
    if let Some(path) = candidate {
        return script_shell_from_path(path, true);
    }

    #[cfg(target_os = "windows")]
    {
        return script_shell_from_path(PathBuf::from("powershell.exe"), false);
    }

    for fallback in ["/bin/zsh", "/bin/bash"] {
        let path = PathBuf::from(fallback);
        if path.exists() {
            return script_shell_from_path(path, true);
        }
    }

    script_shell_from_path(PathBuf::from("/bin/sh"), false)
}

fn script_shell_from_path(path: PathBuf, default_login: bool) -> ScriptShell {
    if looks_like_powershell(&path) {
        return ScriptShell {
            path,
            is_login: false,
            command_arg: "-Command",
            initial_args: &["-NoProfile"],
        };
    }

    ScriptShell {
        path,
        is_login: default_login,
        command_arg: "-c",
        initial_args: &[],
    }
}

fn looks_like_powershell(path: &Path) -> bool {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|value| {
            let normalized = value.to_ascii_lowercase();
            normalized == "pwsh" || normalized == "powershell"
        })
        .unwrap_or(false)
}

fn write_log_header(
    file: &mut File,
    request: &WorktreeScriptRequest,
    shell: &ScriptShell,
    cwd: &Path,
) -> std::io::Result<()> {
    writeln!(file, "Skein worktree script")?;
    writeln!(
        file,
        "started_at={}",
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    )?;
    writeln!(file, "trigger={}", trigger_value(request.trigger))?;
    writeln!(file, "project_id={}", request.project_id)?;
    writeln!(file, "project_name={}", request.project_name)?;
    writeln!(file, "project_root={}", request.project_root.display())?;
    writeln!(file, "worktree_id={}", request.worktree_id)?;
    writeln!(file, "worktree_name={}", request.worktree_name)?;
    writeln!(file, "worktree_branch={}", request.worktree_branch)?;
    writeln!(file, "worktree_path={}", request.worktree_path.display())?;
    writeln!(file, "shell={}", shell.path.display())?;
    writeln!(file, "cwd={}", cwd.display())?;
    writeln!(file)?;
    writeln!(file, "----- output -----")?;
    file.flush()
}

fn apply_script_environment(command: &mut Command, request: &WorktreeScriptRequest) {
    for (key, value) in skein_context_environment(&SkeinContextInput {
        project_id: &request.project_id,
        project_name: &request.project_name,
        project_root: &request.project_root,
        worktree_id: &request.worktree_id,
        worktree_name: &request.worktree_name,
        worktree_branch: &request.worktree_branch,
        worktree_path: &request.worktree_path,
        trigger: Some(trigger_value(request.trigger)),
    }) {
        command.env(key, value);
    }
}

pub struct SkeinContextInput<'a> {
    pub project_id: &'a str,
    pub project_name: &'a str,
    pub project_root: &'a Path,
    pub worktree_id: &'a str,
    pub worktree_name: &'a str,
    pub worktree_branch: &'a str,
    pub worktree_path: &'a Path,
    pub trigger: Option<&'a str>,
}

pub fn skein_context_environment(input: &SkeinContextInput<'_>) -> Vec<(String, String)> {
    let project_root = input.project_root.to_string_lossy().to_string();
    let worktree_path = input.worktree_path.to_string_lossy().to_string();
    let mut values = Vec::with_capacity(if input.trigger.is_some() { 16 } else { 14 });

    // Keep the legacy namespace available for one transition release because
    // these scripts are persisted user settings and are not auto-migrated.
    for prefix in ["SKEIN", "LOOM"] {
        if let Some(trigger) = input.trigger {
            values.push((format!("{prefix}_SCRIPT_TRIGGER"), trigger.to_string()));
        }
        values.push((format!("{prefix}_PROJECT_ID"), input.project_id.to_string()));
        values.push((
            format!("{prefix}_PROJECT_NAME"),
            input.project_name.to_string(),
        ));
        values.push((format!("{prefix}_PROJECT_ROOT"), project_root.clone()));
        values.push((
            format!("{prefix}_WORKTREE_ID"),
            input.worktree_id.to_string(),
        ));
        values.push((
            format!("{prefix}_WORKTREE_NAME"),
            input.worktree_name.to_string(),
        ));
        values.push((
            format!("{prefix}_WORKTREE_BRANCH"),
            input.worktree_branch.to_string(),
        ));
        values.push((format!("{prefix}_WORKTREE_PATH"), worktree_path.clone()));
    }

    values
}

fn append_log_footer(path: &Path, completion: &WorktreeScriptCompletion) -> std::io::Result<()> {
    let mut file = OpenOptions::new().append(true).open(path)?;
    writeln!(file)?;
    writeln!(file, "----- result -----")?;
    writeln!(file, "completed_at={}", Utc::now().to_rfc3339())?;
    writeln!(file, "success={}", completion.success)?;
    match completion.exit_code {
        Some(code) => writeln!(file, "exit_code={code}")?,
        None => writeln!(file, "exit_code=terminated")?,
    };
    file.flush()
}

fn append_log_message(path: &Path, message: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{message}")?;
    file.flush()
}

fn emit_failure(
    app: Option<&AppHandle>,
    request: &WorktreeScriptRequest,
    log_path: &Path,
    exit_code: Option<i32>,
    message: String,
) {
    let payload = WorktreeScriptFailureEvent {
        trigger: request.trigger,
        project_id: request.project_id.clone(),
        project_name: request.project_name.clone(),
        worktree_id: request.worktree_id.clone(),
        worktree_name: request.worktree_name.clone(),
        worktree_branch: request.worktree_branch.clone(),
        worktree_path: request.worktree_path.to_string_lossy().to_string(),
        message: message.clone(),
        log_path: log_path.to_string_lossy().to_string(),
        exit_code,
    };
    if let Some(app) = app {
        if let Err(error) = app.emit(WORKTREE_SCRIPT_FAILURE_EVENT_NAME, payload) {
            error!("failed to emit worktree script failure: {error}");
        }
    }
    warn!("{message}");
}

fn failure_message(
    trigger: WorktreeScriptTrigger,
    worktree_name: &str,
    exit_code: Option<i32>,
) -> String {
    let action = match trigger {
        WorktreeScriptTrigger::Setup => "Setup",
        WorktreeScriptTrigger::Teardown => "Teardown",
    };
    match exit_code {
        Some(code) => format!("{action} script failed for \"{worktree_name}\" (exit code {code})."),
        None => format!("{action} script failed for \"{worktree_name}\"."),
    }
}

fn timeout_message(
    trigger: WorktreeScriptTrigger,
    worktree_name: &str,
    timeout: Duration,
) -> String {
    let action = match trigger {
        WorktreeScriptTrigger::Setup => "Setup",
        WorktreeScriptTrigger::Teardown => "Teardown",
    };
    format!(
        "{action} script timed out for \"{worktree_name}\" after {} seconds.",
        timeout.as_secs()
    )
}

fn trigger_value(trigger: WorktreeScriptTrigger) -> &'static str {
    match trigger {
        WorktreeScriptTrigger::Setup => "setup",
        WorktreeScriptTrigger::Teardown => "teardown",
    }
}

fn short_identifier(value: &str) -> &str {
    value.get(..8).unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_script_environment, execution_directory, failure_message, normalize_script,
        resolve_script_shell, timeout_message, trigger_value, WorktreeScriptRequest,
    };
    use crate::domain::workspace::WorktreeScriptTrigger;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;

    fn sample_request(trigger: WorktreeScriptTrigger) -> WorktreeScriptRequest {
        WorktreeScriptRequest {
            trigger,
            script: "echo hi".to_string(),
            project_id: "project-1".to_string(),
            project_name: "Skein".to_string(),
            project_root: PathBuf::from("/tmp/project"),
            worktree_id: "env-1".to_string(),
            worktree_name: "fuzzy-tiger".to_string(),
            worktree_branch: "fuzzy-tiger".to_string(),
            worktree_path: PathBuf::from("/tmp/worktree"),
        }
    }

    #[test]
    fn scripts_run_in_expected_directories() {
        let setup = sample_request(WorktreeScriptTrigger::Setup);
        let teardown = sample_request(WorktreeScriptTrigger::Teardown);

        assert_eq!(execution_directory(&setup), PathBuf::from("/tmp/worktree"));
        assert_eq!(
            execution_directory(&teardown),
            PathBuf::from("/tmp/project")
        );
    }

    #[test]
    fn failure_messages_include_trigger_and_exit_code() {
        assert_eq!(
            failure_message(WorktreeScriptTrigger::Setup, "fuzzy-tiger", Some(23)),
            "Setup script failed for \"fuzzy-tiger\" (exit code 23)."
        );
        assert_eq!(
            timeout_message(
                WorktreeScriptTrigger::Teardown,
                "fuzzy-tiger",
                Duration::from_secs(90),
            ),
            "Teardown script timed out for \"fuzzy-tiger\" after 90 seconds."
        );
        assert_eq!(trigger_value(WorktreeScriptTrigger::Teardown), "teardown");
    }

    #[test]
    fn normalizes_scripts_and_resolves_a_shell() {
        assert_eq!(normalize_script("   "), None);
        assert_eq!(normalize_script(" echo hi "), Some("echo hi".to_string()));
        let shell = resolve_script_shell();
        #[cfg(target_os = "windows")]
        assert!(
            shell.path.is_absolute()
                || shell
                    .path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("powershell.exe")),
            "expected absolute shell path or PATH-resolved powershell executable"
        );
        #[cfg(not(target_os = "windows"))]
        assert!(shell.path.is_absolute());
    }

    #[test]
    fn apply_script_environment_sets_skein_and_legacy_variables() {
        let request = sample_request(WorktreeScriptTrigger::Setup);
        let mut command = Command::new("env");

        apply_script_environment(&mut command, &request);

        let envs = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value
                        .expect("script env vars should be assigned")
                        .to_string_lossy()
                        .to_string(),
                )
            })
            .collect::<HashMap<_, _>>();

        for prefix in ["SKEIN", "LOOM"] {
            assert_eq!(
                envs.get(&format!("{prefix}_SCRIPT_TRIGGER")),
                Some(&"setup".to_string())
            );
            assert_eq!(
                envs.get(&format!("{prefix}_PROJECT_ID")),
                Some(&request.project_id)
            );
            assert_eq!(
                envs.get(&format!("{prefix}_PROJECT_NAME")),
                Some(&request.project_name)
            );
            assert_eq!(
                envs.get(&format!("{prefix}_PROJECT_ROOT")),
                Some(&request.project_root.to_string_lossy().to_string())
            );
            assert_eq!(
                envs.get(&format!("{prefix}_WORKTREE_ID")),
                Some(&request.worktree_id)
            );
            assert_eq!(
                envs.get(&format!("{prefix}_WORKTREE_NAME")),
                Some(&request.worktree_name)
            );
            assert_eq!(
                envs.get(&format!("{prefix}_WORKTREE_BRANCH")),
                Some(&request.worktree_branch)
            );
            assert_eq!(
                envs.get(&format!("{prefix}_WORKTREE_PATH")),
                Some(&request.worktree_path.to_string_lossy().to_string())
            );
        }
    }
}
