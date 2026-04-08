use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::infrastructure::database::AppDatabase;
use crate::runtime::supervisor::RuntimeSupervisor;
use crate::services::pull_requests::PullRequestMonitorService;
use crate::services::terminal::TerminalService;
use crate::services::voice::VoiceService;
use crate::services::workspace::WorkspaceService;
use crate::services::worktree_scripts::WorktreeScriptService;

pub struct AppState {
    pub workspace: WorkspaceService,
    pub pull_requests: PullRequestMonitorService,
    pub runtime: RuntimeSupervisor,
    pub voice: VoiceService,
    pub terminal: TerminalService,
    pub app_data_dir: PathBuf,
}

impl AppState {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| crate::error::AppError::Runtime(error.to_string()))?;
        let threadex_home_dir = app
            .path()
            .home_dir()
            .map_err(|error| crate::error::AppError::Runtime(error.to_string()))?
            .join(".threadex");
        std::fs::create_dir_all(threadex_home_dir.join("worktrees"))?;
        let database = AppDatabase::new(app)?;
        let workspace = WorkspaceService::new(
            database,
            threadex_home_dir.join("worktrees"),
            WorktreeScriptService::new(app.clone(), app_data_dir.clone()),
        );

        Ok(Self {
            pull_requests: PullRequestMonitorService::new(app.clone(), workspace.clone()),
            workspace,
            runtime: RuntimeSupervisor::new(app.clone(), env!("CARGO_PKG_VERSION").to_string()),
            voice: VoiceService::new(),
            terminal: TerminalService::default(),
            app_data_dir,
        })
    }
}
