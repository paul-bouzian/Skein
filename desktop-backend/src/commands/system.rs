use std::path::Path;

use serde::Serialize;

use crate::app_identity::APP_NAME;
use crate::error::{AppError, CommandError};
use crate::infrastructure::images::image_data_url;
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    app_name: String,
    app_version: String,
    backend: String,
    platform: String,
    app_data_dir: String,
    database_path: String,
    project_count: usize,
    environment_count: usize,
    thread_count: usize,
}

pub(crate) async fn get_bootstrap_status_impl(
    state: &AppState,
) -> Result<BootstrapStatus, CommandError> {
    let runtime_statuses = state.runtime.refresh_statuses().await?;
    let snapshot = state.workspace.snapshot(runtime_statuses)?;
    let environment_count = snapshot
        .projects
        .iter()
        .map(|project| project.environments.len())
        .sum::<usize>();
    let thread_count = snapshot
        .projects
        .iter()
        .flat_map(|project| project.environments.iter())
        .map(|environment| environment.threads.len())
        .sum::<usize>();

    Ok(BootstrapStatus {
        app_name: APP_NAME.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        backend: "registry-ready".to_string(),
        platform: std::env::consts::OS.to_string(),
        app_data_dir: state.app_data_dir.to_string_lossy().to_string(),
        database_path: state
            .workspace
            .database_path()
            .to_string_lossy()
            .to_string(),
        project_count: snapshot.projects.len(),
        environment_count,
        thread_count,
    })
}

const ICON_CANDIDATES: &[&str] = &[
    "public/favicon.svg",
    "public/favicon.png",
    "public/favicon.ico",
    "public/apple-icon.png",
    "public/logo.svg",
    "public/logo.png",
    "public/logo-icon.png",
    "public/logo192.png",
    "public/icon.svg",
    "public/icon.png",
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
    "logo.svg",
    "logo.png",
    "icon.svg",
    "icon.png",
    "src/assets/logo.svg",
    "src/assets/logo.png",
    "src/assets/icon.svg",
    "src/assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    "assets/icon.svg",
    "assets/icon.png",
    "src/app/favicon.ico",
    "src/app/favicon.png",
    "src/app/favicon.svg",
    "src/app/icon.svg",
    "src/app/icon.png",
    "src/app/apple-icon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/favicon.svg",
    "app/icon.svg",
    "app/icon.png",
    "app/apple-icon.png",
    "static/favicon.ico",
    "static/favicon.png",
    "static/favicon.svg",
    "resources/icon.png",
    "resources/icon.icns",
    "desktop-backend/icons/icon.png",
    "desktop-backend/icons/icon.icns",
    "desktop-backend/icons/icon.ico",
    "desktop-backend/icons/32x32.png",
    "electron/icon.png",
    ".github/icon.png",
];

pub(crate) fn get_project_icon_impl(root_path: &str) -> Option<String> {
    let root = Path::new(root_path);
    ICON_CANDIDATES
        .iter()
        .map(|candidate| root.join(candidate))
        .find(|path| path.is_file())
        .and_then(|path| image_data_url(&path).ok())
}

pub(crate) fn read_image_as_data_url_impl(path: &str) -> Result<String, CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Image path is required.".to_string()).into());
    }

    let path = Path::new(trimmed);
    if !path.is_file() {
        return Err(AppError::NotFound(format!("Image not found: {trimmed}")).into());
    }

    Ok(image_data_url(path)?)
}

#[cfg(test)]
mod tests {
    use super::get_project_icon_impl;

    #[test]
    fn project_icon_lookup_returns_none_for_missing_roots() {
        assert_eq!(get_project_icon_impl("/definitely/not/a/project"), None);
    }
}
