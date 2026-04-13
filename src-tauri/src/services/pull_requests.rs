mod github;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tracing::warn;

use crate::app_identity::WORKSPACE_EVENT_NAME;
use crate::domain::workspace::{
    EnvironmentPullRequestSnapshot, WorkspaceEvent, WorkspaceEventKind,
};
use crate::error::AppResult;
use crate::services::workspace::{PullRequestWatchTarget, WorkspaceService};

const PULL_REQUEST_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const PULL_REQUEST_REFRESH_CONCURRENCY: usize = 4;

#[derive(Debug, Clone)]
pub struct PullRequestMonitorService {
    app: Option<AppHandle>,
    workspace: WorkspaceService,
    state: Arc<PullRequestMonitorState>,
}

#[derive(Debug, Default)]
struct PullRequestMonitorState {
    snapshots: RwLock<HashMap<String, EnvironmentPullRequestSnapshot>>,
    in_flight: Mutex<HashSet<String>>,
    refresh_notify: Notify,
}

impl PullRequestMonitorService {
    pub fn new(app: AppHandle, workspace: WorkspaceService) -> Self {
        let service = Self {
            app: Some(app),
            workspace,
            state: Arc::new(PullRequestMonitorState::default()),
        };
        service.spawn_refresh_loop();
        service
    }

    #[cfg(test)]
    fn for_test(workspace: WorkspaceService) -> Self {
        Self {
            app: None,
            workspace,
            state: Arc::new(PullRequestMonitorState::default()),
        }
    }

    pub fn snapshot(&self) -> HashMap<String, EnvironmentPullRequestSnapshot> {
        self.state
            .snapshots
            .read()
            .expect("pull request snapshots lock should not be poisoned")
            .clone()
    }

    pub fn refresh_now(&self) {
        self.state.refresh_notify.notify_one();
    }

    pub fn clear_snapshot(&self, environment_id: &str) {
        self.state
            .snapshots
            .write()
            .expect("pull request snapshots lock should not be poisoned")
            .remove(environment_id);
    }

