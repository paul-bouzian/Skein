use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::warn;

use crate::domain::conversation::{
    ApprovalResponseInput, ComposerMentionBindingInput, RespondToUserInputRequestInput,
    SubmitPlanDecisionInput, ThreadComposerCatalog, ThreadConversationOpenResponse,
    ThreadConversationSnapshot,
};
use crate::domain::workspace::{CodexRateLimitSnapshot, RuntimeState, RuntimeStatusSnapshot};
use crate::error::{AppError, AppResult};
use crate::runtime::codex_paths::{missing_codex_binary_message, resolve_auto_binary_path};
use crate::runtime::session::{RuntimeSession, SendMessageResult};
use crate::services::workspace::ThreadRuntimeContext;

struct RunningRuntime {
    session: Arc<RuntimeSession>,
    status: RuntimeStatusSnapshot,
}

enum RateLimitReadTarget {
    Running(Arc<RuntimeSession>),
    Headless(Box<RuntimeSession>),
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
    environment_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl RuntimeSupervisor {
    pub fn new(app: AppHandle, app_version: String) -> Self {
        Self {
            app,
            app_version,
            registry: Mutex::new(RuntimeRegistry::default()),
            environment_locks: Mutex::new(HashMap::new()),
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

    pub async fn read_account_rate_limits(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<CodexRateLimitSnapshot> {
        let read_target = {
            let environment_lock = self.environment_lock(environment_id).await;
            let _environment_guard = environment_lock.lock().await;
            self.refresh_statuses().await?;

            if let Some(runtime) = self.running_runtime(environment_id).await {
                RateLimitReadTarget::Running(runtime.session)
            } else {
                let binary_path = resolve_binary_path(codex_binary_path)?;
                let session = RuntimeSession::spawn_headless(
                    environment_id.to_string(),
                    environment_path.to_string(),
                    binary_path,
                    self.app_version.clone(),
                )
                .await?;
                RateLimitReadTarget::Headless(Box::new(session))
            }
        };

        match read_target {
            RateLimitReadTarget::Running(session) => session.read_account_rate_limits().await,
            RateLimitReadTarget::Headless(session) => {
                let result = session.read_account_rate_limits().await;
                let stop_result = session.stop().await;

                match (result, stop_result) {
                    (Ok(rate_limits), Ok(())) => Ok(rate_limits),
                    (Err(error), _) => Err(error),
                    (Ok(_), Err(error)) => Err(error),
                }
            }
        }
    }

    async fn ensure_running_runtime(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RunningRuntime> {
        let environment_lock = self.environment_lock(environment_id).await;
        let _environment_guard = environment_lock.lock().await;
        self.refresh_statuses().await?;

        if let Some(runtime) = self.running_runtime(environment_id).await {
            return Ok(runtime);
        }

        let binary_path = resolve_binary_path(codex_binary_path)?;

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

    async fn environment_lock(&self, environment_id: &str) -> Arc<Mutex<()>> {
        let mut environment_locks = self.environment_locks.lock().await;
        environment_locks
            .entry(environment_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
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

    pub async fn get_thread_composer_catalog(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadComposerCatalog> {
        let session = self.ensure_runtime(&context).await?;
        session.composer_catalog(context).await
    }

    pub async fn search_thread_files(
        &self,
        context: ThreadRuntimeContext,
        query: String,
        limit: usize,
    ) -> AppResult<Vec<crate::domain::conversation::ComposerFileSearchResult>> {
        let session = self.ensure_runtime(&context).await?;
        session.search_thread_files(context, query, limit).await
    }

    pub async fn send_thread_message(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        let session = self.ensure_runtime(&context).await?;
        session
            .send_message_with_bindings(context, text, mention_bindings)
            .await
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

fn resolve_binary_path(codex_binary_path: Option<String>) -> AppResult<String> {
    match codex_binary_path {
        Some(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return Err(AppError::Validation(
                    "Codex binary path cannot be empty.".to_string(),
                ));
            }
            Ok(trimmed.to_string())
        }
        None => resolve_auto_binary_path()
            .ok_or_else(|| AppError::Runtime(missing_codex_binary_message()))
            .map(|path| path.to_string_lossy().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_binary_path;
    use crate::error::AppError;

    #[test]
    fn trims_explicit_codex_binary_path() {
        let resolved =
            resolve_binary_path(Some("  /opt/homebrew/bin/codex  ".to_string())).unwrap();

        assert_eq!(resolved, "/opt/homebrew/bin/codex");
    }

    #[test]
    fn rejects_empty_explicit_codex_binary_path() {
        let error = resolve_binary_path(Some("   ".to_string())).unwrap_err();

        assert!(matches!(
            error,
            AppError::Validation(message) if message == "Codex binary path cannot be empty."
        ));
    }
}
