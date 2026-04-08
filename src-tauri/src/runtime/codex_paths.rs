use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn resolve_auto_binary_path() -> Option<PathBuf> {
    which::which("codex").ok().or_else(|| {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        codex_binary_candidates(home.as_deref())
            .into_iter()
            .find_map(|candidate| which::which(&candidate).ok())
    })
}

pub fn build_codex_process_path(binary_path: &str) -> OsString {
    let mut paths = Vec::new();

    if let Some(binary_dir) = Path::new(binary_path).parent() {
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
    "Unable to resolve the Codex CLI binary. Loom can auto-detect Codex from official Homebrew and npm/global install locations, but apps launched from Finder do not inherit your shell PATH. Install `codex` in a standard binary directory or set Settings -> Codex binary to its absolute path.".to_string()
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

fn codex_binary_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];

    for path in shell_path_candidates(home) {
        candidates.push(path.join("codex"));
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
        build_codex_process_path, codex_binary_candidates, missing_codex_binary_message,
        versioned_node_bin_paths,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
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
    fn binary_candidates_cover_common_npm_and_tooling_locations() {
        let candidates = codex_binary_candidates(Some(Path::new("/Users/tester")));

        assert!(candidates.contains(&PathBuf::from("/Users/tester/.npm-global/bin/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.volta/bin/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.asdf/shims/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.n/bin/codex")));
    }

    #[test]
    fn versioned_node_bin_paths_include_nvm_and_fnm_installs() {
        let root = std::env::temp_dir().join(format!("loom-codex-paths-{}", Uuid::now_v7()));
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
}