    fn spawn_refresh_loop(&self) {
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service.run_refresh_loop().await;
        });
    }

    async fn run_refresh_loop(self) {
        loop {
            if let Err(error) = self.refresh_once().await {
                warn!("failed to refresh pull request state: {error}");
            }

            tokio::select! {
                _ = tokio::time::sleep(PULL_REQUEST_REFRESH_INTERVAL) => {}
                _ = self.state.refresh_notify.notified() => {}
            }
        }
    }

    async fn refresh_once(&self) -> AppResult<()> {
        let targets = self.workspace.pull_request_watch_targets()?;
        self.prune_stale_snapshots(&targets);

        let semaphore = Arc::new(tokio::sync::Semaphore::new(
            PULL_REQUEST_REFRESH_CONCURRENCY.max(1),
        ));
        let mut tasks = Vec::with_capacity(targets.len());
        for target in targets {
            let permit = semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("pull request refresh semaphore should remain open");
            let monitor = self.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                let _permit = permit;
                monitor.refresh_target(target).await;
            }));
        }

        for task in tasks {
            let _ = task.await;
        }

        Ok(())
    }

    fn prune_stale_snapshots(&self, targets: &[PullRequestWatchTarget]) {
        let live_environment_ids = targets
            .iter()
            .map(|target| target.environment_id.as_str())
            .collect::<HashSet<_>>();
        let stale_ids = {
            let snapshots = self
                .state
                .snapshots
                .read()
                .expect("pull request snapshots lock should not be poisoned");
            snapshots
                .keys()
                .filter(|environment_id| !live_environment_ids.contains(environment_id.as_str()))
                .cloned()
                .collect::<Vec<_>>()
        };

        if stale_ids.is_empty() {
            return;
        }

        let mut snapshots = self
            .state
            .snapshots
            .write()
            .expect("pull request snapshots lock should not be poisoned");
        for environment_id in stale_ids {
            snapshots.remove(&environment_id);
        }
    }

    async fn refresh_target(&self, target: PullRequestWatchTarget) {
        if !self.begin_target_refresh(&target.environment_id) {
            return;
        }

        let next_snapshot = {
            let resolve_target = target.clone();
            match tokio::task::spawn_blocking(move || {
                github::resolve_pull_request_for_target(&resolve_target)
            })
            .await
            {
                Ok(Ok(snapshot)) => snapshot,
                Ok(Err(error)) => {
                    warn!(
                        environment_id = target.environment_id,
                        path = %target.path,
                        "failed to resolve pull request state: {error}"
                    );
                    None
                }
                Err(error) => {
                    warn!(
                        environment_id = target.environment_id,
                        path = %target.path,
                        "pull request refresh task failed: {error}"
                    );
                    None
                }
            }
        };

        self.finish_target_refresh(target, next_snapshot);
    }

    fn begin_target_refresh(&self, environment_id: &str) -> bool {
        let mut in_flight = self
            .state
            .in_flight
            .lock()
            .expect("pull request in-flight lock should not be poisoned");
        in_flight.insert(environment_id.to_string())
    }

    fn finish_target_refresh(
        &self,
        target: PullRequestWatchTarget,
        next_snapshot: Option<EnvironmentPullRequestSnapshot>,
    ) {
        {
            let mut in_flight = self
                .state
                .in_flight
                .lock()
                .expect("pull request in-flight lock should not be poisoned");
            in_flight.remove(&target.environment_id);
        }

        if !self.target_is_current(&target) {
            return;
        }

        let changed = {
            let mut snapshots = self
                .state
                .snapshots
                .write()
                .expect("pull request snapshots lock should not be poisoned");
            let previous = snapshots.get(&target.environment_id).cloned();
            if previous == next_snapshot {
                false
            } else {
                match next_snapshot {
                    Some(snapshot) => {
                        snapshots.insert(target.environment_id.clone(), snapshot);
                    }
                    None => {
                        snapshots.remove(&target.environment_id);
                    }
                }
                true
            }
        };

        if changed {
            self.emit_workspace_event(target.project_id, target.environment_id);
        }
    }

    fn target_is_current(&self, target: &PullRequestWatchTarget) -> bool {
        match self
            .workspace
            .pull_request_watch_target(&target.environment_id)
        {
            Ok(Some(current_target)) => current_target == *target,
            Ok(None) => false,
            Err(error) => {
                warn!(
                    environment_id = target.environment_id,
                    "failed to verify current pull request target: {error}"
                );
                false
            }
        }
    }

    fn emit_workspace_event(&self, project_id: String, environment_id: String) {
        let Some(app) = self.app.as_ref() else {
            return;
        };

        if let Err(error) = app.emit(
            WORKSPACE_EVENT_NAME,
            WorkspaceEvent {
                kind: WorkspaceEventKind::EnvironmentPullRequestChanged,
                project_id: Some(project_id),
                environment_id: Some(environment_id),
                thread_id: None,
            },
        ) {
            warn!("failed to emit workspace pull request event: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::PullRequestMonitorService;
    use crate::domain::workspace::{EnvironmentPullRequestSnapshot, PullRequestState};
    use crate::services::git;
    use crate::services::workspace::{AddProjectRequest, PullRequestWatchTarget, WorkspaceService};
    use crate::services::worktree_scripts::WorktreeScriptService;

    #[test]
    fn monitor_replaces_changed_snapshots() {
        let harness = MonitorHarness::new();
        let target = harness.create_watch_target();
        let monitor = PullRequestMonitorService::for_test(harness.workspace.clone());
        monitor.finish_target_refresh(
            target.clone(),
            Some(EnvironmentPullRequestSnapshot {
                number: 3,
                title: "Initial".to_string(),
                url: "https://github.com/acme/skein/pull/3".to_string(),
                state: PullRequestState::Open,
            }),
        );

        monitor.finish_target_refresh(
            target,
            Some(EnvironmentPullRequestSnapshot {
                number: 4,
                title: "Updated".to_string(),
                url: "https://github.com/acme/skein/pull/4".to_string(),
                state: PullRequestState::Merged,
            }),
        );

        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.values().next().map(|value| value.number), Some(4));
        assert_eq!(
            snapshot.values().next().map(|value| value.state),
            Some(PullRequestState::Merged)
        );
    }

    #[test]
    fn clear_snapshot_removes_cached_pull_request() {
        let harness = MonitorHarness::new();
        let target = harness.create_watch_target();
        let environment_id = target.environment_id.clone();
        let monitor = PullRequestMonitorService::for_test(harness.workspace.clone());
        monitor.finish_target_refresh(
            target,
            Some(EnvironmentPullRequestSnapshot {
                number: 3,
                title: "Initial".to_string(),
                url: "https://github.com/acme/skein/pull/3".to_string(),
                state: PullRequestState::Open,
            }),
        );

        monitor.clear_snapshot(&environment_id);

        assert!(!monitor.snapshot().contains_key(&environment_id));
    }

    struct MonitorHarness {
        workspace: WorkspaceService,
        temp_root: PathBuf,
    }

    impl MonitorHarness {
        fn new() -> Self {
            let temp_root =
                std::env::temp_dir().join(format!("skein-pr-monitor-test-{}", uuid::Uuid::now_v7()));
            fs::create_dir_all(&temp_root).expect("temp root should be created");
            let database = crate::infrastructure::database::AppDatabase::for_test(
                temp_root.join("skein.sqlite3"),
            )
            .expect("test database should be created");

            Self {
                workspace: WorkspaceService::new(
                    database,
                    temp_root.join("managed-worktrees"),
                    WorktreeScriptService::for_test(temp_root.clone()),
                ),
                temp_root,
            }
        }

        fn create_watch_target(&self) -> PullRequestWatchTarget {
            let repo_root = self.temp_root.join("repo");
            fs::create_dir_all(&repo_root).expect("repo root should exist");
            git::run_git(&repo_root, ["init", "--initial-branch=main"]).expect("git init");
            git::run_git(&repo_root, ["config", "user.email", "skein@example.com"])
                .expect("git email config");
            git::run_git(&repo_root, ["config", "user.name", "Skein Tests"])
                .expect("git name config");
            fs::write(repo_root.join("README.md"), "# Skein\n").expect("readme should write");
            git::run_git(&repo_root, ["add", "README.md"]).expect("git add");
            git::run_git(&repo_root, ["commit", "-m", "Initial commit"]).expect("git commit");

            let project = self
                .workspace
                .add_project(AddProjectRequest {
                    path: repo_root.to_string_lossy().to_string(),
                    name: None,
                })
                .expect("project should be added");
            let worktree = self
                .workspace
                .create_managed_worktree(&project.id)
                .expect("worktree should be created");

            self.workspace
                .pull_request_watch_target(&worktree.environment.id)
                .expect("watch target lookup should succeed")
                .expect("worktree watch target should exist")
        }
    }

    impl Drop for MonitorHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp_root);
        }
    }
}
