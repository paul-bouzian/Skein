use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub const APP_NAME: &str = "Loom";
pub const LEGACY_APP_BUNDLE_ID: &str = "com.paulbouzian.threadex";

pub const APP_HOME_DIR_NAME: &str = ".loom";
pub const LEGACY_APP_HOME_DIR_NAME: &str = ".threadex";
pub const DEVELOPMENT_STORAGE_DIR_NAME: &str = "development";

pub const APP_DATABASE_FILE_NAME: &str = "loom.sqlite3";
pub const LEGACY_APP_DATABASE_FILE_NAME: &str = "threadex.sqlite3";

pub const CONVERSATION_EVENT_NAME: &str = "loom://conversation-event";
pub const CODEX_USAGE_EVENT_NAME: &str = "loom://codex-usage-event";
pub const WORKSPACE_EVENT_NAME: &str = "loom://workspace-event";
pub const WORKTREE_SCRIPT_FAILURE_EVENT_NAME: &str = "loom://worktree-script-failure";
pub const FIRST_PROMPT_RENAME_FAILURE_EVENT_NAME: &str = "loom://first-prompt-rename-failure";
pub const TERMINAL_OUTPUT_EVENT_NAME: &str = "loom://terminal-output";
pub const TERMINAL_EXIT_EVENT_NAME: &str = "loom://terminal-exit";
pub const MENU_OPEN_SETTINGS_EVENT_NAME: &str = "loom://menu-open-settings";
pub const MENU_CHECK_FOR_UPDATES_EVENT_NAME: &str = "loom://menu-check-for-updates";

#[derive(Debug, Clone)]
pub struct AppStoragePaths {
    pub app_data_dir: PathBuf,
    pub app_home_dir: PathBuf,
    pub legacy_app_home_dir: PathBuf,
}

pub fn prepare_storage_paths(app: &AppHandle) -> AppResult<AppStoragePaths> {
    let canonical_app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Runtime(error.to_string()))?;
    let legacy_app_data_dir = canonical_app_data_dir
        .parent()
        .ok_or_else(|| {
            AppError::Runtime(
                "Unable to resolve the parent directory for Loom app data.".to_string(),
            )
        })?
        .join(LEGACY_APP_BUNDLE_ID);

    let canonical_app_home_dir = app
        .path()
        .home_dir()
        .map_err(|error| AppError::Runtime(error.to_string()))?
        .join(APP_HOME_DIR_NAME);
    let legacy_app_home_dir = canonical_app_home_dir
        .parent()
        .ok_or_else(|| {
            AppError::Runtime(
                "Unable to resolve the parent directory for Loom home data.".to_string(),
            )
        })?
        .join(LEGACY_APP_HOME_DIR_NAME);

    let executable_path = std::env::current_exe().map_err(|error| {
        AppError::Runtime(format!("Unable to resolve Loom executable path: {error}"))
    })?;
    let execution_profile = resolve_execution_profile(&executable_path)?;
    migrate_legacy_namespaces_for_profile(
        &execution_profile,
        &legacy_app_data_dir,
        &canonical_app_data_dir,
        &legacy_app_home_dir,
        &canonical_app_home_dir,
    )?;
    let storage_paths = storage_paths_for_profile(
        execution_profile,
        canonical_app_data_dir,
        canonical_app_home_dir,
        legacy_app_home_dir,
    );

    fs::create_dir_all(&storage_paths.app_data_dir)?;
    fs::create_dir_all(storage_paths.app_home_dir.join("worktrees"))?;

    Ok(storage_paths)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AppExecutionProfile {
    Installed,
    Development { scope_name: String },
}

fn storage_paths_for_profile(
    execution_profile: AppExecutionProfile,
    canonical_app_data_dir: PathBuf,
    canonical_app_home_dir: PathBuf,
    legacy_app_home_dir: PathBuf,
) -> AppStoragePaths {
    match execution_profile {
        AppExecutionProfile::Installed => AppStoragePaths {
            app_data_dir: canonical_app_data_dir,
            app_home_dir: canonical_app_home_dir,
            legacy_app_home_dir,
        },
        AppExecutionProfile::Development { scope_name } => {
            let scoped_root = canonical_app_home_dir
                .join(DEVELOPMENT_STORAGE_DIR_NAME)
                .join(scope_name);
            let scoped_app_home_dir = scoped_root.join("home");
            let scoped_app_data_dir = scoped_root.join("app-data");

            AppStoragePaths {
                app_data_dir: scoped_app_data_dir,
                app_home_dir: scoped_app_home_dir.clone(),
                legacy_app_home_dir: scoped_app_home_dir,
            }
        }
    }
}

