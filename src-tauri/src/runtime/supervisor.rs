use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use chrono::Utc;

use crate::domain::workspace::{RuntimeState, RuntimeStatusSnapshot};
use crate::error::{AppError, AppResult};

#[derive(Debug)]
struct RunningRuntime {
    child: Child,
    status: RuntimeStatusSnapshot,
}

#[derive(Debug, Default)]
struct RuntimeRegistry {
    running: HashMap<String, RunningRuntime>,
    last_known: HashMap<String, RuntimeStatusSnapshot>,
}

#[derive(Debug, Default)]
pub struct RuntimeSupervisor {
    registry: Mutex<RuntimeRegistry>,
}

impl RuntimeSupervisor {
    pub fn refresh_statuses(&self) -> AppResult<Vec<RuntimeStatusSnapshot>> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| AppError::Runtime("The runtime registry is poisoned.".to_string()))?;

        let environment_ids = registry.running.keys().cloned().collect::<Vec<_>>();

        for environment_id in environment_ids {
            let Some(runtime) = registry.running.get_mut(&environment_id) else {
                continue;
            };
            let exited = runtime.child.try_wait()?;

            if let Some(exit_status) = exited {
                let Some(removed) = registry.running.remove(&environment_id) else {
                    continue;
                };
                let mut status = removed.status;
                status.state = RuntimeState::Exited;
                status.last_exit_code = exit_status.code();
                registry.last_known.insert(environment_id.clone(), status);
            }
        }

        Ok(registry.last_known.values().cloned().collect())
    }

    pub fn start(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RuntimeStatusSnapshot> {
        self.refresh_statuses()?;

        let mut registry = self
            .registry
            .lock()
            .map_err(|_| AppError::Runtime("The runtime registry is poisoned.".to_string()))?;

        if let Some(runtime) = registry.running.get(environment_id) {
            return Ok(runtime.status.clone());
        }

        let binary_path = match codex_binary_path {
            Some(path) => path,
            None => which::which("codex")
                .map_err(|_| AppError::Runtime("Unable to resolve the Codex CLI binary.".to_string()))?
                .to_string_lossy()
                .to_string(),
        };

        let mut command = Command::new(&binary_path);
        command
            .arg("app-server")
            .current_dir(environment_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = command.spawn()?;
        let status = RuntimeStatusSnapshot {
            environment_id: environment_id.to_string(),
            state: RuntimeState::Running,
            pid: Some(child.id()),
            binary_path: Some(binary_path),
            started_at: Some(Utc::now()),
            last_exit_code: None,
        };

        registry.running.insert(
            environment_id.to_string(),
            RunningRuntime {
                child,
                status: status.clone(),
            },
        );
        registry
            .last_known
            .insert(environment_id.to_string(), status.clone());

        Ok(status)
    }

    pub fn stop(&self, environment_id: &str) -> AppResult<RuntimeStatusSnapshot> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| AppError::Runtime("The runtime registry is poisoned.".to_string()))?;

        if let Some(mut runtime) = registry.running.remove(environment_id) {
            runtime.child.kill()?;

            let status = RuntimeStatusSnapshot {
                environment_id: environment_id.to_string(),
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: runtime.status.binary_path.clone(),
                started_at: None,
                last_exit_code: None,
            };
            registry
                .last_known
                .insert(environment_id.to_string(), status.clone());
            return Ok(status);
        }

        Ok(registry
            .last_known
            .get(environment_id)
            .cloned()
            .unwrap_or(RuntimeStatusSnapshot {
                environment_id: environment_id.to_string(),
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: None,
                started_at: None,
                last_exit_code: None,
            }))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::RuntimeSupervisor;

    #[test]
    fn supervisor_can_start_and_stop_a_runtime_process() {
        let unique = format!(
            "threadex-supervisor-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let temp_dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let script_path = temp_dir.join("fake-codex.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nwhile true; do sleep 1; done\n",
        )
        .expect("script should be written");
        let mut permissions = fs::metadata(&script_path)
            .expect("script metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("script should be executable");

        let supervisor = RuntimeSupervisor::default();
        let started = supervisor
            .start(
                "env-1",
                temp_dir.to_str().expect("temp path should be utf-8"),
                Some(script_path.to_string_lossy().to_string()),
            )
            .expect("runtime should start");
        assert!(started.pid.is_some());

        let stopped = supervisor.stop("env-1").expect("runtime should stop");
        assert!(matches!(stopped.state, crate::domain::workspace::RuntimeState::Stopped));

        let _ = fs::remove_file(script_path);
        let _ = fs::remove_dir_all(temp_dir);
    }
}
