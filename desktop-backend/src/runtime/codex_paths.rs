use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};

const CODEX_BINARY_VERSION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexCliVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: bool,
}

impl Ord for CodexCliVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (
            self.major,
            self.minor,
            self.patch,
            stable_release_rank(self.prerelease),
        )
            .cmp(&(
                other.major,
                other.minor,
                other.patch,
                stable_release_rank(other.prerelease),
            ))
    }
}

impl PartialOrd for CodexCliVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

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
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let candidates = executable_path_candidates(executable_name, home.as_deref());
    choose_best_executable_candidate(candidates)
}

fn executable_path_candidates(executable_name: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = which::which(executable_name) {
        push_unique(&mut candidates, path);
    }
    for candidate in binary_candidates(executable_name, home) {
        if let Ok(path) = which::which(&candidate) {
            push_unique(&mut candidates, path);
        }
    }
    candidates
}

fn choose_best_executable_candidate(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    choose_best_executable_candidate_with_timeout(candidates, CODEX_BINARY_VERSION_TIMEOUT)
}

fn choose_best_executable_candidate_with_timeout(
    candidates: Vec<PathBuf>,
    version_timeout: Duration,
) -> Option<PathBuf> {
    let mut fallback = None;
    let mut best: Option<(CodexCliVersion, PathBuf)> = None;

    for candidate in candidates {
        fallback.get_or_insert_with(|| candidate.clone());
        let Some(version) = codex_binary_version_with_timeout(&candidate, version_timeout) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(current_version, _)| version > *current_version)
        {
            best = Some((version, candidate));
        }
    }

    best.map(|(_, path)| path).or(fallback)
}

fn binary_candidates(executable_name: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if executable_name == "codex" {
        push_unique(
            &mut candidates,
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        );
        push_unique(
            &mut candidates,
            PathBuf::from("/Applications/Codex.app/Contents/Resources/bin/codex"),
        );
        if let Some(home) = home {
            push_unique(
                &mut candidates,
                home.join("Applications/Codex.app/Contents/Resources/codex"),
            );
            push_unique(
                &mut candidates,
                home.join("Applications/Codex.app/Contents/Resources/bin/codex"),
            );
        }
    }
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

pub fn parse_codex_cli_version(output: &str) -> Option<CodexCliVersion> {
    let token = output.split_whitespace().find(|part| {
        part.chars()
            .next()
            .is_some_and(|char| char.is_ascii_digit())
    })?;
    let (version, prerelease) = token
        .split_once('-')
        .map_or((token, false), |(version, _)| (version, true));
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some(CodexCliVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn codex_binary_version_with_timeout(path: &Path, timeout: Duration) -> Option<CodexCliVersion> {
    let start = Instant::now();
    let mut child = Command::new(path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let mut stdout_bytes = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut stdout_bytes);
    }
    let mut stderr_bytes = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_end(&mut stderr_bytes);
    }
    let _ = child.wait();

    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    parse_codex_cli_version(&stdout).or_else(|| parse_codex_cli_version(&stderr))
}

fn stable_release_rank(prerelease: bool) -> u8 {
    if prerelease {
        0
    } else {
        1
    }
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
        binary_candidates, build_codex_process_path, choose_best_executable_candidate,
        choose_best_executable_candidate_with_timeout, missing_codex_binary_message,
        parse_codex_cli_version, resolve_codex_binary_path, versioned_node_bin_paths,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
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
        let resolved = resolve_codex_binary_path(Some("git"))
            .expect("bare binary name should resolve from PATH");

        assert!(Path::new(&resolved).is_absolute());
        assert_eq!(
            Path::new(&resolved)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("git")
        );
    }

    #[test]
    fn choose_best_executable_candidate_falls_back_to_the_first_path_without_versions() {
        let executable_name = format!("codex-test-{}", Uuid::now_v7().simple());
        let root = std::env::temp_dir().join(format!("skein-codex-binary-{}", Uuid::now_v7()));
        let binary_dir = root.join("bin");
        let binary_path = binary_dir.join(&executable_name);
        fs::create_dir_all(&binary_dir).expect("binary dir should exist");
        fs::write(&binary_path, "#!/bin/sh\n").expect("binary should be written");
        make_executable(&binary_path);

        let resolved = choose_best_executable_candidate(vec![binary_path.clone()])
            .expect("candidate should resolve");

        let _ = fs::remove_dir_all(root);
        assert_eq!(resolved, binary_path);
    }

    #[test]
    fn choose_best_executable_candidate_prefers_the_newer_codex_binary() {
        let root = std::env::temp_dir().join(format!("skein-codex-home-{}", Uuid::now_v7()));
        let old_binary_path = root.join("path-bin/codex");
        let new_binary_path = root.join("Applications/Codex.app/Contents/Resources/codex");
        fs::create_dir_all(old_binary_path.parent().expect("path binary parent"))
            .expect("PATH dir should exist");
        fs::create_dir_all(new_binary_path.parent().expect("app binary parent"))
            .expect("app binary dir should exist");
        write_versioned_binary(&old_binary_path, "codex-cli 0.122.0");
        write_versioned_binary(&new_binary_path, "codex-cli 99.0.0");

        let resolved =
            choose_best_executable_candidate(vec![old_binary_path, new_binary_path.clone()])
                .expect("best binary should resolve");

        let _ = fs::remove_dir_all(root);
        assert_eq!(resolved, new_binary_path);
    }

    #[test]
    fn choose_best_executable_candidate_skips_version_probes_that_timeout() {
        let root = std::env::temp_dir().join(format!("skein-codex-timeout-{}", Uuid::now_v7()));
        let slow_binary_path = root.join("path-bin/codex");
        let new_binary_path = root.join("Applications/Codex.app/Contents/Resources/codex");
        fs::create_dir_all(slow_binary_path.parent().expect("slow binary parent"))
            .expect("slow binary dir should exist");
        fs::create_dir_all(new_binary_path.parent().expect("app binary parent"))
            .expect("app binary dir should exist");
        fs::write(&slow_binary_path, "#!/bin/sh\nsleep 5\n")
            .expect("slow binary should be written");
        make_executable(&slow_binary_path);
        write_versioned_binary(&new_binary_path, "codex-cli 99.0.0");

        let start = Instant::now();
        let resolved = choose_best_executable_candidate_with_timeout(
            vec![slow_binary_path, new_binary_path.clone()],
            Duration::from_millis(500),
        )
        .expect("best binary should resolve despite a hung probe");

        let _ = fs::remove_dir_all(root);
        assert_eq!(resolved, new_binary_path);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "hung version probes should be bounded"
        );
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

        assert!(candidates.contains(&PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/codex"
        )));
        assert!(candidates.contains(&PathBuf::from(
            "/Users/tester/Applications/Codex.app/Contents/Resources/codex"
        )));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.npm-global/bin/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.volta/bin/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.asdf/shims/codex")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/.n/bin/codex")));
    }

    #[test]
    fn parse_codex_cli_version_orders_releases_and_prereleases() {
        let stable = parse_codex_cli_version("codex-cli 0.124.0").expect("stable version");
        let prerelease =
            parse_codex_cli_version("codex-cli 0.124.0-alpha.2").expect("prerelease version");
        let older = parse_codex_cli_version("codex-cli 0.122.0").expect("older version");

        assert!(prerelease > older);
        assert!(stable > prerelease);
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

    fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).expect("binary metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("binary permissions should update");
        }
    }

    fn write_versioned_binary(path: &Path, version: &str) {
        fs::write(
            path,
            format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"{version}\"; fi\n"),
        )
        .expect("versioned binary should be written");
        make_executable(path);
    }
}
