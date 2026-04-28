use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use tracing::warn;

use crate::app_identity::{CODEX_USAGE_EVENT_NAME, WORKSPACE_EVENT_NAME};
use crate::domain::conversation::{
    ApprovalResponseInput, ComposerMentionBindingInput, ConversationImageAttachment,
    EnvironmentCapabilitiesSnapshot, RespondToUserInputRequestInput, SubmitPlanDecisionInput,
    ThreadComposerCatalog, ThreadConversationOpenResponse, ThreadConversationSnapshot,
};
use crate::domain::settings::ProviderKind;
use crate::domain::workspace::{
    CodexCreditsSnapshot, CodexPlanType, CodexRateLimitSnapshot, CodexRateLimitWindow,
    RuntimeState, RuntimeStatusSnapshot, WorkspaceEvent, WorkspaceEventKind,
};
use crate::error::{AppError, AppResult};
use crate::events::EventSink;
use crate::runtime::claude::{append_claude_provider, ClaudeRuntimeSession};
use crate::runtime::codex_paths::resolve_codex_binary_path;
use crate::runtime::protocol::AccountReadResponse;
use crate::runtime::session::{AppServerAuthStatus, RuntimeSession, SendMessageResult};
use crate::serde_helpers::deserialize_explicit_optional;
use crate::services::composer::{
    build_claude_thread_catalog, load_claude_command_definitions, load_claude_skill_definitions,
};
use crate::services::workspace::{
    ComposerTargetContext, EnvironmentRuntimeTarget, ThreadRuntimeContext,
};

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

struct HeadlessSession {
    handle: SharedHeadlessHandle,
    environment_path: String,
    binary_path: String,
    last_activity_at: DateTime<Utc>,
}

enum RuntimeReadTarget {
    Running(Arc<RuntimeSession>),
    SharedHeadless(SharedHeadlessLease),
    Headless(Box<RuntimeSession>),
}

#[derive(Clone)]
struct SharedHeadlessHandle {
    session: Arc<RuntimeSession>,
    active_readers: Arc<AtomicUsize>,
}

