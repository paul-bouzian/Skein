use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::infrastructure::database::AppDatabase;
use crate::runtime::supervisor::RuntimeSupervisor;
use crate::services::workspace::WorkspaceService;

pub struct AppState {
    pub workspace: WorkspaceService,
    pub runtime: RuntimeSupervisor,
    pub app_data_dir: PathBuf,
}

impl AppState {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| crate::error::AppError::Runtime(error.to_string()))?;
        let database = AppDatabase::new(app)?;

        Ok(Self {
            workspace: WorkspaceService::new(database),
            runtime: RuntimeSupervisor::new(
                app.clone(),
                env!("CARGO_PKG_VERSION").to_string(),
            ),
            app_data_dir,
        })
    }
}
