use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::app_identity::{TERMINAL_EXIT_EVENT_NAME, TERMINAL_OUTPUT_EVENT_NAME};
use crate::error::{AppError, AppResult};

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

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

struct RegisteredSession {
    environment_id: String,
    session: Arc<Session>,
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

    fn finalize_exited_session(&self, pty_id: &str) -> bool {
        self.take_session(pty_id).is_some()
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
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(cols, rows))
            .map_err(|e| AppError::Runtime(format!("openpty: {e}")))?;

        // Resolve cwd: explicit path > $HOME > "/".
        let resolved_cwd = if cwd.trim().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        } else {
            cwd.to_string()
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

        let mut cmd = CommandBuilder::new(&shell);
        // Login shell: source .zprofile/.zshrc/etc so PATH/nvm/mise/pyenv work
        // on shells that explicitly support login mode.
        if let Some(login_flag) = login_flag_for_shell(&shell) {
            cmd.arg(login_flag);
        }
        cmd.cwd(&resolved_cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (key, value) in env_overrides {
            cmd.env(key.as_ref(), value.as_ref());
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
        });

        self.register_session(environment_id.to_string(), pty_id.clone(), session.clone());

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
                        let payload = TerminalOutputPayload {
                            pty_id: pty_id_for_reader.clone(),
                            data_base64: B64.encode(&buf[..n]),
                        };
                        let _ = app_for_reader.emit(TERMINAL_OUTPUT_EVENT_NAME, payload);
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
            if service_for_reader.finalize_exited_session(&pty_id_for_reader) {
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

        assert!(service.finalize_exited_session("pty-1"));

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
}