struct SharedHeadlessLease {
    handle: SharedHeadlessHandle,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeUsageUpdate {
    pub environment_id: String,
    pub environment_path: String,
    pub codex_binary_path: Option<String>,
    pub rate_limits: Value,
}

impl RuntimeUsageUpdate {
    fn confirmation_fallback(&self) -> UsageConfirmationFallback {
        UsageConfirmationFallback {
            environment_id: self.environment_id.clone(),
            environment_path: self.environment_path.clone(),
            codex_binary_path: self.codex_binary_path.clone(),
        }
    }
}

#[derive(Default)]
struct RuntimeRegistry {
    running: HashMap<String, RunningRuntime>,
    last_known: HashMap<String, RuntimeStatusSnapshot>,
}

#[derive(Default)]
struct AccountUsageState {
    snapshot: Option<CodexRateLimitSnapshot>,
    confirmation_inflight: bool,
}

pub struct RuntimeSupervisor {
    events: EventSink,
    app_version: String,
    registry: Arc<Mutex<RuntimeRegistry>>,
    claude: Arc<ClaudeRuntimeSession>,
    environment_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    headless_sessions: Arc<Mutex<HashMap<String, HeadlessSession>>>,
    account_usage: Arc<Mutex<AccountUsageState>>,
    usage_updates: mpsc::UnboundedSender<RuntimeUsageUpdate>,
}

pub const RUNTIME_IDLE_REAPER_INTERVAL: Duration = Duration::from_secs(60);
pub const RUNTIME_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const HEADLESS_SESSION_RETIRE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UsageUpdateOrigin {
    LiveNotification,
    DirectRead,
    ConfirmationRead,
}

#[derive(Debug, Clone)]
struct UsageConfirmationFallback {
    environment_id: String,
    environment_path: String,
    codex_binary_path: Option<String>,
}

#[derive(Debug, Clone)]
struct UsageApplyResult {
    snapshot: CodexRateLimitSnapshot,
    changed: bool,
    confirmation_requested: bool,
}

#[derive(Debug, Clone)]
struct UsageMergeResult {
    snapshot: CodexRateLimitSnapshot,
    regression_detected: bool,
}

#[derive(Debug, Clone)]
struct WindowMergeResult {
    window: Option<CodexRateLimitWindow>,
    regression_detected: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageEventPayload<'a> {
    environment_id: &'a str,
    rate_limits: &'a CodexRateLimitSnapshot,
}

#[derive(Debug, Clone, Copy)]
struct UsageWindowContext<'a> {
    plan_type: Option<&'a CodexPlanType>,
    limit_id: Option<&'a str>,
    limit_name: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindowPatch {
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    resets_at: Option<Option<i64>>,
    #[serde(default)]
    used_percent: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    window_duration_mins: Option<Option<i64>>,
}

impl CodexRateLimitWindowPatch {
    fn is_empty(&self) -> bool {
        self.resets_at.is_none()
            && self.used_percent.is_none()
            && self.window_duration_mins.is_none()
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitSnapshotPatch {
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    credits: Option<Option<CodexCreditsSnapshot>>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    limit_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    limit_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    plan_type: Option<Option<CodexPlanType>>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    primary: Option<Option<CodexRateLimitWindowPatch>>,
    #[serde(default, deserialize_with = "deserialize_explicit_optional")]
    secondary: Option<Option<CodexRateLimitWindowPatch>>,
}

impl CodexRateLimitSnapshotPatch {
    fn is_empty(&self) -> bool {
        self.credits.is_none()
            && self.limit_id.is_none()
            && self.limit_name.is_none()
            && self.plan_type.is_none()
            && patch_window_is_empty(self.primary.as_ref())
            && patch_window_is_empty(self.secondary.as_ref())
    }
}

fn patch_window_is_empty(window: Option<&Option<CodexRateLimitWindowPatch>>) -> bool {
    match window {
        None => true,
        Some(None) => false,
        Some(Some(window)) => window.is_empty(),
    }
}

impl SharedHeadlessHandle {
    fn new(session: Arc<RuntimeSession>) -> Self {
        Self {
            session,
            active_readers: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn acquire(&self) -> SharedHeadlessLease {
        self.active_readers.fetch_add(1, Ordering::Relaxed);
        SharedHeadlessLease {
            handle: self.clone(),
        }
    }
}

impl SharedHeadlessLease {
    fn session(&self) -> &Arc<RuntimeSession> {
        &self.handle.session
    }
}

impl Drop for SharedHeadlessLease {
    fn drop(&mut self) {
        self.handle.active_readers.fetch_sub(1, Ordering::Relaxed);
    }
}

impl RuntimeSupervisor {
    pub fn new(events: EventSink, app_version: String) -> Self {
        let registry = Arc::new(Mutex::new(RuntimeRegistry::default()));
        let environment_locks = Arc::new(Mutex::new(HashMap::new()));
        let headless_sessions = Arc::new(Mutex::new(HashMap::new()));
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));
        let (usage_updates, usage_update_rx) = mpsc::unbounded_channel();
        spawn_usage_update_task(
            events.clone(),
            app_version.clone(),
            registry.clone(),
            account_usage.clone(),
            usage_update_rx,
        );
        let claude = Arc::new(ClaudeRuntimeSession::new(
            events.clone(),
            app_version.clone(),
        ));

        Self {
            events,
            app_version,
            registry,
            claude,
            environment_locks,
            headless_sessions,
            account_usage,
            usage_updates,
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
                registry.last_known.insert(environment_id.clone(), status);
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
        runtime_target: &EnvironmentRuntimeTarget,
    ) -> AppResult<RuntimeStatusSnapshot> {
        if matches!(runtime_target.provider, ProviderKind::Claude) {
            return Ok(RuntimeStatusSnapshot {
                environment_id: environment_id.to_string(),
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: runtime_target.claude_binary_path.clone(),
                started_at: None,
                last_exit_code: None,
            });
        }
        Ok(self
            .ensure_running_runtime(environment_id, runtime_target)
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
            .resolve_read_target(environment_id, environment_path, codex_binary_path.clone())
            .await?;

        let snapshot = read_account_rate_limits_from_target(read_target).await?;
        let apply_result = store_account_usage_snapshot_from_read(
            &self.events,
            &self.app_version,
            &self.registry,
            &self.account_usage,
            snapshot,
            UsageUpdateOrigin::DirectRead,
            Some(UsageConfirmationFallback {
                environment_id: environment_id.to_string(),
                environment_path: environment_path.to_string(),
                codex_binary_path,
            }),
        )
        .await?;

        Ok(apply_result.snapshot)
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

    pub async fn read_capabilities(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<EnvironmentCapabilitiesSnapshot> {
        let read_target = self
            .resolve_read_target(environment_id, environment_path, codex_binary_path)
            .await?;

        let mut capabilities = read_capabilities_from_target(read_target).await?;
        append_claude_provider(&mut capabilities);
        Ok(capabilities)
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
        runtime_target: &EnvironmentRuntimeTarget,
    ) -> AppResult<RunningRuntime> {
        let environment_lock = self.environment_lock(environment_id).await;
        let _environment_guard = environment_lock.lock().await;
        self.refresh_statuses().await?;

        if let Some(runtime) = self.running_runtime(environment_id).await {
            self.mark_runtime_activity(environment_id).await;
            if let Some(session) = {
                let mut sessions = self.headless_sessions.lock().await;
                take_headless_session(&mut sessions, environment_id)
            } {
                retire_headless_session(
                    environment_id.to_string(),
                    session,
                    "runtime became active",
                );
            }
            return Ok(runtime);
        }

        if let Some(session) = {
            let mut sessions = self.headless_sessions.lock().await;
            take_headless_session(&mut sessions, environment_id)
        } {
            retire_headless_session(
                environment_id.to_string(),
                session,
                "starting a long-lived runtime",
            );
        }

        let binary_path = resolve_binary_path(runtime_target.codex_binary_path.clone())?;

        let now = Utc::now();
        let session = Arc::new(
            RuntimeSession::spawn(
                self.events.clone(),
                environment_id.to_string(),
                runtime_target.environment_path.clone(),
                binary_path.clone(),
                self.app_version.clone(),
                runtime_target.stream_assistant_responses,
                self.usage_updates.clone(),
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
        self.schedule_runtime_usage_priming(environment_id, runtime_target, &session);

        Ok(RunningRuntime {
            session,
            status,
            last_activity_at: now,
        })
    }

    fn schedule_runtime_usage_priming(
        &self,
        environment_id: &str,
        runtime_target: &EnvironmentRuntimeTarget,
        session: &Arc<RuntimeSession>,
    ) {
        let events = self.events.clone();
        let app_version = self.app_version.clone();
        let registry = self.registry.clone();
        let account_usage = self.account_usage.clone();
        let environment_id = environment_id.to_string();
        let session = session.clone();
        let confirmation_fallback = UsageConfirmationFallback {
            environment_id: environment_id.clone(),
            environment_path: runtime_target.environment_path.clone(),
            codex_binary_path: runtime_target.codex_binary_path.clone(),
        };

        tokio::spawn(async move {
            if let Err(error) = prime_running_runtime_usage(
                &events,
                &app_version,
                &registry,
                &account_usage,
                &environment_id,
                session,
                confirmation_fallback,
            )
            .await
            {
                warn!("failed to prime Codex usage for running runtime {environment_id}: {error}");
            }
        });
    }

    async fn environment_lock(&self, environment_id: &str) -> Arc<Mutex<()>> {
        let mut environment_locks = self.environment_locks.lock().await;
        environment_locks
            .entry(environment_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn resolve_file_search_target(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RuntimeReadTarget> {
        self.resolve_shared_headless_target(environment_id, environment_path, codex_binary_path)
            .await
    }

    async fn resolve_shared_headless_target(
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
            if let Some(session) = {
                let mut sessions = self.headless_sessions.lock().await;
                take_headless_session(&mut sessions, environment_id)
            } {
                retire_headless_session(
                    environment_id.to_string(),
                    session,
                    "handing off to a running runtime",
                );
            }
            return Ok(RuntimeReadTarget::Running(runtime.session));
        }

        let binary_path = resolve_binary_path(codex_binary_path)?;
        if let Some(stale) = {
            let mut sessions = self.headless_sessions.lock().await;
            take_mismatched_headless_session(
                &mut sessions,
                environment_id,
                environment_path,
                &binary_path,
            )
        } {
            retire_headless_session(
                environment_id.to_string(),
                stale,
                "replacing a stale headless session",
            );
        }

        let now = Utc::now();
        let cached_session = {
            let sessions = self.headless_sessions.lock().await;
            sessions
                .get(environment_id)
                .map(|entry| entry.handle.clone())
        };
        if let Some(handle) = cached_session {
            if handle.session.try_wait().await?.is_none() {
                let reused = {
                    let mut sessions = self.headless_sessions.lock().await;
                    touch_headless_session(&mut sessions, environment_id, now)
                };
                if let Some(reused) = reused {
                    return Ok(RuntimeReadTarget::SharedHeadless(reused));
                }
            } else if let Some(stale) = {
                let mut sessions = self.headless_sessions.lock().await;
                take_headless_session(&mut sessions, environment_id)
            } {
                if let Err(error) = stale.session.stop().await {
                    warn!(
                        environment_id,
                        "failed to stop exited shared headless session: {error}"
                    );
                }
            }
        }

        let handle = SharedHeadlessHandle::new(Arc::new(
            RuntimeSession::spawn_headless(
                environment_id.to_string(),
                environment_path.to_string(),
                binary_path.clone(),
                self.app_version.clone(),
                true,
            )
            .await?,
        ));
        {
            let mut sessions = self.headless_sessions.lock().await;
            store_headless_session(
                &mut sessions,
                environment_id.to_string(),
                handle.clone(),
                environment_path.to_string(),
                binary_path,
                now,
            );
        }
        Ok(RuntimeReadTarget::SharedHeadless(handle.acquire()))
    }

    async fn resolve_read_target(
        &self,
        environment_id: &str,
        environment_path: &str,
        codex_binary_path: Option<String>,
    ) -> AppResult<RuntimeReadTarget> {
        self.resolve_shared_headless_target(environment_id, environment_path, codex_binary_path)
            .await
    }

    pub async fn stop(&self, environment_id: &str) -> AppResult<RuntimeStatusSnapshot> {
        let headless_search = {
            let mut sessions = self.headless_sessions.lock().await;
            take_headless_session(&mut sessions, environment_id)
        };
        if let Some(session) = headless_search {
            retire_headless_session(
                environment_id.to_string(),
                session,
                "environment stop requested",
            );
        }

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
        Ok(touch_running_runtime(
            &mut registry,
            environment_id,
            Utc::now(),
        ))
    }

    pub async fn open_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationOpenResponse> {
        if matches!(context.provider, ProviderKind::Claude) {
            let mut response = self.claude.open_thread(context.clone()).await?;
            let fallback_capabilities = response.capabilities.clone();
            response.capabilities = match self
                .read_capabilities(
                    &context.environment_id,
                    &context.environment_path,
                    context.codex_binary_path.clone(),
                )
                .await
            {
                Ok(capabilities) => capabilities,
                Err(error) => {
                    warn!(
                        environment_id = %context.environment_id,
                        "failed to enrich Claude open response with Codex capabilities: {error}"
                    );
                    fallback_capabilities
                }
            };
            return Ok(response);
        }
        let session = self.ensure_runtime(&context).await?;
        session.open_thread(context).await
    }

    pub async fn cached_thread_snapshot(
        &self,
        context: &ThreadRuntimeContext,
    ) -> Option<ThreadConversationSnapshot> {
        if matches!(context.provider, ProviderKind::Claude) {
            return self.claude.cached_thread_snapshot(context).await;
        }
        let runtime = self.running_runtime(&context.environment_id).await?;
        runtime.session.cached_thread_snapshot(context).await
    }

    pub async fn get_composer_catalog(
        &self,
        context: ComposerTargetContext,
    ) -> AppResult<ThreadComposerCatalog> {
        if matches!(context.provider, ProviderKind::Claude) {
            let commands = load_claude_command_definitions(&context.environment_path)?;
            let skills = load_claude_skill_definitions(&context.environment_path)?;
            return Ok(build_claude_thread_catalog(&commands, &skills));
        }
        let read_target = self
            .resolve_read_target(
                &context.environment_id,
                &context.environment_path,
                context.codex_binary_path.clone(),
            )
            .await?;
        read_composer_catalog_from_target(
            read_target,
            &context.environment_path,
            context.codex_thread_id.as_deref(),
        )
        .await
    }

    pub async fn search_composer_files(
        &self,
        context: ComposerTargetContext,
        request_key: &str,
        query: String,
        limit: usize,
    ) -> AppResult<Vec<crate::domain::conversation::ComposerFileSearchResult>> {
        validate_composer_file_search_context(&context)?;
        if matches!(context.provider, ProviderKind::Claude) {
            return Err(AppError::Validation(
                "File search is not available in Claude composer yet.".to_string(),
            ));
        }

        let read_target = self
            .resolve_file_search_target(
                &context.environment_id,
                &context.environment_path,
                context.codex_binary_path.clone(),
            )
            .await?;
        search_files_from_target(
            read_target,
            &context.environment_path,
            request_key,
            query,
            limit,
        )
        .await
    }

    pub async fn send_thread_message(
        &self,
        context: ThreadRuntimeContext,
        text: String,
        images: Vec<ConversationImageAttachment>,
        mention_bindings: Vec<ComposerMentionBindingInput>,
    ) -> AppResult<SendMessageResult> {
        if matches!(context.provider, ProviderKind::Claude) {
            return self
                .claude
                .send_message(context, text, images, mention_bindings)
                .await;
        }
        let session = self.ensure_runtime(&context).await?;
        session
            .send_message_with_bindings(context, text, images, mention_bindings)
            .await
    }

    pub async fn refresh_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        if matches!(context.provider, ProviderKind::Claude) {
            return self.claude.refresh_thread(context).await;
        }
        let session = self.ensure_runtime(&context).await?;
        session.refresh_thread(context).await
    }

    pub async fn interrupt_thread(
        &self,
        context: ThreadRuntimeContext,
    ) -> AppResult<ThreadConversationSnapshot> {
        if matches!(context.provider, ProviderKind::Claude) {
            return self.claude.interrupt_thread(context).await;
        }
        let session = self.ensure_runtime(&context).await?;
        session.interrupt_thread(context).await
    }

    pub async fn respond_to_approval_request(
        &self,
        context: ThreadRuntimeContext,
        interaction_id: &str,
        response: ApprovalResponseInput,
    ) -> AppResult<ThreadConversationSnapshot> {
        if matches!(context.provider, ProviderKind::Claude) {
            return self
                .claude
                .respond_to_approval_request(&context.thread_id, interaction_id, response)
                .await;
        }
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
        if matches!(context.provider, ProviderKind::Claude) {
            if input.thread_id != context.thread_id {
                return Err(AppError::Validation(
                    "User input response thread id does not match the active context.".to_string(),
                ));
            }
            return self.claude.respond_to_user_input_request(input).await;
        }
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
        if matches!(context.provider, ProviderKind::Claude) {
            if input.thread_id != context.thread_id {
                return Err(AppError::Validation(
                    "Plan decision thread id does not match the active context.".to_string(),
                ));
            }
            return self.claude.submit_plan_decision(context, input).await;
        }
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
            if !should_stop_idle_runtime_candidate(&self.registry, &candidate, Utc::now(), cutoff)
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

        let idle_headless_sessions = {
            let mut sessions = self.headless_sessions.lock().await;
            take_idle_headless_sessions(&mut sessions, now, cutoff)
        };
        for (environment_id, session) in idle_headless_sessions {
            retire_headless_session(environment_id, session, "evicting an idle headless session");
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
        self.events.emit(
            WORKSPACE_EVENT_NAME,
            WorkspaceEvent {
                kind: WorkspaceEventKind::RuntimeStatusChanged,
                project_id: None,
                environment_id: Some(environment_id.to_string()),
                thread_id: None,
            },
        );
    }

    async fn ensure_runtime(
        &self,
        context: &ThreadRuntimeContext,
    ) -> AppResult<Arc<RuntimeSession>> {
        Ok(self
            .ensure_running_runtime(
                &context.environment_id,
                &context.environment_runtime_target(),
            )
            .await?
            .session)
    }
}

fn spawn_usage_update_task(
    events: EventSink,
    app_version: String,
    registry: Arc<Mutex<RuntimeRegistry>>,
    account_usage: Arc<Mutex<AccountUsageState>>,
    mut usage_update_rx: mpsc::UnboundedReceiver<RuntimeUsageUpdate>,
) {
    tokio::spawn(async move {
        while let Some(update) = usage_update_rx.recv().await {
            let confirmation_fallback = update.confirmation_fallback();
            let apply_result = match apply_account_usage_patch(
                &account_usage,
                update.rate_limits,
                UsageUpdateOrigin::LiveNotification,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    warn!("dropping invalid Codex usage update: {error}");
                    continue;
                }
            };

            if apply_result.changed {
                emit_account_usage_event(&events, &update.environment_id, &apply_result.snapshot);
            }

            schedule_usage_confirmation_if_needed(
                &events,
                &app_version,
                &registry,
                &account_usage,
                apply_result.confirmation_requested,
                Some(confirmation_fallback),
            );
        }
    });
}

async fn apply_account_usage_patch(
    account_usage: &Arc<Mutex<AccountUsageState>>,
    rate_limits: Value,
    origin: UsageUpdateOrigin,
) -> AppResult<UsageApplyResult> {
    let patch =
        serde_json::from_value::<CodexRateLimitSnapshotPatch>(rate_limits).map_err(|error| {
            AppError::Runtime(format!("Failed to decode Codex usage update: {error}"))
        })?;
    apply_account_usage_patch_struct(account_usage, patch, origin).await
}

async fn apply_account_usage_snapshot(
    account_usage: &Arc<Mutex<AccountUsageState>>,
    snapshot: CodexRateLimitSnapshot,
    origin: UsageUpdateOrigin,
) -> AppResult<UsageApplyResult> {
    apply_account_usage_patch_struct(
        account_usage,
        usage_snapshot_patch_from_snapshot(snapshot),
        origin,
    )
    .await
}

async fn apply_account_usage_patch_struct(
    account_usage: &Arc<Mutex<AccountUsageState>>,
    patch: CodexRateLimitSnapshotPatch,
    origin: UsageUpdateOrigin,
) -> AppResult<UsageApplyResult> {
    if patch.is_empty() {
        return Err(AppError::Runtime(
            "Codex usage update did not contain any usable fields.".to_string(),
        ));
    }

    let mut usage = account_usage.lock().await;
    let previous = usage.snapshot.clone();
    let merge_result = merge_account_usage_snapshot(previous.as_ref(), &patch);

    let changed = previous.as_ref() != Some(&merge_result.snapshot);
    usage.snapshot = Some(merge_result.snapshot.clone());

    let confirmation_requested = merge_result.regression_detected
        && !matches!(origin, UsageUpdateOrigin::ConfirmationRead)
        && !usage.confirmation_inflight;
    if confirmation_requested {
        usage.confirmation_inflight = true;
    }

    Ok(UsageApplyResult {
        snapshot: merge_result.snapshot,
        changed,
        confirmation_requested,
    })
}

async fn store_account_usage_snapshot_from_read(
    events: &EventSink,
    app_version: &str,
    registry: &Arc<Mutex<RuntimeRegistry>>,
    account_usage: &Arc<Mutex<AccountUsageState>>,
    snapshot: CodexRateLimitSnapshot,
    origin: UsageUpdateOrigin,
    confirmation_fallback: Option<UsageConfirmationFallback>,
) -> AppResult<UsageApplyResult> {
    let apply_result = apply_account_usage_snapshot(account_usage, snapshot, origin).await?;
    schedule_usage_confirmation_if_needed(
        events,
        app_version,
        registry,
        account_usage,
        apply_result.confirmation_requested,
        confirmation_fallback,
    );
    Ok(apply_result)
}

async fn prime_running_runtime_usage(
    events: &EventSink,
    app_version: &str,
    registry: &Arc<Mutex<RuntimeRegistry>>,
    account_usage: &Arc<Mutex<AccountUsageState>>,
    environment_id: &str,
    session: Arc<RuntimeSession>,
    confirmation_fallback: UsageConfirmationFallback,
) -> AppResult<CodexRateLimitSnapshot> {
    let snapshot = session.read_account_rate_limits().await?;
    let apply_result = store_account_usage_snapshot_from_read(
        events,
        app_version,
        registry,
        account_usage,
        snapshot,
        UsageUpdateOrigin::DirectRead,
        Some(confirmation_fallback),
    )
    .await?;

    if apply_result.changed {
        emit_account_usage_event(events, environment_id, &apply_result.snapshot);
    }

    Ok(apply_result.snapshot)
}

fn schedule_usage_confirmation_if_needed(
    events: &EventSink,
    app_version: &str,
    registry: &Arc<Mutex<RuntimeRegistry>>,
    account_usage: &Arc<Mutex<AccountUsageState>>,
    confirmation_requested: bool,
    fallback: Option<UsageConfirmationFallback>,
) {
    if !confirmation_requested {
        return;
    }

    schedule_usage_confirmation(
        events.clone(),
        app_version.to_string(),
        registry.clone(),
        account_usage.clone(),
        fallback,
    );
}

fn schedule_usage_confirmation(
    events: EventSink,
    app_version: String,
    registry: Arc<Mutex<RuntimeRegistry>>,
    account_usage: Arc<Mutex<AccountUsageState>>,
    fallback: Option<UsageConfirmationFallback>,
) {
    tokio::spawn(async move {
        let confirmation =
            read_usage_confirmation_snapshot(&registry, &app_version, fallback).await;

        match confirmation {
            Ok(Some((environment_id, snapshot))) => {
                match apply_account_usage_snapshot(
                    &account_usage,
                    snapshot,
                    UsageUpdateOrigin::ConfirmationRead,
                )
                .await
                {
                    Ok(result) => {
                        if result.changed {
                            emit_account_usage_event(&events, &environment_id, &result.snapshot);
                        }
                    }
                    Err(error) => {
                        warn!("failed to apply confirmed Codex usage snapshot: {error}");
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                warn!("failed to confirm Codex usage snapshot: {error}");
            }
        }

        account_usage.lock().await.confirmation_inflight = false;
    });
}

async fn read_usage_confirmation_snapshot(
    registry: &Arc<Mutex<RuntimeRegistry>>,
    app_version: &str,
    fallback: Option<UsageConfirmationFallback>,
) -> AppResult<Option<(String, CodexRateLimitSnapshot)>> {
    if let Some((environment_id, session)) = latest_running_usage_source(registry).await {
        match session.read_account_rate_limits().await {
            Ok(snapshot) => return Ok(Some((environment_id, snapshot))),
            Err(error) => {
                warn!(
                    "failed to read confirmation usage from running runtime {environment_id}: {error}"
                );
            }
        }
    }

    let Some(fallback) = fallback else {
        return Ok(None);
    };

    let binary_path = resolve_binary_path(fallback.codex_binary_path)?;
    let session = RuntimeSession::spawn_headless(
        fallback.environment_id.clone(),
        fallback.environment_path,
        binary_path,
        app_version.to_string(),
        true,
    )
    .await?;
    let snapshot =
        read_account_rate_limits_from_target(RuntimeReadTarget::Headless(Box::new(session)))
            .await?;

    Ok(Some((fallback.environment_id, snapshot)))
}

async fn latest_running_usage_source(
    registry: &Arc<Mutex<RuntimeRegistry>>,
) -> Option<(String, Arc<RuntimeSession>)> {
    let registry = registry.lock().await;
    registry
        .running
        .iter()
        .max_by_key(|(_, runtime)| runtime.last_activity_at)
        .map(|(environment_id, runtime)| (environment_id.clone(), runtime.session.clone()))
}

fn emit_account_usage_event(
    events: &EventSink,
    environment_id: &str,
    snapshot: &CodexRateLimitSnapshot,
) {
    events.emit(
        CODEX_USAGE_EVENT_NAME,
        CodexUsageEventPayload {
            environment_id,
            rate_limits: snapshot,
        },
    );
}

fn merge_account_usage_snapshot(
    previous: Option<&CodexRateLimitSnapshot>,
    patch: &CodexRateLimitSnapshotPatch,
) -> UsageMergeResult {
    let next_credits = merge_patch_value(
        previous.and_then(|snapshot| snapshot.credits.clone()),
        patch.credits.clone(),
    );
    let next_limit_id = merge_patch_value(
        previous.and_then(|snapshot| snapshot.limit_id.clone()),
        patch.limit_id.clone(),
    );
    let next_limit_name = merge_patch_value(
        previous.and_then(|snapshot| snapshot.limit_name.clone()),
        patch.limit_name.clone(),
    );
    let next_plan_type = merge_patch_value(
        previous.and_then(|snapshot| snapshot.plan_type),
        patch.plan_type,
    );

    let previous_context = previous.map(usage_window_context);
    let next_context = UsageWindowContext {
        plan_type: next_plan_type.as_ref(),
        limit_id: next_limit_id.as_deref(),
        limit_name: next_limit_name.as_deref(),
    };
    let same_limit = previous_context.is_none_or(|context| same_usage_limit(context, next_context));
    let previous_windows = same_limit.then_some(previous).flatten();
    let previous_window_context = same_limit.then_some(previous_context).flatten();

    let primary = merge_usage_window(
        previous_windows.and_then(|snapshot| snapshot.primary.as_ref()),
        patch.primary.as_ref(),
        previous_window_context,
        next_context,
    );
    let secondary = merge_usage_window(
        previous_windows.and_then(|snapshot| snapshot.secondary.as_ref()),
        patch.secondary.as_ref(),
        previous_window_context,
        next_context,
    );

    UsageMergeResult {
        snapshot: CodexRateLimitSnapshot {
            credits: next_credits,
            limit_id: next_limit_id,
            limit_name: next_limit_name,
            plan_type: next_plan_type,
            primary: primary.window,
            secondary: secondary.window,
        },
        regression_detected: primary.regression_detected || secondary.regression_detected,
    }
}

fn merge_usage_window(
    previous: Option<&CodexRateLimitWindow>,
    patch: Option<&Option<CodexRateLimitWindowPatch>>,
    previous_context: Option<UsageWindowContext<'_>>,
    next_context: UsageWindowContext<'_>,
) -> WindowMergeResult {
    let Some(patch) = patch else {
        return WindowMergeResult {
            window: previous.cloned(),
            regression_detected: false,
        };
    };

    let Some(patch) = patch else {
        return WindowMergeResult {
            window: None,
            regression_detected: false,
        };
    };

    let Some(used_percent) = patch
        .used_percent
        .or_else(|| previous.map(|window| window.used_percent))
    else {
        return WindowMergeResult {
            window: previous.cloned(),
            regression_detected: false,
        };
    };

    let mut next = CodexRateLimitWindow {
        resets_at: merge_patch_value(
            previous.and_then(|window| window.resets_at),
            patch.resets_at,
        ),
        used_percent,
        window_duration_mins: merge_patch_value(
            previous.and_then(|window| window.window_duration_mins),
            patch.window_duration_mins,
        ),
    };

    let stale_window_detected = previous
        .zip(previous_context)
        .is_some_and(|(current, context)| {
            is_stale_usage_window(context, current, next_context, &next)
        });
    if stale_window_detected {
        return WindowMergeResult {
            window: previous.cloned(),
            regression_detected: false,
        };
    }

    let metadata_advanced_without_usage = previous.is_some()
        && patch.used_percent.is_none()
        && patch_advances_usage_window(previous, patch);
    if metadata_advanced_without_usage {
        return WindowMergeResult {
            window: None,
            regression_detected: false,
        };
    }

    let regression_detected = previous
        .zip(previous_context)
        .is_some_and(|(current, context)| {
            patch.used_percent.is_some()
                && same_usage_window(context, current, next_context, &next)
                && next.used_percent < current.used_percent
        });
    if regression_detected {
        if let Some(current) = previous {
            next.used_percent = current.used_percent;
        }
    }

    WindowMergeResult {
        window: Some(next),
        regression_detected,
    }
}

fn same_usage_window(
    previous_context: UsageWindowContext<'_>,
    previous: &CodexRateLimitWindow,
    next_context: UsageWindowContext<'_>,
    next: &CodexRateLimitWindow,
) -> bool {
    same_usage_limit(previous_context, next_context)
        && previous.resets_at == next.resets_at
        && previous.window_duration_mins == next.window_duration_mins
}

fn is_stale_usage_window(
    previous_context: UsageWindowContext<'_>,
    previous: &CodexRateLimitWindow,
    next_context: UsageWindowContext<'_>,
    next: &CodexRateLimitWindow,
) -> bool {
    same_usage_limit(previous_context, next_context)
        && previous
            .resets_at
            .zip(next.resets_at)
            .is_some_and(|(previous_reset, next_reset)| next_reset < previous_reset)
}

fn same_usage_limit(
    previous_context: UsageWindowContext<'_>,
    next_context: UsageWindowContext<'_>,
) -> bool {
    compatible_usage_limit_field(previous_context.plan_type, next_context.plan_type)
        && compatible_usage_limit_field(previous_context.limit_id, next_context.limit_id)
        && compatible_usage_limit_field(previous_context.limit_name, next_context.limit_name)
}

fn compatible_usage_limit_field<T>(previous: Option<&T>, next: Option<&T>) -> bool
where
    T: PartialEq + ?Sized,
{
    previous
        .zip(next)
        .is_none_or(|(previous, next)| previous == next)
}

fn patch_advances_usage_window(
    previous: Option<&CodexRateLimitWindow>,
    patch: &CodexRateLimitWindowPatch,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };

    metadata_field_advanced(previous.resets_at, patch.resets_at)
        || metadata_field_advanced(previous.window_duration_mins, patch.window_duration_mins)
}

fn metadata_field_advanced<T>(previous: Option<T>, patch: Option<Option<T>>) -> bool
where
    T: PartialEq + Copy,
{
    matches!(
        (previous, patch),
        (Some(previous), Some(Some(next))) if next != previous
    )
}

fn usage_window_context(snapshot: &CodexRateLimitSnapshot) -> UsageWindowContext<'_> {
    UsageWindowContext {
        plan_type: snapshot.plan_type.as_ref(),
        limit_id: snapshot.limit_id.as_deref(),
        limit_name: snapshot.limit_name.as_deref(),
    }
}

#[cfg(test)]
fn usage_snapshot_is_empty(snapshot: &CodexRateLimitSnapshot) -> bool {
    snapshot.credits.is_none()
        && snapshot.limit_id.is_none()
        && snapshot.limit_name.is_none()
        && snapshot.plan_type.is_none()
        && snapshot.primary.is_none()
        && snapshot.secondary.is_none()
}

fn usage_snapshot_patch_from_snapshot(
    snapshot: CodexRateLimitSnapshot,
) -> CodexRateLimitSnapshotPatch {
    CodexRateLimitSnapshotPatch {
        credits: Some(snapshot.credits),
        limit_id: Some(snapshot.limit_id),
        limit_name: Some(snapshot.limit_name),
        plan_type: Some(snapshot.plan_type),
        primary: Some(snapshot.primary.map(usage_window_patch_from_window)),
        secondary: Some(snapshot.secondary.map(usage_window_patch_from_window)),
    }
}

fn usage_window_patch_from_window(window: CodexRateLimitWindow) -> CodexRateLimitWindowPatch {
    CodexRateLimitWindowPatch {
        resets_at: Some(window.resets_at),
        used_percent: Some(window.used_percent),
        window_duration_mins: Some(window.window_duration_mins),
    }
}

fn merge_patch_value<T>(previous: Option<T>, patch: Option<Option<T>>) -> Option<T> {
    match patch {
        None => previous,
        Some(next) => next,
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
        RuntimeReadTarget::SharedHeadless(lease) => {
            lease.session().read_account_rate_limits().await
        }
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
        RuntimeReadTarget::SharedHeadless(lease) => {
            lease.session().read_account(refresh_token).await
        }
        RuntimeReadTarget::Headless(session) => {
            let result = session.read_account(refresh_token).await;
            let stop_result = session.stop().await;
            finish_headless_read(result, stop_result)
        }
    }
}

async fn read_capabilities_from_target(
    read_target: RuntimeReadTarget,
) -> AppResult<EnvironmentCapabilitiesSnapshot> {
    match read_target {
        RuntimeReadTarget::Running(session) => session.read_capabilities().await,
        RuntimeReadTarget::SharedHeadless(lease) => lease.session().read_capabilities().await,
        RuntimeReadTarget::Headless(session) => {
            let result = session.read_capabilities().await;
            let stop_result = session.stop().await;
            finish_headless_read(result, stop_result)
        }
    }
}

async fn read_composer_catalog_from_target(
    read_target: RuntimeReadTarget,
    environment_path: &str,
    codex_thread_id: Option<&str>,
) -> AppResult<ThreadComposerCatalog> {
    match read_target {
        RuntimeReadTarget::Running(session) => {
            session
                .composer_catalog(environment_path, codex_thread_id)
                .await
        }
        RuntimeReadTarget::SharedHeadless(lease) => {
            lease
                .session()
                .composer_catalog(environment_path, codex_thread_id)
                .await
        }
        RuntimeReadTarget::Headless(session) => {
            let result = session
                .composer_catalog(environment_path, codex_thread_id)
                .await;
            let stop_result = session.stop().await;
            finish_headless_read(result, stop_result)
        }
    }
}

async fn search_files_from_target(
    read_target: RuntimeReadTarget,
    environment_path: &str,
    cancellation_token: &str,
    query: String,
    limit: usize,
) -> AppResult<Vec<crate::domain::conversation::ComposerFileSearchResult>> {
    match read_target {
        RuntimeReadTarget::Running(session) => {
            session
                .search_files(environment_path, cancellation_token, query, limit)
                .await
        }
        RuntimeReadTarget::SharedHeadless(lease) => {
            lease
                .session()
                .search_files(environment_path, cancellation_token, query, limit)
                .await
        }
        RuntimeReadTarget::Headless(session) => {
            let result = session
                .search_files(environment_path, cancellation_token, query, limit)
                .await;
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
        RuntimeReadTarget::SharedHeadless(lease) => {
            lease
                .session()
                .read_auth_status(include_token, refresh_token)
                .await
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

#[cfg_attr(not(test), allow(dead_code))]
async fn finish_headless_session(
    headless_sessions: &Arc<Mutex<HashMap<String, HeadlessSession>>>,
    environment_id: &str,
) -> AppResult<()> {
    let session = {
        let mut sessions = headless_sessions.lock().await;
        take_headless_session(&mut sessions, environment_id)
    };
    if let Some(handle) = session {
        handle.session.stop().await?;
    }
    Ok(())
}

fn retire_headless_session(
    environment_id: String,
    handle: SharedHeadlessHandle,
    reason: &'static str,
) {
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + HEADLESS_SESSION_RETIRE_TIMEOUT;
        loop {
            let active_readers = handle.active_readers.load(Ordering::Relaxed);
            let has_pending_requests = handle.session.has_pending_requests().await;
            if active_readers == 0 && !has_pending_requests {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                warn!(
                    environment_id = %environment_id,
                    reason,
                    active_readers,
                    has_pending_requests,
                    "shared headless session retirement timed out while work was still in flight"
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        if let Err(error) = handle.session.stop().await {
            warn!(
                environment_id = %environment_id,
                reason,
                "failed to stop shared headless session: {error}"
            );
        }
    });
}

fn store_headless_session(
    sessions: &mut HashMap<String, HeadlessSession>,
    environment_id: String,
    handle: SharedHeadlessHandle,
    environment_path: String,
    binary_path: String,
    now: DateTime<Utc>,
) {
    sessions.insert(
        environment_id,
        HeadlessSession {
            handle,
            environment_path,
            binary_path,
            last_activity_at: now,
        },
    );
}

fn touch_headless_session(
    sessions: &mut HashMap<String, HeadlessSession>,
    environment_id: &str,
    now: DateTime<Utc>,
) -> Option<SharedHeadlessLease> {
    let entry = sessions.get_mut(environment_id)?;
    entry.last_activity_at = now;
    Some(entry.handle.acquire())
}

fn take_headless_session(
    sessions: &mut HashMap<String, HeadlessSession>,
    environment_id: &str,
) -> Option<SharedHeadlessHandle> {
    sessions.remove(environment_id).map(|entry| entry.handle)
}

fn take_mismatched_headless_session(
    sessions: &mut HashMap<String, HeadlessSession>,
    environment_id: &str,
    environment_path: &str,
    binary_path: &str,
) -> Option<SharedHeadlessHandle> {
    let entry = sessions.get(environment_id)?;
    if entry.environment_path == environment_path && entry.binary_path == binary_path {
        return None;
    }

    sessions.remove(environment_id).map(|entry| entry.handle)
}

fn take_idle_headless_sessions(
    sessions: &mut HashMap<String, HeadlessSession>,
    now: DateTime<Utc>,
    cutoff: chrono::Duration,
) -> Vec<(String, SharedHeadlessHandle)> {
    let mut idle = Vec::new();
    sessions.retain(|environment_id, entry| {
        if (now - entry.last_activity_at) >= cutoff {
            idle.push((environment_id.clone(), entry.handle.clone()));
            false
        } else {
            true
        }
    });
    idle
}

fn validate_composer_file_search_context(context: &ComposerTargetContext) -> AppResult<()> {
    if !context.file_search_enabled {
        return Err(AppError::Validation(
            "File search is unavailable for standalone chats.".to_string(),
        ));
    }

    Ok(())
}

fn resolve_binary_path(codex_binary_path: Option<String>) -> AppResult<String> {
    resolve_codex_binary_path(codex_binary_path.as_deref())
}

#[cfg(test)]
mod tests {
    use chrono::{Duration as ChronoDuration, TimeZone, Utc};
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::{mpsc, Mutex};

    use super::{
        apply_account_usage_patch, apply_account_usage_snapshot, classify_idle_runtime_candidates,
        collect_idle_runtime_candidates, emit_account_usage_event, finish_headless_read,
        finish_headless_session, latest_running_usage_source, merge_account_usage_snapshot,
        prime_running_runtime_usage, read_account_from_target, read_auth_status_from_target,
        read_capabilities_from_target, read_composer_catalog_from_target, resolve_binary_path,
        search_files_from_target, should_stop_idle_runtime_candidate,
        store_account_usage_snapshot_from_read, store_headless_session,
        take_idle_headless_sessions, take_mismatched_headless_session, touch_headless_session,
        touch_running_runtime, usage_snapshot_is_empty, usage_snapshot_patch_from_snapshot,
        validate_composer_file_search_context, AccountUsageState, AppServerAuthStatus,
        CodexRateLimitSnapshotPatch, HeadlessSession, RunningRuntime, RuntimeReadTarget,
        RuntimeRegistry, RuntimeSupervisor, RuntimeUsageUpdate, SharedHeadlessHandle,
        UsageConfirmationFallback, UsageUpdateOrigin,
    };
    use crate::app_identity::CODEX_USAGE_EVENT_NAME;
    use crate::domain::conversation::{
        ConversationComposerSettings, ConversationMessageItem, ConversationRole,
        ConversationStatus, SubagentThreadSnapshot, ThreadConversationSnapshot,
    };
    use crate::domain::settings::{
        ApprovalPolicy, CollaborationMode, ProviderKind, ReasoningEffort,
    };
    use crate::domain::voice::VoiceAuthMode;
    use crate::domain::workspace::{
        CodexPlanType, CodexRateLimitSnapshot, CodexRateLimitWindow, RuntimeState,
        RuntimeStatusSnapshot,
    };
    use crate::error::AppError;
    use crate::events::{EmittedEvent, EventSink};
    use crate::runtime::protocol::AccountReadAuthTypeWire;
    use crate::runtime::session::RuntimeSession;
    use crate::services::workspace::{ComposerTargetContext, ThreadRuntimeContext};

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

    #[tokio::test]
    async fn running_read_capabilities_uses_the_active_session() {
        let (session, harness) = spawn_test_session().await;

        let capabilities =
            read_capabilities_from_target(RuntimeReadTarget::Running(Arc::new(session)))
                .await
                .expect("running capabilities read should load");

        assert_eq!(capabilities.environment_id, "env-1");
        assert_eq!(capabilities.models[0].display_name, "GPT-5.4");
        assert!(capabilities
            .models
            .iter()
            .any(|model| model.id == "claude-opus-4-7[1m]"));
        assert_eq!(capabilities.collaboration_modes.len(), 1);

        let requests = harness.requests().await;
        assert!(
            requests
                .iter()
                .any(|request| request.method == "model/list"),
            "model/list request should be recorded"
        );
        assert!(
            requests
                .iter()
                .any(|request| request.method == "collaborationMode/list"),
            "collaborationMode/list request should be recorded"
        );
    }

    #[tokio::test]
    async fn running_read_capabilities_refreshes_the_existing_session_cache() {
        let (session, harness) = spawn_test_session().await;
        let session = Arc::new(session);

        session
            .read_capabilities()
            .await
            .expect("initial capabilities read should load");

        read_capabilities_from_target(RuntimeReadTarget::Running(session))
            .await
            .expect("refreshed capabilities read should load");

        let requests = harness.requests().await;
        let model_list_count = requests
            .iter()
            .filter(|request| request.method == "model/list")
            .count();
        let collaboration_mode_count = requests
            .iter()
            .filter(|request| request.method == "collaborationMode/list")
            .count();

        assert_eq!(
            model_list_count, 2,
            "read_capabilities should refresh model/list"
        );
        assert_eq!(
            collaboration_mode_count, 2,
            "read_capabilities should refresh collaborationMode/list"
        );
    }

    #[tokio::test]
    async fn running_read_composer_catalog_uses_the_active_session() {
        let (session, harness) = spawn_test_session().await;

        let catalog = read_composer_catalog_from_target(
            RuntimeReadTarget::Running(Arc::new(session)),
            "/tmp/skein",
            Some("thr-123"),
        )
        .await
        .expect("running composer catalog should load");
        assert!(catalog.skills.is_empty());
        assert!(catalog.apps.is_empty());

        let requests = harness.requests().await;
        let skills_request = requests
            .iter()
            .find(|request| request.method == "skills/list")
            .expect("skills/list request should be recorded");
        assert_eq!(skills_request.params["cwds"][0], "/tmp/skein");
        let app_request = requests
            .iter()
            .find(|request| request.method == "app/list")
            .expect("app/list request should be recorded");
        assert_eq!(app_request.params["threadId"], "thr-123");
    }

    #[tokio::test]
    async fn running_read_composer_catalog_skips_app_list_without_a_thread_id() {
        let (session, harness) = spawn_test_session().await;

        let catalog = read_composer_catalog_from_target(
            RuntimeReadTarget::Running(Arc::new(session)),
            "/tmp/skein",
            None,
        )
        .await
        .expect("running composer catalog should load without a thread id");

        assert!(catalog.apps.is_empty());
        let requests = harness.requests().await;
        assert!(
            requests.iter().all(|request| request.method != "app/list"),
            "app/list should be skipped when no thread id is available",
        );
    }

    #[tokio::test]
    async fn opening_claude_thread_returns_environment_wide_capabilities() {
        let (session, _harness) = spawn_test_session().await;
        let supervisor = RuntimeSupervisor::new(EventSink::noop(), "0.1.0".to_string());
        supervisor.registry.lock().await.running.insert(
            "env-1".to_string(),
            RunningRuntime {
                session: Arc::new(session),
                status: make_runtime_status("env-1"),
                last_activity_at: Utc::now(),
            },
        );

        let response = supervisor
            .open_thread(claude_thread_context_without_provider_thread())
            .await
            .expect("Claude open should use the environment capability set when available");

        assert!(response
            .capabilities
            .providers
            .iter()
            .any(|provider| matches!(provider.id, ProviderKind::Codex)));
        assert!(response
            .capabilities
            .providers
            .iter()
            .any(|provider| matches!(provider.id, ProviderKind::Claude)));
        assert!(response
            .capabilities
            .models
            .iter()
            .any(|model| model.id == "gpt-5.4"));
        assert!(response
            .capabilities
            .models
            .iter()
            .any(|model| model.id == "claude-opus-4-7[1m]"));
    }

    #[tokio::test]
    async fn running_search_files_uses_the_active_session() {
        let (session, harness) = spawn_test_session().await;

        let results = search_files_from_target(
            RuntimeReadTarget::Running(Arc::new(session)),
            "/tmp/skein",
            "draft:topLeft",
            "main".to_string(),
            50,
        )
        .await
        .expect("running file search should load");

        assert_eq!(results.len(), 2);
        let requests = harness.requests().await;
        let search_request = requests
            .iter()
            .find(|request| request.method == "fuzzyFileSearch")
            .expect("fuzzyFileSearch request should be recorded");
        assert_eq!(search_request.params["roots"][0], "/tmp/skein");
        assert_eq!(search_request.params["cancellationToken"], "draft:topLeft");
    }

    #[tokio::test]
    async fn finish_headless_session_clears_cached_session() {
        let now = Utc::now();
        let cached_session = SharedHeadlessHandle::new(Arc::new(
            RuntimeSession::from_snapshot_for_test(make_completed_snapshot()),
        ));
        let headless_sessions = Arc::new(Mutex::new(HashMap::new()));

        {
            let mut sessions = headless_sessions.lock().await;
            store_headless_session(
                &mut sessions,
                "env-1".to_string(),
                cached_session,
                "/tmp/skein".to_string(),
                "/usr/bin/codex".to_string(),
                now,
            );
        }

        finish_headless_session(&headless_sessions, "env-1")
            .await
            .expect("cached headless session should stop cleanly");

        assert!(!headless_sessions.lock().await.contains_key("env-1"));
    }

    #[test]
    fn touch_headless_session_reuses_cached_session_and_updates_activity() {
        let earlier = Utc
            .with_ymd_and_hms(2026, 4, 19, 17, 0, 0)
            .single()
            .expect("valid timestamp");
        let now = Utc
            .with_ymd_and_hms(2026, 4, 19, 17, 5, 0)
            .single()
            .expect("valid timestamp");
        let session = Arc::new(RuntimeSession::from_snapshot_for_test(
            make_completed_snapshot(),
        ));
        let mut sessions = HashMap::new();
        store_headless_session(
            &mut sessions,
            "env-1".to_string(),
            SharedHeadlessHandle::new(session.clone()),
            "/tmp/skein".to_string(),
            "/usr/bin/codex".to_string(),
            earlier,
        );

        let reused = touch_headless_session(&mut sessions, "env-1", now)
            .expect("cached session should be reused");

        assert!(Arc::ptr_eq(reused.session(), &session));
        assert_eq!(
            sessions.get("env-1").map(|entry| entry.last_activity_at),
            Some(now)
        );
    }

    #[test]
    fn take_mismatched_headless_session_removes_stale_targets() {
        let session = Arc::new(RuntimeSession::from_snapshot_for_test(
            make_completed_snapshot(),
        ));
        let mut sessions = HashMap::new();
        store_headless_session(
            &mut sessions,
            "env-1".to_string(),
            SharedHeadlessHandle::new(session.clone()),
            "/tmp/skein".to_string(),
            "/usr/bin/codex".to_string(),
            Utc::now(),
        );

        let removed = take_mismatched_headless_session(
            &mut sessions,
            "env-1",
            "/tmp/other",
            "/usr/bin/codex",
        )
        .expect("mismatched targets should evict the cached session");

        assert!(Arc::ptr_eq(&removed.session, &session));
        assert!(!sessions.contains_key("env-1"));
    }

    #[test]
    fn take_idle_headless_sessions_returns_only_expired_sessions() {
        let now = Utc
            .with_ymd_and_hms(2026, 4, 19, 17, 10, 0)
            .single()
            .expect("valid timestamp");
        let cutoff = ChronoDuration::minutes(10);
        let stale_session = Arc::new(RuntimeSession::from_snapshot_for_test(
            make_completed_snapshot(),
        ));
        let fresh_session = Arc::new(RuntimeSession::from_snapshot_for_test(
            make_completed_snapshot(),
        ));
        let mut sessions = HashMap::from([
            (
                "env-stale".to_string(),
                HeadlessSession {
                    handle: SharedHeadlessHandle::new(stale_session.clone()),
                    environment_path: "/tmp/stale".to_string(),
                    binary_path: "/usr/bin/codex".to_string(),
                    last_activity_at: now - ChronoDuration::minutes(15),
                },
            ),
            (
                "env-fresh".to_string(),
                HeadlessSession {
                    handle: SharedHeadlessHandle::new(fresh_session.clone()),
                    environment_path: "/tmp/fresh".to_string(),
                    binary_path: "/usr/bin/codex".to_string(),
                    last_activity_at: now - ChronoDuration::minutes(5),
                },
            ),
        ]);

        let idle = take_idle_headless_sessions(&mut sessions, now, cutoff);

        assert_eq!(idle.len(), 1);
        assert_eq!(idle[0].0, "env-stale");
        assert!(Arc::ptr_eq(&idle[0].1.session, &stale_session));
        assert!(sessions.contains_key("env-fresh"));
        assert!(!sessions.contains_key("env-stale"));
    }

    #[test]
    fn disabled_composer_file_search_targets_fail_validation() {
        let error = validate_composer_file_search_context(&ComposerTargetContext {
            environment_id: "skein-chat-workspace".to_string(),
            environment_path: "/tmp/chats".to_string(),
            provider: ProviderKind::Codex,
            codex_thread_id: None,
            codex_binary_path: Some(String::new()),
            file_search_enabled: false,
        })
        .expect_err("standalone chats should reject file search");

        assert!(
            matches!(error, AppError::Validation(message) if message == "File search is unavailable for standalone chats.")
        );
    }

    #[tokio::test]
    async fn priming_a_running_runtime_reads_usage_updates_state_and_emits_event() {
        let (events, mut event_rx) = usage_event_sink();
        let (session, harness) = spawn_test_session().await;
        let registry = Arc::new(Mutex::new(RuntimeRegistry::default()));
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));

        let snapshot = prime_running_runtime_usage(
            &events,
            "0.1.0",
            &registry,
            &account_usage,
            "env-1",
            Arc::new(session),
            test_confirmation_fallback(),
        )
        .await
        .expect("usage priming should succeed");

        assert_eq!(
            snapshot.primary.as_ref().map(|window| window.used_percent),
            Some(64)
        );
        assert_eq!(
            account_usage
                .lock()
                .await
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.secondary.as_ref())
                .map(|window| window.used_percent),
            Some(22)
        );

        let requests = harness.requests().await;
        assert_single_rate_limit_read(&requests);

        let payload = recv_usage_event(&mut event_rx)
            .await
            .expect("usage event should be emitted");
        assert_eq!(payload["environmentId"], "env-1");
        assert_eq!(payload["rateLimits"]["primary"]["usedPercent"], 64);
        assert_eq!(payload["rateLimits"]["secondary"]["usedPercent"], 22);
    }

    #[tokio::test]
    async fn storing_a_manual_read_snapshot_preserves_the_existing_emit_contract() {
        let (events, mut event_rx) = usage_event_sink();
        let registry = Arc::new(Mutex::new(RuntimeRegistry::default()));
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));

        let apply_result = store_account_usage_snapshot_from_read(
            &events,
            "0.1.0",
            &registry,
            &account_usage,
            make_rate_limit_snapshot(
                Some(CodexPlanType::Pro),
                Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
                Some(make_rate_limit_window(
                    22,
                    Some(1_775_910_400),
                    Some(10_080),
                )),
            ),
            UsageUpdateOrigin::DirectRead,
            Some(test_confirmation_fallback()),
        )
        .await
        .expect("manual read snapshot should apply");

        assert!(apply_result.changed);
        assert_eq!(
            account_usage
                .lock()
                .await
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.primary.as_ref())
                .map(|window| window.used_percent),
            Some(64)
        );
        assert!(
            recv_usage_event_timeout(&mut event_rx, Duration::from_millis(100))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn priming_a_running_runtime_leaves_usage_state_unchanged_when_the_read_fails() {
        let (events, mut event_rx) = usage_event_sink();
        let (session, harness) = spawn_test_session_with_rate_limits_response(Err(
            "rate limits unavailable".to_string(),
        ))
        .await;
        let registry = Arc::new(Mutex::new(RuntimeRegistry::default()));
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));

        let result = prime_running_runtime_usage(
            &events,
            "0.1.0",
            &registry,
            &account_usage,
            "env-1",
            Arc::new(session),
            test_confirmation_fallback(),
        )
        .await;

        assert!(matches!(
            result,
            Err(AppError::Runtime(message)) if message.contains("rate limits unavailable")
        ));
        assert!(account_usage.lock().await.snapshot.is_none());
        assert!(
            recv_usage_event_timeout(&mut event_rx, Duration::from_millis(100))
                .await
                .is_none()
        );

        let requests = harness.requests().await;
        assert_single_rate_limit_read(&requests);
    }

    #[test]
    fn emitting_account_usage_event_serializes_the_expected_payload() {
        let (events, mut event_rx) = usage_event_sink();

        emit_account_usage_event(
            &events,
            "env-1",
            &make_rate_limit_snapshot(
                Some(CodexPlanType::Pro),
                Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
                Some(make_rate_limit_window(
                    22,
                    Some(1_775_910_400),
                    Some(10_080),
                )),
            ),
        );

        let payload = event_rx
            .try_recv()
            .ok()
            .map(|event| event.payload)
            .expect("usage event should be emitted");
        assert_eq!(payload["environmentId"], "env-1");
        assert_eq!(payload["rateLimits"]["primary"]["usedPercent"], 64);
        assert_eq!(payload["rateLimits"]["secondary"]["usedPercent"], 22);
    }

    fn usage_event_sink() -> (EventSink, mpsc::UnboundedReceiver<EmittedEvent>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        (EventSink::channel(event_tx), event_rx)
    }

    async fn recv_usage_event(
        event_rx: &mut mpsc::UnboundedReceiver<EmittedEvent>,
    ) -> Option<Value> {
        recv_usage_event_timeout(event_rx, Duration::from_millis(200)).await
    }

    async fn recv_usage_event_timeout(
        event_rx: &mut mpsc::UnboundedReceiver<EmittedEvent>,
        timeout: Duration,
    ) -> Option<Value> {
        tokio::time::timeout(timeout, async {
            while let Some(event) = event_rx.recv().await {
                if event.name == CODEX_USAGE_EVENT_NAME {
                    return Some(event.payload);
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    }

    fn test_confirmation_fallback() -> UsageConfirmationFallback {
        UsageConfirmationFallback {
            environment_id: "env-1".to_string(),
            environment_path: "/tmp/skein".to_string(),
            codex_binary_path: None,
        }
    }

    fn assert_single_rate_limit_read(requests: &[RecordedRequest]) {
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == "account/rateLimits/read")
                .count(),
            1
        );
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

        let should_stop =
            should_stop_idle_runtime_candidate(&Mutex::new(registry), &candidate, now, cutoff)
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

    #[test]
    fn merge_account_usage_snapshot_rejects_regression_within_the_same_window() {
        let previous = make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
            Some(make_rate_limit_window(
                22,
                Some(1_775_910_400),
                Some(10_080),
            )),
        );
        let patch = usage_snapshot_patch_from_snapshot(make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(18, Some(1_775_306_400), Some(300))),
            Some(make_rate_limit_window(
                11,
                Some(1_775_910_400),
                Some(10_080),
            )),
        ));

        let merged = merge_account_usage_snapshot(Some(&previous), &patch);

        assert!(merged.regression_detected);
        assert_eq!(
            merged
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(64)
        );
        assert_eq!(
            merged
                .snapshot
                .secondary
                .as_ref()
                .map(|window| window.used_percent),
            Some(22)
        );
    }

    #[test]
    fn merge_account_usage_snapshot_allows_regression_after_a_window_reset() {
        let previous = make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
            Some(make_rate_limit_window(
                22,
                Some(1_775_910_400),
                Some(10_080),
            )),
        );
        let patch = usage_snapshot_patch_from_snapshot(make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(3, Some(1_775_324_400), Some(300))),
            Some(make_rate_limit_window(5, Some(1_776_515_200), Some(10_080))),
        ));

        let merged = merge_account_usage_snapshot(Some(&previous), &patch);

        assert!(!merged.regression_detected);
        assert_eq!(
            merged
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(3)
        );
        assert_eq!(
            merged
                .snapshot
                .secondary
                .as_ref()
                .map(|window| window.used_percent),
            Some(5)
        );
    }

    #[test]
    fn merge_account_usage_snapshot_rejects_stale_prior_window_snapshots() {
        let previous = make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(3, Some(1_775_324_400), Some(300))),
            Some(make_rate_limit_window(5, Some(1_776_515_200), Some(10_080))),
        );
        let patch = usage_snapshot_patch_from_snapshot(make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(97, Some(1_775_306_400), Some(300))),
            Some(make_rate_limit_window(
                41,
                Some(1_775_910_400),
                Some(10_080),
            )),
        ));

        let merged = merge_account_usage_snapshot(Some(&previous), &patch);

        assert!(!merged.regression_detected);
        assert_eq!(merged.snapshot.primary, previous.primary);
        assert_eq!(merged.snapshot.secondary, previous.secondary);
    }

    #[test]
    fn merge_account_usage_snapshot_rejects_regression_when_limit_metadata_is_later_populated() {
        let previous = make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
            None,
        );
        let patch = serde_json::from_value::<CodexRateLimitSnapshotPatch>(json!({
            "limitName": "Pro",
            "primary": {
                "usedPercent": 18,
                "resetsAt": 1_775_306_400,
                "windowDurationMins": 300
            }
        }))
        .expect("same-window patch with new metadata should decode");

        let merged = merge_account_usage_snapshot(Some(&previous), &patch);

        assert!(merged.regression_detected);
        assert_eq!(merged.snapshot.limit_name.as_deref(), Some("Pro"));
        assert_eq!(
            merged
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(64)
        );
    }

