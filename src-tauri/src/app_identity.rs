use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub const APP_NAME: &str = "Loom";
pub const LEGACY_APP_BUNDLE_ID: &str = "com.paulbouzian.threadex";

pub const APP_HOME_DIR_NAME: &str = ".loom";
pub const LEGACY_APP_HOME_DIR_NAME: &str = ".threadex";

pub const APP_DATABASE_FILE_NAME: &str = "loom.sqlite3";
pub const LEGACY_APP_DATABASE_FILE_NAME: &str = "threadex.sqlite3";

pub const CONVERSATION_EVENT_NAME: &str = "loom://conversation-event";
pub const CODEX_USAGE_EVENT_NAME: &str = "loom://codex-usage-event";
pub const WORKSPACE_EVENT_NAME: &str = "loom://workspace-event";
pub const WORKTREE_SCRIPT_FAILURE_EVENT_NAME: &str = "loom://worktree-script-failure";
pub const TERMINAL_OUTPUT_EVENT_NAME: &str = "loom://terminal-output";
pub const TERMINAL_EXIT_EVENT_NAME: &str = "loom://terminal-exit";

#[derive(Debug, Clone)]
pub struct AppStoragePaths {
    pub app_data_dir: PathBuf,
    pub app_home_dir: PathBuf,
    pub legacy_app_home_dir: PathBuf,
}

pub fn prepare_storage_paths(app: &AppHandle) -> AppResult<AppStoragePaths> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Runtime(error.to_string()))?;
    let legacy_app_data_dir = app_data_dir
        .parent()
        .ok_or_else(|| {
            AppError::Runtime("Unable to resolve the parent directory for Loom app data.".to_string())
        })?
        .join(LEGACY_APP_BUNDLE_ID);
    migrate_directory_namespace(&legacy_app_data_dir, &app_data_dir)?;

    let app_home_dir = app
        .path()
        .home_dir()
        .map_err(|error| AppError::Runtime(error.to_string()))?
        .join(APP_HOME_DIR_NAME);
    let legacy_app_home_dir = app_home_dir
        .parent()
        .ok_or_else(|| {
            AppError::Runtime("Unable to resolve the parent directory for Loom home data.".to_string())
        })?
        .join(LEGACY_APP_HOME_DIR_NAME);
    migrate_directory_namespace(&legacy_app_home_dir, &app_home_dir)?;
    fs::create_dir_all(app_home_dir.join("worktrees"))?;

    Ok(AppStoragePaths {
        app_data_dir,
        app_home_dir,
        legacy_app_home_dir,
    })
}

fn migrate_directory_namespace(legacy: &Path, current: &Path) -> AppResult<()> {
    if !legacy.exists() {
        return Ok(());
    }

    if !legacy.is_dir() {
        return Err(AppError::Runtime(format!(
            "Legacy Loom migration source is not a directory: {}",
            legacy.display()
        )));
    }

    if !current.exists() {
        if let Some(parent) = current.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(legacy, current)?;
        return Ok(());
    }

    if !current.is_dir() {
        return Err(AppError::Runtime(format!(
            "Loom migration destination is not a directory: {}",
            current.display()
        )));
    }

    merge_directory_contents(legacy, current)?;
    remove_empty_tree(legacy)?;
    Ok(())
}

fn merge_directory_contents(source: &Path, destination: &Path) -> AppResult<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if destination_path.exists() {
            if source_path.is_dir() && destination_path.is_dir() {
                merge_directory_contents(&source_path, &destination_path)?;
                remove_empty_tree(&source_path)?;
                continue;
            }

            return Err(AppError::Runtime(format!(
                "Cannot migrate legacy Loom data because '{}' already exists.",
                destination_path.display()
            )));
        }

        fs::rename(&source_path, &destination_path)?;
    }

    Ok(())
}

fn remove_empty_tree(path: &Path) -> AppResult<()> {
    if !path.exists() || !path.is_dir() {
        return Ok(());
    }

    if fs::read_dir(path)?.next().is_none() {
        fs::remove_dir(path)?;
        return Ok(());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        merge_directory_contents, remove_empty_tree, APP_DATABASE_FILE_NAME,
        LEGACY_APP_DATABASE_FILE_NAME,
    };
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn merge_directory_contents_moves_nested_entries_without_overwrite() {
        let root = std::env::temp_dir().join(format!("loom-app-identity-{}", Uuid::now_v7()));
        let legacy = root.join("legacy");
        let current = root.join("current");
        std::fs::create_dir_all(legacy.join("nested")).expect("legacy dir should exist");
        std::fs::create_dir_all(&current).expect("current dir should exist");
        std::fs::write(legacy.join("nested").join(LEGACY_APP_DATABASE_FILE_NAME), b"db")
            .expect("legacy db should write");

        merge_directory_contents(&legacy, &current).expect("merge should succeed");

        assert!(current.join("nested").join(LEGACY_APP_DATABASE_FILE_NAME).exists());
        assert!(!Path::new(&legacy.join("nested").join(LEGACY_APP_DATABASE_FILE_NAME)).exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_empty_tree_removes_now_empty_directories() {
        let root = std::env::temp_dir().join(format!("loom-empty-tree-{}", Uuid::now_v7()));
        let empty = root.join(APP_DATABASE_FILE_NAME);
        std::fs::create_dir_all(&root).expect("root should exist");
        std::fs::create_dir_all(&empty).expect("empty dir should exist");

        remove_empty_tree(&empty).expect("cleanup should succeed");

        assert!(!empty.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
