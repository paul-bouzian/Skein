use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};

pub fn resolve_auto_binary_path() -> Option<PathBuf> {
    resolve_bare_executable_path("codex")
}

pub fn resolve_codex_binary_path(codex_binary_path: Option<&str>) -> AppResult<String> {
    match codex_binary_path {
        Some(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return Err(AppError::Validation(
                    "Codex binary path cannot be empty.".to_string(),
                ));
            }
            let path = Path::new(trimmed);
            if path.is_absolute() {
                return Ok(trimmed.to_string());
            }
            if is_bare_executable_name(path) {
                return resolve_bare_executable_path(trimmed)
                    .map(|path| path.to_string_lossy().to_string())
                    .ok_or_else(|| {
                        AppError::Validation(format!(
                            "Unable to resolve Codex binary `{trimmed}` from PATH or known Codex install locations. Set Settings -> Codex binary to its absolute path."
                        ))
                    });
            }
            Err(AppError::Validation(
                "Codex binary path must be an absolute path or executable name.".to_string(),
            ))
        }
        None => resolve_auto_binary_path()
            .ok_or_else(|| AppError::Runtime(missing_codex_binary_message()))
            .map(|path| path.to_string_lossy().to_string()),
    }
}

pub fn build_codex_process_path(binary_path: &str) -> OsString {
    let mut paths = Vec::new();

    if let Some(binary_dir) = Path::new(binary_path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        push_unique(&mut paths, binary_dir.to_path_buf());
    }

    let home = std::env::var_os("HOME").map(PathBuf::from);
    for path in shell_path_candidates(home.as_deref()) {
        push_unique(&mut paths, path);
    }

    if let Some(existing_path) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&existing_path) {
            push_unique(&mut paths, path);
        }
    }

    std::env::join_paths(paths).unwrap_or_else(|_| {
        std::env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
    })
}

pub fn missing_codex_binary_message() -> String {
    "Unable to resolve the Codex CLI binary. Skein can auto-detect Codex from official Homebrew and npm/global install locations, but apps launched from Finder do not inherit your shell PATH. Install `codex` in a standard binary directory or set Settings -> Codex binary to its absolute path.".to_string()
}

pub fn sync_process_path_from_login_shell() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let Some(shell) = resolve_login_shell() else {
            return;
        };
        let Some(path) = read_path_from_login_shell(&shell) else {
            return;
        };
        std::env::set_var("PATH", path);
    }
}

fn resolve_bare_executable_path(executable_name: &str) -> Option<PathBuf> {
    which::which(executable_name).ok().or_else(|| {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        binary_candidates(executable_name, home.as_deref())
            .into_iter()
            .find_map(|candidate| which::which(&candidate).ok())
    })
}

fn binary_candidates(executable_name: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    push_unique(
        &mut candidates,
        PathBuf::from("/opt/homebrew/bin").join(executable_name),
    );
    push_unique(
        &mut candidates,
        PathBuf::from("/usr/local/bin").join(executable_name),
    );
    for path in shell_path_candidates(home) {
        push_unique(&mut candidates, path.join(executable_name));
    }

    candidates
}

fn shell_path_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];

    if let Some(home) = home {
        paths.extend([
            home.join(".bun/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
            home.join(".volta/bin"),
            home.join(".asdf/bin"),
            home.join(".asdf/shims"),
            home.join(".n/bin"),
        ]);

        for path in versioned_node_bin_paths(home) {
            push_unique(&mut paths, path);
        }
    }

    paths
}

fn versioned_node_bin_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    collect_child_bin_paths(&home.join(".nvm/versions/node"), &["bin"], &mut paths);
    collect_child_bin_paths(
        &home.join(".local/share/fnm/node-versions"),
        &["installation", "bin"],
        &mut paths,
    );

    paths
}

fn collect_child_bin_paths(root: &Path, suffix: &[&str], output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }

        let mut candidate = entry.path();
        for segment in suffix {
            candidate = candidate.join(segment);
        }

        if candidate.is_dir() {
            push_unique(output, candidate);
        }
    }
}

fn push_unique(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.contains(&candidate) {
        paths.push(candidate);
    }
}