    #[test]
    fn merge_account_usage_snapshot_clears_old_windows_when_limit_changes() {
        let previous = CodexRateLimitSnapshot {
            credits: None,
            limit_id: Some("pro-hourly".to_string()),
            limit_name: Some("Pro".to_string()),
            plan_type: Some(CodexPlanType::Pro),
            primary: Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
            secondary: Some(make_rate_limit_window(
                22,
                Some(1_775_910_400),
                Some(10_080),
            )),
        };
        let patch = serde_json::from_value::<CodexRateLimitSnapshotPatch>(json!({
            "limitId": "team-hourly",
            "limitName": "Team",
            "primary": {
                "usedPercent": 7,
                "resetsAt": 1_775_342_400,
                "windowDurationMins": 300
            }
        }))
        .expect("limit change patch should decode");

        let merged = merge_account_usage_snapshot(Some(&previous), &patch);

        assert!(!merged.regression_detected);
        assert_eq!(merged.snapshot.limit_id.as_deref(), Some("team-hourly"));
        assert_eq!(merged.snapshot.limit_name.as_deref(), Some("Team"));
        assert_eq!(
            merged
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(7)
        );
        assert_eq!(merged.snapshot.secondary, None);
    }

    #[test]
    fn merge_account_usage_snapshot_keeps_metadata_only_window_enrichment() {
        let previous = make_rate_limit_snapshot(
            Some(CodexPlanType::Pro),
            Some(make_rate_limit_window(64, Some(1_775_306_400), None)),
            Some(make_rate_limit_window(22, Some(1_775_910_400), None)),
        );
        let patch = serde_json::from_value::<CodexRateLimitSnapshotPatch>(json!({
            "primary": {
                "windowDurationMins": 300
            },
            "secondary": {
                "resetsAt": 1_775_910_400
            }
        }))
        .expect("metadata-only patch should decode");

        let merged = merge_account_usage_snapshot(Some(&previous), &patch);

        assert!(!merged.regression_detected);
        assert_eq!(
            merged
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(64)
        );
        assert_eq!(
            merged
                .snapshot
                .primary
                .as_ref()
                .and_then(|window| window.window_duration_mins),
            Some(300)
        );
        assert_eq!(
            merged
                .snapshot
                .secondary
                .as_ref()
                .map(|window| window.used_percent),
            Some(22)
        );
        assert_eq!(
            merged
                .snapshot
                .secondary
                .as_ref()
                .and_then(|window| window.resets_at),
            Some(1_775_910_400)
        );
    }

