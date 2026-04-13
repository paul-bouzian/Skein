use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::warn;

use crate::app_identity::WORKSPACE_EVENT_NAME;
use crate::domain::conversation::{
    ApprovalResponseInput, ComposerMentionBindingInput, ConversationImageAttachment,
    RespondToUserInputRequestInput, SubmitPlanDecisionInput, ThreadComposerCatalog,
    ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::domain::workspace::{
    CodexRateLimitSnapshot, RuntimeState, RuntimeStatusSnapshot, WorkspaceEvent,
    WorkspaceEventKind,
};
use crate::error::{AppError, AppResult};
use crate::runtime::codex_paths::resolve_codex_binary_path;
use crate::runtime::protocol::AccountReadResponse;
use crate::runtime::session::{AppServerAuthStatus, RuntimeSession, SendMessageResult};
use crate::services::workspace::ThreadRuntimeContext;

struct RunningRuntime {
    session: Arc<RuntimeSession>,
    status: RuntimeStatusSnapshot,
    last_activity_at: DateTime<Utc>,
}

struct IdleRuntimeCandidate {
    environment_id: String,
    session: Arc<RuntimeSession>,
}

struct IdleRuntimeClassification {
    evictable_candidates: Vec<IdleRuntimeCandidate>,
    keep_alive_environment_ids: Vec<String>,
}

enum RuntimeReadTarget {
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

pub const RUNTIME_IDLE_REAPER_INTERVAL: Duration = Duration::from_secs(60);
pub const RUNTIME_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

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
            let mut changed_environment_ids = Vec::new();
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
                registry
                    .last_known
                    .insert(environment_id.clone(), status);
                finalized.push(session);
                changed_environment_ids.push(environment_id);
            }
            drop(registry);

            for session in finalized {
                if let Err(error) = session.stop().await {
                    warn!("failed to stop finalized runtime session: {error}");
                }
            }

            for environment_id in changed_environment_ids {
                self.emit_runtime_status_event(&environment_id);
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
        let read_target = self
            .resolve_read_target(environment_id, environment_path, codex_binary_path)
            .await?;

        read_account_rate_limits_from_target(read_target).await
    }

    pub async fn read_account(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
        refresh_token: bool,
    ) -> AppResult<AccountReadResponse> {
        let read_target = self
            .resolve_read_target(environment_id, environment_path, codex_binary_path)
            .await?;

        read_account_from_target(read_target, refresh_token).await
    }

    pub async fn read_auth_status(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
        include_token: bool,
        refresh_token: bool,
    ) -> AppResult<AppServerAuthStatus> {
        let read_target = self
            .resolve_read_target(environment_id, environment_path, codex_binary_path)
            .await?;

        read_auth_status_from_target(read_target, include_token, refresh_token).await
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
            self.mark_runtime_activity(environment_id).await;
            return Ok(runtime);
        }

        let binary_path = resolve_binary_path(codex_binary_path)?;

        let now = Utc::now();
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
            started_at: Some(now),
            last_exit_code: None,
        };

        let mut registry = self.registry.lock().await;
        registry.running.insert(
            environment_id.to_string(),
            RunningRuntime {
                session: session.clone(),
                status: status.clone(),
                last_activity_at: now,
            },
        );
        registry
            .last_known
            .insert(environment_id.to_string(), status.clone());
        drop(registry);
        self.emit_runtime_status_event(environment_id);

        Ok(RunningRuntime {
            session,
            status,
            last_activity_at: now,
        })
    }

    async fn environment_lock(&self, environment_id: &str) -> Arc<Mutex<()>> {
        let mut environment_locks = self.environment_locks.lock().await;
        environment_locks
            .entry(environment_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn resolve_read_target(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RuntimeReadTarget> {
        let environment_lock = self.environment_lock(environment_id).await;
        let _environment_guard = environment_lock.lock().await;
        self.refresh_statuses().await?;

        if let Some(runtime) = self.running_runtime(environment_id).await {
            self.mark_runtime_activity(environment_id).await;
            return Ok(RuntimeReadTarget::Running(runtime.session));
        }

        let binary_path = resolve_binary_path(codex_binary_path)?;
        let session = RuntimeSession::spawn_headless(
            environment_id.to_string(),
            environment_path.to_string(),
            binary_path,
            self.app_version.clone(),
        )
        .await?;
        Ok(RuntimeReadTarget::Headless(Box::new(session)))
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
            self.emit_runtime_status_event(environment_id);
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

    pub async fn touch(&self, environment_id: &str) -> AppResult<bool> {
        self.refresh_statuses().await?;

        let mut registry = self.registry.lock().await;
        Ok(touch_running_runtime(&mut registry, environment_id, Utc::now()))
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
        images: Vec<ConversationImageAttachment>,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        let session = self.ensure_runtime(&context).await?;
        session
            .send_message_with_bindings(context, text, images, mention_bindings)
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

    pub async fn evict_idle_runtimes(&self, max_idle: Duration) -> AppResult<()> {
        self.refresh_statuses().await?;

        let cutoff = chrono::Duration::from_std(max_idle)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        let now = Utc::now();
        let candidates = {
            let registry = self.registry.lock().await;
            collect_idle_runtime_candidates(&registry, now, cutoff)
        };

        let classification = classify_idle_runtime_candidates(candidates).await;

        for environment_id in classification.keep_alive_environment_ids {
            self.mark_runtime_activity(&environment_id).await;
        }

        for candidate in classification.evictable_candidates {
            if !should_stop_idle_runtime_candidate(
                &self.registry,
                &candidate,
                Utc::now(),
                cutoff,
            )
            .await
            {
                continue;
            }

            if candidate.session.has_keep_alive_work().await {
                self.mark_runtime_activity(&candidate.environment_id).await;
                continue;
            }

            if let Err(error) = self.stop(&candidate.environment_id).await {
                warn!(
                    environment_id = %candidate.environment_id,
                    "failed to evict idle runtime: {error}"
                );
            }
        }

        Ok(())
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
                last_activity_at: runtime.last_activity_at,
            })
    }

    async fn mark_runtime_activity(&self, environment_id: &str) {
        let mut registry = self.registry.lock().await;
        touch_running_runtime(&mut registry, environment_id, Utc::now());
    }

    fn emit_runtime_status_event(&self, environment_id: &str) {
        if let Err(error) = self.app.emit(
            WORKSPACE_EVENT_NAME,
            WorkspaceEvent {
                kind: WorkspaceEventKind::RuntimeStatusChanged,
                project_id: None,
                environment_id: Some(environment_id.to_string()),
                thread_id: None,
            },
        ) {
            warn!("failed to emit workspace runtime event: {error}");
        }
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

fn touch_running_runtime(
    registry: &mut RuntimeRegistry,
    environment_id: &str,
    touched_at: DateTime<Utc>,
) -> bool {
    if let Some(runtime) = registry.running.get_mut(environment_id) {
        runtime.last_activity_at = touched_at;
        true
    } else {
        false
    }
}

fn collect_idle_runtime_candidates(
    registry: &RuntimeRegistry,
    now: DateTime<Utc>,
    cutoff: chrono::Duration,
) -> Vec<IdleRuntimeCandidate> {
    registry
        .running
        .iter()
        .filter(|(_, runtime)| (now - runtime.last_activity_at) >= cutoff)
        .map(|(environment_id, runtime)| IdleRuntimeCandidate {
            environment_id: environment_id.clone(),
            session: runtime.session.clone(),
        })
        .collect()
}

async fn classify_idle_runtime_candidates(
    candidates: Vec<IdleRuntimeCandidate>,
) -> IdleRuntimeClassification {
    let mut evictable_candidates = Vec::new();
    let mut keep_alive_environment_ids = Vec::new();

    for candidate in candidates {
        if candidate.session.has_keep_alive_work().await {
            keep_alive_environment_ids.push(candidate.environment_id);
        } else {
            evictable_candidates.push(candidate);
        }
    }

    IdleRuntimeClassification {
        evictable_candidates,
        keep_alive_environment_ids,
    }
}

async fn should_stop_idle_runtime_candidate(
    registry: &Mutex<RuntimeRegistry>,
    candidate: &IdleRuntimeCandidate,
    now: DateTime<Utc>,
    cutoff: chrono::Duration,
) -> bool {
    let registry = registry.lock().await;
    registry
        .running
        .get(&candidate.environment_id)
        .is_some_and(|runtime| {
            Arc::ptr_eq(&runtime.session, &candidate.session)
                && (now - runtime.last_activity_at) >= cutoff
        })
}

async fn read_account_rate_limits_from_target(
    read_target: RuntimeReadTarget,
) -> AppResult<CodexRateLimitSnapshot> {
    match read_target {
        RuntimeReadTarget::Running(session) => session.read_account_rate_limits().await,
        RuntimeReadTarget::Headless(session) => {
            let result = session.read_account_rate_limits().await;
            let stop_result = session.stop().await;
            finish_headless_read(result, stop_result)
        }
    }
}

async fn read_account_from_target(
    read_target: RuntimeReadTarget,
    refresh_token: bool,
) -> AppResult<AccountReadResponse> {
    match read_target {
        RuntimeReadTarget::Running(session) => session.read_account(refresh_token).await,
        RuntimeReadTarget::Headless(session) => {
            let result = session.read_account(refresh_token).await;
            let stop_result = session.stop().await;
            finish_headless_read(result, stop_result)
        }
    }
}

async fn read_auth_status_from_target(
    read_target: RuntimeReadTarget,
    include_token: bool,
    refresh_token: bool,
) -> AppResult<AppServerAuthStatus> {
    match read_target {
        RuntimeReadTarget::Running(session) => {
            session.read_auth_status(include_token, refresh_token).await
        }
        RuntimeReadTarget::Headless(session) => {
            let result = session.read_auth_status(include_token, refresh_token).await;
            let stop_result = session.stop().await;
            finish_headless_read(result, stop_result)
        }
    }
}

fn finish_headless_read<T>(result: AppResult<T>, stop_result: AppResult<()>) -> AppResult<T> {
    match (result, stop_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn resolve_binary_path(codex_binary_path: Option<String>) -> AppResult<String> {
    resolve_codex_binary_path(codex_binary_path.as_deref())
}

#[cfg(test)]
mod tests {
    use chrono::{Duration as ChronoDuration, TimeZone, Utc};
    use std::sync::Arc;

    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::Mutex;

    use super::{
        classify_idle_runtime_candidates, collect_idle_runtime_candidates,
        finish_headless_read, read_account_from_target, read_auth_status_from_target,
        resolve_binary_path, should_stop_idle_runtime_candidate, touch_running_runtime,
        AppServerAuthStatus, RunningRuntime, RuntimeReadTarget, RuntimeRegistry,
    };
    use crate::domain::conversation::{
        ConversationComposerSettings, ConversationMessageItem, ConversationRole,
        ConversationStatus, SubagentThreadSnapshot, ThreadConversationSnapshot,
    };
    use crate::domain::settings::{ApprovalPolicy, CollaborationMode, ReasoningEffort};
    use crate::domain::voice::VoiceAuthMode;
    use crate::domain::workspace::{RuntimeState, RuntimeStatusSnapshot};
    use crate::error::AppError;
    use crate::runtime::protocol::AccountReadAuthTypeWire;
    use crate::runtime::session::RuntimeSession;

    #[tokio::test]
    async fn running_read_auth_status_uses_the_active_session() {
        let (session, harness) = spawn_test_session().await;

        let auth_status =
            read_auth_status_from_target(RuntimeReadTarget::Running(Arc::new(session)), true, true)
                .await
                .expect("running auth status should load");

        assert_eq!(auth_status.auth_method, Some(VoiceAuthMode::Chatgpt));
        assert_eq!(auth_status.auth_token.as_deref(), Some("token-123"));

        let requests = harness.requests().await;
        let auth_request = requests
            .iter()
            .find(|request| request.method == "getAuthStatus")
            .expect("getAuthStatus request should be recorded");
        assert_eq!(auth_request.params["includeToken"], true);
        assert_eq!(auth_request.params["refreshToken"], true);
    }

    #[tokio::test]
    async fn running_read_account_uses_the_active_session() {
        let (session, harness) = spawn_test_session().await;

        let account =
            read_account_from_target(RuntimeReadTarget::Running(Arc::new(session)), false)
                .await
                .expect("running account read should load");

        assert_eq!(
            account.account.as_ref().map(|account| account.auth_type),
            Some(AccountReadAuthTypeWire::Chatgpt)
        );
        assert!(!account.requires_openai_auth);

        let requests = harness.requests().await;
        let account_request = requests
            .iter()
            .find(|request| request.method == "account/read")
            .expect("account/read request should be recorded");
        assert_eq!(account_request.params["refreshToken"], false);
    }

    #[test]
    fn touch_updates_last_activity_for_a_running_runtime() {
        let mut registry = RuntimeRegistry::default();
        let initial_activity_at = Utc
            .with_ymd_and_hms(2026, 4, 12, 10, 0, 0)
            .single()
            .expect("valid timestamp");
        let touched_at = initial_activity_at + ChronoDuration::minutes(5);
        registry.running.insert(
            "env-1".to_string(),
            RunningRuntime {
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
                status: make_runtime_status("env-1"),
                last_activity_at: initial_activity_at,
            },
        );

        let touched = touch_running_runtime(&mut registry, "env-1", touched_at);

        assert!(touched);
        assert_eq!(
            registry
                .running
                .get("env-1")
                .expect("runtime should stay registered")
                .last_activity_at,
            touched_at
        );
    }

    #[test]
    fn collect_idle_runtime_candidates_only_returns_expired_runtimes() {
        let stale_activity_at = Utc
            .with_ymd_and_hms(2026, 4, 12, 10, 0, 0)
            .single()
            .expect("valid timestamp");
        let fresh_activity_at = stale_activity_at + ChronoDuration::minutes(9);
        let now = stale_activity_at + ChronoDuration::minutes(11);
        let mut registry = RuntimeRegistry::default();
        registry.running.insert(
            "env-stale".to_string(),
            RunningRuntime {
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
                status: make_runtime_status("env-stale"),
                last_activity_at: stale_activity_at,
            },
        );
        registry.running.insert(
            "env-fresh".to_string(),
            RunningRuntime {
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
                status: make_runtime_status("env-fresh"),
                last_activity_at: fresh_activity_at,
            },
        );

        let candidates =
            collect_idle_runtime_candidates(&registry, now, ChronoDuration::minutes(10));

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].environment_id, "env-stale");
    }

    #[tokio::test]
    async fn idle_classification_skips_sessions_with_keep_alive_work() {
        let candidates = vec![
            super::IdleRuntimeCandidate {
                environment_id: "env-idle".to_string(),
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
            },
            super::IdleRuntimeCandidate {
                environment_id: "env-active".to_string(),
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_waiting_snapshot(),
                )),
            },
        ];

        let classification = classify_idle_runtime_candidates(candidates).await;

        assert_eq!(classification.evictable_candidates.len(), 1);
        assert_eq!(
            classification.evictable_candidates[0].environment_id,
            "env-idle"
        );
        assert_eq!(
            classification.keep_alive_environment_ids,
            vec!["env-active"]
        );
    }

    #[tokio::test]
    async fn idle_revalidation_skips_candidates_touched_after_collection() {
        let initial_activity_at = Utc
            .with_ymd_and_hms(2026, 4, 12, 10, 0, 0)
            .single()
            .expect("valid timestamp");
        let touched_at = initial_activity_at + ChronoDuration::minutes(12);
        let now = initial_activity_at + ChronoDuration::minutes(11);
        let cutoff = ChronoDuration::minutes(10);
        let session = Arc::new(RuntimeSession::from_snapshot_for_test(
            make_completed_snapshot(),
        ));
        let candidate = super::IdleRuntimeCandidate {
            environment_id: "env-1".to_string(),
            session: session.clone(),
        };
        let mut registry = RuntimeRegistry::default();
        registry.running.insert(
            "env-1".to_string(),
            RunningRuntime {
                session,
                status: make_runtime_status("env-1"),
                last_activity_at: initial_activity_at,
            },
        );
        touch_running_runtime(&mut registry, "env-1", touched_at);

        let should_stop = should_stop_idle_runtime_candidate(
            &Mutex::new(registry),
            &candidate,
            now,
            cutoff,
        )
        .await;

        assert!(!should_stop);
    }

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

    #[test]
    fn headless_read_returns_the_primary_read_error() {
        let result = finish_headless_read::<AppServerAuthStatus>(
            Err(AppError::Runtime("read failed".to_string())),
            Ok(()),
        )
        .unwrap_err();

        assert!(matches!(
            result,
            AppError::Runtime(message) if message == "read failed"
        ));
    }

    #[test]
    fn headless_read_returns_auth_after_a_clean_stop() {
        let auth_status = finish_headless_read(
            Ok(AppServerAuthStatus {
                auth_method: Some(VoiceAuthMode::Chatgpt),
                auth_token: Some("token-123".to_string()),
                requires_openai_auth: Some(false),
            }),
            Ok(()),
        )
        .expect("successful headless reads should preserve auth data");

        assert_eq!(auth_status.auth_method, Some(VoiceAuthMode::Chatgpt));
        assert_eq!(auth_status.auth_token.as_deref(), Some("token-123"));
    }

    #[test]
    fn headless_read_returns_stop_error_after_a_successful_read() {
        let result = finish_headless_read(
            Ok(AppServerAuthStatus {
                auth_method: Some(VoiceAuthMode::Chatgpt),
                auth_token: Some("token-123".to_string()),
                requires_openai_auth: Some(false),
            }),
            Err(AppError::Runtime("stop failed".to_string())),
        )
        .unwrap_err();

        assert!(matches!(
            result,
            AppError::Runtime(message) if message == "stop failed"
        ));
    }

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        method: String,
        params: Value,
    }

    struct FakeCodexHarness {
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FakeCodexHarness {
        async fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().await.clone()
        }
    }

    impl Drop for FakeCodexHarness {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn spawn_test_session() -> (RuntimeSession, FakeCodexHarness) {
        let (client_writer, server_reader) = duplex(32 * 1024);
        let (server_writer, client_reader) = duplex(32 * 1024);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let task = spawn_fake_codex(server_reader, server_writer, requests.clone());
        let session = RuntimeSession::from_test_transport(
            "env-1".to_string(),
            "/tmp/skein".to_string(),
            "0.1.0".to_string(),
            client_writer,
            client_reader,
        )
        .await
        .expect("test runtime should initialize");

        (session, FakeCodexHarness { requests, task })
    }

    fn make_runtime_status(environment_id: &str) -> RuntimeStatusSnapshot {
        RuntimeStatusSnapshot {
            environment_id: environment_id.to_string(),
            state: RuntimeState::Running,
            pid: Some(123),
            binary_path: Some("/opt/homebrew/bin/codex".to_string()),
            started_at: Some(
                Utc.with_ymd_and_hms(2026, 4, 12, 10, 0, 0)
                    .single()
                    .expect("valid timestamp"),
            ),
            last_exit_code: None,
        }
    }

    fn make_completed_snapshot() -> ThreadConversationSnapshot {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.status = ConversationStatus::Completed;
        snapshot.items.push(crate::domain::conversation::ConversationItem::Message(
            ConversationMessageItem {
                id: "assistant-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: ConversationRole::Assistant,
                text: "Done".to_string(),
                images: None,
                is_streaming: false,
            },
        ));
        snapshot
    }

    fn make_waiting_snapshot() -> ThreadConversationSnapshot {
        let mut snapshot = make_completed_snapshot();
        snapshot.status = ConversationStatus::WaitingForExternalAction;
        snapshot.subagents = vec![SubagentThreadSnapshot {
            thread_id: "subagent-1".to_string(),
            nickname: Some("Scout".to_string()),
            role: Some("explorer".to_string()),
            depth: 1,
            status: crate::domain::conversation::SubagentStatus::Running,
        }];
        snapshot
    }

    fn spawn_fake_codex(
        reader: DuplexStream,
        writer: DuplexStream,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let writer = Arc::new(Mutex::new(writer));
            let mut lines = BufReader::new(reader).lines();

            while let Ok(Some(line)) = lines.next_line().await {
                let payload = serde_json::from_str::<Value>(&line).expect("json-rpc should parse");
                let Some(method) = payload.get("method").and_then(Value::as_str) else {
                    continue;
                };
                let id = payload.get("id").cloned().unwrap_or(Value::Null);
                let params = payload.get("params").cloned().unwrap_or(Value::Null);
                requests.lock().await.push(RecordedRequest {
                    method: method.to_string(),
                    params: params.clone(),
                });

                let response = match method {
                    "initialize" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    "model/list" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "data": [{
                                "id": "gpt-5.4",
                                "displayName": "GPT-5.4",
                                "description": "Main Codex model",
                                "supportedReasoningEfforts": [{"reasoningEffort": "medium"}],
                                "defaultReasoningEffort": "medium",
                                "isDefault": true,
                                "hidden": false
                            }]
                        }
                    }),
                    "collaborationMode/list" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "data": [{ "name": "build", "mode": "default" }] }
                    }),
                    "skills/list" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "data": [{ "cwd": "/tmp/skein", "skills": [], "errors": [] }] }
                    }),
                    "app/list" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "data": [], "nextCursor": null }
                    }),
                    "account/read" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "account": {
                                "type": "chatgpt",
                                "email": "codex@example.com",
                                "planType": "plus"
                            },
                            "requiresOpenaiAuth": false
                        }
                    }),
                    "getAuthStatus" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "authMethod": "chatgpt",
                            "authToken": params["includeToken"]
                                .as_bool()
                                .filter(|include_token| *include_token)
                                .map(|_| "token-123"),
                            "requiresOpenaiAuth": false
                        }
                    }),
                    _ => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": format!("unsupported method: {method}") }
                    }),
                };

                let mut writer = writer.lock().await;
                writer
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .expect("response should write");
                writer.flush().await.expect("response should flush");
            }
        })
    }
}
