#[cfg(target_os = "macos")]
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub const APP_NAME: &str = "Skein";
#[cfg(target_os = "macos")]
pub const APP_BUNDLE_NAME: &str = "Skein.app";
pub const LEGACY_APP_BUNDLE_IDS: &[&str] = &["com.paulbouzian.loom", "com.paulbouzian.threadex"];

pub const APP_HOME_DIR_NAME: &str = ".skein";
pub const LEGACY_APP_HOME_DIR_NAMES: &[&str] = &[".loom", ".threadex"];
pub const DEVELOPMENT_STORAGE_DIR_NAME: &str = "development";

pub const APP_DATABASE_FILE_NAME: &str = "skein.sqlite3";
pub const LEGACY_APP_DATABASE_FILE_NAMES: &[&str] = &["loom.sqlite3", "threadex.sqlite3"];

pub const CONVERSATION_EVENT_NAME: &str = "skein://conversation-event";
pub const CODEX_USAGE_EVENT_NAME: &str = "skein://codex-usage-event";
pub const WORKSPACE_EVENT_NAME: &str = "skein://workspace-event";
pub const WORKTREE_SCRIPT_FAILURE_EVENT_NAME: &str = "skein://worktree-script-failure";
pub const FIRST_PROMPT_RENAME_FAILURE_EVENT_NAME: &str = "skein://first-prompt-rename-failure";
pub const TERMINAL_OUTPUT_EVENT_NAME: &str = "skein://terminal-output";
pub const TERMINAL_EXIT_EVENT_NAME: &str = "skein://terminal-exit";
pub const MENU_OPEN_SETTINGS_EVENT_NAME: &str = "skein://menu-open-settings";
pub const MENU_CHECK_FOR_UPDATES_EVENT_NAME: &str = "skein://menu-check-for-updates";

#[derive(Debug, Clone)]
pub struct AppStoragePaths {
    pub app_data_dir: PathBuf,
    pub app_home_dir: PathBuf,
    pub legacy_app_home_dirs: Vec<PathBuf>,
}

fn legacy_app_data_dirs(app_data_root: &Path) -> Vec<PathBuf> {
    LEGACY_APP_BUNDLE_IDS
        .iter()
        .map(|bundle_id| app_data_root.join(bundle_id))
        .collect()
}

pub fn prepare_storage_paths(app: &AppHandle) -> AppResult<AppStoragePaths> {
    let installed_app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Runtime(error.to_string()))?;
    let app_data_root = installed_app_data_dir.parent().ok_or_else(|| {
        AppError::Runtime("Unable to resolve the parent directory for Skein app data.".to_string())
    })?;
    let legacy_app_data_dirs = legacy_app_data_dirs(app_data_root);

    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| AppError::Runtime(error.to_string()))?;
    let canonical_installed_app_home_dir = home_dir.join(APP_HOME_DIR_NAME);
    let legacy_installed_app_home_dirs = LEGACY_APP_HOME_DIR_NAMES
        .iter()
        .map(|name| home_dir.join(name))
        .collect::<Vec<_>>();

    let executable_path = std::env::current_exe().map_err(|error| {
        AppError::Runtime(format!("Unable to resolve Skein executable path: {error}"))
    })?;
    let execution_profile = resolve_execution_profile(&executable_path)?;
    migrate_legacy_namespaces_for_profile(
        &execution_profile,
        &legacy_app_data_dirs,
        &installed_app_data_dir,
        &legacy_installed_app_home_dirs,
        &canonical_installed_app_home_dir,
    )?;
    let storage_paths = storage_paths_for_profile(
        execution_profile,
        installed_app_data_dir,
        canonical_installed_app_home_dir,
        legacy_installed_app_home_dirs,
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
    legacy_installed_app_home_dirs: Vec<PathBuf>,
) -> AppStoragePaths {
    match execution_profile {
        AppExecutionProfile::Installed => AppStoragePaths {
            app_data_dir: canonical_app_data_dir,
            app_home_dir: canonical_app_home_dir,
            legacy_app_home_dirs: legacy_installed_app_home_dirs,
        },
        AppExecutionProfile::Development { scope_name } => {
            let scoped_root = canonical_app_home_dir
                .join(DEVELOPMENT_STORAGE_DIR_NAME)
                .join(&scope_name);

            AppStoragePaths {
                app_data_dir: scoped_root.join("app-data"),
                app_home_dir: scoped_root.join("home"),
                legacy_app_home_dirs: legacy_installed_app_home_dirs
                    .into_iter()
                    .map(|legacy_home_dir| {
                        legacy_home_dir
                            .join(DEVELOPMENT_STORAGE_DIR_NAME)
                            .join(&scope_name)
                            .join("home")
                    })
                    .collect(),
            }
        }
    }
}