    #[tokio::test]
    async fn metadata_only_window_reset_does_not_pin_previous_usage() {
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));
        apply_account_usage_snapshot(
            &account_usage,
            make_rate_limit_snapshot(
                Some(CodexPlanType::Pro),
                Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
                Some(make_rate_limit_window(
                    22,
                    Some(1_775_910_400),
                    Some(10_080),
                )),
            ),
            UsageUpdateOrigin::DirectRead,
        )
        .await
        .expect("initial snapshot should apply");

        let reset_only = apply_account_usage_patch(
            &account_usage,
            json!({
                "primary": {
                    "resetsAt": 1_775_324_400
                }
            }),
            UsageUpdateOrigin::LiveNotification,
        )
        .await
        .expect("metadata-only reset patch should apply");

        assert!(reset_only.snapshot.primary.is_none());
        assert_eq!(
            reset_only
                .snapshot
                .secondary
                .as_ref()
                .map(|window| window.used_percent),
            Some(22)
        );

        let actual_usage = apply_account_usage_patch(
            &account_usage,
            json!({
                "primary": {
                    "usedPercent": 3,
                    "resetsAt": 1_775_324_400,
                    "windowDurationMins": 300
                }
            }),
            UsageUpdateOrigin::LiveNotification,
        )
        .await
        .expect("follow-up usage patch should apply");

