use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

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

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[derive(Default)]
pub struct TerminalService {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalService {
    fn get_session(&self, pty_id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(pty_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("terminal session not found".into()))
    }

    pub fn spawn(
        &self,
        app: &AppHandle,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
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

        // Resolve shell: $SHELL > /bin/zsh > /bin/sh.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        let mut cmd = CommandBuilder::new(&shell);
        // Login shell: source .zprofile/.zshrc/etc so PATH/nvm/mise/pyenv work.
        cmd.arg("-l");
        cmd.cwd(&resolved_cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

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

        self.sessions
            .lock()
            .unwrap()
            .insert(pty_id.clone(), session.clone());

        // Reader loop on a dedicated OS thread. portable-pty Read is blocking;
        // we don't want this loop to occupy a tokio blocking-pool slot for the
        // app's lifetime.
        let app_for_reader = app.clone();
        let pty_id_for_reader = pty_id.clone();
        let session_for_reader = session.clone();
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
                        let _ = app_for_reader.emit("threadex://terminal-output", payload);
                    }
                    Err(_) => break,
                }
            }
            // Reader EOF / error => child has likely exited. Collect exit code.
            let exit_code = session_for_reader
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| i32::try_from(s.exit_code()).ok());
            let _ = app_for_reader.emit(
                "threadex://terminal-exit",
                TerminalExitPayload {
                    pty_id: pty_id_for_reader,
                    exit_code,
                },
            );
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
        if let Some(session) = self.sessions.lock().unwrap().remove(pty_id) {
            let _ = session.child.lock().unwrap().kill();
        }
        Ok(())
    }

    pub fn shutdown_all(&self) {
        let mut map = self.sessions.lock().unwrap();
        for (_, session) in map.drain() {
            let _ = session.child.lock().unwrap().kill();
        }
    }
}
