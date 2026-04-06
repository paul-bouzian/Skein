use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{AppError, CommandError};
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

#[tauri::command]
pub async fn get_bootstrap_status(
    state: State<'_, AppState>,
) -> Result<BootstrapStatus, crate::error::CommandError> {
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
        app_name: "ThreadEx".to_string(),
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

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
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
    "src-tauri/icons/icon.png",
    "src-tauri/icons/icon.icns",
    "src-tauri/icons/icon.ico",
    "src-tauri/icons/32x32.png",
    "electron/icon.png",
    ".github/icon.png",
];
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

#[tauri::command]
pub fn get_project_icon(root_path: String) -> Option<String> {
    let root = Path::new(&root_path);
    ICON_CANDIDATES
        .iter()
        .map(|candidate| root.join(candidate))
        .find(|path| path.is_file())
        .and_then(|path| image_data_url(&path).ok())
}

#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, CommandError> {
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

fn image_data_url(path: &Path) -> crate::error::AppResult<String> {
    let mime = image_mime_type(path).ok_or_else(|| {
        AppError::Validation(format!(
            "Unsupported image type for preview: {}",
            path.display()
        ))
    })?;
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Validation(format!(
            "Image exceeds the 25 MiB preview limit: {}",
            path.display()
        )));
    }
    let bytes = std::fs::read(path)?;
    let encoded = STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "icns" => Some("image/icns"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{image_data_url, image_mime_type, MAX_IMAGE_BYTES};
    use crate::error::AppError;

    #[test]
    fn mime_type_is_detected_from_known_icon_extensions() {
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/favicon.png")),
            Some("image/png")
        );
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/favicon.ico")),
            Some("image/x-icon")
        );
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/icon.svg")),
            Some("image/svg+xml")
        );
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/preview.gif")),
            Some("image/gif")
        );
    }

    #[test]
    fn icon_data_url_embeds_the_file_as_base64() {
        let temp_dir = std::env::temp_dir().join(format!(
            "threadex-icon-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&temp_dir).expect("temp directory should exist");
        let icon_path = temp_dir.join("favicon.png");
        std::fs::write(&icon_path, [0u8, 1u8, 2u8, 3u8]).expect("icon bytes should be written");

        let data_url = image_data_url(&icon_path).expect("data url should be generated");
        assert!(data_url.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_file(icon_path);
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn image_data_url_rejects_files_that_exceed_the_preview_limit() {
        let temp_dir = std::env::temp_dir().join(format!(
            "threadex-image-limit-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&temp_dir).expect("temp directory should exist");
        let icon_path = temp_dir.join("oversized.png");
        std::fs::File::create(&icon_path)
            .and_then(|file| file.set_len(MAX_IMAGE_BYTES + 1))
            .expect("oversized image file should be created");

        let error = image_data_url(&icon_path).expect_err("oversized image should fail");
        assert!(matches!(error, AppError::Validation(message) if message.contains("25 MiB")));

        let _ = std::fs::remove_file(icon_path);
        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
