use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use tracing::warn;
use uuid::Uuid;

use crate::domain::conversation::ConversationComposerSettings;
use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::workspace::{
    EnvironmentKind, EnvironmentRecord, ManagedWorktreeCreateResult, ProjectRecord,
    ProjectSettings, ProjectSettingsPatch, RuntimeState, RuntimeStatusSnapshot, ThreadOverrides,
    ThreadRecord, ThreadStatus, WorkspaceSnapshot, WorktreeScriptTrigger,
};
use crate::error::{AppError, AppResult};
use crate::infrastructure::database::AppDatabase;
use crate::services::git::{self, GitEnvironmentContext};
use crate::services::worktree_scripts::{WorktreeScriptRequest, WorktreeScriptService};
use crate::services::{prompt_naming, thread_titles, worktree_names};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectRequest {
    pub path: String,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub environment_id: String,
    pub title: Option<String>,
    pub overrides: Option<ThreadOverrides>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectRequest {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectSettingsRequest {
    pub project_id: String,
    pub patch: ProjectSettingsPatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameThreadRequest {
    pub thread_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveThreadRequest {
    pub thread_id: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceService {
    database: AppDatabase,
    managed_worktrees_root: PathBuf,
    worktree_scripts: WorktreeScriptService,
}

#[derive(Debug, Clone)]
pub struct ThreadRuntimeContext {
    pub thread_id: String,
    pub environment_id: String,
    pub environment_path: String,
    pub codex_thread_id: Option<String>,
    pub composer: ConversationComposerSettings,
    pub codex_binary_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AutoRenameFirstPromptRequest {
    pub thread_id: String,
    pub message: String,
    pub model: String,
    pub codex_binary_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AutoRenameFirstPromptResult {
    pub project_id: String,
    pub environment_id: String,
    pub thread_id: String,
    pub environment_renamed: bool,
    pub thread_renamed: bool,
}

impl WorkspaceService {
    pub fn new(
        database: AppDatabase,
        managed_worktrees_root: PathBuf,
        worktree_scripts: WorktreeScriptService,
    ) -> Self {
        Self {
            database,
            managed_worktrees_root,
            worktree_scripts,
        }
    }

    pub fn database_path(&self) -> PathBuf {
        self.database.path().to_path_buf()
    }

    pub fn snapshot(
        &self,
        runtime_statuses: Vec<RuntimeStatusSnapshot>,
    ) -> AppResult<WorkspaceSnapshot> {
        let connection = self.database.open()?;
        let settings = self.read_or_seed_settings(&connection)?;
        let runtime_map = runtime_statuses
            .into_iter()
            .map(|status| (status.environment_id.clone(), status))
            .collect::<HashMap<_, _>>();

        let mut projects = self.read_projects(&connection, &runtime_map)?;
        projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

        Ok(WorkspaceSnapshot { settings, projects })
    }

    pub fn update_settings(&self, patch: GlobalSettingsPatch) -> AppResult<GlobalSettings> {
        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;
        let mut settings = self.read_or_seed_settings(&transaction)?;
        settings.apply_patch(patch);

        let payload = serde_json::to_string(&settings)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        transaction.execute(
            "
            INSERT INTO global_settings (singleton_key, payload_json, updated_at)
            VALUES ('global', ?1, ?2)
            ON CONFLICT(singleton_key) DO UPDATE SET
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
            ",
            params![payload, Utc::now()],
        )?;
        transaction.commit()?;
        Ok(settings)
    }

    pub fn add_project(&self, input: AddProjectRequest) -> AppResult<ProjectRecord> {
        let context = git::resolve_repo_context(&input.path)?;
        let root_path = context.root_path.canonicalize()?;
        let root_path_string = root_path.to_string_lossy().to_string();
        let project_name = input.name.unwrap_or_else(|| infer_project_name(&root_path));
        let now = Utc::now();

        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;
        let existing_project_id = transaction
            .query_row(
                "SELECT id FROM projects WHERE root_path = ?1 AND archived_at IS NULL",
                params![root_path_string],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let project_id = if let Some(project_id) = existing_project_id {
            project_id
        } else {
            let project_id = Uuid::now_v7().to_string();
            let managed_worktree_dir =
                self.allocate_managed_worktree_directory(&transaction, None, &root_path)?;
            let project_settings_json = serde_json::to_string(&ProjectSettings::default())
                .map_err(|error| AppError::Validation(error.to_string()))?;
            transaction.execute(
                "
                INSERT INTO projects (
                  id, name, root_path, managed_worktree_dir, settings_json, created_at, updated_at, archived_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
                ",
                params![
                    project_id,
                    project_name,
                    root_path_string,
                    managed_worktree_dir,
                    project_settings_json,
                    now,
                    now
                ],
            )?;
            project_id
        };

        self.ensure_local_environment(
            &transaction,
            &project_id,
            &root_path_string,
            context.current_branch.clone(),
            now,
        )?;
        transaction.commit()?;

        self.ensure_project_managed_worktree_dir(&project_id, &root_path)?;

        self.project_by_id(&project_id, Vec::new())
    }

    pub fn rename_project(&self, input: RenameProjectRequest) -> AppResult<ProjectRecord> {
        let connection = self.database.open()?;
        let affected = connection.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3 AND archived_at IS NULL",
            params![input.name.trim(), Utc::now(), input.project_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        self.project_by_id(&input.project_id, Vec::new())
    }

    pub fn update_project_settings(
        &self,
        input: UpdateProjectSettingsRequest,
    ) -> AppResult<ProjectRecord> {
        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;
        let settings_json = transaction
            .query_row(
                "SELECT settings_json FROM projects WHERE id = ?1 AND archived_at IS NULL",
                params![input.project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))?;
        let mut settings = project_settings_from_json(&settings_json, 0)?;
        settings.apply_patch(input.patch);
        let payload = serde_json::to_string(&settings)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        transaction.execute(
            "
            UPDATE projects
            SET settings_json = ?1, updated_at = ?2
            WHERE id = ?3 AND archived_at IS NULL
            ",
            params![payload, Utc::now(), input.project_id],
        )?;
        transaction.commit()?;

        self.project_by_id(&input.project_id, Vec::new())
    }

    pub fn project_environment_ids(&self, project_id: &str) -> AppResult<Vec<String>> {
        let connection = self.database.open()?;
        self.ensure_project_can_be_removed_with_connection(&connection, project_id)?;

        let mut statement = connection.prepare(
            "
            SELECT id
            FROM environments
            WHERE project_id = ?1
            ORDER BY is_default DESC, created_at ASC
            ",
        )?;
        let rows = statement.query_map(params![project_id], |row| row.get::<_, String>(0))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn remove_project(&self, project_id: &str) -> AppResult<()> {
        let connection = self.database.open()?;
        self.ensure_project_can_be_removed_with_connection(&connection, project_id)?;

        let managed_worktree_dir = connection
            .query_row(
                "
                SELECT managed_worktree_dir
                FROM projects
                WHERE id = ?1 AND archived_at IS NULL
                ",
                params![project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))?;

        let affected = connection.execute(
            "DELETE FROM projects WHERE id = ?1 AND archived_at IS NULL",
            params![project_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        if let Some(directory) = managed_worktree_dir {
            if let Err(error) = self.remove_empty_managed_worktree_directory(&directory) {
                warn!(
                    project_id = project_id,
                    directory = directory,
                    "failed to clean up managed worktree directory after project removal: {error}"
                );
            }
        }

        Ok(())
    }

    pub fn ensure_project_can_be_removed(&self, project_id: &str) -> AppResult<()> {
        let connection = self.database.open()?;
        self.ensure_project_can_be_removed_with_connection(&connection, project_id)
    }

    pub fn create_managed_worktree(
        &self,
        project_id: &str,
    ) -> AppResult<ManagedWorktreeCreateResult> {
        let project = self.project_metadata(project_id)?;
        let base_branch = git::current_branch(&project.root_path)?
            .or_else(|| git::resolve_base_reference(&project.root_path, None))
            .ok_or_else(|| {
                AppError::Git("Unable to determine a base branch for this project.".to_string())
            })?;
        let candidate = self.next_managed_worktree_candidate(project_id, &project)?;
        git::create_worktree(
            &project.root_path,
            &candidate.destination,
            &candidate.branch_name,
            &base_branch,
        )?;

        let now = Utc::now();
        let environment_id = Uuid::now_v7().to_string();
        let thread_id = Uuid::now_v7().to_string();
        let mut connection = self.database.open()?;
        let transaction_result = (|| -> AppResult<()> {
            let transaction = connection.transaction()?;
            let environment_insert = transaction.execute(
                "
                INSERT INTO environments (
                  id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
                ",
                params![
                    environment_id,
                    project_id,
                    candidate.branch_name.as_str(),
                    environment_kind_value(EnvironmentKind::ManagedWorktree),
                    candidate.destination.to_string_lossy().to_string(),
                    candidate.branch_name.as_str(),
                    base_branch.as_str(),
                    now,
                    now,
                ],
            )?;
            debug_assert_eq!(environment_insert, 1);

            let overrides_json = serde_json::to_string(&ThreadOverrides::default())
                .map_err(|error| AppError::Validation(error.to_string()))?;
            let thread_insert = transaction.execute(
                "
                INSERT INTO threads (
                  id, environment_id, title, status, codex_thread_id, overrides_json, created_at, updated_at, archived_at
                ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, NULL)
                ",
                params![
                    thread_id,
                    environment_id,
                    "Thread 1",
                    thread_status_value(ThreadStatus::Active),
                    overrides_json,
                    now,
                    now,
                ],
            )?;
            debug_assert_eq!(thread_insert, 1);

            transaction.commit()?;
            Ok(())
        })();

        if let Err(error) = transaction_result {
            let cleanup_result = git::remove_worktree(&project.root_path, &candidate.destination)
                .and_then(|_| git::delete_branch(&project.root_path, &candidate.branch_name));
            if let Err(cleanup_error) = cleanup_result {
                tracing::error!(
                    environment_id,
                    branch = candidate.branch_name,
                    path = %candidate.destination.display(),
                    "failed to clean up worktree after database error: {cleanup_error}"
                );
            }
            return Err(error);
        }

        let environment = self.environment_by_id(
            &environment_id,
            RuntimeStatusSnapshot {
                environment_id: environment_id.clone(),
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: None,
                started_at: None,
                last_exit_code: None,
            },
        )?;
        let thread = self.thread_by_id(&thread_id)?;

        if let Some(script) = project.settings.worktree_setup_script.clone() {
            self.worktree_scripts.run(WorktreeScriptRequest {
                trigger: WorktreeScriptTrigger::Setup,
                script,
                project_id: project_id.to_string(),
                project_name: project.name,
                project_root: project.root_path,
                worktree_id: environment.id.clone(),
                worktree_name: environment.name.clone(),
                worktree_branch: environment
                    .git_branch
                    .clone()
                    .unwrap_or_else(|| environment.name.clone()),
                worktree_path: PathBuf::from(&environment.path),
            });
        }

        Ok(ManagedWorktreeCreateResult {
            environment,
            thread,
        })
    }

    pub fn delete_worktree_environment(&self, environment_id: &str) -> AppResult<()> {
        let metadata = self.deletable_worktree_environment_metadata(environment_id)?;
        if matches!(metadata.kind, EnvironmentKind::ManagedWorktree) {
            self.ensure_project_managed_worktree_dir(&metadata.project_id, &metadata.project_root)?;
        }

        if metadata.project_root.is_dir() {
            git::remove_worktree(&metadata.project_root, &metadata.environment_path)?;
            git::delete_branch(&metadata.project_root, &metadata.branch_name)?;
        } else if metadata.environment_path.exists() {
            std::fs::remove_dir_all(&metadata.environment_path)?;
        }

        let connection = self.database.open()?;
        connection.execute(
            "DELETE FROM threads WHERE environment_id = ?1",
            params![environment_id],
        )?;
        let affected = connection.execute(
            "DELETE FROM environments WHERE id = ?1",
            params![environment_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Environment not found.".to_string()));
        }

        if let Some(script) = metadata.project_settings.worktree_teardown_script.clone() {
            self.worktree_scripts.run(WorktreeScriptRequest {
                trigger: WorktreeScriptTrigger::Teardown,
                script,
                project_id: metadata.project_id,
                project_name: metadata.project_name,
                project_root: metadata.project_root,
                worktree_id: metadata.environment_id,
                worktree_name: metadata.environment_name,
                worktree_branch: metadata.branch_name,
                worktree_path: metadata.environment_path,
            });
        }

        Ok(())
    }

    pub fn ensure_worktree_environment_can_be_deleted(
        &self,
        environment_id: &str,
    ) -> AppResult<()> {
        self.deletable_worktree_environment_metadata(environment_id)?;
        Ok(())
    }

    pub fn create_thread(&self, input: CreateThreadRequest) -> AppResult<ThreadRecord> {
        let connection = self.database.open()?;
        let environment_exists = connection
            .query_row(
                "SELECT 1 FROM environments WHERE id = ?1",
                params![input.environment_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();

        if !environment_exists {
            return Err(AppError::NotFound("Environment not found.".to_string()));
        }

        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM threads WHERE environment_id = ?1",
            params![input.environment_id],
            |row| row.get(0),
        )?;
        let title = input
            .title
            .unwrap_or_else(|| format!("Thread {}", count + 1))
            .trim()
            .to_string();
        let overrides = input.overrides.unwrap_or_default();
        let overrides_json = serde_json::to_string(&overrides)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let now = Utc::now();
        let thread_id = Uuid::now_v7().to_string();

        connection.execute(
            "
            INSERT INTO threads (
              id, environment_id, title, status, codex_thread_id, overrides_json, created_at, updated_at, archived_at
            ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, NULL)
            ",
            params![
                thread_id,
                input.environment_id,
                title,
                thread_status_value(ThreadStatus::Active),
                overrides_json,
                now,
                now,
            ],
        )?;

        self.thread_by_id(&thread_id)
    }

    pub fn rename_thread(&self, input: RenameThreadRequest) -> AppResult<ThreadRecord> {
        let connection = self.database.open()?;
        let affected = connection.execute(
            "UPDATE threads SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.title.trim(), Utc::now(), input.thread_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        self.thread_by_id(&input.thread_id)
    }

    pub fn thread_needs_auto_title(&self, thread_id: &str) -> AppResult<bool> {
        let connection = self.database.open()?;
        let maybe_thread = connection
            .query_row(
                "SELECT title, codex_thread_id FROM threads WHERE id = ?1",
                params![thread_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;

        let Some((title, codex_thread_id)) = maybe_thread else {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        };

        Ok(codex_thread_id.is_none() && thread_titles::is_auto_generated_thread_title(&title))
    }

    pub fn auto_rename_thread_from_message(
        &self,
        thread_id: &str,
        message: &str,
    ) -> AppResult<Option<ThreadRecord>> {
        let Some(next_title) = thread_titles::derive_thread_title_from_message(message) else {
            return Ok(None);
        };

        let connection = self.database.open()?;
        let affected = connection.execute(
            "UPDATE threads SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![next_title, Utc::now(), thread_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        self.thread_by_id(thread_id).map(Some)
    }

    pub fn maybe_auto_rename_first_prompt_environment(
        &self,
        input: AutoRenameFirstPromptRequest,
    ) -> AppResult<Option<AutoRenameFirstPromptResult>> {
        let metadata = self.first_prompt_naming_metadata(&input.thread_id)?;
        if !matches!(metadata.kind, EnvironmentKind::ManagedWorktree) {
            return Ok(None);
        }
        if !prompt_naming::is_auto_generated_worktree_name(&metadata.environment_name) {
            return Ok(None);
        }
        if metadata.thread_id != metadata.first_thread_id || metadata.started_thread_count > 0 {
            return Ok(None);
        }

        let suggestion = match prompt_naming::generate_first_prompt_naming(
            prompt_naming::GenerateFirstPromptNamingInput {
                binary_path: input.codex_binary_path.as_deref(),
                cwd: &metadata.environment_path,
                model: &input.model,
                message: &input.message,
            },
        ) {
            Ok(suggestion) => suggestion,
            Err(error) => {
                warn!(
                    thread_id = metadata.thread_id,
                    environment_id = metadata.environment_id,
                    "failed to auto-name first prompt worktree: {error}"
                );
                return Ok(None);
            }
        };

        let environment_parent = metadata.environment_path.parent().ok_or_else(|| {
            AppError::Runtime("Managed worktree path is missing its parent directory.".to_string())
        })?;
        let branch_refs = git::list_branch_refs(&metadata.project_root)?
            .into_iter()
            .collect::<HashSet<_>>();
        let next_branch_name =
            prompt_naming::ensure_unique_branch_slug(&suggestion.branch_slug, |candidate| {
                let branch_taken =
                    candidate != metadata.branch_name && branch_ref_exists(&branch_refs, candidate);
                let path_taken =
                    candidate != metadata.branch_name && environment_parent.join(candidate).exists();
                branch_taken || path_taken
            });
        let next_environment_path = environment_parent.join(&next_branch_name);
        let next_environment_name = prompt_naming::clamp_worktree_label(&suggestion.worktree_label)
            .ok_or_else(|| {
                AppError::Runtime(
                    "Codex returned an empty worktree label for first prompt naming.".to_string(),
                )
            })?;
        let next_thread_title =
            thread_titles::is_auto_generated_thread_title(&metadata.thread_title)
                .then_some(suggestion.thread_title.clone())
                .filter(|value| value != &metadata.thread_title);

        let environment_renamed = next_environment_name != metadata.environment_name
            || next_branch_name != metadata.branch_name
            || next_environment_path != metadata.environment_path;
        let thread_renamed = next_thread_title.is_some();
        if !environment_renamed && !thread_renamed {
            return Ok(None);
        }

        let mut branch_renamed = false;
        let mut worktree_moved = false;

        if next_branch_name != metadata.branch_name {
            git::rename_branch(&metadata.project_root, &metadata.branch_name, &next_branch_name)?;
            branch_renamed = true;
        }

        if next_environment_path != metadata.environment_path {
            if let Err(error) = git::move_worktree(
                &metadata.project_root,
                &metadata.environment_path,
                &next_environment_path,
            ) {
                if branch_renamed {
                    rollback_branch_rename(
                        &metadata.project_root,
                        &next_branch_name,
                        &metadata.branch_name,
                    );
                }
                return Err(error);
            }
            worktree_moved = true;
        }

        let database_result = (|| -> AppResult<()> {
            let mut connection = self.database.open()?;
            let transaction = connection.transaction()?;
            let now = Utc::now();

            transaction.execute(
                "
                UPDATE environments
                SET name = ?1, path = ?2, git_branch = ?3, updated_at = ?4
                WHERE id = ?5
                ",
                params![
                    next_environment_name,
                    next_environment_path.to_string_lossy().to_string(),
                    next_branch_name,
                    now,
                    metadata.environment_id
                ],
            )?;

            if let Some(thread_title) = next_thread_title.as_deref() {
                transaction.execute(
                    "UPDATE threads SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![thread_title, now, metadata.thread_id],
                )?;
            }

            transaction.execute(
                "UPDATE projects SET updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
                params![now, metadata.project_id],
            )?;

            transaction.commit()?;
            Ok(())
        })();

        if let Err(error) = database_result {
            if worktree_moved {
                rollback_worktree_move(
                    &metadata.project_root,
                    &next_environment_path,
                    &metadata.environment_path,
                );
            }
            if branch_renamed {
                rollback_branch_rename(
                    &metadata.project_root,
                    &next_branch_name,
                    &metadata.branch_name,
                );
            }
            return Err(error);
        }

        Ok(Some(AutoRenameFirstPromptResult {
            project_id: metadata.project_id,
            environment_id: metadata.environment_id,
            thread_id: metadata.thread_id,
            environment_renamed,
            thread_renamed,
        }))
    }

    pub fn archive_thread(&self, input: ArchiveThreadRequest) -> AppResult<ThreadRecord> {
        let now = Utc::now();
        let connection = self.database.open()?;
        let affected = connection.execute(
            "
            UPDATE threads
            SET status = ?1, archived_at = ?2, updated_at = ?3
            WHERE id = ?4
            ",
            params![
                thread_status_value(ThreadStatus::Archived),
                now,
                now,
                input.thread_id
            ],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        self.thread_by_id(&input.thread_id)
    }

    pub fn environment_path(&self, environment_id: &str) -> AppResult<String> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "SELECT path FROM environments WHERE id = ?1",
                params![environment_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))
    }

    pub fn environment_runtime_target(
        &self,
        environment_id: &str,
    ) -> AppResult<(String, Option<String>)> {
        let connection = self.database.open()?;
        let environment_path = connection
            .query_row(
                "SELECT path FROM environments WHERE id = ?1",
                params![environment_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))?;
        let settings = self.read_or_seed_settings(&connection)?;

        Ok((environment_path, settings.codex_binary_path))
    }

    pub fn environment_git_context(
        &self,
        environment_id: &str,
    ) -> AppResult<GitEnvironmentContext> {
        let connection = self.database.open()?;
        let settings = self.read_or_seed_settings(&connection)?;

        connection
            .query_row(
                "
                SELECT id, path, git_branch, base_branch
                FROM environments
                WHERE id = ?1
                ",
                params![environment_id],
                |row| {
                    Ok(GitEnvironmentContext {
                        environment_id: row.get(0)?,
                        environment_path: row.get(1)?,
                        current_branch: row.get(2)?,
                        base_branch: row.get(3)?,
                        codex_binary_path: settings.codex_binary_path.clone(),
                        default_model: settings.default_model.clone(),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))
    }

    pub fn thread_runtime_context(&self, thread_id: &str) -> AppResult<ThreadRuntimeContext> {
        let connection = self.database.open()?;
        let settings = self.read_or_seed_settings(&connection)?;
        connection
            .query_row(
                "
                SELECT
                  threads.id,
                  threads.environment_id,
                  environments.path,
                  threads.codex_thread_id,
                  threads.overrides_json
                FROM threads
                JOIN environments ON environments.id = threads.environment_id
                WHERE threads.id = ?1
                ",
                params![thread_id],
                |row| {
                    let overrides_json = row.get::<_, String>(4)?;
                    let overrides = serde_json::from_str::<ThreadOverrides>(&overrides_json)
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                overrides_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?;

                    Ok(ThreadRuntimeContext {
                        thread_id: row.get(0)?,
                        environment_id: row.get(1)?,
                        environment_path: row.get(2)?,
                        codex_thread_id: row.get(3)?,
                        composer: ConversationComposerSettings {
                            model: overrides
                                .model
                                .unwrap_or_else(|| settings.default_model.clone()),
                            reasoning_effort: overrides
                                .reasoning_effort
                                .unwrap_or(settings.default_reasoning_effort),
                            collaboration_mode: overrides
                                .collaboration_mode
                                .unwrap_or(settings.default_collaboration_mode),
                            approval_policy: overrides
                                .approval_policy
                                .unwrap_or(settings.default_approval_policy),
                        },
                        codex_binary_path: settings.codex_binary_path.clone(),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))
    }

    pub fn persist_codex_thread_id(&self, thread_id: &str, codex_thread_id: &str) -> AppResult<()> {
        let affected = self.database.open()?.execute(
            "
            UPDATE threads
            SET codex_thread_id = ?1, updated_at = ?2
            WHERE id = ?3
            ",
            params![codex_thread_id, Utc::now(), thread_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        Ok(())
    }

    pub fn persist_thread_composer_settings(
        &self,
        thread_id: &str,
        composer: &ConversationComposerSettings,
    ) -> AppResult<()> {
        let overrides = ThreadOverrides {
            model: Some(composer.model.clone()),
            reasoning_effort: Some(composer.reasoning_effort),
            collaboration_mode: Some(composer.collaboration_mode),
            approval_policy: Some(composer.approval_policy),
        };
        let overrides_json = serde_json::to_string(&overrides)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let affected = self.database.open()?.execute(
            "
            UPDATE threads
            SET overrides_json = ?1, updated_at = ?2
            WHERE id = ?3
            ",
            params![overrides_json, Utc::now(), thread_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        Ok(())
    }

    fn project_by_id(
        &self,
        project_id: &str,
        runtime_statuses: Vec<RuntimeStatusSnapshot>,
    ) -> AppResult<ProjectRecord> {
        let snapshot = self.snapshot(runtime_statuses)?;
        snapshot
            .projects
            .into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))
    }

    fn environment_by_id(
        &self,
        environment_id: &str,
        runtime_status: RuntimeStatusSnapshot,
    ) -> AppResult<EnvironmentRecord> {
        let snapshot = self.snapshot(vec![runtime_status])?;
        snapshot
            .projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .find(|environment| environment.id == environment_id)
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))
    }

    fn thread_by_id(&self, thread_id: &str) -> AppResult<ThreadRecord> {
        let snapshot = self.snapshot(Vec::new())?;
        snapshot
            .projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .flat_map(|environment| environment.threads.into_iter())
            .find(|thread| thread.id == thread_id)
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))
    }

    fn ensure_project_managed_worktree_dir(
        &self,
        project_id: &str,
        root_path: &Path,
    ) -> AppResult<String> {
        let connection = self.database.open()?;
        let existing_value = connection
            .query_row(
                "
                SELECT managed_worktree_dir
                FROM projects
                WHERE id = ?1 AND archived_at IS NULL
                ",
                params![project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))?;

        if let Some(directory) = existing_value {
            return validate_managed_worktree_directory_name(&directory);
        }

        let directory = if let Some(inferred) =
            self.infer_managed_worktree_directory(&connection, project_id)?
        {
            inferred
        } else {
            self.allocate_managed_worktree_directory(&connection, Some(project_id), root_path)?
        };
        self.persist_project_managed_worktree_dir(&connection, project_id, &directory)?;
        Ok(directory)
    }

    fn allocate_managed_worktree_directory(
        &self,
        connection: &rusqlite::Connection,
        exclude_project_id: Option<&str>,
        root_path: &Path,
    ) -> AppResult<String> {
        let base_name = git::sanitize_path_component(&infer_project_name(root_path), "project");
        let used_directories =
            self.active_managed_worktree_directories(connection, exclude_project_id)?;

        if self.managed_worktree_directory_available(&used_directories, &base_name)? {
            return Ok(base_name);
        }

        for index in 2..10_000 {
            let candidate = format!("{base_name}-{index}");
            if self.managed_worktree_directory_available(&used_directories, &candidate)? {
                return Ok(candidate);
            }
        }

        Err(AppError::Runtime(
            "Unable to allocate a managed worktree directory for this project.".to_string(),
        ))
    }

    fn active_managed_worktree_directories(
        &self,
        connection: &rusqlite::Connection,
        exclude_project_id: Option<&str>,
    ) -> AppResult<HashSet<String>> {
        let mut statement = connection.prepare(
            "
            SELECT managed_worktree_dir
            FROM projects
            WHERE archived_at IS NULL
              AND managed_worktree_dir IS NOT NULL
              AND (?1 IS NULL OR id != ?1)
            ",
        )?;
        let rows =
            statement.query_map(params![exclude_project_id], |row| row.get::<_, String>(0))?;
        let values = rows.collect::<Result<Vec<_>, _>>()?;

        Ok(values
            .into_iter()
            .map(|value| value.to_ascii_lowercase())
            .collect())
    }

    fn managed_worktree_directory_available(
        &self,
        used_directories: &HashSet<String>,
        candidate: &str,
    ) -> AppResult<bool> {
        let normalized = validate_managed_worktree_directory_name(candidate)?;
        Ok(!used_directories.contains(&normalized.to_ascii_lowercase())
            && !git::managed_worktree_project_path(&self.managed_worktrees_root, &normalized)
                .exists())
    }

    fn infer_managed_worktree_directory(
        &self,
        connection: &rusqlite::Connection,
        project_id: &str,
    ) -> AppResult<Option<String>> {
        let mut statement = connection.prepare(
            "
            SELECT path
            FROM environments
            WHERE project_id = ?1 AND kind = 'managedWorktree'
            ORDER BY created_at ASC
            ",
        )?;
        let rows = statement.query_map(params![project_id], |row| row.get::<_, String>(0))?;

        let mut directories = HashSet::new();
        for path in rows.collect::<Result<Vec<_>, _>>()? {
            let directory = managed_worktree_directory_name_from_path(
                &self.managed_worktrees_root,
                Path::new(&path),
            )
            .ok_or_else(|| {
                AppError::Runtime(format!(
                    "Unable to infer the managed worktree directory from '{}'.",
                    path
                ))
            })?;
            directories.insert(validate_managed_worktree_directory_name(&directory)?);
        }

        match directories.len() {
            0 => Ok(None),
            1 => Ok(directories.into_iter().next()),
            _ => Err(AppError::Runtime(
                "Project worktrees are split across multiple managed directories.".to_string(),
            )),
        }
    }

    fn persist_project_managed_worktree_dir(
        &self,
        connection: &rusqlite::Connection,
        project_id: &str,
        directory: &str,
    ) -> AppResult<()> {
        let normalized = validate_managed_worktree_directory_name(directory)?;
        let affected = connection.execute(
            "
            UPDATE projects
            SET managed_worktree_dir = ?1
            WHERE id = ?2 AND archived_at IS NULL
            ",
            params![normalized, project_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        Ok(())
    }

    fn remove_empty_managed_worktree_directory(&self, directory: &str) -> AppResult<()> {
        let normalized = validate_managed_worktree_directory_name(directory)?;
        let path = git::managed_worktree_project_path(&self.managed_worktrees_root, &normalized);
        match std::fs::remove_dir(&path) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    fn project_has_managed_worktrees(
        &self,
        connection: &rusqlite::Connection,
        project_id: &str,
    ) -> AppResult<bool> {
        Ok(connection
            .query_row(
                "
                SELECT 1
                FROM environments
                WHERE project_id = ?1 AND kind != 'local'
                LIMIT 1
                ",
                params![project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    fn ensure_project_can_be_removed_with_connection(
        &self,
        connection: &rusqlite::Connection,
        project_id: &str,
    ) -> AppResult<()> {
        let project_exists = connection
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1 AND archived_at IS NULL",
                params![project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();

        if !project_exists {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        if self.project_has_managed_worktrees(connection, project_id)? {
            return Err(AppError::Validation(
                "Delete this project's worktrees before removing it from ThreadEx.".to_string(),
            ));
        }

        Ok(())
    }

    fn project_metadata(&self, project_id: &str) -> AppResult<ProjectMetadata> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "
                SELECT name, root_path, settings_json
                FROM projects
                WHERE id = ?1 AND archived_at IS NULL
                ",
                params![project_id],
                |row| {
                    Ok(ProjectMetadata {
                        name: row.get(0)?,
                        root_path: PathBuf::from(row.get::<_, String>(1)?),
                        settings: project_settings_from_json(&row.get::<_, String>(2)?, 2)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))
    }

    fn next_managed_worktree_candidate(
        &self,
        project_id: &str,
        project: &ProjectMetadata,
    ) -> AppResult<ManagedWorktreeCandidate> {
        let managed_worktree_dir =
            self.ensure_project_managed_worktree_dir(project_id, &project.root_path)?;
        let connection = self.database.open()?;
        let mut statement = connection.prepare(
            "
            SELECT name
            FROM environments
            WHERE project_id = ?1
            ",
        )?;
        let environment_names = statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|value| value.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let branch_refs = git::list_branch_refs(&project.root_path)?
            .into_iter()
            .collect::<HashSet<_>>();

        let branch_name = worktree_names::generate_unique_worktree_name(|candidate| {
            let lower_candidate = candidate.to_ascii_lowercase();
            let path = git::managed_worktree_path(
                &self.managed_worktrees_root,
                &managed_worktree_dir,
                candidate,
            );
            environment_names.contains(&lower_candidate)
                || branch_ref_exists(&branch_refs, candidate)
                || path.exists()
        });
        let destination = git::managed_worktree_path(
            &self.managed_worktrees_root,
            &managed_worktree_dir,
            &branch_name,
        );

        Ok(ManagedWorktreeCandidate {
            branch_name,
            destination,
        })
    }

    fn worktree_environment_metadata(
        &self,
        environment_id: &str,
    ) -> AppResult<WorktreeEnvironmentMetadata> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "
                SELECT
                  environments.id,
                  environments.name,
                  environments.kind,
                  environments.path,
                  environments.git_branch,
                  projects.id,
                  projects.name,
                  projects.root_path,
                  projects.settings_json
                FROM environments
                JOIN projects ON projects.id = environments.project_id
                WHERE environments.id = ?1 AND projects.archived_at IS NULL
                ",
                params![environment_id],
                |row| {
                    Ok(WorktreeEnvironmentMetadata {
                        environment_id: row.get(0)?,
                        environment_name: row.get(1)?,
                        kind: environment_kind_from_str(&row.get::<_, String>(2)?)?,
                        environment_path: PathBuf::from(row.get::<_, String>(3)?),
                        branch_name: row.get::<_, Option<String>>(4)?.ok_or_else(|| {
                            rusqlite::Error::InvalidParameterName(
                                "Environment branch is missing.".to_string(),
                            )
                        })?,
                        project_id: row.get(5)?,
                        project_name: row.get(6)?,
                        project_root: PathBuf::from(row.get::<_, String>(7)?),
                        project_settings: project_settings_from_json(&row.get::<_, String>(8)?, 8)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))
    }

    fn deletable_worktree_environment_metadata(
        &self,
        environment_id: &str,
    ) -> AppResult<WorktreeEnvironmentMetadata> {
        let metadata = self.worktree_environment_metadata(environment_id)?;
        if matches!(metadata.kind, EnvironmentKind::Local) {
            return Err(AppError::Validation(
                "The local environment cannot be deleted.".to_string(),
            ));
        }

        Ok(metadata)
    }

    fn first_prompt_naming_metadata(&self, thread_id: &str) -> AppResult<FirstPromptNamingMetadata> {
        let connection = self.database.open()?;
        let mut metadata = connection
            .query_row(
                "
                SELECT
                  threads.id,
                  threads.title,
                  environments.id,
                  environments.project_id,
                  environments.name,
                  environments.kind,
                  environments.path,
                  environments.git_branch,
                  projects.root_path
                FROM threads
                JOIN environments ON environments.id = threads.environment_id
                JOIN projects ON projects.id = environments.project_id
                WHERE threads.id = ?1 AND projects.archived_at IS NULL
                ",
                params![thread_id],
                |row| {
                    Ok(FirstPromptNamingMetadata {
                        thread_id: row.get(0)?,
                        thread_title: row.get(1)?,
                        environment_id: row.get(2)?,
                        project_id: row.get(3)?,
                        environment_name: row.get(4)?,
                        kind: environment_kind_from_str(&row.get::<_, String>(5)?)?,
                        environment_path: PathBuf::from(row.get::<_, String>(6)?),
                        branch_name: row.get::<_, Option<String>>(7)?.ok_or_else(|| {
                            rusqlite::Error::InvalidParameterName(
                                "Environment branch is missing.".to_string(),
                            )
                        })?,
                        project_root: PathBuf::from(row.get::<_, String>(8)?),
                        first_thread_id: String::new(),
                        started_thread_count: 0,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))?;

        metadata.first_thread_id = connection.query_row(
            "
            SELECT id
            FROM threads
            WHERE environment_id = ?1
            ORDER BY created_at ASC
            LIMIT 1
            ",
            params![metadata.environment_id],
            |row| row.get(0),
        )?;
        metadata.started_thread_count = connection.query_row(
            "
            SELECT COUNT(*)
            FROM threads
            WHERE environment_id = ?1 AND codex_thread_id IS NOT NULL
            ",
            params![metadata.environment_id],
            |row| row.get(0),
        )?;

        Ok(metadata)
    }

    fn ensure_local_environment(
        &self,
        connection: &rusqlite::Transaction<'_>,
        project_id: &str,
        root_path: &str,
        branch: Option<String>,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        let exists = connection
            .query_row(
                "SELECT 1 FROM environments WHERE project_id = ?1 AND kind = 'local'",
                params![project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();

        if exists {
            return Ok(());
        }

        connection.execute(
            "
            INSERT INTO environments (
              id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
            ) VALUES (?1, ?2, 'Local', 'local', ?3, ?4, ?4, 1, ?5, ?5)
            ",
            params![Uuid::now_v7().to_string(), project_id, root_path, branch, now],
        )?;

        Ok(())
    }

    fn read_projects(
        &self,
        connection: &rusqlite::Connection,
        runtime_map: &HashMap<String, RuntimeStatusSnapshot>,
    ) -> AppResult<Vec<ProjectRecord>> {
        let mut project_statement = connection.prepare(
            "
            SELECT id, name, root_path, settings_json, created_at, updated_at
            FROM projects
            WHERE archived_at IS NULL
            ",
        )?;
        let project_rows = project_statement.query_map([], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                settings: project_settings_from_json(&row.get::<_, String>(3)?, 3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                environments: Vec::new(),
            })
        })?;

        let mut projects = project_rows.collect::<Result<Vec<_>, _>>()?;
        let mut project_index = HashMap::new();
        for (index, project) in projects.iter().enumerate() {
            project_index.insert(project.id.clone(), index);
        }

        let mut thread_map = self.read_threads(connection)?;
        let mut environment_statement = connection.prepare(
            "
            SELECT id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
            FROM environments
            ORDER BY is_default DESC, created_at ASC
            ",
        )?;
        let environment_rows = environment_statement.query_map([], |row| {
            let environment_id = row.get::<_, String>(0)?;
            Ok(EnvironmentRecord {
                id: environment_id.clone(),
                project_id: row.get(1)?,
                name: row.get(2)?,
                kind: environment_kind_from_str(&row.get::<_, String>(3)?)?,
                path: row.get(4)?,
                git_branch: row.get(5)?,
                base_branch: row.get(6)?,
                is_default: row.get::<_, i64>(7)? == 1,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                threads: thread_map.remove(&environment_id).unwrap_or_default(),
                runtime: runtime_map.get(&environment_id).cloned().unwrap_or(
                    RuntimeStatusSnapshot {
                        environment_id,
                        state: RuntimeState::Stopped,
                        pid: None,
                        binary_path: None,
                        started_at: None,
                        last_exit_code: None,
                    },
                ),
            })
        })?;

        for environment in environment_rows.collect::<Result<Vec<_>, _>>()? {
            if let Some(index) = project_index.get(&environment.project_id) {
                projects[*index].environments.push(environment);
            }
        }

        Ok(projects)
    }

    fn read_threads(
        &self,
        connection: &rusqlite::Connection,
    ) -> AppResult<HashMap<String, Vec<ThreadRecord>>> {
        let mut statement = connection.prepare(
            "
            SELECT id, environment_id, title, status, codex_thread_id, overrides_json, created_at, updated_at, archived_at
            FROM threads
            ORDER BY created_at ASC
            ",
        )?;
        let rows = statement.query_map([], |row| {
            let overrides_json = row.get::<_, String>(5)?;
            let overrides =
                serde_json::from_str::<ThreadOverrides>(&overrides_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        overrides_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(ThreadRecord {
                id: row.get(0)?,
                environment_id: row.get(1)?,
                title: row.get(2)?,
                status: thread_status_from_str(&row.get::<_, String>(3)?)?,
                codex_thread_id: row.get(4)?,
                overrides,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                archived_at: row.get(8)?,
            })
        })?;

        let mut thread_map = HashMap::<String, Vec<ThreadRecord>>::new();
        for thread in rows.collect::<Result<Vec<_>, _>>()? {
            thread_map
                .entry(thread.environment_id.clone())
                .or_default()
                .push(thread);
        }
        Ok(thread_map)
    }

    fn read_or_seed_settings(
        &self,
        connection: &rusqlite::Connection,
    ) -> AppResult<GlobalSettings> {
        let payload = connection
            .query_row(
                "SELECT payload_json FROM global_settings WHERE singleton_key = 'global'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        if let Some(payload) = payload {
            let settings = serde_json::from_str(&payload)
                .map_err(|error| AppError::Validation(error.to_string()))?;
            return Ok(settings);
        }

        let settings = GlobalSettings::default();
        let payload = serde_json::to_string(&settings)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        connection.execute(
            "
            INSERT INTO global_settings (singleton_key, payload_json, updated_at)
            VALUES ('global', ?1, ?2)
            ",
            params![payload, Utc::now()],
        )?;
        Ok(settings)
    }
}

#[derive(Debug)]
struct ProjectMetadata {
    name: String,
    root_path: PathBuf,
    settings: ProjectSettings,
}

#[derive(Debug)]
struct ManagedWorktreeCandidate {
    branch_name: String,
    destination: PathBuf,
}

#[derive(Debug)]
struct WorktreeEnvironmentMetadata {
    environment_id: String,
    environment_name: String,
    kind: EnvironmentKind,
    environment_path: PathBuf,
    branch_name: String,
    project_id: String,
    project_name: String,
    project_root: PathBuf,
    project_settings: ProjectSettings,
}

#[derive(Debug)]
struct FirstPromptNamingMetadata {
    thread_id: String,
    thread_title: String,
    environment_id: String,
    project_id: String,
    environment_name: String,
    kind: EnvironmentKind,
    environment_path: PathBuf,
    branch_name: String,
    project_root: PathBuf,
    first_thread_id: String,
    started_thread_count: i64,
}

fn validate_managed_worktree_directory_name(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Runtime(
            "Managed worktree directory cannot be empty.".to_string(),
        ));
    }

    let normalized = git::sanitize_path_component(trimmed, "project");
    if normalized != trimmed {
        return Err(AppError::Runtime(format!(
            "Managed worktree directory '{}' is invalid.",
            value
        )));
    }

    Ok(normalized)
}

fn managed_worktree_directory_name_from_path(
    managed_root: &Path,
    worktree_path: &Path,
) -> Option<String> {
    let project_directory = worktree_path.parent()?;
    if project_directory.parent()? != managed_root {
        return None;
    }

    project_directory
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
}

fn infer_project_name(root_path: &Path) -> String {
    root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project")
        .to_string()
}

fn branch_ref_exists(branch_refs: &HashSet<String>, branch_name: &str) -> bool {
    branch_refs.iter().any(|reference| {
        reference == branch_name
            || reference
                .split_once('/')
                .is_some_and(|(_, remote_branch)| remote_branch == branch_name)
    })
}

fn rollback_branch_rename(repo_root: &Path, current_branch: &str, previous_branch: &str) {
    if let Err(error) = git::rename_branch(repo_root, current_branch, previous_branch) {
        warn!(
            current_branch = current_branch,
            previous_branch = previous_branch,
            "failed to roll back renamed branch: {error}"
        );
    }
}

fn rollback_worktree_move(repo_root: &Path, current_path: &Path, previous_path: &Path) {
    if let Err(error) = git::move_worktree(repo_root, current_path, previous_path) {
        warn!(
            current_path = %current_path.display(),
            previous_path = %previous_path.display(),
            "failed to roll back moved worktree: {error}"
        );
    }
}

fn environment_kind_value(kind: EnvironmentKind) -> &'static str {
    match kind {
        EnvironmentKind::Local => "local",
        EnvironmentKind::ManagedWorktree => "managedWorktree",
        EnvironmentKind::PermanentWorktree => "permanentWorktree",
    }
}

fn environment_kind_from_str(value: &str) -> Result<EnvironmentKind, rusqlite::Error> {
    match value {
        "local" => Ok(EnvironmentKind::Local),
        "managedWorktree" => Ok(EnvironmentKind::ManagedWorktree),
        "permanentWorktree" => Ok(EnvironmentKind::PermanentWorktree),
        other => Err(rusqlite::Error::InvalidParameterName(other.to_string())),
    }
}

fn thread_status_value(status: ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Active => "active",
        ThreadStatus::Archived => "archived",
    }
}

fn thread_status_from_str(value: &str) -> Result<ThreadStatus, rusqlite::Error> {
    match value {
        "active" => Ok(ThreadStatus::Active),
        "archived" => Ok(ThreadStatus::Archived),
        other => Err(rusqlite::Error::InvalidParameterName(other.to_string())),
    }
}

fn project_settings_from_json(
    value: &str,
    column_index: usize,
) -> Result<ProjectSettings, rusqlite::Error> {
    serde_json::from_str::<ProjectSettings>(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column_index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use chrono::Utc;
    use rusqlite::{params, Connection};
    use uuid::Uuid;

    use super::{AddProjectRequest, AutoRenameFirstPromptRequest, WorkspaceService};
    use crate::services::git;
    use crate::services::worktree_scripts::WorktreeScriptService;

    #[test]
    fn add_project_assigns_readable_managed_worktree_directories_with_suffixes() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo_one = harness
            .create_repo(&harness.temp_root.join("repos-one").join("krewzer"))
            .expect("repo one");
        let repo_two = harness
            .create_repo(&harness.temp_root.join("repos-two").join("krewzer"))
            .expect("repo two");

        let project_one = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_one.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project one should be added");
        let project_two = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_two.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project two should be added");

        assert_eq!(
            harness.project_managed_worktree_dir(&project_one.id),
            Some("krewzer".to_string())
        );
        assert_eq!(
            harness.project_managed_worktree_dir(&project_two.id),
            Some("krewzer-2".to_string())
        );
    }

    #[test]
    fn add_project_skips_existing_orphaned_managed_worktree_directory() {
        let harness = WorkspaceHarness::new().expect("harness");
        fs::create_dir_all(harness.managed_root.join("krewzer")).expect("orphan dir");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("krewzer"))
            .expect("repo");

        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        assert_eq!(
            harness.project_managed_worktree_dir(&project.id),
            Some("krewzer-2".to_string())
        );
    }

    #[test]
    fn create_managed_worktree_reuses_inferred_legacy_parent_directory() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("legacy-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let connection = harness.open_connection();
        connection
            .execute(
                "UPDATE projects SET managed_worktree_dir = NULL WHERE id = ?1",
                params![project.id],
            )
            .expect("project dir should be cleared");
        connection
            .execute(
                "
                INSERT INTO environments (
                  id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
                ) VALUES (?1, ?2, ?3, 'managedWorktree', ?4, ?5, ?6, 0, ?7, ?7)
                ",
                params![
                    Uuid::now_v7().to_string(),
                    project.id,
                    "existing-worktree",
                    harness
                        .managed_root
                        .join("legacy-repo-dir")
                        .join("existing-worktree")
                        .to_string_lossy()
                        .to_string(),
                    "existing-worktree",
                    "main",
                    Utc::now(),
                ],
            )
            .expect("legacy environment should be inserted");

        let result = harness
            .service
            .create_managed_worktree(&project.id)
            .expect("worktree should be created");

        assert_eq!(
            harness.project_managed_worktree_dir(&project.id),
            Some("legacy-repo-dir".to_string())
        );
        assert_eq!(
            Path::new(&result.environment.path)
                .parent()
                .and_then(|path| path.file_name())
                .and_then(|value| value.to_str())
                .map(ToString::to_string),
            Some("legacy-repo-dir".to_string())
        );
    }

    #[test]
    fn remove_project_deletes_an_empty_managed_worktree_directory() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("cleanup-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let managed_dir = harness
            .project_managed_worktree_dir(&project.id)
            .expect("managed dir should exist");
        let managed_path = harness.managed_root.join(&managed_dir);
        fs::create_dir_all(&managed_path).expect("managed dir should exist");

        harness
            .service
            .remove_project(&project.id)
            .expect("project should be removed");

        assert!(!managed_path.exists());
        assert!(repo.path.exists());
    }

    #[test]
    fn remove_project_preserves_a_non_empty_managed_worktree_directory() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("non-empty-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let managed_dir = harness
            .project_managed_worktree_dir(&project.id)
            .expect("managed dir should exist");
        let managed_path = harness.managed_root.join(&managed_dir);
        fs::create_dir_all(&managed_path).expect("managed dir should exist");
        fs::write(managed_path.join("keep.txt"), "persist").expect("marker file");

        harness
            .service
            .remove_project(&project.id)
            .expect("project should be removed");

        assert!(managed_path.exists());
        assert!(repo.path.exists());
    }

    #[test]
    fn deleting_the_last_legacy_worktree_backfills_project_directory_for_cleanup() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("legacy-cleanup-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let result = harness
            .service
            .create_managed_worktree(&project.id)
            .expect("worktree should be created");
        let managed_dir = harness
            .project_managed_worktree_dir(&project.id)
            .expect("managed dir should exist");
        let managed_path = harness.managed_root.join(&managed_dir);

        harness
            .open_connection()
            .execute(
                "UPDATE projects SET managed_worktree_dir = NULL WHERE id = ?1",
                params![project.id],
            )
            .expect("project dir should be cleared");

        harness
            .service
            .delete_worktree_environment(&result.environment.id)
            .expect("worktree should be deleted");

        assert_eq!(
            harness.project_managed_worktree_dir(&project.id),
            Some(managed_dir.clone())
        );

        harness
            .service
            .remove_project(&project.id)
            .expect("project should be removed");

        assert!(!managed_path.exists());
        assert!(repo.path.exists());
    }

    #[test]
    fn first_prompt_auto_rename_updates_the_managed_worktree_and_thread() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("renaming-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let result = harness
            .service
            .create_managed_worktree(&project.id)
            .expect("worktree should be created");
        let fake_codex = harness.create_fake_codex(
            r#"{"threadTitle":"Ajouter des themes","worktreeLabel":"Ajouter des themes","branchSlug":"add-themes"}"#,
        );

        let rename = harness
            .service
            .maybe_auto_rename_first_prompt_environment(AutoRenameFirstPromptRequest {
                thread_id: result.thread.id.clone(),
                message: "Ajouter un systeme de themes".to_string(),
                model: "gpt-5.4".to_string(),
                codex_binary_path: Some(fake_codex.to_string_lossy().to_string()),
            })
            .expect("rename should succeed")
            .expect("rename should apply");

        assert!(rename.environment_renamed);
        assert!(rename.thread_renamed);

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        let environment = snapshot
            .projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .find(|environment| environment.id == result.environment.id)
            .expect("environment should exist");
        let thread = environment
            .threads
            .into_iter()
            .find(|thread| thread.id == result.thread.id)
            .expect("thread should exist");

        assert_eq!(environment.name, "Ajouter des themes");
        assert_eq!(environment.git_branch.as_deref(), Some("add-themes"));
        assert!(environment.path.ends_with("/add-themes"));
        assert_eq!(thread.title, "Ajouter des themes");
        assert!(Path::new(&environment.path).exists());
        assert!(
            git::current_branch(Path::new(&environment.path))
                .expect("branch should resolve")
                .as_deref()
                == Some("add-themes")
        );
    }

    struct WorkspaceHarness {
        service: WorkspaceService,
        managed_root: PathBuf,
        temp_root: PathBuf,
    }

    impl WorkspaceHarness {
        fn new() -> Result<Self, Box<dyn std::error::Error>> {
            let temp_root =
                std::env::temp_dir().join(format!("threadex-workspace-test-{}", Uuid::now_v7()));
            fs::create_dir_all(&temp_root)?;
            let database = crate::infrastructure::database::AppDatabase::for_test(
                temp_root.join("threadex.sqlite3"),
            )?;
            let managed_root = temp_root.join("managed-worktrees");
            fs::create_dir_all(&managed_root)?;
            let service = WorkspaceService::new(
                database,
                managed_root.clone(),
                WorktreeScriptService::for_test(temp_root.clone()),
            );

            Ok(Self {
                service,
                managed_root,
                temp_root,
            })
        }

        fn create_repo(&self, path: &Path) -> Result<TestRepo, Box<dyn std::error::Error>> {
            TestRepo::new(path.to_path_buf())
        }

        fn open_connection(&self) -> Connection {
            let connection =
                Connection::open(self.service.database_path()).expect("database should open");
            connection
                .pragma_update(None, "foreign_keys", "ON")
                .expect("foreign keys should be enabled");
            connection
        }

        fn project_managed_worktree_dir(&self, project_id: &str) -> Option<String> {
            self.open_connection()
                .query_row(
                    "SELECT managed_worktree_dir FROM projects WHERE id = ?1",
                    params![project_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("project query should succeed")
        }

        fn create_fake_codex(&self, json: &str) -> PathBuf {
            let script_path = self.temp_root.join(format!("fake-codex-{}.sh", Uuid::now_v7()));
            fs::write(
                &script_path,
                format!(
                    "#!/bin/sh\nset -eu\noutput=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--output-last-message\" ]; then\n    output=\"$2\"\n    shift 2\n    continue\n  fi\n  shift\n done\ncat >/dev/null\ncat <<'EOF' > \"$output\"\n{json}\nEOF\n"
                ),
            )
            .expect("script should be written");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let mut permissions = fs::metadata(&script_path)
                    .expect("script metadata")
                    .permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&script_path, permissions).expect("permissions");
            }
            script_path
        }
    }

    impl Drop for WorkspaceHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp_root);
        }
    }

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn new(path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
            fs::create_dir_all(&path)?;
            git::run_git(&path, ["init", "--initial-branch=main"])?;
            git::run_git(&path, ["config", "user.email", "threadex@example.com"])?;
            git::run_git(&path, ["config", "user.name", "ThreadEx Tests"])?;
            fs::write(path.join("README.md"), "# ThreadEx\n")?;
            git::run_git(&path, ["add", "README.md"])?;
            git::run_git(&path, ["commit", "-m", "Initial commit"])?;
            Ok(Self { path })
        }
    }
}