fn migrate_legacy_namespaces_for_profile(
    execution_profile: &AppExecutionProfile,
    legacy_app_data_dirs: &[PathBuf],
    canonical_app_data_dir: &Path,
    legacy_installed_app_home_dirs: &[PathBuf],
    canonical_installed_app_home_dir: &Path,
) -> AppResult<()> {
    match execution_profile {
        AppExecutionProfile::Installed => {
            for legacy_app_data_dir in legacy_app_data_dirs {
                migrate_directory_namespace(legacy_app_data_dir, canonical_app_data_dir)?;
            }
            for legacy_app_home_dir in legacy_installed_app_home_dirs {
                migrate_directory_namespace(legacy_app_home_dir, canonical_installed_app_home_dir)?;
            }
        }
        AppExecutionProfile::Development { scope_name } => {
            let canonical_scoped_root = canonical_installed_app_home_dir
                .join(DEVELOPMENT_STORAGE_DIR_NAME)
                .join(scope_name);
            for legacy_app_home_dir in legacy_installed_app_home_dirs {
                let legacy_scoped_root = legacy_app_home_dir
                    .join(DEVELOPMENT_STORAGE_DIR_NAME)
                    .join(scope_name);
                migrate_directory_namespace(&legacy_scoped_root, &canonical_scoped_root)?;
            }
        }
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

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct InstalledBundlePaths {
    current_bundle_path: PathBuf,
    canonical_bundle_path: PathBuf,
    canonical_executable_path: PathBuf,
}

#[cfg(target_os = "macos")]
fn installed_bundle_paths_from_executable(executable_path: &Path) -> Option<InstalledBundlePaths> {
    if !matches!(
        resolve_execution_profile(executable_path).ok()?,
        AppExecutionProfile::Installed
    ) {
        return None;
    }

    let macos_dir = executable_path.parent()?;
    if macos_dir.file_name() != Some(OsStr::new("MacOS")) {
        return None;
    }

    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name() != Some(OsStr::new("Contents")) {
        return None;
    }

    let current_bundle_path = contents_dir.parent()?.to_path_buf();
    if current_bundle_path.extension() != Some(OsStr::new("app")) {
        return None;
    }

    let executable_name = executable_path.file_name()?;
    let canonical_bundle_path = current_bundle_path.parent()?.join(APP_BUNDLE_NAME);
    let canonical_executable_path = canonical_bundle_path
        .join("Contents")
        .join("MacOS")
        .join(executable_name);

    Some(InstalledBundlePaths {
        current_bundle_path,
        canonical_bundle_path,
        canonical_executable_path,
    })
}

fn canonical_bundle_paths_if_relaunch_needed(
    executable_path: &Path,
) -> AppResult<Option<InstalledBundlePaths>> {
    let Some(paths) = installed_bundle_paths_from_executable(executable_path) else {
        return Ok(None);
    };

    if paths.current_bundle_path == paths.canonical_bundle_path {
        return Ok(None);
    }

    if paths.canonical_bundle_path.exists() {
        return Ok((!paths.current_bundle_path.exists()
            && paths.canonical_executable_path.exists())
        .then_some(paths));
    }

    fs::rename(&paths.current_bundle_path, &paths.canonical_bundle_path)?;
    Ok(Some(paths))
}

#[cfg(target_os = "macos")]
pub fn best_effort_rename_installed_bundle() -> AppResult<()> {
    let executable_path = std::env::current_exe()?;
    canonical_bundle_paths_if_relaunch_needed(&executable_path)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn restart_from_canonical_bundle_if_needed(app: &AppHandle) -> AppResult<bool> {
    let executable_path = std::env::current_exe()?;
    let Some(paths) = canonical_bundle_paths_if_relaunch_needed(&executable_path)? else {
        return Ok(false);
    };
    Command::new(&paths.canonical_executable_path)
        .args(std::env::args_os().skip(1))
        .spawn()?;
    app.exit(0);
    Ok(true)
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
            "Legacy app migration source is not a directory: {}",
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
            "App migration destination is not a directory: {}",
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

            // Legacy namespaces are migrated from newest to oldest. If a path already
            // exists in the canonical tree, keep that winner and discard the older copy.
            discard_legacy_conflict(&source_path)?;
            continue;
        }

        fs::rename(&source_path, &destination_path)?;
    }

    Ok(())
}

fn discard_legacy_conflict(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
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
    #[cfg(target_os = "macos")]
    use super::installed_bundle_paths_from_executable;
    use super::{
        canonical_bundle_paths_if_relaunch_needed, development_scope_name, find_checkout_root,
        legacy_app_data_dirs, merge_directory_contents, migrate_legacy_namespaces_for_profile,
        remove_empty_tree, resolve_execution_profile, storage_paths_for_profile,
        AppExecutionProfile, APP_DATABASE_FILE_NAME, DEVELOPMENT_STORAGE_DIR_NAME,
        LEGACY_APP_DATABASE_FILE_NAMES, LEGACY_APP_HOME_DIR_NAMES,
    };
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn merge_directory_contents_moves_nested_entries_without_overwrite() {
        let root = std::env::temp_dir().join(format!("skein-app-identity-{}", Uuid::now_v7()));
        let legacy = root.join("legacy");
        let current = root.join("current");
        std::fs::create_dir_all(legacy.join("nested")).expect("legacy dir should exist");
        std::fs::create_dir_all(&current).expect("current dir should exist");
        std::fs::write(
            legacy
                .join("nested")
                .join(LEGACY_APP_DATABASE_FILE_NAMES[1]),
            b"db",
        )
        .expect("legacy db should write");

        merge_directory_contents(&legacy, &current).expect("merge should succeed");

        assert!(current
            .join("nested")
            .join(LEGACY_APP_DATABASE_FILE_NAMES[1])
            .exists());
        assert!(!Path::new(
            &legacy
                .join("nested")
                .join(LEGACY_APP_DATABASE_FILE_NAMES[1])
        )
        .exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_empty_tree_removes_now_empty_directories() {
        let root = std::env::temp_dir().join(format!("skein-empty-tree-{}", Uuid::now_v7()));
        let empty = root.join(APP_DATABASE_FILE_NAME);
        std::fs::create_dir_all(&root).expect("root should exist");
        std::fs::create_dir_all(&empty).expect("empty dir should exist");

        remove_empty_tree(&empty).expect("cleanup should succeed");

        assert!(!empty.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn checkout_launched_executables_use_development_profile() {
        let root = std::env::temp_dir().join(format!("skein-profile-{}", Uuid::now_v7()));
        let repo_root = root.join("feature-ordering");
        std::fs::create_dir_all(repo_root.join("src-tauri").join("target").join("debug"))
            .expect("repo target directory should exist");
        std::fs::write(repo_root.join(".git"), b"gitdir: /tmp/mock")
            .expect("git marker should exist");
        let executable = repo_root
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join("skein");

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
        let root = std::env::temp_dir().join(format!("skein-installed-{}", Uuid::now_v7()));
        let app_data_dir = root.join("app-data");
        let app_home_dir = root.join("home");
        let legacy_app_home_dirs = vec![root.join("legacy-previous"), root.join("legacy-threadex")];

        let paths = storage_paths_for_profile(
            AppExecutionProfile::Installed,
            app_data_dir.clone(),
            app_home_dir.clone(),
            legacy_app_home_dirs.clone(),
        );

        assert_eq!(paths.app_data_dir, app_data_dir);
        assert_eq!(paths.app_home_dir, app_home_dir);
        assert_eq!(paths.legacy_app_home_dirs, legacy_app_home_dirs);
    }

    #[test]
    fn checkout_storage_paths_are_scoped_under_the_development_namespace() {
        let root = std::env::temp_dir().join(format!("skein-dev-storage-{}", Uuid::now_v7()));
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
            .join("skein");
        let execution_profile =
            resolve_execution_profile(&executable).expect("profile should resolve");
        let paths = storage_paths_for_profile(
            execution_profile,
            root.join("app-data"),
            root.join("home").join(".skein"),
            vec![
                root.join("home").join(".loom"),
                root.join("home").join(".threadex"),
            ],
        );
        let scope_name = paths
            .app_home_dir
            .parent()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .expect("scope name should exist")
            .to_string();

        assert!(paths.app_home_dir.starts_with(
            root.join("home")
                .join(".skein")
                .join(DEVELOPMENT_STORAGE_DIR_NAME)
        ));
        assert!(paths.app_data_dir.ends_with(Path::new("app-data")));
        assert_eq!(
            paths.legacy_app_home_dirs,
            vec![
                root.join("home")
                    .join(".loom")
                    .join(DEVELOPMENT_STORAGE_DIR_NAME)
                    .join(&scope_name)
                    .join("home"),
                root.join("home")
                    .join(".threadex")
                    .join(DEVELOPMENT_STORAGE_DIR_NAME)
                    .join(&scope_name)
                    .join("home"),
            ]
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn development_scope_name_is_stable_for_a_checkout_path() {
        let checkout_root = Path::new("/Users/paul/dev/Skein-feature");

        let first = development_scope_name(checkout_root);
        let second = development_scope_name(checkout_root);

        assert_eq!(first, second);
        assert!(first.starts_with("skein-feature-"));
    }

    #[test]
    fn find_checkout_root_detects_git_file_worktrees() {
        let root = std::env::temp_dir().join(format!("skein-checkout-root-{}", Uuid::now_v7()));
        let repo_root = root.join("repo");
        let executable_dir = repo_root.join("src-tauri").join("target").join("debug");
        std::fs::create_dir_all(&executable_dir).expect("executable dir should exist");
        std::fs::write(repo_root.join(".git"), b"gitdir: /tmp/mock")
            .expect("git marker should exist");

        let detected = find_checkout_root(&executable_dir.join("skein"))
            .expect("checkout root should resolve");
        assert_eq!(detected, repo_root);

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_bundle_paths_detects_legacy_bundle_locations() {
        let executable_path = Path::new("/Applications/Loom.app/Contents/MacOS/skein");

        let paths = installed_bundle_paths_from_executable(executable_path)
            .expect("installed bundle paths should resolve");

        assert_eq!(
            paths.current_bundle_path,
            Path::new("/Applications/Loom.app")
        );
        assert_eq!(
            paths.canonical_bundle_path,
            Path::new("/Applications/Skein.app")
        );
        assert_eq!(
            paths.canonical_executable_path,
            Path::new("/Applications/Skein.app/Contents/MacOS/skein")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn relaunch_helper_uses_the_canonical_bundle_after_startup_rename() {
        let root = std::env::temp_dir().join(format!("skein-relaunch-{}", Uuid::now_v7()));
        let canonical_executable = root.join("Skein.app/Contents/MacOS/skein");
        std::fs::create_dir_all(canonical_executable.parent().expect("parent should exist"))
            .expect("canonical bundle should exist");
        std::fs::write(&canonical_executable, b"binary").expect("executable should write");

        let legacy_executable = root.join("Loom.app/Contents/MacOS/skein");
        let paths = canonical_bundle_paths_if_relaunch_needed(&legacy_executable)
            .expect("relaunch detection should succeed")
            .expect("canonical relaunch should be required");

        assert_eq!(paths.current_bundle_path, root.join("Loom.app"));
        assert_eq!(paths.canonical_bundle_path, root.join("Skein.app"));
        assert_eq!(paths.canonical_executable_path, canonical_executable);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn development_profile_migrates_legacy_scoped_storage() {
        let root = std::env::temp_dir().join(format!("skein-dev-migration-{}", Uuid::now_v7()));
        let canonical_app_data_dir = root.join("canonical-app-data");
        let canonical_app_home_dir = root.join("home").join(".skein");
        let legacy_app_data_dirs = legacy_app_data_dirs(&root);
        let legacy_app_home_dirs = LEGACY_APP_HOME_DIR_NAMES
            .iter()
            .map(|name| root.join("home").join(name))
            .collect::<Vec<_>>();
        let legacy_scoped_root = legacy_app_home_dirs[0]
            .join(DEVELOPMENT_STORAGE_DIR_NAME)
            .join("feature-ordering-test");
        let canonical_scoped_root = canonical_app_home_dir
            .join(DEVELOPMENT_STORAGE_DIR_NAME)
            .join("feature-ordering-test");

        std::fs::create_dir_all(&canonical_app_data_dir).expect("canonical app data should exist");
        std::fs::create_dir_all(legacy_scoped_root.join("home"))
            .expect("legacy scoped home should exist");
        std::fs::create_dir_all(legacy_scoped_root.join("app-data"))
            .expect("legacy scoped app data should exist");
        std::fs::create_dir_all(&legacy_app_data_dirs[0]).expect("legacy app data should exist");
        std::fs::write(
            legacy_scoped_root.join("home").join("legacy.txt"),
            b"legacy-home",
        )
        .expect("legacy scoped home should write");
        std::fs::write(
            legacy_scoped_root.join("app-data").join("state.txt"),
            b"legacy-app-data",
        )
        .expect("legacy scoped app data should write");

        migrate_legacy_namespaces_for_profile(
            &AppExecutionProfile::Development {
                scope_name: "feature-ordering-test".to_string(),
            },
            &legacy_app_data_dirs,
            &canonical_app_data_dir,
            &legacy_app_home_dirs,
            &canonical_app_home_dir,
        )
        .expect("development migration should succeed");

        assert!(canonical_scoped_root
            .join("home")
            .join("legacy.txt")
            .exists());
        assert!(canonical_scoped_root
            .join("app-data")
            .join("state.txt")
            .exists());
        assert!(!legacy_scoped_root.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn installed_profile_migrates_legacy_home_dirs_in_order() {
        let root =
            std::env::temp_dir().join(format!("skein-installed-migration-{}", Uuid::now_v7()));
        let canonical_app_data_dir = root.join("canonical-app-data");
        let canonical_app_home_dir = root.join("home").join(".skein");
        let legacy_app_data_dirs = legacy_app_data_dirs(&root);
        let legacy_app_home_dirs = LEGACY_APP_HOME_DIR_NAMES
            .iter()
            .map(|name| root.join("home").join(name))
            .collect::<Vec<_>>();

        std::fs::create_dir_all(&legacy_app_data_dirs[0]).expect("loom app data should exist");
        std::fs::create_dir_all(&legacy_app_data_dirs[1]).expect("threadex app data should exist");
        std::fs::create_dir_all(&legacy_app_home_dirs[0]).expect("previous home dir should exist");
        std::fs::create_dir_all(&legacy_app_home_dirs[1]).expect("threadex dir should exist");
        std::fs::write(legacy_app_data_dirs[0].join("loom.txt"), b"loom-app-data")
            .expect("loom app data should write");
        std::fs::write(
            legacy_app_data_dirs[1].join("threadex.txt"),
            b"threadex-app-data",
        )
        .expect("threadex app data should write");
        std::fs::write(
            legacy_app_home_dirs[0].join("previous.txt"),
            b"previous-home",
        )
        .expect("previous home should write");
        std::fs::write(
            legacy_app_home_dirs[1].join("threadex.txt"),
            b"threadex-home",
        )
        .expect("threadex home should write");

        migrate_legacy_namespaces_for_profile(
            &AppExecutionProfile::Installed,
            &legacy_app_data_dirs,
            &canonical_app_data_dir,
            &legacy_app_home_dirs,
            &canonical_app_home_dir,
        )
        .expect("installed migration should succeed");

        assert!(canonical_app_data_dir.join("loom.txt").exists());
        assert!(canonical_app_data_dir.join("threadex.txt").exists());
        assert!(canonical_app_home_dir.join("previous.txt").exists());
        assert!(canonical_app_home_dir.join("threadex.txt").exists());
        assert!(!legacy_app_data_dirs[0].exists());
        assert!(!legacy_app_data_dirs[1].exists());
        assert!(!legacy_app_home_dirs[0].exists());
        assert!(!legacy_app_home_dirs[1].exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn installed_profile_keeps_newer_legacy_entries_when_paths_conflict() {
        let root =
            std::env::temp_dir().join(format!("skein-installed-conflict-{}", Uuid::now_v7()));
        let canonical_app_data_dir = root.join("canonical-app-data");
        let canonical_app_home_dir = root.join("home").join(".skein");
        let legacy_app_data_dirs = legacy_app_data_dirs(&root);
        let legacy_app_home_dirs = LEGACY_APP_HOME_DIR_NAMES
            .iter()
            .map(|name| root.join("home").join(name))
            .collect::<Vec<_>>();

        std::fs::create_dir_all(legacy_app_data_dirs[0].join("nested"))
            .expect("loom app data should exist");
        std::fs::create_dir_all(legacy_app_data_dirs[1].join("nested"))
            .expect("threadex app data should exist");
        std::fs::create_dir_all(legacy_app_home_dirs[0].join("nested"))
            .expect("loom home dir should exist");
        std::fs::create_dir_all(legacy_app_home_dirs[1].join("nested"))
            .expect("threadex home dir should exist");
        std::fs::write(
            legacy_app_data_dirs[0].join("nested").join("shared.txt"),
            b"loom-app-data",
        )
        .expect("loom app data should write");
        std::fs::write(
            legacy_app_data_dirs[1].join("nested").join("shared.txt"),
            b"threadex-app-data",
        )
        .expect("threadex app data should write");
        std::fs::write(
            legacy_app_home_dirs[0].join("nested").join("shared.txt"),
            b"loom-home",
        )
        .expect("loom home should write");
        std::fs::write(
            legacy_app_home_dirs[1].join("nested").join("shared.txt"),
            b"threadex-home",
        )
        .expect("threadex home should write");

        migrate_legacy_namespaces_for_profile(
            &AppExecutionProfile::Installed,
            &legacy_app_data_dirs,
            &canonical_app_data_dir,
            &legacy_app_home_dirs,
            &canonical_app_home_dir,
        )
        .expect("installed migration should succeed");

        assert_eq!(
            std::fs::read(canonical_app_data_dir.join("nested").join("shared.txt"))
                .expect("canonical app data should exist"),
            b"loom-app-data"
        );
        assert_eq!(
            std::fs::read(canonical_app_home_dir.join("nested").join("shared.txt"))
                .expect("canonical home should exist"),
            b"loom-home"
        );
        assert!(!legacy_app_data_dirs[0].exists());
        assert!(!legacy_app_data_dirs[1].exists());
        assert!(!legacy_app_home_dirs[0].exists());
        assert!(!legacy_app_home_dirs[1].exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