fn migrate_legacy_namespaces_for_profile(
    execution_profile: &AppExecutionProfile,
    legacy_app_data_dir: &Path,
    canonical_app_data_dir: &Path,
    legacy_app_home_dir: &Path,
    canonical_app_home_dir: &Path,
) -> AppResult<()> {
    if matches!(execution_profile, AppExecutionProfile::Installed) {
        migrate_directory_namespace(legacy_app_data_dir, canonical_app_data_dir)?;
        migrate_directory_namespace(legacy_app_home_dir, canonical_app_home_dir)?;
    }

    Ok(())
}

fn resolve_execution_profile(executable_path: &Path) -> AppResult<AppExecutionProfile> {
    let Some(checkout_root) = find_checkout_root(executable_path) else {
        return Ok(AppExecutionProfile::Installed);
    };

    let canonical_checkout_root = checkout_root.canonicalize()?;
    Ok(AppExecutionProfile::Development {
        scope_name: development_scope_name(&canonical_checkout_root),
    })
}

fn find_checkout_root(executable_path: &Path) -> Option<PathBuf> {
    for ancestor in executable_path.ancestors() {
        let git_entry = ancestor.join(".git");
        if git_entry.is_dir() || git_entry.is_file() {
            return Some(ancestor.to_path_buf());
        }
    }

    None
}

fn development_scope_name(checkout_root: &Path) -> String {
    let checkout_name = checkout_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("workspace");
    let slug = checkout_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let slug = if slug.is_empty() {
        "workspace".to_string()
    } else {
        slug
    };

    let hash = fnv1a64_hex(&checkout_root.to_string_lossy());
    format!("{slug}-{hash}")
}

