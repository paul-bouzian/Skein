use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::warn;

use crate::domain::conversation::{
    ApprovalResponseInput, RespondToUserInputRequestInput, SubmitPlanDecisionInput,
    ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::domain::workspace::{RuntimeState, RuntimeStatusSnapshot};
use crate::error::{AppError, AppResult};
use crate::runtime::session::{RuntimeSession, SendMessageResult};
use crate::services::workspace::ThreadRuntimeContext;

struct RunningRuntime {
    session: Arc<RuntimeSession>,
    status: RuntimeStatusSnapshot,
}

#[derive(Default)]
struct RuntimeRegistry {
    running: HashMap<String, RunningRuntime>,
    last_known: HashMap<String, RuntimeStatusSnapshot>,
}

pub struct RuntimeSupervisor {
    app: AppHandle,
    app_version: String,
    registry: Mutex<RuntimeRegistry>,
    start_lock: Mutex<()>,
}

impl RuntimeSupervisor {
    pub fn new(app: AppHandle, app_version: String) -> Self {
        Self {
            app,
            app_version,
            registry: Mutex::new(RuntimeRegistry::default()),
            start_lock: Mutex::new(()),
        }
    }

    pub async fn refresh_statuses(&self) -> AppResult<Vec<RuntimeStatusSnapshot>> {
        let sessions = {
            let registry = self.registry.lock().await;
            registry
                .running
                .iter()
                .map(|(environment_id, runtime)| {
                    (
                        environment_id.clone(),
                        runtime.session.clone(),
                        runtime.status.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };

        let mut exited = Vec::new();
        for (environment_id, session, status) in sessions {
            if let Some(last_exit_code) = session.try_wait().await? {
                exited.push((environment_id, session, status, last_exit_code));
            }
        }

        if !exited.is_empty() {
            let mut finalized = Vec::new();
            let mut registry = self.registry.lock().await;
            for (environment_id, session, mut status, last_exit_code) in exited {
                let should_remove = registry
                    .running
                    .get(&environment_id)
                    .is_some_and(|runtime| Arc::ptr_eq(&runtime.session, &session));
                if !should_remove {
                    continue;
                }
                registry.running.remove(&environment_id);
                status.state = RuntimeState::Exited;
                status.pid = None;
                status.started_at = None;
                status.last_exit_code = Some(last_exit_code);
                registry.last_known.insert(environment_id, status);
                finalized.push(session);
            }
            drop(registry);

            for session in finalized {
                if let Err(error) = session.stop().await {
                    warn!("failed to stop finalized runtime session: {error}");
                }
            }
        }

        Ok(self
            .registry
            .lock()
            .await
            .last_known
            .values()
            .cloned()
            .collect())
    }

    pub async fn start(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RuntimeStatusSnapshot> {
        Ok(self
            .ensure_running_runtime(environment_id, environment_path, codex_binary_path)
            .await?
            .status)
    }

    async fn ensure_running_runtime(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RunningRuntime> {
        let _start_guard = self.start_lock.lock().await;
        self.refresh_statuses().await?;

        if let Some(runtime) = self.running_runtime(environment_id).await {
            return Ok(runtime);
        }

        let binary_path = match codex_binary_path {
            Some(path) => path,
            None => which::which("codex")
                .map_err(|_| {
                    AppError::Runtime("Unable to resolve the Codex CLI binary.".to_string())
                })?
                .to_string_lossy()
                .to_string(),
        };

        let session = Arc::new(
            RuntimeSession::spawn(
                self.app.clone(),
                environment_id.to_string(),
                environment_path.to_string(),
                binary_path.clone(),
                self.app_version.clone(),
            )
            .await?,
        );
        let pid = session.pid().await;
        let status = RuntimeStatusSnapshot {
            environment_id: environment_id.to_string(),
            state: RuntimeState::Running,
            pid,
            binary_path: Some(binary_path),
            started_at: Some(Utc::now()),
            last_exit_code: None,
        };

        let mut registry = self.registry.lock().await;
        registry.running.insert(
            environment_id.to_string(),
            RunningRuntime {
                session: session.clone(),
                status: status.clone(),
            },
        );
        registry
            .last_known
            .insert(environment_id.to_string(), status.clone());

        Ok(RunningRuntime { session, status })
    }

    pub async fn stop(&self, environment_id: &str) -> AppResult<RuntimeStatusSnapshot> {
        let running = self.registry.lock().await.running.remove(environment_id);
        if let Some(runtime) = running {
            runtime.session.stop().await?;

            let status = RuntimeStatusSnapshot {
                environment_id: environment_id.to_string(),
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: runtime.status.binary_path,
                started_at: None,
                last_exit_code: None,
            };
            self.registry
                .lock()
                .await
                .last_known
                .insert(environment_id.to_string(), status.clone());
            return Ok(status);
        }

        Ok(self
            .registry
            .lock()
            .await
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

    pub async fn open_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationOpenResponse> {
        let session = self.ensure_runtime(&context).await?;
        session.open_thread(context).await
    }

    pub async fn send_thread_message(
        &self,
        context: ThreadRuntimeContext,
        text: String,
    ) -> AppResult<SendMessageResult> {
        let session = self.ensure_runtime(&context).await?;
        session.send_message(context, text).await
    }

    pub async fn refresh_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        let session = self.ensure_runtime(&context).await?;
        session.refresh_thread(context).await
    }

    pub async fn interrupt_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        let session = self.ensure_runtime(&context).await?;
        session.interrupt_thread(context).await
    }

    pub async fn respond_to_approval_request(
        &self,
        context: ThreadRuntimeContext,
        interaction_id: &str,
        response: ApprovalResponseInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        let session = self.ensure_runtime(&context).await?;
        session
            .respond_to_approval_request(&context.thread_id, interaction_id, response)
            .await
    }

    pub async fn respond_to_user_input_request(
        &self,
        context: ThreadRuntimeContext,
        input: RespondToUserInputRequestInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        let session = self.ensure_runtime(&context).await?;
        if input.thread_id != context.thread_id {
            return Err(AppError::Validation(
                "User input response thread id does not match the active context.".to_string(),
            ));
        }
        session.respond_to_user_input_request(input).await
    }

    pub async fn submit_plan_decision(
        &self,
        context: ThreadRuntimeContext,
        input: SubmitPlanDecisionInput,
    ) -> AppResult<SendMessageResult> {
        let session = self.ensure_runtime(&context).await?;
        if input.thread_id != context.thread_id {
            return Err(AppError::Validation(
                "Plan decision thread id does not match the active context.".to_string(),
            ));
        }
        session.submit_plan_decision(context, input).await
    }

    async fn running_runtime(&self, environment_id: &str) -> Option<RunningRuntime> {
        self.registry
            .lock()
            .await
            .running
            .get(environment_id)
            .map(|runtime| RunningRuntime {
                session: runtime.session.clone(),
                status: runtime.status.clone(),
            })
    }

    async fn ensure_runtime(
        &self,
        context: &ThreadRuntimeContext,
    ) -> AppResult<Arc<RuntimeSession>> {
        Ok(self
            .ensure_running_runtime(
                &context.environment_id,
                &context.environment_path,
                context.codex_binary_path.clone(),
            )
            .await?
            .session)
    }
}