fn is_bare_executable_name(path: &Path) -> bool {
    let mut components = path.components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn resolve_login_shell() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").map(PathBuf::from);
    let shell = shell.filter(|path| path.is_absolute() && path.exists());
    shell.or_else(|| {
        ["/bin/zsh", "/bin/bash", "/bin/sh"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.exists())
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read_path_from_login_shell(shell: &Path) -> Option<OsString> {
    let output = Command::new(shell)
        .arg("-l")
        .arg("-c")
        .arg("printf %s \"$PATH\"")
        .env("TERM", "dumb")
        .output()
        .ok()?;

    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    Some(OsString::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        binary_candidates, build_codex_process_path, missing_codex_binary_message,
        resolve_codex_binary_path, versioned_node_bin_paths,
    };
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use uuid::Uuid;

    #[test]
    fn codex_process_path_puts_binary_directory_first_for_gui_launches() {
        let path = build_codex_process_path("/opt/homebrew/bin/codex");
        let segments = std::env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(segments.first(), Some(&PathBuf::from("/opt/homebrew/bin")));
        assert!(segments.contains(&PathBuf::from("/usr/bin")));
        assert!(segments.contains(&PathBuf::from("/bin")));
    }

    #[test]
    fn codex_process_path_skips_empty_parent_for_bare_names() {
        let path = build_codex_process_path("codex");
        let segments = std::env::split_paths(&path).collect::<Vec<_>>();

        assert_ne!(segments.first(), Some(&PathBuf::from("")));
    }

    #[test]
    fn resolve_explicit_binary_path_accepts_absolute_paths() {
        let path = resolve_codex_binary_path(Some("/opt/homebrew/bin/codex"))
            .expect("absolute binary path should resolve");

        assert_eq!(path, "/opt/homebrew/bin/codex");
    }

    #[test]
    fn resolve_explicit_binary_path_resolves_bare_names_from_path() {
        let _guard = environment_lock()
            .lock()
            .expect("environment lock should not be poisoned");
        let executable_name = format!("codex-test-{}", Uuid::now_v7().simple());
        let root = std::env::temp_dir().join(format!("skein-codex-binary-{}", Uuid::now_v7()));
        let binary_path = root.join(&executable_name);
        fs::create_dir_all(&root).expect("binary dir should exist");
        fs::write(&binary_path, "#!/bin/sh\n").expect("binary should be written");
        make_executable(&binary_path);
        let _path_restore = EnvVarRestore::capture("PATH");
        std::env::set_var("PATH", &root);

        let resolved = resolve_codex_binary_path(Some(&executable_name))
            .expect("bare binary name should resolve from PATH");

        let _ = fs::remove_dir_all(root);
        assert_eq!(resolved, binary_path.to_string_lossy());
    }

    #[test]
    fn resolve_explicit_binary_path_resolves_bare_names_from_known_install_candidates() {
        let _guard = environment_lock()
            .lock()
            .expect("environment lock should not be poisoned");
        let executable_name = format!("codex-test-{}", Uuid::now_v7().simple());
        let root = std::env::temp_dir().join(format!("skein-codex-home-{}", Uuid::now_v7()));
        let empty_path = root.join("empty-path");
        let binary_dir = root.join(".local/bin");
        let binary_path = binary_dir.join(&executable_name);
        fs::create_dir_all(&empty_path).expect("empty PATH dir should exist");
        fs::create_dir_all(&binary_dir).expect("binary dir should exist");
        fs::write(&binary_path, "#!/bin/sh\n").expect("binary should be written");
        make_executable(&binary_path);
        let _path_restore = EnvVarRestore::capture("PATH");
        let _home_restore = EnvVarRestore::capture("HOME");
        std::env::set_var("PATH", &empty_path);
        std::env::set_var("HOME", &root);

        let resolved = resolve_codex_binary_path(Some(&executable_name))
            .expect("bare binary name should resolve from known install candidates");

        let _ = fs::remove_dir_all(root);
        assert_eq!(resolved, binary_path.to_string_lossy());
    }

    #[test]
    fn resolve_explicit_binary_path_rejects_relative_paths_with_components() {
        let error = resolve_codex_binary_path(Some("./bin/codex"))
            .expect_err("relative binary paths should be rejected");

        assert!(
            error
                .to_string()
                .contains("absolute path or executable name"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn binary_candidates_cover_common_npm_and_tooling_locations() {
        let candidates = binary_candidates("codex", Some(Path::new("/Users/tester")));

        assert!(candidates.contains(&PathBuf::from("/Users/tester/.npm-global/bin/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.volta/bin/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.asdf/shims/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.n/bin/codex")));
    }

    #[test]
    fn versioned_node_bin_paths_include_nvm_and_fnm_installs() {
        let root = std::env::temp_dir().join(format!("skein-codex-paths-{}", Uuid::now_v7()));
        let nvm_bin = root.join(".nvm/versions/node/v25.6.1/bin");
        let fnm_bin = root.join(".local/share/fnm/node-versions/v25.6.1/installation/bin");
        fs::create_dir_all(&nvm_bin).expect("nvm bin dir should exist");
        fs::create_dir_all(&fnm_bin).expect("fnm bin dir should exist");

        let paths = versioned_node_bin_paths(&root);

        assert!(paths.contains(&nvm_bin));
        assert!(paths.contains(&fnm_bin));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_binary_message_mentions_finder_and_supported_installs() {
        let message = missing_codex_binary_message();

        assert!(message.contains("Finder"));
        assert!(message.contains("Homebrew"));
        assert!(message.contains("npm"));
        assert!(message.contains("Settings -> Codex binary"));
    }

    fn environment_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvVarRestore {
        name: &'static str,
        value: Option<OsString>,
    }

    impl EnvVarRestore {
        fn capture(name: &'static str) -> Self {
            Self {
                name,
                value: std::env::var_os(name),
            }
        }
    }

    impl Drop for EnvVarRestore {
        fn drop(&mut self) {
            if let Some(value) = self.value.take() {
                std::env::set_var(self.name, value);
            } else {
                std::env::remove_var(self.name);
            }
        }
    }

    fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).expect("binary metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("binary permissions should update");
        }
    }
}