fn fnv1a64_hex(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }

    format!("{hash:016x}")
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
        development_scope_name, find_checkout_root, merge_directory_contents,
        migrate_legacy_namespaces_for_profile, remove_empty_tree, resolve_execution_profile,
        storage_paths_for_profile, AppExecutionProfile, APP_DATABASE_FILE_NAME,
        DEVELOPMENT_STORAGE_DIR_NAME, LEGACY_APP_BUNDLE_ID, LEGACY_APP_DATABASE_FILE_NAME,
        LEGACY_APP_HOME_DIR_NAME,
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
        std::fs::write(
            legacy.join("nested").join(LEGACY_APP_DATABASE_FILE_NAME),
            b"db",
        )
        .expect("legacy db should write");

        merge_directory_contents(&legacy, &current).expect("merge should succeed");

        assert!(current
            .join("nested")
            .join(LEGACY_APP_DATABASE_FILE_NAME)
            .exists());
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

    #[test]
    fn checkout_launched_executables_use_development_profile() {
        let root = std::env::temp_dir().join(format!("loom-profile-{}", Uuid::now_v7()));
        let repo_root = root.join("feature-ordering");
        std::fs::create_dir_all(repo_root.join("src-tauri").join("target").join("debug"))
            .expect("repo target directory should exist");
        std::fs::write(repo_root.join(".git"), b"gitdir: /tmp/mock")
            .expect("git marker should exist");
        let executable = repo_root
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join("loom");

        let profile = resolve_execution_profile(&executable).expect("profile should resolve");

        match profile {
            AppExecutionProfile::Development { scope_name } => {
                assert!(scope_name.starts_with("feature-ordering-"));
            }
            AppExecutionProfile::Installed => {
                panic!("checkout executable should not resolve as installed")
            }
        }

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn installed_executables_keep_the_canonical_storage_paths() {
        let root = std::env::temp_dir().join(format!("loom-installed-{}", Uuid::now_v7()));
        let app_data_dir = root.join("app-data");
        let app_home_dir = root.join("home");
        let legacy_app_home_dir = root.join("legacy-home");

        let paths = storage_paths_for_profile(
            AppExecutionProfile::Installed,
            app_data_dir.clone(),
            app_home_dir.clone(),
            legacy_app_home_dir.clone(),
        );

        assert_eq!(paths.app_data_dir, app_data_dir);
        assert_eq!(paths.app_home_dir, app_home_dir);
        assert_eq!(paths.legacy_app_home_dir, legacy_app_home_dir);
    }

    #[test]
    fn checkout_storage_paths_are_scoped_under_the_development_namespace() {
        let root = std::env::temp_dir().join(format!("loom-dev-storage-{}", Uuid::now_v7()));
        let repo_root = root.join("worktree-ordering");
        std::fs::create_dir_all(repo_root.join("src-tauri").join("target").join("debug"))
            .expect("repo target directory should exist");
        std::fs::create_dir_all(root.join("app-data")).expect("app-data directory should exist");
        std::fs::create_dir_all(root.join("home")).expect("home directory should exist");
        std::fs::write(repo_root.join(".git"), b"gitdir: /tmp/mock")
            .expect("git marker should exist");

        let executable = repo_root
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join("loom");
        let execution_profile =
            resolve_execution_profile(&executable).expect("profile should resolve");
        let paths = storage_paths_for_profile(
            execution_profile,
            root.join("app-data"),
            root.join("home"),
            root.join("legacy-home"),
        );

        assert!(paths
            .app_home_dir
            .starts_with(root.join("home").join(DEVELOPMENT_STORAGE_DIR_NAME)));
        assert!(paths.app_data_dir.ends_with(Path::new("app-data")));
        assert_eq!(paths.legacy_app_home_dir, paths.app_home_dir);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn development_scope_name_is_stable_for_a_checkout_path() {
        let checkout_root = Path::new("/Users/paul/dev/Loom-feature");

        let first = development_scope_name(checkout_root);
        let second = development_scope_name(checkout_root);

        assert_eq!(first, second);
        assert!(first.starts_with("loom-feature-"));
    }

    #[test]
    fn find_checkout_root_detects_git_file_worktrees() {
        let root = std::env::temp_dir().join(format!("loom-checkout-root-{}", Uuid::now_v7()));
        let repo_root = root.join("repo");
        let executable_dir = repo_root.join("src-tauri").join("target").join("debug");
        std::fs::create_dir_all(&executable_dir).expect("executable dir should exist");
        std::fs::write(repo_root.join(".git"), b"gitdir: /tmp/mock")
            .expect("git marker should exist");

        let detected =
            find_checkout_root(&executable_dir.join("loom")).expect("checkout root should resolve");
        assert_eq!(detected, repo_root);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn development_profile_does_not_migrate_the_canonical_namespaces() {
        let root = std::env::temp_dir().join(format!("loom-dev-migration-{}", Uuid::now_v7()));
        let canonical_app_data_dir = root.join("canonical-app-data");
        let canonical_app_home_dir = root.join("canonical-home");
        let legacy_app_data_dir = root.join(LEGACY_APP_BUNDLE_ID);
        let legacy_app_home_dir = root.join(LEGACY_APP_HOME_DIR_NAME);

        std::fs::create_dir_all(&canonical_app_data_dir).expect("canonical app data should exist");
        std::fs::create_dir_all(&canonical_app_home_dir).expect("canonical app home should exist");
        std::fs::create_dir_all(&legacy_app_data_dir).expect("legacy app data should exist");
        std::fs::create_dir_all(&legacy_app_home_dir).expect("legacy app home should exist");
        std::fs::write(legacy_app_data_dir.join("legacy.txt"), b"legacy-data")
            .expect("legacy app data should write");
        std::fs::write(legacy_app_home_dir.join("legacy.txt"), b"legacy-home")
            .expect("legacy app home should write");

        migrate_legacy_namespaces_for_profile(
            &AppExecutionProfile::Development {
                scope_name: "feature-ordering-test".to_string(),
            },
            &legacy_app_data_dir,
            &canonical_app_data_dir,
            &legacy_app_home_dir,
            &canonical_app_home_dir,
        )
        .expect("development migration should be a no-op");

        assert!(legacy_app_data_dir.join("legacy.txt").exists());
        assert!(legacy_app_home_dir.join("legacy.txt").exists());
        assert!(!canonical_app_data_dir.join("legacy.txt").exists());
        assert!(!canonical_app_home_dir.join("legacy.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