        assert_eq!(
            actual_usage
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(3)
        );
        assert!(!actual_usage.confirmation_requested);
    }

    #[tokio::test]
    async fn apply_account_usage_patch_allows_explicit_window_clear() {
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));
        apply_account_usage_snapshot(
            &account_usage,
            make_rate_limit_snapshot(
                Some(CodexPlanType::Pro),
                Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
                Some(make_rate_limit_window(
                    22,
                    Some(1_775_910_400),
                    Some(10_080),
                )),
            ),
            UsageUpdateOrigin::DirectRead,
        )
        .await
        .expect("initial snapshot should apply");

        let result = apply_account_usage_patch(
            &account_usage,
            json!({
                "primary": null
            }),
            UsageUpdateOrigin::LiveNotification,
        )
        .await
        .expect("explicit null window patch should apply");

        assert!(result.changed);
        assert!(result.snapshot.primary.is_none());
        assert_eq!(
            result
                .snapshot
                .secondary
                .as_ref()
                .map(|window| window.used_percent),
            Some(22)
        );
    }

    #[tokio::test]
    async fn apply_account_usage_patch_allows_clearing_the_entire_snapshot() {
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));
        apply_account_usage_snapshot(
            &account_usage,
            make_rate_limit_snapshot(
                Some(CodexPlanType::Pro),
                Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
                Some(make_rate_limit_window(
                    22,
                    Some(1_775_910_400),
                    Some(10_080),
                )),
            ),
            UsageUpdateOrigin::DirectRead,
        )
        .await
        .expect("initial snapshot should apply");

        let result = apply_account_usage_patch(
            &account_usage,
            json!({
                "planType": null,
                "limitId": null,
                "limitName": null,
                "credits": null,
                "primary": null,
                "secondary": null
            }),
            UsageUpdateOrigin::LiveNotification,
        )
        .await
        .expect("explicit clear patch should apply");

        assert!(result.changed);
        assert!(usage_snapshot_is_empty(&result.snapshot));
        assert!(account_usage
            .lock()
            .await
            .snapshot
            .as_ref()
            .is_some_and(usage_snapshot_is_empty));
    }

    #[tokio::test]
    async fn apply_account_usage_snapshot_accepts_an_empty_initial_snapshot() {
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));
        let result = apply_account_usage_snapshot(
            &account_usage,
            make_rate_limit_snapshot(None, None, None),
            UsageUpdateOrigin::DirectRead,
        )
        .await
        .expect("empty initial snapshot should apply");

        assert!(result.changed);
        assert!(usage_snapshot_is_empty(&result.snapshot));
        assert!(account_usage
            .lock()
            .await
            .snapshot
            .as_ref()
            .is_some_and(usage_snapshot_is_empty));
    }

    #[tokio::test]
    async fn repeated_ambiguous_regressions_only_request_one_confirmation() {
        let account_usage = Arc::new(Mutex::new(AccountUsageState::default()));
        apply_account_usage_snapshot(
            &account_usage,
            make_rate_limit_snapshot(
                Some(CodexPlanType::Pro),
                Some(make_rate_limit_window(64, Some(1_775_306_400), Some(300))),
                Some(make_rate_limit_window(
                    22,
                    Some(1_775_910_400),
                    Some(10_080),
                )),
            ),
            UsageUpdateOrigin::DirectRead,
        )
        .await
        .expect("initial snapshot should apply");

        let regression = json!({
            "primary": {
                "usedPercent": 18,
                "resetsAt": 1_775_306_400,
                "windowDurationMins": 300
            },
            "secondary": {
                "usedPercent": 11,
                "resetsAt": 1_775_910_400,
                "windowDurationMins": 10_080
            }
        });

        let first = apply_account_usage_patch(
            &account_usage,
            regression.clone(),
            UsageUpdateOrigin::LiveNotification,
        )
        .await
        .expect("first regression should apply");
        let second = apply_account_usage_patch(
            &account_usage,
            regression,
            UsageUpdateOrigin::LiveNotification,
        )
        .await
        .expect("second regression should apply");

        assert!(first.confirmation_requested);
        assert!(!second.confirmation_requested);
        assert_eq!(
            first
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(64)
        );
        assert_eq!(
            second
                .snapshot
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(64)
        );
    }

    #[test]
    fn runtime_usage_update_preserves_confirmation_fallback_context() {
        let update = RuntimeUsageUpdate {
            environment_id: "env-1".to_string(),
            environment_path: "/tmp/skein".to_string(),
            codex_binary_path: Some("/opt/homebrew/bin/codex".to_string()),
            rate_limits: json!({}),
        };

        let fallback = update.confirmation_fallback();

        assert_eq!(fallback.environment_id, "env-1");
        assert_eq!(fallback.environment_path, "/tmp/skein");
        assert_eq!(
            fallback.codex_binary_path.as_deref(),
            Some("/opt/homebrew/bin/codex")
        );
    }

    #[tokio::test]
    async fn latest_running_usage_source_prefers_the_most_recent_runtime() {
        let older = Utc
            .with_ymd_and_hms(2026, 4, 12, 10, 0, 0)
            .single()
            .expect("valid timestamp");
        let newer = older + ChronoDuration::minutes(5);
        let mut registry = RuntimeRegistry::default();
        registry.running.insert(
            "env-old".to_string(),
            RunningRuntime {
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
                status: make_runtime_status("env-old"),
                last_activity_at: older,
            },
        );
        registry.running.insert(
            "env-new".to_string(),
            RunningRuntime {
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
                status: make_runtime_status("env-new"),
                last_activity_at: newer,
            },
        );

        let selected = latest_running_usage_source(&Arc::new(Mutex::new(registry)))
            .await
            .expect("latest runtime should be selected");

        assert_eq!(selected.0, "env-new");
    }

    #[tokio::test]
    async fn latest_running_usage_source_does_not_touch_last_activity() {
        let activity_at = Utc
            .with_ymd_and_hms(2026, 4, 12, 10, 5, 0)
            .single()
            .expect("valid timestamp");
        let mut registry = RuntimeRegistry::default();
        registry.running.insert(
            "env-1".to_string(),
            RunningRuntime {
                session: Arc::new(RuntimeSession::from_snapshot_for_test(
                    make_completed_snapshot(),
                )),
                status: make_runtime_status("env-1"),
                last_activity_at: activity_at,
            },
        );
        let registry = Arc::new(Mutex::new(registry));

        let selected = latest_running_usage_source(&registry)
            .await
            .expect("latest runtime should be selected");

        assert_eq!(selected.0, "env-1");
        assert_eq!(
            registry
                .lock()
                .await
                .running
                .get("env-1")
                .map(|runtime| runtime.last_activity_at),
            Some(activity_at)
        );
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
        spawn_test_session_with_rate_limits_response(Ok(json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 64,
                    "windowDurationMins": 300,
                    "resetsAt": 1_775_306_400
                },
                "secondary": {
                    "usedPercent": 22,
                    "windowDurationMins": 10_080,
                    "resetsAt": 1_775_910_400
                }
            }
        })))
        .await
    }

    async fn spawn_test_session_with_rate_limits_response(
        rate_limits_response: Result<Value, String>,
    ) -> (RuntimeSession, FakeCodexHarness) {
        let (client_writer, server_reader) = duplex(32 * 1024);
        let (server_writer, client_reader) = duplex(32 * 1024);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let task = spawn_fake_codex(
            server_reader,
            server_writer,
            requests.clone(),
            rate_limits_response,
        );
        let session = RuntimeSession::from_test_transport(
            "env-1".to_string(),
            "/tmp/skein".to_string(),
            "0.1.0".to_string(),
            true,
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

    fn claude_thread_context_without_provider_thread() -> ThreadRuntimeContext {
        ThreadRuntimeContext {
            thread_id: "claude-thread-1".to_string(),
            environment_id: "env-1".to_string(),
            environment_path: "/tmp/skein".to_string(),
            provider: ProviderKind::Claude,
            provider_thread_id: None,
            codex_thread_id: None,
            composer: ConversationComposerSettings {
                provider: ProviderKind::Claude,
                model: "claude-sonnet-4-6".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
            codex_binary_path: None,
            claude_binary_path: None,
            handoff: None,
            handoff_bootstrap_context: None,
            stream_assistant_responses: true,
            multi_agent_nudge_enabled: false,
            multi_agent_nudge_max_subagents: 0,
        }
    }

    fn make_rate_limit_snapshot(
        plan_type: Option<CodexPlanType>,
        primary: Option<CodexRateLimitWindow>,
        secondary: Option<CodexRateLimitWindow>,
    ) -> CodexRateLimitSnapshot {
        CodexRateLimitSnapshot {
            credits: None,
            limit_id: None,
            limit_name: None,
            plan_type,
            primary,
            secondary,
        }
    }

    fn make_rate_limit_window(
        used_percent: i32,
        resets_at: Option<i64>,
        window_duration_mins: Option<i64>,
    ) -> CodexRateLimitWindow {
        CodexRateLimitWindow {
            resets_at,
            used_percent,
            window_duration_mins,
        }
    }

    fn make_completed_snapshot() -> ThreadConversationSnapshot {
        let mut snapshot = ThreadConversationSnapshot::new(
            "thread-1".to_string(),
            "env-1".to_string(),
            Some("thr_codex".to_string()),
            ConversationComposerSettings {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_string(),
                reasoning_effort: ReasoningEffort::High,
                collaboration_mode: CollaborationMode::Build,
                approval_policy: ApprovalPolicy::AskToEdit,
                service_tier: None,
            },
        );
        snapshot.status = ConversationStatus::Completed;
        snapshot
            .items
            .push(crate::domain::conversation::ConversationItem::Message(
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
        rate_limits_response: Result<Value, String>,
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
                    "account/rateLimits/read" => match &rate_limits_response {
                        Ok(result) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": result
                        }),
                        Err(message) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32000, "message": message }
                        }),
                    },
                    "app/list" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "data": [], "nextCursor": null }
                    }),
                    "fuzzyFileSearch" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "files": [
                                {
                                    "root": "/tmp/skein",
                                    "path": "src/main.ts",
                                    "matchType": "file",
                                    "fileName": "main.ts",
                                    "score": 100
                                },
                                {
                                    "root": "/tmp/skein",
                                    "path": "src/lib.rs",
                                    "matchType": "file",
                                    "fileName": "lib.rs",
                                    "score": 90
                                }
                            ]
                        }
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
