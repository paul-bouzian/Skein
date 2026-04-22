use std::path::PathBuf;

use crate::app_identity::AppStoragePaths;
use crate::error::AppResult;
use crate::events::EventSink;
use crate::infrastructure::database::AppDatabase;
use crate::runtime::supervisor::RuntimeSupervisor;
use crate::services::pull_requests::PullRequestMonitorService;
use crate::services::terminal::TerminalService;
use crate::services::voice::VoiceService;
use crate::services::workspace::WorkspaceService;
use crate::services::worktree_scripts::WorktreeScriptService;

pub struct AppState {
    pub events: EventSink,
    pub workspace: WorkspaceService,
    pub pull_requests: PullRequestMonitorService,
    pub runtime: RuntimeSupervisor,
    pub voice: VoiceService,
    pub terminal: TerminalService,
    pub app_data_dir: PathBuf,
}

impl AppState {
    pub fn from_storage_paths(
        storage_paths: AppStoragePaths,
        events: EventSink,
    ) -> AppResult<Self> {
        let app_data_dir = storage_paths.app_data_dir.clone();
        std::fs::create_dir_all(storage_paths.app_home_dir.join("chats"))?;
        let database = AppDatabase::new(&storage_paths)?;
        let workspace = WorkspaceService::new(
            database,
            storage_paths.app_home_dir.join("worktrees"),
            storage_paths.app_home_dir.join("chats"),
            WorktreeScriptService::new(events.clone(), app_data_dir.clone()),
        );

        Ok(Self {
            events: events.clone(),
            pull_requests: PullRequestMonitorService::new(events.clone(), workspace.clone()),
            workspace,
            runtime: RuntimeSupervisor::new(events, env!("CARGO_PKG_VERSION").to_string()),
            voice: VoiceService::new(),
            terminal: TerminalService::default(),
            app_data_dir,
        })
    }
}
