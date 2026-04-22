use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

use crate::domain::settings::{OpenTarget, OpenTargetKind};
use crate::error::{AppError, AppResult};

pub fn open_environment(path: &Path, target: &OpenTarget) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "Environment path does not exist: {}",
            path.display()
        )));
    }
    if !path.is_dir() {
        return Err(AppError::Validation(format!(
            "Environment path is not a directory: {}",
            path.display()
        )));
    }

    let spec = build_launch_spec(path, target)?;
    run_launch(spec)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchSpec {
    program: String,
    args: Vec<OsString>,
}

fn build_launch_spec(path: &Path, target: &OpenTarget) -> AppResult<LaunchSpec> {
    let path_arg = path.as_os_str().to_os_string();

    match target.kind {
        OpenTargetKind::App => build_app_launch_spec(path_arg, target),
        OpenTargetKind::Command => Err(AppError::Validation(
            "Command-based Open In targets are no longer supported.".to_string(),
        )),
        OpenTargetKind::FileManager => build_file_manager_launch_spec(path_arg),
    }
}

#[cfg(target_os = "macos")]
fn build_app_launch_spec(path_arg: OsString, target: &OpenTarget) -> AppResult<LaunchSpec> {
    let app_name = target
        .app_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Validation("App targets require an application name.".to_string())
        })?;
    let args = vec![OsString::from("-a"), OsString::from(app_name), path_arg];
    Ok(LaunchSpec {
        program: "/usr/bin/open".to_string(),
        args,
    })
}

#[cfg(not(target_os = "macos"))]
fn build_app_launch_spec(_path_arg: OsString, _target: &OpenTarget) -> AppResult<LaunchSpec> {
    Err(AppError::Validation(
        "App launch targets are only supported on macOS in this build.".to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn build_file_manager_launch_spec(path_arg: OsString) -> AppResult<LaunchSpec> {
    Ok(LaunchSpec {
        program: "/usr/bin/open".to_string(),
        args: vec![path_arg],
    })
}

#[cfg(target_os = "windows")]
fn build_file_manager_launch_spec(path_arg: OsString) -> AppResult<LaunchSpec> {
    Ok(LaunchSpec {
        program: "explorer".to_string(),
        args: vec![path_arg],
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn build_file_manager_launch_spec(path_arg: OsString) -> AppResult<LaunchSpec> {
    Ok(LaunchSpec {
        program: "xdg-open".to_string(),
        args: vec![path_arg],
    })
}

fn run_launch(spec: LaunchSpec) -> AppResult<()> {
    let output = Command::new(&spec.program).args(&spec.args).output()?;
    if output.status.success() {
        return Ok(());
    }

    Err(AppError::Runtime(format_launch_failure(&spec, &output)))
}

fn format_launch_failure(spec: &LaunchSpec, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {}", output.status)
    };

    format!("Failed to launch {}: {details}", spec.program)
}

#[cfg(test)]
mod tests {
    use super::{build_launch_spec, format_launch_failure, LaunchSpec};
    use crate::domain::settings::{OpenTarget, OpenTargetKind};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::process::{ExitStatus, Output};

    #[cfg(unix)]
    use std::os::unix::ffi::OsStringExt;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn legacy_command_targets_are_rejected() {
        let target = OpenTarget {
            id: "cursor-cli".to_string(),
            label: "Cursor CLI".to_string(),
            kind: OpenTargetKind::Command,
            app_name: None,
            args: vec!["--reuse-window".to_string()],
        };

        assert_eq!(
            build_launch_spec(Path::new("/tmp/skein"), &target)
                .expect_err("legacy command target should be rejected")
                .to_string(),
            "Command-based Open In targets are no longer supported."
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_targets_use_the_open_command_without_extra_args() {
        let target = OpenTarget {
            id: "cursor".to_string(),
            label: "Cursor".to_string(),
            kind: OpenTargetKind::App,
            app_name: Some(" Cursor ".to_string()),
            args: vec!["--reuse-window".to_string()],
        };

        let spec = build_launch_spec(Path::new("/tmp/skein"), &target).expect("launch spec");

        assert_eq!(
            spec,
            LaunchSpec {
                program: "/usr/bin/open".to_string(),
                args: vec![
                    OsString::from("-a"),
                    OsString::from("Cursor"),
                    OsString::from("/tmp/skein"),
                ],
            }
        );
    }

    #[test]
    fn file_manager_targets_use_the_platform_default_launcher() {
        let target = OpenTarget {
            id: "file-manager".to_string(),
            label: "Finder".to_string(),
            kind: OpenTargetKind::FileManager,
            app_name: None,
            args: Vec::new(),
        };

        let spec = build_launch_spec(Path::new("/tmp/skein"), &target).expect("launch spec");

        #[cfg(target_os = "macos")]
        assert_eq!(
            spec,
            LaunchSpec {
                program: "/usr/bin/open".to_string(),
                args: vec![OsString::from("/tmp/skein")],
            }
        );

        #[cfg(target_os = "windows")]
        assert_eq!(
            spec,
            LaunchSpec {
                program: "explorer".to_string(),
                args: vec![OsString::from("/tmp/skein")],
            }
        );

        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        assert_eq!(
            spec,
            LaunchSpec {
                program: "xdg-open".to_string(),
                args: vec![OsString::from("/tmp/skein")],
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_manager_targets_preserve_non_utf8_environment_paths() {
        let target = OpenTarget {
            id: "file-manager".to_string(),
            label: "Finder".to_string(),
            kind: OpenTargetKind::FileManager,
            app_name: None,
            args: Vec::new(),
        };
        let path = PathBuf::from(OsString::from_vec(vec![
            b'/', b't', b'm', b'p', b'/', b'l', b'o', b'o', b'm', b'-', 0xFE,
        ]));

        let spec = build_launch_spec(&path, &target).expect("launch spec");

        assert_eq!(
            spec.args.last().map(OsString::as_os_str),
            Some(path.as_os_str())
        );
    }

    #[cfg(unix)]
    #[test]
    fn launch_failure_prefers_stderr_output() {
        let failure = format_launch_failure(
            &LaunchSpec {
                program: "/usr/bin/open".to_string(),
                args: vec![],
            },
            &Output {
                status: ExitStatus::from_raw(1 << 8),
                stdout: Vec::new(),
                stderr: b"Unable to find application named 'MissingApp'".to_vec(),
            },
        );

        assert_eq!(
            failure,
            "Failed to launch /usr/bin/open: Unable to find application named 'MissingApp'"
        );
    }
}
