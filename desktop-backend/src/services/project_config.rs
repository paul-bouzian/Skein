use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::workspace::{ProjectManualAction, ProjectSettings, ProjectSettingsPatch};
use crate::error::{AppError, AppResult};

const PROJECT_CONFIG_FILE: &str = "skein.json";
const PROJECT_CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
    version: u32,
    #[serde(default)]
    worktree: WorktreeConfig,
    #[serde(default)]
    actions: Vec<ProjectManualAction>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorktreeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    setup_script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    teardown_script: Option<String>,
}

pub fn project_config_path(project_root: &Path) -> PathBuf {
    project_root.join(PROJECT_CONFIG_FILE)
}

pub fn read_project_settings(
    project_root: &Path,
    fallback_settings: &ProjectSettings,
) -> AppResult<ProjectSettings> {
    let settings = match read_project_config(project_root)? {
        Some(config) => project_settings_from_config(config),
        None => fallback_settings.clone(),
    };
    settings.validate(None).map_err(|error| {
        AppError::Validation(format!(
            "Invalid {}: {error}",
            project_config_path(project_root).display()
        ))
    })?;
    Ok(settings)
}

pub fn write_project_settings(project_root: &Path, settings: &ProjectSettings) -> AppResult<()> {
    let path = project_config_path(project_root);
    let config = ProjectConfig {
        version: PROJECT_CONFIG_VERSION,
        worktree: WorktreeConfig {
            setup_script: settings.worktree_setup_script.clone(),
            teardown_script: settings.worktree_teardown_script.clone(),
        },
        actions: settings.manual_actions.clone(),
    };
    let payload = serde_json::to_string_pretty(&config)
        .map_err(|error| AppError::Validation(error.to_string()))?;
    write_atomically(
        &path,
        &project_root.join(format!(".{PROJECT_CONFIG_FILE}.{}.tmp", Uuid::now_v7())),
        format!("{payload}\n").as_bytes(),
    )
}

fn write_atomically(path: &Path, temp_path: &Path, payload: &[u8]) -> AppResult<()> {
    let result = (|| -> AppResult<()> {
        let mut file = fs::File::create(temp_path)?;
        file.write_all(payload)?;
        file.sync_all()?;
        fs::rename(temp_path, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }

    result
}

fn read_project_config(project_root: &Path) -> AppResult<Option<ProjectConfig>> {
    let path = project_config_path(project_root);
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let config = serde_json::from_str::<ProjectConfig>(&raw).map_err(|error| {
                AppError::Validation(format!("Invalid {}: {error}", path.display()))
            })?;
            validate_project_config_version(&path, config.version)?;
            Ok(Some(config))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn validate_project_config_version(path: &Path, version: u32) -> AppResult<()> {
    if version == PROJECT_CONFIG_VERSION {
        return Ok(());
    }

    Err(AppError::Validation(format!(
        "Unsupported {} version {version}; expected version {PROJECT_CONFIG_VERSION}.",
        path.display()
    )))
}

fn project_settings_from_config(config: ProjectConfig) -> ProjectSettings {
    let mut settings = ProjectSettings::default();
    settings.apply_patch(ProjectSettingsPatch {
        worktree_setup_script: Some(config.worktree.setup_script),
        worktree_teardown_script: Some(config.worktree.teardown_script),
        manual_actions: Some(Some(config.actions)),
    });
    settings
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use uuid::Uuid;

    use super::{project_config_path, read_project_settings, write_project_settings};
    use crate::domain::workspace::{ProjectActionIcon, ProjectManualAction, ProjectSettings};

    #[test]
    fn missing_config_returns_fallback_settings() {
        let temp = TempRoot::new();
        let fallback = ProjectSettings {
            worktree_setup_script: Some("bun install".to_string()),
            worktree_teardown_script: None,
            manual_actions: Vec::new(),
        };

        let settings = read_project_settings(temp.path(), &fallback).expect("settings should load");

        assert_eq!(settings, fallback);
    }

    #[test]
    fn writes_and_reads_project_config() {
        let temp = TempRoot::new();
        let settings = ProjectSettings {
            worktree_setup_script: Some("bun install".to_string()),
            worktree_teardown_script: Some("./scripts/cleanup.sh".to_string()),
            manual_actions: vec![ProjectManualAction {
                id: "dev".to_string(),
                label: "Dev".to_string(),
                icon: ProjectActionIcon::Play,
                script: "bun run dev".to_string(),
                shortcut: Some("mod+shift+d".to_string()),
            }],
        };

        write_project_settings(temp.path(), &settings).expect("config should write");
        let payload =
            fs::read_to_string(project_config_path(temp.path())).expect("config file should exist");

        assert!(payload.contains("\"version\": 1"));
        assert!(payload.contains("\"setupScript\": \"bun install\""));
        assert!(payload.contains("\"actions\""));
        let temp_entries = fs::read_dir(temp.path())
            .expect("project root should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temp_entries, 0);
        assert_eq!(
            read_project_settings(temp.path(), &ProjectSettings::default())
                .expect("config should read"),
            settings
        );
    }

    #[test]
    fn invalid_config_reports_the_config_path() {
        let temp = TempRoot::new();
        fs::write(project_config_path(temp.path()), "{ nope").expect("invalid config");

        let error = read_project_settings(temp.path(), &ProjectSettings::default())
            .expect_err("invalid config should fail");

        assert!(error.to_string().contains("Invalid"));
        assert!(error.to_string().contains("skein.json"));
    }

    #[test]
    fn config_values_are_normalized_and_validated_on_read() {
        let temp = TempRoot::new();
        fs::write(
            project_config_path(temp.path()),
            r#"{
  "version": 1,
  "worktree": {
    "setupScript": "  bun install  ",
    "teardownScript": "   "
  },
  "actions": [
    {
      "id": "  dev  ",
      "label": "  Dev  ",
      "icon": "play",
      "script": "  bun run dev  ",
      "shortcut": "  mod+shift+d  "
    }
  ]
}
"#,
        )
        .expect("config should write");

        let settings = read_project_settings(temp.path(), &ProjectSettings::default())
            .expect("config should normalize");

        assert_eq!(
            settings.worktree_setup_script.as_deref(),
            Some("bun install")
        );
        assert_eq!(settings.worktree_teardown_script, None);
        assert_eq!(
            settings.manual_actions,
            vec![ProjectManualAction {
                id: "dev".to_string(),
                label: "Dev".to_string(),
                icon: ProjectActionIcon::Play,
                script: "bun run dev".to_string(),
                shortcut: Some("mod+shift+d".to_string()),
            }]
        );
    }

    #[test]
    fn invalid_actions_report_the_config_path() {
        let temp = TempRoot::new();
        fs::write(
            project_config_path(temp.path()),
            r#"{
  "version": 1,
  "actions": [
    {
      "id": "   ",
      "label": "Dev",
      "icon": "play",
      "script": "bun run dev"
    }
  ]
}
"#,
        )
        .expect("config should write");

        let error = read_project_settings(temp.path(), &ProjectSettings::default())
            .expect_err("invalid config should fail");

        assert!(error.to_string().contains("skein.json"));
        assert!(error.to_string().contains("Id is required"));
    }

    struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("skein-project-config-{}", Uuid::now_v7()));
            fs::create_dir_all(&path).expect("temp root");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
