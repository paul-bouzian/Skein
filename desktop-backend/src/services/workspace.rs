use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use tracing::warn;
use uuid::Uuid;

use crate::domain::conversation::{
    ComposerTarget, ConversationComposerDraft, ConversationComposerSettings,
};
use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch, OpenTarget};
use crate::domain::shortcuts::ShortcutSettings;
use crate::domain::workspace::{
    ChatThreadCreateResult, ChatWorkspaceSnapshot, DraftProjectSelection, DraftThreadTarget,
    EnvironmentKind, EnvironmentPullRequestSnapshot, EnvironmentRecord,
    FirstPromptRenameFailureEvent, ManagedWorktreeCreateResult, ProjectManualAction, ProjectRecord,
    ProjectSettings, ProjectSettingsPatch, RuntimeState, RuntimeStatusSnapshot,
    SavedDraftThreadState, ThreadOverrides, ThreadRecord, ThreadStatus, WorkspaceSnapshot,
    WorktreeScriptTrigger,
};
use crate::error::{AppError, AppResult};
use crate::infrastructure::database::AppDatabase;
use crate::services::git::{self, GitEnvironmentContext};
use crate::services::worktree_scripts::{WorktreeScriptRequest, WorktreeScriptService};
use crate::services::{prompt_naming, thread_titles, worktree_names};

const CHAT_WORKSPACE_PROJECT_ID: &str = "skein-chat-workspace";
const CHAT_WORKSPACE_TITLE: &str = "Chats";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectKind {
    Repository,
    ChatWorkspace,
}

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
pub struct CreateChatThreadRequest {
    pub title: Option<String>,
    pub overrides: Option<ThreadOverrides>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateManagedWorktreeRequest {
    pub project_id: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub overrides: Option<ThreadOverrides>,
}

impl CreateManagedWorktreeRequest {
    #[cfg(test)]
    pub fn for_project(project_id: &str) -> Self {
        Self {
            project_id: project_id.to_string(),
            base_branch: None,
            name: None,
            overrides: None,
        }
    }
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
pub struct RunProjectActionRequest {
    pub environment_id: String,
    pub action_id: String,
}

#[derive(Debug, Clone)]
pub struct EnvironmentOpenContext {
    pub environment_path: PathBuf,
    pub target: OpenTarget,
}

#[derive(Debug, Clone)]
pub struct EnvironmentRuntimeTarget {
    pub environment_path: String,
    pub codex_binary_path: Option<String>,
    pub stream_assistant_responses: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderProjectsRequest {
    pub project_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectSidebarCollapsedRequest {
    pub project_id: String,
    pub collapsed: bool,
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
pub struct ArchiveThreadResult {
    pub thread: ThreadRecord,
    pub runtime_environment_to_stop: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceService {
    database: AppDatabase,
    managed_worktrees_root: PathBuf,
    chats_root: PathBuf,
    worktree_scripts: WorktreeScriptService,
}

#[derive(Debug, Clone)]
pub struct ProjectActionExecutionTarget {
    pub environment_id: String,
    pub cwd: String,
    pub project_id: String,
    pub project_name: String,
    pub project_root: PathBuf,
    pub environment_name: String,
    pub branch_name: String,
    pub action: ProjectManualAction,
}

#[derive(Debug, Clone)]
pub struct ThreadRuntimeContext {
    pub thread_id: String,
    pub environment_id: String,
    pub environment_path: String,
    pub codex_thread_id: Option<String>,
    pub composer: ConversationComposerSettings,
    pub codex_binary_path: Option<String>,
    pub stream_assistant_responses: bool,
    pub multi_agent_nudge_enabled: bool,
    pub multi_agent_nudge_max_subagents: u8,
}

impl ThreadRuntimeContext {
    pub fn environment_runtime_target(&self) -> EnvironmentRuntimeTarget {
        EnvironmentRuntimeTarget {
            environment_path: self.environment_path.clone(),
            codex_binary_path: self.codex_binary_path.clone(),
            stream_assistant_responses: self.stream_assistant_responses,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ComposerTargetContext {
    pub environment_id: String,
    pub environment_path: String,
    pub codex_thread_id: Option<String>,
    pub codex_binary_path: Option<String>,
    pub file_search_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestWatchTarget {
    pub environment_id: String,
    pub project_id: String,
    pub path: String,
    pub git_branch: String,
}

#[derive(Debug, Clone)]
pub struct AutoRenameFirstPromptRequest {
    pub thread_id: String,
    pub message: String,
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
        chats_root: PathBuf,
        worktree_scripts: WorktreeScriptService,
    ) -> Self {
        Self {
            database,
            managed_worktrees_root,
            chats_root,
            worktree_scripts,
        }
    }

    pub fn database_path(&self) -> PathBuf {
        self.database.path().to_path_buf()
    }

    fn ensure_chat_workspace(&self, connection: &rusqlite::Connection) -> AppResult<()> {
        std::fs::create_dir_all(&self.chats_root)?;
        let now = Utc::now();
        let root_path = self.chats_root.to_string_lossy().to_string();
        let settings_json = serde_json::to_string(&ProjectSettings::default())
            .map_err(|error| AppError::Validation(error.to_string()))?;

        connection.execute(
            "
            INSERT INTO projects (
              id, name, root_path, kind, managed_worktree_dir, settings_json, sort_order, sidebar_collapsed, created_at, updated_at, archived_at
            )
            VALUES (?1, ?2, ?3, ?4, NULL, ?5, -1, 0, ?6, ?6, NULL)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              root_path = excluded.root_path,
              kind = excluded.kind,
              archived_at = NULL,
              updated_at = excluded.updated_at
            WHERE projects.name <> excluded.name
               OR projects.root_path <> excluded.root_path
               OR projects.kind <> excluded.kind
               OR projects.archived_at IS NOT NULL
            ",
            params![
                CHAT_WORKSPACE_PROJECT_ID,
                CHAT_WORKSPACE_TITLE,
                root_path,
                project_kind_value(ProjectKind::ChatWorkspace),
                settings_json,
                now,
            ],
        )?;

        Ok(())
    }

    fn ensure_repository_project_with_connection(
        &self,
        connection: &rusqlite::Connection,
        project_id: &str,
    ) -> AppResult<()> {
        validate_non_blank_id(project_id, "project")?;
        let project_kind = connection
            .query_row(
                "
                SELECT kind
                FROM projects
                WHERE id = ?1 AND archived_at IS NULL
                ",
                params![project_id],
                |row| project_kind_from_str(&row.get::<_, String>(0)?),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))?;

        if matches!(project_kind, ProjectKind::ChatWorkspace) {
            return Err(AppError::Validation(
                "Chat is managed by Skein and cannot be modified.".to_string(),
            ));
        }

        Ok(())
    }

    pub fn snapshot(
        &self,
        runtime_statuses: Vec<RuntimeStatusSnapshot>,
    ) -> AppResult<WorkspaceSnapshot> {
        self.snapshot_with_pull_requests(runtime_statuses, &HashMap::new())
    }

    pub fn snapshot_with_pull_requests(
        &self,
        runtime_statuses: Vec<RuntimeStatusSnapshot>,
        pull_requests: &HashMap<String, EnvironmentPullRequestSnapshot>,
    ) -> AppResult<WorkspaceSnapshot> {
        let connection = self.database.open()?;
        let settings = self.read_or_seed_settings(&connection)?;
        let runtime_map = runtime_statuses
            .into_iter()
            .map(|status| (status.environment_id.clone(), status))
            .collect::<HashMap<_, _>>();

        let (chat, projects) = self.read_projects(&connection, &runtime_map, pull_requests)?;

        Ok(WorkspaceSnapshot {
            settings,
            chat,
            projects,
        })
    }

    pub fn pull_request_watch_targets(&self) -> AppResult<Vec<PullRequestWatchTarget>> {
        let connection = self.database.open()?;
        let mut statement = connection.prepare(
            "
            SELECT environments.id, environments.project_id, environments.path, environments.git_branch
            FROM environments
            JOIN projects ON projects.id = environments.project_id
            WHERE projects.archived_at IS NULL
              AND environments.kind IN ('managedWorktree', 'permanentWorktree')
              AND environments.git_branch IS NOT NULL
              AND TRIM(environments.git_branch) <> ''
            ORDER BY environments.created_at ASC
            ",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(PullRequestWatchTarget {
                environment_id: row.get(0)?,
                project_id: row.get(1)?,
                path: row.get(2)?,
                git_branch: row.get(3)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn pull_request_watch_target(
        &self,
        environment_id: &str,
    ) -> AppResult<Option<PullRequestWatchTarget>> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "
                SELECT environments.id, environments.project_id, environments.path, environments.git_branch
                FROM environments
                JOIN projects ON projects.id = environments.project_id
                WHERE environments.id = ?1
                  AND projects.archived_at IS NULL
                  AND environments.kind IN ('managedWorktree', 'permanentWorktree')
                  AND environments.git_branch IS NOT NULL
                  AND TRIM(environments.git_branch) <> ''
                ",
                params![environment_id],
                |row| {
                    Ok(PullRequestWatchTarget {
                        environment_id: row.get(0)?,
                        project_id: row.get(1)?,
                        path: row.get(2)?,
                        git_branch: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(AppError::from)
    }

    pub fn update_settings(&self, patch: GlobalSettingsPatch) -> AppResult<GlobalSettings> {
        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;
        let mut settings = self.read_or_seed_stored_settings(&transaction)?;
        let patch_updates_open_targets = patch.open_targets.is_some();
        let patch_updates_default_open_target = patch.default_open_target_id.is_some();
        settings.apply_patch(patch);
        if patch_updates_open_targets {
            settings
                .normalize_for_update()
                .map_err(AppError::Validation)?;
        } else if patch_updates_default_open_target {
            settings
                .normalize_default_open_target_for_update()
                .map_err(AppError::Validation)?;
        }
        settings.validate().map_err(AppError::Validation)?;
        validate_project_shortcuts_against_global_settings(&transaction, &settings.shortcuts)?;

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
        Ok(settings.projected_for_client())
    }

    pub fn current_settings(&self) -> AppResult<GlobalSettings> {
        let connection = self.database.open()?;
        self.read_or_seed_settings(&connection)
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
                "
                SELECT id
                FROM projects
                WHERE root_path = ?1
                  AND archived_at IS NULL
                  AND kind = 'repository'
                ",
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
            let sort_order = next_project_sort_order(&transaction)?;
            let project_settings_json = serde_json::to_string(&ProjectSettings::default())
                .map_err(|error| AppError::Validation(error.to_string()))?;
            transaction.execute(
                "
                INSERT INTO projects (
                  id, name, root_path, kind, managed_worktree_dir, settings_json, sort_order, sidebar_collapsed, created_at, updated_at, archived_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, NULL)
                ",
                params![
                    project_id,
                    project_name,
                    root_path_string,
                    project_kind_value(ProjectKind::Repository),
                    managed_worktree_dir,
                    project_settings_json,
                    sort_order,
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
        let trimmed_name = input.name.trim();
        if trimmed_name.is_empty() {
            return Err(AppError::Validation(
                "Project name cannot be empty.".to_string(),
            ));
        }
        let connection = self.database.open()?;
        self.ensure_repository_project_with_connection(&connection, &input.project_id)?;
        let affected = connection.execute(
            "
            UPDATE projects
            SET name = ?1, updated_at = ?2
            WHERE id = ?3 AND archived_at IS NULL AND kind = 'repository'
            ",
            params![trimmed_name, Utc::now(), input.project_id],
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
        self.ensure_repository_project_with_connection(&connection, &input.project_id)?;
        let transaction = connection.transaction()?;
        let global_settings = self.read_or_seed_stored_settings(&transaction)?;
        let settings_json = transaction
            .query_row(
                "
                SELECT settings_json
                FROM projects
                WHERE id = ?1 AND archived_at IS NULL AND kind = 'repository'
                ",
                params![input.project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))?;
        let mut settings = project_settings_from_json(&settings_json, 0)?;
        settings.apply_patch(input.patch);
        settings
            .validate(Some(&global_settings.shortcuts))
            .map_err(AppError::Validation)?;
        let payload = serde_json::to_string(&settings)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        transaction.execute(
            "
            UPDATE projects
            SET settings_json = ?1, updated_at = ?2
            WHERE id = ?3 AND archived_at IS NULL AND kind = 'repository'
            ",
            params![payload, Utc::now(), input.project_id],
        )?;
        transaction.commit()?;

        self.project_by_id(&input.project_id, Vec::new())
    }

    pub fn project_action_execution_target(
        &self,
        input: RunProjectActionRequest,
    ) -> AppResult<ProjectActionExecutionTarget> {
        validate_non_blank_id(&input.environment_id, "environment")?;
        validate_non_blank_id(&input.action_id, "action")?;
        let metadata = self.project_action_environment_metadata(&input.environment_id)?;
        if matches!(metadata.kind, EnvironmentKind::Chat) {
            return Err(AppError::Validation(
                "Chat does not expose project actions.".to_string(),
            ));
        }
        let action = metadata
            .project_settings
            .manual_actions
            .iter()
            .find(|action| action.id == input.action_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Project action not found.".to_string()))?;

        Ok(ProjectActionExecutionTarget {
            environment_id: metadata.environment_id,
            cwd: metadata.environment_path.to_string_lossy().to_string(),
            project_id: metadata.project_id,
            project_name: metadata.project_name,
            project_root: metadata.project_root,
            environment_name: metadata.environment_name,
            branch_name: metadata.branch_name.unwrap_or_default(),
            action,
        })
    }

    pub fn reorder_projects(&self, input: ReorderProjectsRequest) -> AppResult<()> {
        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;
        validate_unique_ids(&input.project_ids, "project")?;
        let existing_project_ids = active_project_ids(&transaction)?;
        if existing_project_ids.len() != input.project_ids.len() {
            return Err(AppError::Validation(
                "Project reorder payload must include every active project.".to_string(),
            ));
        }
        let existing_set = existing_project_ids.into_iter().collect::<HashSet<_>>();
        if input
            .project_ids
            .iter()
            .any(|project_id| !existing_set.contains(project_id))
        {
            return Err(AppError::Validation(
                "Project reorder payload contains an unknown project.".to_string(),
            ));
        }

        for (index, project_id) in input.project_ids.iter().enumerate() {
            transaction.execute(
                "
                UPDATE projects
                SET sort_order = ?1
                WHERE id = ?2 AND archived_at IS NULL AND sort_order != ?1
                ",
                params![index as i64, project_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn set_project_sidebar_collapsed(
        &self,
        input: SetProjectSidebarCollapsedRequest,
    ) -> AppResult<()> {
        let connection = self.database.open()?;
        self.ensure_repository_project_with_connection(&connection, &input.project_id)?;
        let collapsed = if input.collapsed { 1_i64 } else { 0_i64 };
        let affected = connection.execute(
            "
            UPDATE projects
            SET sidebar_collapsed = ?1
            WHERE id = ?2 AND archived_at IS NULL AND kind = 'repository'
            ",
            params![collapsed, input.project_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        Ok(())
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
                WHERE id = ?1 AND archived_at IS NULL AND kind = 'repository'
                ",
                params![project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))?;

        let affected = connection.execute(
            "DELETE FROM projects WHERE id = ?1 AND archived_at IS NULL AND kind = 'repository'",
            params![project_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        connection.execute(
            "
            DELETE FROM draft_thread_states
            WHERE scope_kind = 'project' AND scope_id = ?1
            ",
            params![project_id],
        )?;

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
        input: CreateManagedWorktreeRequest,
    ) -> AppResult<ManagedWorktreeCreateResult> {
        let project_id = input.project_id.as_str();
        let project = self.project_metadata(project_id)?;
        if matches!(project.kind, ProjectKind::ChatWorkspace) {
            return Err(AppError::Validation(
                "Chats cannot create worktrees until they are moved into a project draft."
                    .to_string(),
            ));
        }

        let base_branch = if let Some(provided) = input.base_branch.as_deref() {
            let trimmed = provided.trim();
            if trimmed.is_empty() {
                return Err(AppError::Validation(
                    "Base branch cannot be empty.".to_string(),
                ));
            }
            if !git::branch_exists(&project.root_path, trimmed)? {
                return Err(AppError::Validation(format!(
                    "Base branch '{trimmed}' does not exist in this project."
                )));
            }
            trimmed.to_string()
        } else {
            git::resolve_base_reference(&project.root_path, None).ok_or_else(|| {
                AppError::Git("Unable to determine a base branch for this project.".to_string())
            })?
        };

        let candidate = if let Some(provided_name) = input.name.as_deref() {
            self.named_managed_worktree_candidate(project_id, &project, provided_name)?
        } else {
            self.next_managed_worktree_candidate(project_id, &project)?
        };

        git::create_worktree(
            &project.root_path,
            &candidate.destination,
            &candidate.branch_name,
            &base_branch,
        )?;

        let now = Utc::now();
        let environment_id = Uuid::now_v7().to_string();
        let thread_id = Uuid::now_v7().to_string();
        let overrides = input.overrides.unwrap_or_default();
        let mut connection = self.database.open()?;
        let transaction_result = (|| -> AppResult<()> {
            let transaction = connection.transaction()?;
            let sort_order = next_environment_sort_order(&transaction, project_id)?;
            let environment_insert = transaction.execute(
                "
                INSERT INTO environments (
                  id, project_id, name, kind, path, git_branch, base_branch, is_default, sort_order, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10)
                ",
                params![
                    environment_id,
                    project_id,
                    candidate.branch_name.as_str(),
                    environment_kind_value(EnvironmentKind::ManagedWorktree),
                    candidate.destination.to_string_lossy().to_string(),
                    candidate.branch_name.as_str(),
                    base_branch.as_str(),
                    sort_order,
                    now,
                    now,
                ],
            )?;
            debug_assert_eq!(environment_insert, 1);

            let overrides_json = serde_json::to_string(&overrides)
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
        let thread = ThreadRecord {
            id: thread_id,
            environment_id: environment_id.clone(),
            title: "Thread 1".to_string(),
            status: ThreadStatus::Active,
            codex_thread_id: None,
            overrides,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };

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

    pub fn create_chat_thread(
        &self,
        input: CreateChatThreadRequest,
    ) -> AppResult<ChatThreadCreateResult> {
        std::fs::create_dir_all(&self.chats_root)?;
        let environment_id = Uuid::now_v7().to_string();
        let environment_path = self.chats_root.join(&environment_id);
        std::fs::create_dir_all(&environment_path)?;

        let thread_title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Thread 1")
            .to_string();
        let overrides = input.overrides.unwrap_or_default();
        let overrides_json = serde_json::to_string(&overrides)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let thread_id = Uuid::now_v7().to_string();
        let now = Utc::now();

        let mut connection = self.database.open()?;
        let transaction_result = (|| -> AppResult<()> {
            let transaction = connection.transaction()?;
            self.ensure_chat_workspace(&transaction)?;
            let sort_order = next_environment_sort_order(&transaction, CHAT_WORKSPACE_PROJECT_ID)?;

            transaction.execute(
                "
                INSERT INTO environments (
                  id, project_id, name, kind, path, git_branch, base_branch, is_default, sort_order, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0, ?6, ?7, ?7)
                ",
                params![
                    environment_id,
                    CHAT_WORKSPACE_PROJECT_ID,
                    "Chat",
                    environment_kind_value(EnvironmentKind::Chat),
                    environment_path.to_string_lossy().to_string(),
                    sort_order,
                    now,
                ],
            )?;

            transaction.execute(
                "
                INSERT INTO threads (
                  id, environment_id, title, status, codex_thread_id, overrides_json, created_at, updated_at, archived_at
                ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?6, NULL)
                ",
                params![
                    thread_id,
                    environment_id,
                    thread_title,
                    thread_status_value(ThreadStatus::Active),
                    overrides_json,
                    now,
                ],
            )?;

            transaction.commit()?;
            Ok(())
        })();

        if let Err(error) = transaction_result {
            let _ = std::fs::remove_dir_all(&environment_path);
            return Err(error);
        }

        let thread = ThreadRecord {
            id: thread_id,
            environment_id: environment_id.clone(),
            title: thread_title,
            status: ThreadStatus::Active,
            codex_thread_id: None,
            overrides,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };
        let environment = EnvironmentRecord {
            id: environment_id.clone(),
            project_id: CHAT_WORKSPACE_PROJECT_ID.to_string(),
            name: "Chat".to_string(),
            kind: EnvironmentKind::Chat,
            path: environment_path.to_string_lossy().to_string(),
            git_branch: None,
            base_branch: None,
            is_default: false,
            pull_request: None,
            created_at: now,
            updated_at: now,
            threads: vec![thread.clone()],
            runtime: RuntimeStatusSnapshot {
                environment_id,
                state: RuntimeState::Stopped,
                pid: None,
                binary_path: None,
                started_at: None,
                last_exit_code: None,
            },
        };

        Ok(ChatThreadCreateResult {
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

        self.normalize_deleted_worktree_project_draft_thread_state(
            &connection,
            &metadata.project_id,
            environment_id,
        )?;

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
        validate_non_blank_id(&input.environment_id, "environment")?;
        let connection = self.database.open()?;
        let environment_kind = connection
            .query_row(
                "SELECT kind FROM environments WHERE id = ?1",
                params![input.environment_id],
                |row| environment_kind_from_str(&row.get::<_, String>(0)?),
            )
            .optional()?;

        let Some(environment_kind) = environment_kind else {
            return Err(AppError::NotFound("Environment not found.".to_string()));
        };
        if matches!(environment_kind, EnvironmentKind::Chat) {
            return Err(AppError::Validation(
                "Chat environments only allow the initial chat thread.".to_string(),
            ));
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
        let current_branch_name = metadata
            .branch_name
            .clone()
            .ok_or_else(|| AppError::Runtime("Managed worktree branch is missing.".to_string()))?;
        if !prompt_naming::is_auto_generated_worktree_name(&metadata.environment_name) {
            return Ok(None);
        }
        if metadata.thread_id != metadata.first_thread_id || metadata.started_thread_count > 0 {
            return Ok(None);
        }

        let suggestion = prompt_naming::generate_first_prompt_naming(
            prompt_naming::GenerateFirstPromptNamingInput {
                binary_path: input.codex_binary_path.as_deref(),
                cwd: &metadata.environment_path,
                message: &input.message,
            },
        )?;

        let environment_parent = metadata.environment_path.parent().ok_or_else(|| {
            AppError::Runtime("Managed worktree path is missing its parent directory.".to_string())
        })?;
        let branch_refs = git::list_branch_refs(&metadata.project_root)?
            .into_iter()
            .collect::<HashSet<_>>();
        let next_branch_name =
            prompt_naming::ensure_unique_branch_slug(&suggestion.branch_slug, |candidate| {
                let branch_taken =
                    candidate != current_branch_name && branch_ref_exists(&branch_refs, candidate);
                let path_taken =
                    candidate != current_branch_name && environment_parent.join(candidate).exists();
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
            || next_branch_name != current_branch_name
            || next_environment_path != metadata.environment_path;
        let thread_renamed = next_thread_title.is_some();
        if !environment_renamed && !thread_renamed {
            return Ok(None);
        }

        let mut branch_renamed = false;
        let mut worktree_moved = false;

        if next_branch_name != current_branch_name {
            git::rename_branch(
                &metadata.project_root,
                &current_branch_name,
                &next_branch_name,
            )?;
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
                        &current_branch_name,
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
                    &current_branch_name,
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

    pub fn first_prompt_rename_failure_event(
        &self,
        thread_id: &str,
        message: String,
    ) -> AppResult<FirstPromptRenameFailureEvent> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "
                SELECT
                  environments.project_id,
                  environments.id,
                  threads.id,
                  environments.name,
                  environments.git_branch
                FROM threads
                JOIN environments ON environments.id = threads.environment_id
                JOIN projects ON projects.id = environments.project_id
                WHERE threads.id = ?1 AND projects.archived_at IS NULL
                ",
                params![thread_id],
                |row| {
                    let environment_name = row.get::<_, String>(3)?;
                    let branch_name = row
                        .get::<_, Option<String>>(4)?
                        .unwrap_or_else(|| environment_name.clone());
                    Ok(FirstPromptRenameFailureEvent {
                        project_id: row.get(0)?,
                        environment_id: row.get(1)?,
                        thread_id: row.get(2)?,
                        environment_name,
                        branch_name,
                        message: message.clone(),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))
    }

    pub fn archive_thread(&self, input: ArchiveThreadRequest) -> AppResult<ArchiveThreadResult> {
        let now = Utc::now();
        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;
        let (environment_id, previous_status) = transaction
            .query_row(
                "SELECT environment_id, status FROM threads WHERE id = ?1",
                params![&input.thread_id],
                |row| {
                    let status = thread_status_from_str(&row.get::<_, String>(1)?)?;
                    Ok((row.get::<_, String>(0)?, status))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))?;

        transaction.execute(
            "
            UPDATE threads
            SET status = ?1, archived_at = ?2, updated_at = ?3
            WHERE id = ?4
            ",
            params![
                thread_status_value(ThreadStatus::Archived),
                now,
                now,
                &input.thread_id
            ],
        )?;
        let active_threads_remaining = transaction.query_row(
            "SELECT COUNT(*) FROM threads WHERE environment_id = ?1 AND status = ?2",
            params![&environment_id, thread_status_value(ThreadStatus::Active)],
            |row| row.get::<_, i64>(0),
        )?;
        transaction.commit()?;
        let should_stop_runtime =
            matches!(previous_status, ThreadStatus::Active) && active_threads_remaining == 0;

        Ok(ArchiveThreadResult {
            thread: self.thread_by_id(&input.thread_id)?,
            runtime_environment_to_stop: if should_stop_runtime {
                Some(environment_id)
            } else {
                None
            },
        })
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
    ) -> AppResult<EnvironmentRuntimeTarget> {
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

        Ok(EnvironmentRuntimeTarget {
            environment_path,
            codex_binary_path: settings.codex_binary_path,
            stream_assistant_responses: settings.stream_assistant_responses,
        })
    }

    pub fn environment_open_context(
        &self,
        environment_id: &str,
        target_id: Option<&str>,
    ) -> AppResult<EnvironmentOpenContext> {
        let connection = self.database.open()?;
        let (environment_path, environment_kind) = connection
            .query_row(
                "SELECT path, kind FROM environments WHERE id = ?1",
                params![environment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        environment_kind_from_str(&row.get::<_, String>(1)?)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))?;
        if matches!(environment_kind, EnvironmentKind::Chat) {
            return Err(AppError::Validation(
                "Chat does not expose an open-environment action.".to_string(),
            ));
        }
        let settings = self.read_or_seed_settings(&connection)?;
        let target = settings
            .resolve_open_target(target_id)
            .map_err(AppError::Validation)?;

        Ok(EnvironmentOpenContext {
            environment_path: PathBuf::from(environment_path),
            target,
        })
    }

    pub fn environment_git_context(
        &self,
        environment_id: &str,
    ) -> AppResult<GitEnvironmentContext> {
        let connection = self.database.open()?;
        let settings = self.read_or_seed_settings(&connection)?;
        let (environment_id, environment_path, current_branch, base_branch, environment_kind) =
            connection
                .query_row(
                    "
                SELECT id, path, git_branch, base_branch, kind
                FROM environments
                WHERE id = ?1
                ",
                    params![environment_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            environment_kind_from_str(&row.get::<_, String>(4)?)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))?;

        if matches!(environment_kind, EnvironmentKind::Chat) {
            return Err(AppError::Validation(
                "Chat environments do not expose git context.".to_string(),
            ));
        }

        Ok(GitEnvironmentContext {
            environment_id,
            environment_path,
            current_branch,
            base_branch,
            codex_binary_path: settings.codex_binary_path.clone(),
            default_model: settings.default_model.clone(),
        })
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
                            service_tier: if overrides.service_tier_overridden {
                                overrides.service_tier
                            } else {
                                settings.default_service_tier
                            },
                        },
                        codex_binary_path: settings.codex_binary_path.clone(),
                        stream_assistant_responses: settings.stream_assistant_responses,
                        multi_agent_nudge_enabled: settings.multi_agent_nudge_enabled,
                        multi_agent_nudge_max_subagents: settings.multi_agent_nudge_max_subagents,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))
    }

    pub fn composer_target_context(
        &self,
        target: &ComposerTarget,
    ) -> AppResult<ComposerTargetContext> {
        match target {
            ComposerTarget::Thread { thread_id } => {
                validate_non_blank_id(thread_id, "Thread")?;
                let context = self.thread_runtime_context(thread_id)?;
                Ok(ComposerTargetContext {
                    environment_id: context.environment_id,
                    environment_path: context.environment_path,
                    codex_thread_id: context.codex_thread_id,
                    codex_binary_path: context.codex_binary_path,
                    file_search_enabled: true,
                })
            }
            ComposerTarget::Environment { environment_id } => {
                validate_non_blank_id(environment_id, "Environment")?;
                let connection = self.database.open()?;
                let environment_kind = connection
                    .query_row(
                        "SELECT kind FROM environments WHERE id = ?1",
                        params![environment_id],
                        |row| environment_kind_from_str(&row.get::<_, String>(0)?),
                    )
                    .optional()?
                    .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))?;
                if matches!(environment_kind, EnvironmentKind::Chat) {
                    return Err(AppError::Validation(
                        "Chat environments must use the chat workspace composer target."
                            .to_string(),
                    ));
                }
                let runtime_target = self.environment_runtime_target(environment_id)?;
                let codex_thread_id = self
                    .latest_active_codex_thread_id_for_environment(&connection, environment_id)?;

                Ok(ComposerTargetContext {
                    environment_id: environment_id.to_string(),
                    environment_path: runtime_target.environment_path,
                    codex_thread_id,
                    codex_binary_path: runtime_target.codex_binary_path,
                    file_search_enabled: true,
                })
            }
            ComposerTarget::ChatWorkspace {} => {
                std::fs::create_dir_all(&self.chats_root)?;
                let connection = self.database.open()?;
                let settings = self.read_or_seed_settings(&connection)?;
                let environment_id = CHAT_WORKSPACE_PROJECT_ID.to_string();

                Ok(ComposerTargetContext {
                    environment_id: environment_id.clone(),
                    environment_path: self.chats_root.to_string_lossy().to_string(),
                    codex_thread_id: None,
                    codex_binary_path: settings.codex_binary_path,
                    file_search_enabled: false,
                })
            }
        }
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
        let default_service_tier = self.current_settings()?.default_service_tier;
        let overrides = ThreadOverrides {
            model: Some(composer.model.clone()),
            reasoning_effort: Some(composer.reasoning_effort),
            collaboration_mode: Some(composer.collaboration_mode),
            approval_policy: Some(composer.approval_policy),
            service_tier: composer.service_tier,
            service_tier_overridden: composer.service_tier != default_service_tier,
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

    pub fn thread_composer_draft(
        &self,
        thread_id: &str,
    ) -> AppResult<Option<ConversationComposerDraft>> {
        let connection = self.database.open()?;
        let draft = connection
            .query_row(
                "
                SELECT composer_draft_json
                FROM threads
                WHERE id = ?1
                ",
                params![thread_id],
                |row| {
                    let draft_json = row.get::<_, Option<String>>(0)?;
                    let Some(draft_json) = draft_json else {
                        return Ok(None);
                    };
                    let draft = serde_json::from_str::<ConversationComposerDraft>(&draft_json)
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                draft_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?;
                    Ok((!draft.is_empty()).then_some(draft))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Thread not found.".to_string()))?;
        Ok(draft)
    }

    pub fn persist_thread_composer_draft(
        &self,
        thread_id: &str,
        draft: Option<&ConversationComposerDraft>,
    ) -> AppResult<()> {
        let draft_json = match draft {
            Some(draft) if !draft.is_empty() => Some(
                serde_json::to_string(draft)
                    .map_err(|error| AppError::Validation(error.to_string()))?,
            ),
            _ => None,
        };
        let affected = self.database.open()?.execute(
            "
            UPDATE threads
            SET composer_draft_json = ?1, updated_at = ?2
            WHERE id = ?3
            ",
            params![draft_json, Utc::now(), thread_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        Ok(())
    }

    pub fn clear_thread_composer_draft(&self, thread_id: &str) -> AppResult<()> {
        self.persist_thread_composer_draft(thread_id, None)
    }

    pub fn draft_thread_state(
        &self,
        target: &DraftThreadTarget,
    ) -> AppResult<Option<SavedDraftThreadState>> {
        let connection = self.database.open()?;
        self.validate_draft_thread_target_with_connection(&connection, target)?;
        let (scope_kind, scope_id) = draft_thread_scope(target);
        let state = connection
            .query_row(
                "
                SELECT payload_json
                FROM draft_thread_states
                WHERE scope_kind = ?1 AND scope_id = ?2
                ",
                params![scope_kind, scope_id],
                |row| {
                    let payload_json = row.get::<_, String>(0)?;
                    serde_json::from_str::<SavedDraftThreadState>(&payload_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            payload_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                },
            )
            .optional()?;
        Ok(state)
    }

    pub fn persist_draft_thread_state(
        &self,
        target: &DraftThreadTarget,
        state: Option<&SavedDraftThreadState>,
    ) -> AppResult<()> {
        let connection = self.database.open()?;
        self.validate_draft_thread_state_with_connection(&connection, target, state)?;
        let (scope_kind, scope_id) = draft_thread_scope(target);

        match state {
            Some(state) => {
                let payload_json = serde_json::to_string(state)
                    .map_err(|error| AppError::Validation(error.to_string()))?;
                connection.execute(
                    "
                    INSERT INTO draft_thread_states (scope_kind, scope_id, payload_json, updated_at)
                    VALUES (?1, ?2, ?3, ?4)
                    ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
                      payload_json = excluded.payload_json,
                      updated_at = excluded.updated_at
                    ",
                    params![scope_kind, scope_id, payload_json, Utc::now()],
                )?;
            }
            None => {
                connection.execute(
                    "
                    DELETE FROM draft_thread_states
                    WHERE scope_kind = ?1 AND scope_id = ?2
                    ",
                    params![scope_kind, scope_id],
                )?;
            }
        }

        Ok(())
    }

    fn normalize_deleted_worktree_project_draft_thread_state(
        &self,
        connection: &rusqlite::Connection,
        project_id: &str,
        deleted_environment_id: &str,
    ) -> AppResult<()> {
        let payload_json = connection
            .query_row(
                "
                SELECT payload_json
                FROM draft_thread_states
                WHERE scope_kind = 'project' AND scope_id = ?1
                ",
                params![project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(payload_json) = payload_json else {
            return Ok(());
        };

        let mut state = serde_json::from_str::<SavedDraftThreadState>(&payload_json)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let should_normalize = matches!(
            state.project_selection.as_ref(),
            Some(DraftProjectSelection::Existing { environment_id })
                if environment_id == deleted_environment_id
        );
        if !should_normalize {
            return Ok(());
        }

        state.project_selection = Some(DraftProjectSelection::Local);
        let payload_json = serde_json::to_string(&state)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        connection.execute(
            "
            UPDATE draft_thread_states
            SET payload_json = ?1, updated_at = ?2
            WHERE scope_kind = 'project' AND scope_id = ?3
            ",
            params![payload_json, Utc::now(), project_id],
        )?;

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
        let WorkspaceSnapshot { projects, chat, .. } = snapshot;
        projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .chain(chat.environments)
            .find(|environment| environment.id == environment_id)
            .ok_or_else(|| AppError::NotFound("Environment not found.".to_string()))
    }

    fn thread_by_id(&self, thread_id: &str) -> AppResult<ThreadRecord> {
        let WorkspaceSnapshot { projects, chat, .. } = self.snapshot(Vec::new())?;
        projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .chain(chat.environments)
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
        self.ensure_repository_project_with_connection(connection, project_id)?;

        if self.project_has_managed_worktrees(connection, project_id)? {
            return Err(AppError::Validation(
                "Delete this project's worktrees before removing it from Skein.".to_string(),
            ));
        }

        Ok(())
    }

    fn project_metadata(&self, project_id: &str) -> AppResult<ProjectMetadata> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "
                SELECT kind, name, root_path, settings_json
                FROM projects
                WHERE id = ?1 AND archived_at IS NULL
                ",
                params![project_id],
                |row| {
                    Ok(ProjectMetadata {
                        kind: project_kind_from_str(&row.get::<_, String>(0)?)?,
                        name: row.get(1)?,
                        root_path: PathBuf::from(row.get::<_, String>(2)?),
                        settings: project_settings_from_json(&row.get::<_, String>(3)?, 3)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))
    }

    fn validate_draft_thread_target_with_connection(
        &self,
        connection: &rusqlite::Connection,
        target: &DraftThreadTarget,
    ) -> AppResult<()> {
        match target {
            DraftThreadTarget::Project { project_id } => {
                self.ensure_repository_project_with_connection(connection, project_id)
            }
            DraftThreadTarget::Chat => Ok(()),
        }
    }

    fn validate_draft_thread_state_with_connection(
        &self,
        connection: &rusqlite::Connection,
        target: &DraftThreadTarget,
        state: Option<&SavedDraftThreadState>,
    ) -> AppResult<()> {
        self.validate_draft_thread_target_with_connection(connection, target)?;
        let Some(state) = state else {
            return Ok(());
        };

        if state.composer.model.trim().is_empty() {
            return Err(AppError::Validation("Model is required.".to_string()));
        }

        match (target, state.project_selection.as_ref()) {
            (DraftThreadTarget::Chat, Some(_)) => Err(AppError::Validation(
                "Chat drafts cannot persist a project selection.".to_string(),
            )),
            (DraftThreadTarget::Project { .. }, None) => Err(AppError::Validation(
                "Project drafts must persist a project selection.".to_string(),
            )),
            (
                DraftThreadTarget::Project { project_id },
                Some(DraftProjectSelection::Existing { environment_id }),
            ) => {
                let belongs_to_project = connection.query_row(
                    "
                        SELECT COUNT(*)
                        FROM environments
                        JOIN projects ON projects.id = environments.project_id
                        WHERE environments.id = ?1
                          AND environments.project_id = ?2
                          AND projects.archived_at IS NULL
                        ",
                    params![environment_id, project_id],
                    |row| row.get::<_, i64>(0),
                )? > 0;
                if !belongs_to_project {
                    return Err(AppError::Validation(
                        "The selected worktree no longer belongs to this project.".to_string(),
                    ));
                }
                Ok(())
            }
            _ => Ok(()),
        }
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

    fn named_managed_worktree_candidate(
        &self,
        project_id: &str,
        project: &ProjectMetadata,
        requested_name: &str,
    ) -> AppResult<ManagedWorktreeCandidate> {
        let trimmed = requested_name.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation(
                "Worktree name cannot be empty.".to_string(),
            ));
        }
        if trimmed.contains('\n') || trimmed.contains(char::is_whitespace) {
            return Err(AppError::Validation(
                "Worktree name cannot contain whitespace.".to_string(),
            ));
        }
        if trimmed.starts_with('-') {
            return Err(AppError::Validation(
                "Worktree name cannot start with '-'.".to_string(),
            ));
        }
        // Reject anything that could escape the per-project managed-worktree
        // directory: path components, separators, traversal segments, or
        // null bytes. Git refnames already forbid some of these, but path
        // containment needs its own guard before we resolve the destination.
        if trimmed == "."
            || trimmed == ".."
            || trimmed.starts_with('.')
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.contains('\0')
        {
            return Err(AppError::Validation(
                "Worktree name cannot contain path separators or start with '.'.".to_string(),
            ));
        }

        let managed_worktree_dir =
            self.ensure_project_managed_worktree_dir(project_id, &project.root_path)?;

        let connection = self.database.open()?;
        let existing_name: Option<String> = connection
            .query_row(
                "
                SELECT name
                FROM environments
                WHERE project_id = ?1 AND LOWER(name) = LOWER(?2)
                LIMIT 1
                ",
                params![project_id, trimmed],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(name) = existing_name {
            return Err(AppError::Validation(format!(
                "An environment named '{name}' already exists for this project."
            )));
        }

        let branch_refs = git::list_branch_refs(&project.root_path)?
            .into_iter()
            .collect::<HashSet<_>>();
        if branch_ref_exists(&branch_refs, trimmed) {
            return Err(AppError::Validation(format!(
                "Branch '{trimmed}' already exists in this repository."
            )));
        }

        let destination = git::managed_worktree_path(
            &self.managed_worktrees_root,
            &managed_worktree_dir,
            trimmed,
        );
        let expected_parent = self.managed_worktrees_root.join(&managed_worktree_dir);
        // Defence in depth: after path assembly the destination's direct
        // parent must still be the expected per-project directory. Rejects
        // pathological inputs that slipped past the character check.
        if destination.parent() != Some(expected_parent.as_path()) {
            return Err(AppError::Validation(
                "Worktree name would escape the managed worktree directory.".to_string(),
            ));
        }
        if destination.exists() {
            return Err(AppError::Validation(format!(
                "A worktree folder already exists at {}.",
                destination.display()
            )));
        }

        Ok(ManagedWorktreeCandidate {
            branch_name: trimmed.to_string(),
            destination,
        })
    }

    pub fn list_project_branches(&self, project_id: &str) -> AppResult<Vec<String>> {
        let project = self.project_metadata(project_id)?;
        if matches!(project.kind, ProjectKind::ChatWorkspace) {
            return Err(AppError::Validation(
                "Chat does not expose project branches.".to_string(),
            ));
        }
        let mut branches = git::list_local_branches(&project.root_path)?;
        branches.sort();
        branches.dedup();
        Ok(branches)
    }

    fn worktree_environment_metadata(
        &self,
        environment_id: &str,
    ) -> AppResult<WorktreeEnvironmentMetadata> {
        let metadata = self.project_action_environment_metadata(environment_id)?;
        let branch_name = metadata
            .branch_name
            .ok_or_else(|| AppError::Runtime("Environment branch is missing.".to_string()))?;

        Ok(WorktreeEnvironmentMetadata {
            environment_id: metadata.environment_id,
            environment_name: metadata.environment_name,
            kind: metadata.kind,
            environment_path: metadata.environment_path,
            branch_name,
            project_id: metadata.project_id,
            project_name: metadata.project_name,
            project_root: metadata.project_root,
            project_settings: metadata.project_settings,
        })
    }

    fn project_action_environment_metadata(
        &self,
        environment_id: &str,
    ) -> AppResult<ProjectActionEnvironmentMetadata> {
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
                    Ok(ProjectActionEnvironmentMetadata {
                        environment_id: row.get(0)?,
                        environment_name: row.get(1)?,
                        kind: environment_kind_from_str(&row.get::<_, String>(2)?)?,
                        environment_path: PathBuf::from(row.get::<_, String>(3)?),
                        branch_name: row.get(4)?,
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
        if matches!(metadata.kind, EnvironmentKind::Chat) {
            return Err(AppError::Validation(
                "Chat environments cannot be deleted directly.".to_string(),
            ));
        }
        if matches!(metadata.kind, EnvironmentKind::Local) {
            return Err(AppError::Validation(
                "The local environment cannot be deleted.".to_string(),
            ));
        }

        Ok(metadata)
    }

    fn first_prompt_naming_metadata(
        &self,
        thread_id: &str,
    ) -> AppResult<FirstPromptNamingMetadata> {
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
                        branch_name: row.get(7)?,
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

    fn latest_active_codex_thread_id_for_environment(
        &self,
        connection: &rusqlite::Connection,
        environment_id: &str,
    ) -> AppResult<Option<String>> {
        connection
            .query_row(
                "
                SELECT codex_thread_id
                FROM threads
                WHERE environment_id = ?1
                  AND archived_at IS NULL
                  AND status = ?2
                  AND codex_thread_id IS NOT NULL
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                ",
                params![environment_id, thread_status_value(ThreadStatus::Active)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(AppError::from)
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
              id, project_id, name, kind, path, git_branch, base_branch, is_default, sort_order, created_at, updated_at
            ) VALUES (?1, ?2, 'Local', 'local', ?3, ?4, ?4, 1, 0, ?5, ?5)
            ",
            params![Uuid::now_v7().to_string(), project_id, root_path, branch, now],
        )?;

        Ok(())
    }

    fn read_projects(
        &self,
        connection: &rusqlite::Connection,
        runtime_map: &HashMap<String, RuntimeStatusSnapshot>,
        pull_requests: &HashMap<String, EnvironmentPullRequestSnapshot>,
    ) -> AppResult<(ChatWorkspaceSnapshot, Vec<ProjectRecord>)> {
        let mut chat = ChatWorkspaceSnapshot {
            project_id: CHAT_WORKSPACE_PROJECT_ID.to_string(),
            title: CHAT_WORKSPACE_TITLE.to_string(),
            root_path: self.chats_root.to_string_lossy().to_string(),
            environments: Vec::new(),
        };
        let mut project_statement = connection.prepare(
            "
            SELECT id, name, root_path, settings_json, sidebar_collapsed, created_at, updated_at
            FROM projects
            WHERE archived_at IS NULL AND kind = 'repository'
            ORDER BY sort_order ASC, id ASC
            ",
        )?;
        let project_rows = project_statement.query_map([], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                settings: project_settings_from_json(&row.get::<_, String>(3)?, 3)?,
                sidebar_collapsed: row.get::<_, i64>(4)? == 1,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                environments: Vec::new(),
            })
        })?;

        let mut projects = Vec::new();
        let mut project_index = HashMap::new();
        for project in project_rows.collect::<Result<Vec<_>, _>>()? {
            let index = projects.len();
            project_index.insert(project.id.clone(), index);
            projects.push(project);
        }

        let mut thread_map = self.read_threads(connection)?;
        let mut environment_statement = connection.prepare(
            "
            SELECT id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
            FROM environments
            ORDER BY project_id ASC, is_default DESC, sort_order ASC, created_at ASC, id ASC
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
                pull_request: pull_requests.get(&environment_id).cloned(),
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
            if environment.project_id == chat.project_id {
                chat.environments.push(environment);
                continue;
            }
            if let Some(index) = project_index.get(&environment.project_id) {
                projects[*index].environments.push(environment);
            }
        }

        Ok((chat, projects))
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
        Ok(self
            .read_or_seed_stored_settings(connection)?
            .projected_for_client())
    }

    fn read_or_seed_stored_settings(
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
            let mut settings: GlobalSettings = match serde_json::from_str(&payload) {
                Ok(settings) => settings,
                Err(error) => {
                    warn!("failed to parse stored global settings, using defaults: {error}");
                    return Ok(GlobalSettings::default());
                }
            };
            let repaired = settings.normalize_for_read();
            if let Err(error) = settings.validate() {
                warn!("stored global settings remained invalid after repair: {error}");
                return Err(AppError::Validation(format!(
                    "Stored global settings remained invalid after repair: {error}"
                )));
            }
            if repaired {
                let payload = serde_json::to_string(&settings)
                    .map_err(|error| AppError::Validation(error.to_string()))?;
                connection.execute(
                    "
                    INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                    VALUES ('global', ?1, ?2)
                    ON CONFLICT(singleton_key) DO UPDATE SET
                      payload_json = excluded.payload_json,
                      updated_at = excluded.updated_at
                    ",
                    params![payload, Utc::now()],
                )?;
            }
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
    kind: ProjectKind,
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
struct ProjectActionEnvironmentMetadata {
    environment_id: String,
    environment_name: String,
    kind: EnvironmentKind,
    environment_path: PathBuf,
    branch_name: Option<String>,
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
    branch_name: Option<String>,
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

fn validate_non_blank_id(id: &str, label: &str) -> AppResult<()> {
    if id.trim().is_empty() {
        return Err(AppError::Validation(format!("{label} id cannot be empty.")));
    }

    Ok(())
}

fn validate_unique_ids(ids: &[String], label: &str) -> AppResult<()> {
    let mut seen = HashSet::new();
    for id in ids {
        validate_non_blank_id(id, label)?;
        if !seen.insert(id.as_str()) {
            return Err(AppError::Validation(format!(
                "{label} reorder payload contains duplicate ids."
            )));
        }
    }
    Ok(())
}

fn active_project_ids(connection: &rusqlite::Connection) -> AppResult<Vec<String>> {
    let mut statement = connection.prepare(
        "
        SELECT id
        FROM projects
        WHERE archived_at IS NULL
          AND kind = 'repository'
        ORDER BY sort_order ASC, id ASC
        ",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn next_project_sort_order(connection: &rusqlite::Connection) -> AppResult<i64> {
    connection
        .query_row(
            "
            SELECT COALESCE(MAX(sort_order), -1) + 1
            FROM projects
            WHERE archived_at IS NULL
              AND kind = 'repository'
            ",
            [],
            |row| row.get(0),
        )
        .map_err(AppError::from)
}

fn next_environment_sort_order(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<i64> {
    connection
        .query_row(
            "
            SELECT COALESCE(MAX(sort_order), 0) + 1
            FROM environments
            WHERE project_id = ?1
            ",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(AppError::from)
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
        EnvironmentKind::Chat => "chat",
    }
}

fn environment_kind_from_str(value: &str) -> Result<EnvironmentKind, rusqlite::Error> {
    match value {
        "local" => Ok(EnvironmentKind::Local),
        "managedWorktree" => Ok(EnvironmentKind::ManagedWorktree),
        "permanentWorktree" => Ok(EnvironmentKind::PermanentWorktree),
        "chat" => Ok(EnvironmentKind::Chat),
        other => Err(rusqlite::Error::InvalidParameterName(other.to_string())),
    }
}

fn project_kind_value(kind: ProjectKind) -> &'static str {
    match kind {
        ProjectKind::Repository => "repository",
        ProjectKind::ChatWorkspace => "chatWorkspace",
    }
}

fn project_kind_from_str(value: &str) -> Result<ProjectKind, rusqlite::Error> {
    match value {
        "repository" => Ok(ProjectKind::Repository),
        "chatWorkspace" => Ok(ProjectKind::ChatWorkspace),
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

fn draft_thread_scope(target: &DraftThreadTarget) -> (&'static str, &str) {
    match target {
        DraftThreadTarget::Project { project_id } => ("project", project_id.as_str()),
        DraftThreadTarget::Chat => ("chat", "chat"),
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

fn validate_project_shortcuts_against_global_settings(
    connection: &rusqlite::Connection,
    shortcuts: &ShortcutSettings,
) -> AppResult<()> {
    let mut statement = connection.prepare(
        "
        SELECT name, settings_json
        FROM projects
        WHERE archived_at IS NULL
        ",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            project_settings_from_json(&row.get::<_, String>(1)?, 1)?,
        ))
    })?;

    for row in rows {
        let (project_name, project_settings) = row?;
        project_settings
            .validate(Some(shortcuts))
            .map_err(|error| {
                AppError::Validation(format!("Project \"{project_name}\": {error}"))
            })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use chrono::Utc;
    use rusqlite::{params, Connection};
    use uuid::Uuid;

    use super::{
        AddProjectRequest, ArchiveThreadRequest, AutoRenameFirstPromptRequest,
        CreateChatThreadRequest, CreateManagedWorktreeRequest, CreateThreadRequest,
        RenameProjectRequest, ReorderProjectsRequest, RunProjectActionRequest,
        SetProjectSidebarCollapsedRequest, UpdateProjectSettingsRequest, WorkspaceService,
        CHAT_WORKSPACE_PROJECT_ID,
    };
    use crate::domain::conversation::{
        ComposerDraftMentionBinding, ComposerMentionBindingKind, ComposerTarget,
        ConversationComposerDraft, ConversationComposerSettings, ConversationImageAttachment,
    };
    use crate::domain::settings::{
        GlobalSettings, GlobalSettingsPatch, NotificationSoundChannelSettingsPatch,
        NotificationSoundId, NotificationSoundSettingsPatch, OpenTarget, OpenTargetKind,
        ServiceTier,
    };
    use crate::domain::shortcuts::{ShortcutSettings, ShortcutSettingsPatch};
    use crate::domain::workspace::{
        DraftProjectSelection, DraftThreadTarget, EnvironmentKind, EnvironmentPullRequestSnapshot,
        ProjectActionIcon, ProjectManualAction, ProjectSettingsPatch, PullRequestState,
        SavedDraftThreadState, ThreadOverrides, ThreadStatus,
    };
    use crate::error::AppError;
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
    fn update_project_settings_rejects_manual_action_global_shortcut_conflicts() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("skein"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        let error = harness
            .service
            .update_project_settings(UpdateProjectSettingsRequest {
                project_id: project.id,
                patch: ProjectSettingsPatch {
                    manual_actions: Some(Some(vec![ProjectManualAction {
                        id: "dev".to_string(),
                        label: "Dev".to_string(),
                        icon: ProjectActionIcon::Play,
                        script: "bun run dev".to_string(),
                        shortcut: Some("mod+j".to_string()),
                    }])),
                    ..ProjectSettingsPatch::default()
                },
            })
            .expect_err("conflicting manual action shortcut should fail");

        assert!(error.to_string().contains("Toggle terminal"));
    }

    #[test]
    fn update_settings_rejects_global_shortcut_conflicts_with_existing_manual_actions() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("skein"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        harness
            .service
            .update_project_settings(UpdateProjectSettingsRequest {
                project_id: project.id,
                patch: ProjectSettingsPatch {
                    manual_actions: Some(Some(vec![ProjectManualAction {
                        id: "dev".to_string(),
                        label: "Dev".to_string(),
                        icon: ProjectActionIcon::Play,
                        script: "bun run dev".to_string(),
                        shortcut: Some("mod+shift+d".to_string()),
                    }])),
                    ..ProjectSettingsPatch::default()
                },
            })
            .expect("manual action should save");

        let error = harness
            .service
            .update_settings(GlobalSettingsPatch {
                shortcuts: Some(ShortcutSettingsPatch {
                    toggle_terminal: Some(Some("mod+shift+d".to_string())),
                    ..ShortcutSettingsPatch::default()
                }),
                ..GlobalSettingsPatch::default()
            })
            .expect_err("conflicting global shortcut should fail");

        assert!(error.to_string().contains("Project \"skein\""));
        assert!(error.to_string().contains("Toggle terminal"));
    }

    #[test]
    fn project_action_execution_target_returns_environment_context() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("skein"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project.environments[0].id.clone();

        harness
            .service
            .update_project_settings(UpdateProjectSettingsRequest {
                project_id: project.id.clone(),
                patch: ProjectSettingsPatch {
                    manual_actions: Some(Some(vec![ProjectManualAction {
                        id: "dev".to_string(),
                        label: "Dev".to_string(),
                        icon: ProjectActionIcon::Play,
                        script: "bun run dev".to_string(),
                        shortcut: Some("mod+shift+d".to_string()),
                    }])),
                    ..ProjectSettingsPatch::default()
                },
            })
            .expect("project settings should update");

        let target = harness
            .service
            .project_action_execution_target(RunProjectActionRequest {
                environment_id: environment_id.clone(),
                action_id: "dev".to_string(),
            })
            .expect("action target should resolve");

        assert_eq!(target.environment_id, environment_id);
        assert_eq!(target.project_id, project.id);
        assert_eq!(
            PathBuf::from(&target.cwd)
                .canonicalize()
                .expect("canonical cwd"),
            repo.path.canonicalize().expect("canonical repo path")
        );
        assert_eq!(
            target
                .project_root
                .canonicalize()
                .expect("canonical project root"),
            repo.path.canonicalize().expect("canonical repo path")
        );
        assert_eq!(target.branch_name, "main");
        assert_eq!(target.action.label, "Dev");
        assert_eq!(target.action.script, "bun run dev");
    }

    #[test]
    fn project_action_execution_target_rejects_blank_ids() {
        let harness = WorkspaceHarness::new().expect("harness");

        let environment_error = harness
            .service
            .project_action_execution_target(RunProjectActionRequest {
                environment_id: "   ".to_string(),
                action_id: "dev".to_string(),
            })
            .expect_err("blank environment id should fail");
        assert!(environment_error
            .to_string()
            .contains("environment id cannot be empty"));

        let action_error = harness
            .service
            .project_action_execution_target(RunProjectActionRequest {
                environment_id: "env-1".to_string(),
                action_id: "   ".to_string(),
            })
            .expect_err("blank action id should fail");
        assert!(action_error
            .to_string()
            .contains("action id cannot be empty"));
    }

    #[test]
    fn project_action_execution_target_tolerates_missing_branch() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("skein-detached"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project.environments[0].id.clone();

        harness
            .service
            .update_project_settings(UpdateProjectSettingsRequest {
                project_id: project.id.clone(),
                patch: ProjectSettingsPatch {
                    manual_actions: Some(Some(vec![ProjectManualAction {
                        id: "dev".to_string(),
                        label: "Dev".to_string(),
                        icon: ProjectActionIcon::Play,
                        script: "bun run dev".to_string(),
                        shortcut: None,
                    }])),
                    ..ProjectSettingsPatch::default()
                },
            })
            .expect("project settings should update");

        harness
            .open_connection()
            .execute(
                "UPDATE environments SET git_branch = NULL WHERE id = ?1",
                params![environment_id],
            )
            .expect("environment branch should be cleared");

        let target = harness
            .service
            .project_action_execution_target(RunProjectActionRequest {
                environment_id: environment_id.clone(),
                action_id: "dev".to_string(),
            })
            .expect("branchless action target should resolve");

        assert_eq!(target.environment_id, environment_id);
        assert_eq!(target.branch_name, "");
        assert_eq!(target.action.script, "bun run dev");
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
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
    fn create_managed_worktree_rejects_path_traversal_names() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("traversal-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        for bad_name in [
            "-leading-option",
            "..",
            ".",
            "../escape",
            "nested/name",
            "nested\\name",
            ".hidden",
        ] {
            let error = harness
                .service
                .create_managed_worktree(CreateManagedWorktreeRequest {
                    project_id: project.id.clone(),
                    base_branch: None,
                    name: Some(bad_name.to_string()),
                    overrides: None,
                })
                .expect_err("path-like worktree names must be rejected before git sees them");
            assert!(
                matches!(error, crate::error::AppError::Validation(_)),
                "expected Validation error for name {bad_name:?}, got {error:?}"
            );
        }
    }

    #[test]
    fn create_managed_worktree_uses_inferred_base_reference_instead_of_head_branch() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("base-reference-repo"))
            .expect("repo");
        git::run_git(&repo.path, ["checkout", "-b", "feature-stack"])
            .expect("feature branch should be created");
        fs::write(
            repo.path.join("feature-only.txt"),
            "feature branch commit\n",
        )
        .expect("feature-only marker should be written");
        git::run_git(&repo.path, ["add", "feature-only.txt"]).expect("file should be staged");
        git::run_git(&repo.path, ["commit", "-m", "Feature branch commit"])
            .expect("feature commit should succeed");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        let result = harness
            .service
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created from the inferred base branch");

        assert_eq!(result.environment.base_branch.as_deref(), Some("main"));
        assert!(
            !Path::new(&result.environment.path)
                .join("feature-only.txt")
                .exists(),
            "managed worktree should be created from the inferred base branch, not the current feature branch"
        );
    }

    #[test]
    fn create_managed_worktree_uses_the_only_local_branch_when_no_default_ref_exists() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("trunk-only-repo"))
            .expect("repo");
        git::run_git(&repo.path, ["branch", "-m", "trunk"])
            .expect("default branch should be renamed");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        let result = harness
            .service
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created from the only local branch");

        assert_eq!(result.environment.base_branch.as_deref(), Some("trunk"));
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
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
    fn delete_worktree_environment_normalizes_project_draft_selection_back_to_local() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("draft-delete-repo"))
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");
        let target = DraftThreadTarget::Project {
            project_id: project.id.clone(),
        };
        harness
            .service
            .persist_draft_thread_state(
                &target,
                Some(&saved_draft_thread_state(Some(
                    DraftProjectSelection::Existing {
                        environment_id: result.environment.id.clone(),
                    },
                ))),
            )
            .expect("draft should persist");

        harness
            .service
            .delete_worktree_environment(&result.environment.id)
            .expect("worktree should be deleted");

        assert_eq!(
            harness
                .service
                .draft_thread_state(&target)
                .expect("draft should load")
                .and_then(|state| state.project_selection),
            Some(DraftProjectSelection::Local)
        );
    }

    #[test]
    fn archive_thread_requests_runtime_stop_for_the_last_active_thread() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("archive-last-thread-repo"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id: environment_id.clone(),
                title: Some("Investigate status".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        let result = harness
            .service
            .archive_thread(ArchiveThreadRequest {
                thread_id: thread.id,
            })
            .expect("thread should archive");

        assert!(matches!(result.thread.status, ThreadStatus::Archived));
        assert_eq!(
            result.runtime_environment_to_stop.as_deref(),
            Some(environment_id.as_str())
        );
    }

    #[test]
    fn create_thread_rejects_blank_environment_ids() {
        let harness = WorkspaceHarness::new().expect("harness");

        let error = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id: "   ".to_string(),
                title: None,
                overrides: None,
            })
            .expect_err("blank environment ids should fail");

        assert!(error.to_string().contains("environment id cannot be empty"));
    }

    #[test]
    fn create_chat_thread_returns_the_created_chat_environment_and_thread() {
        let harness = WorkspaceHarness::new().expect("harness");

        let result = harness
            .service
            .create_chat_thread(CreateChatThreadRequest {
                title: Some("Bonjour".to_string()),
                overrides: None,
            })
            .expect("chat thread should be created");

        assert_eq!(result.thread.environment_id, result.environment.id);
        assert_eq!(result.thread.title, "Bonjour");
        assert!(matches!(result.environment.kind, EnvironmentKind::Chat));
        assert_eq!(result.environment.project_id, CHAT_WORKSPACE_PROJECT_ID);
        assert_eq!(
            Path::new(&result.environment.path),
            harness.temp_root.join("chats").join(&result.environment.id)
        );
    }

    #[test]
    fn create_chat_thread_normalizes_blank_titles() {
        let harness = WorkspaceHarness::new().expect("harness");

        let result = harness
            .service
            .create_chat_thread(CreateChatThreadRequest {
                title: Some("   ".to_string()),
                overrides: None,
            })
            .expect("chat thread should be created");

        assert_eq!(result.thread.title, "Thread 1");
    }

    #[test]
    fn first_prompt_auto_rename_skips_chat_threads() {
        let harness = WorkspaceHarness::new().expect("harness");
        let result = harness
            .service
            .create_chat_thread(CreateChatThreadRequest {
                title: Some("Bonjour".to_string()),
                overrides: None,
            })
            .expect("chat thread should be created");

        let rename = harness
            .service
            .maybe_auto_rename_first_prompt_environment(AutoRenameFirstPromptRequest {
                thread_id: result.thread.id,
                message: "Salut, ca va ?".to_string(),
                codex_binary_path: None,
            })
            .expect("chat threads should skip first-prompt auto rename");

        assert!(rename.is_none());
    }

    #[test]
    fn archive_chat_thread_returns_the_archived_thread() {
        let harness = WorkspaceHarness::new().expect("harness");
        let result = harness
            .service
            .create_chat_thread(CreateChatThreadRequest {
                title: Some("Bonjour".to_string()),
                overrides: None,
            })
            .expect("chat thread should be created");

        let archived = harness
            .service
            .archive_thread(ArchiveThreadRequest {
                thread_id: result.thread.id,
            })
            .expect("chat thread should archive");

        assert!(matches!(archived.thread.status, ThreadStatus::Archived));
        assert_eq!(
            archived.runtime_environment_to_stop.as_deref(),
            Some(result.environment.id.as_str())
        );
    }

    #[test]
    fn archive_thread_preserves_runtime_when_active_threads_remain() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("archive-one-thread-repo"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let first_thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id: environment_id.clone(),
                title: Some("First".to_string()),
                overrides: None,
            })
            .expect("first thread should be created");
        harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Second".to_string()),
                overrides: None,
            })
            .expect("second thread should be created");

        let result = harness
            .service
            .archive_thread(ArchiveThreadRequest {
                thread_id: first_thread.id,
            })
            .expect("thread should archive");

        assert!(matches!(result.thread.status, ThreadStatus::Archived));
        assert_eq!(result.runtime_environment_to_stop, None);
    }

    #[test]
    fn thread_runtime_context_inherits_default_service_tier() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("service-tier-default"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Fast default".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_service_tier: Some(Some(ServiceTier::Fast)),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");

        let context = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should load");

        assert_eq!(context.composer.service_tier, Some(ServiceTier::Fast));
    }

    #[test]
    fn chat_workspace_composer_target_disables_file_search() {
        let harness = WorkspaceHarness::new().expect("harness");

        let context = harness
            .service
            .composer_target_context(&ComposerTarget::ChatWorkspace {})
            .expect("chat workspace target should resolve");

        assert_eq!(context.environment_id, CHAT_WORKSPACE_PROJECT_ID);
        assert!(!context.file_search_enabled);
    }

    #[test]
    fn environment_composer_target_rejects_chat_environments() {
        let harness = WorkspaceHarness::new().expect("harness");
        let chat = harness
            .service
            .create_chat_thread(CreateChatThreadRequest {
                title: Some("Composer validation".to_string()),
                overrides: None,
            })
            .expect("chat thread should be created");

        let error = harness
            .service
            .composer_target_context(&ComposerTarget::Environment {
                environment_id: chat.environment.id,
            })
            .expect_err("chat environment should be rejected");

        assert!(
            matches!(error, AppError::Validation(message) if message == "Chat environments must use the chat workspace composer target.")
        );
    }

    #[test]
    fn thread_runtime_context_inherits_assistant_streaming_setting() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("assistant-streaming-default"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Buffered assistant".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        harness
            .service
            .update_settings(GlobalSettingsPatch {
                stream_assistant_responses: Some(false),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");

        let context = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should load");

        assert!(!context.stream_assistant_responses);
    }

    #[test]
    fn thread_runtime_context_inherits_multi_agent_nudge_settings() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("multi-agent-default"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Multi-agent default".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        harness
            .service
            .update_settings(GlobalSettingsPatch {
                multi_agent_nudge_enabled: Some(true),
                multi_agent_nudge_max_subagents: Some(6),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");

        let context = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should load");

        assert!(context.multi_agent_nudge_enabled);
        assert_eq!(context.multi_agent_nudge_max_subagents, 6);
    }

    #[test]
    fn thread_runtime_context_defaults_assistant_streaming_to_true() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("assistant-streaming-enabled"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Streaming assistant".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        let context = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should load");

        assert!(context.stream_assistant_responses);
    }

    #[test]
    fn persist_thread_composer_settings_can_explicitly_disable_fast_mode() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("service-tier-override"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Fast override".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_service_tier: Some(Some(ServiceTier::Fast)),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");

        let context = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should load");
        assert_eq!(context.composer.service_tier, Some(ServiceTier::Fast));

        harness
            .service
            .persist_thread_composer_settings(
                &thread.id,
                &ConversationComposerSettings {
                    service_tier: None,
                    ..context.composer
                },
            )
            .expect("composer settings should persist");

        let refreshed = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should reload");

        assert_eq!(refreshed.composer.service_tier, None);
    }

    #[test]
    fn persist_thread_composer_settings_keeps_service_tier_inherited_when_unchanged() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("service-tier-inheritance"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("local environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Inherited fast".to_string()),
                overrides: None,
            })
            .expect("thread should be created");

        harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_service_tier: Some(Some(ServiceTier::Fast)),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");

        let context = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should load");
        assert_eq!(context.composer.service_tier, Some(ServiceTier::Fast));

        harness
            .service
            .persist_thread_composer_settings(&thread.id, &context.composer)
            .expect("composer settings should persist");

        harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_service_tier: Some(Some(ServiceTier::Flex)),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");

        let refreshed = harness
            .service
            .thread_runtime_context(&thread.id)
            .expect("thread context should reload");

        assert_eq!(refreshed.composer.service_tier, Some(ServiceTier::Flex));
    }

    #[test]
    fn update_settings_persists_notification_sound_preferences() {
        let harness = WorkspaceHarness::new().expect("harness");

        let updated = harness
            .service
            .update_settings(GlobalSettingsPatch {
                notification_sounds: Some(NotificationSoundSettingsPatch {
                    attention: Some(NotificationSoundChannelSettingsPatch {
                        enabled: Some(true),
                        sound: Some(NotificationSoundId::Chord),
                    }),
                    completion: Some(NotificationSoundChannelSettingsPatch {
                        enabled: Some(true),
                        sound: Some(NotificationSoundId::Glass),
                    }),
                }),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings should update");
        let reloaded = harness
            .service
            .current_settings()
            .expect("settings should reload");

        assert!(updated.notification_sounds.attention.enabled);
        assert_eq!(
            updated.notification_sounds.attention.sound,
            NotificationSoundId::Chord
        );
        assert!(updated.notification_sounds.completion.enabled);
        assert_eq!(
            updated.notification_sounds.completion.sound,
            NotificationSoundId::Glass
        );
        assert_eq!(updated.notification_sounds, reloaded.notification_sounds);
    }

    #[test]
    fn update_settings_repairs_invalid_stored_notification_sounds_without_resetting_other_fields() {
        let harness = WorkspaceHarness::new().expect("harness");

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    r#"{
                        "defaultModel":"gpt-5.4-mini",
                        "defaultReasoningEffort":"high",
                        "defaultCollaborationMode":"build",
                        "defaultApprovalPolicy":"askToEdit",
                        "desktopNotificationsEnabled":true,
                        "notificationSounds":{
                            "attention":{"enabled":true},
                            "completion":{"enabled":true,"sound":"future-bell"}
                        }
                    }"#,
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let updated = harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_model: Some("gpt-5.3-codex".to_string()),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings update should repair notification sounds");
        let reloaded = harness
            .service
            .current_settings()
            .expect("settings should reload");

        assert_eq!(updated.default_model, "gpt-5.3-codex");
        assert!(updated.desktop_notifications_enabled);
        assert!(updated.notification_sounds.attention.enabled);
        assert_eq!(
            updated.notification_sounds.attention.sound,
            NotificationSoundId::Glass
        );
        assert!(updated.notification_sounds.completion.enabled);
        assert_eq!(
            updated.notification_sounds.completion.sound,
            NotificationSoundId::Polite
        );
        assert_eq!(updated.notification_sounds, reloaded.notification_sounds);
        assert_eq!(
            updated.desktop_notifications_enabled,
            reloaded.desktop_notifications_enabled
        );
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");
        let fake_codex = harness.create_fake_codex(
            r#"{"threadTitle":"Add themes","worktreeLabel":"Add themes","branchSlug":"add-themes"}"#,
        );

        let rename = harness
            .service
            .maybe_auto_rename_first_prompt_environment(AutoRenameFirstPromptRequest {
                thread_id: result.thread.id.clone(),
                message: "Ajouter un systeme de themes".to_string(),
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

        assert_eq!(environment.name, "Add themes");
        assert_eq!(environment.git_branch.as_deref(), Some("add-themes"));
        assert!(environment.path.ends_with("/add-themes"));
        assert_eq!(thread.title, "Add themes");
        assert!(Path::new(&environment.path).exists());
        assert!(
            git::current_branch(Path::new(&environment.path))
                .expect("branch should resolve")
                .as_deref()
                == Some("add-themes")
        );
    }

    #[test]
    fn first_prompt_auto_rename_surfaces_naming_failures_without_mutating() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("rename-fail-repo"))
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");
        let original_environment = result.environment.clone();
        let fake_codex = harness.create_failing_fake_codex("naming auth failed", 42);

        let error = harness
            .service
            .maybe_auto_rename_first_prompt_environment(AutoRenameFirstPromptRequest {
                thread_id: result.thread.id.clone(),
                message: "Ajouter un systeme de themes".to_string(),
                codex_binary_path: Some(fake_codex.to_string_lossy().to_string()),
            })
            .expect_err("naming failure should surface");

        assert!(
            error.to_string().contains("naming auth failed"),
            "unexpected error: {error}"
        );

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        let environment = snapshot
            .projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .find(|environment| environment.id == original_environment.id)
            .expect("environment should remain");

        assert_eq!(environment.name, original_environment.name);
        assert_eq!(environment.git_branch, original_environment.git_branch);
        assert_eq!(environment.path, original_environment.path);
    }

    #[test]
    fn first_prompt_auto_rename_explains_empty_stderr_failures() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("rename-empty-stderr-repo"),
            )
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");
        let fake_codex = harness.create_failing_fake_codex("", 43);

        let error = harness
            .service
            .maybe_auto_rename_first_prompt_environment(AutoRenameFirstPromptRequest {
                thread_id: result.thread.id.clone(),
                message: "Diagnose empty naming stderr".to_string(),
                codex_binary_path: Some(fake_codex.to_string_lossy().to_string()),
            })
            .expect_err("naming failure should surface");

        let message = error.to_string();
        assert!(
            message.contains("Codex exited with"),
            "unexpected error: {error}"
        );
        assert!(message.contains("43"), "unexpected error: {error}");
    }

    #[test]
    fn first_prompt_rename_failure_event_uses_current_workspace_metadata() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("failure-event-repo"))
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");

        let event = harness
            .service
            .first_prompt_rename_failure_event(&result.thread.id, "naming failed".to_string())
            .expect("event should be built");

        assert_eq!(event.project_id, project.id);
        assert_eq!(event.environment_id, result.environment.id);
        assert_eq!(event.thread_id, result.thread.id);
        assert_eq!(event.environment_name, result.environment.name);
        assert_eq!(
            event.branch_name,
            result.environment.git_branch.expect("branch should exist")
        );
        assert_eq!(event.message, "naming failed");
    }

    #[test]
    fn first_prompt_rename_failure_event_falls_back_to_environment_name_without_branch() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("failure-event-no-branch-repo"),
            )
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");
        harness
            .open_connection()
            .execute(
                "UPDATE environments SET git_branch = NULL WHERE id = ?1",
                params![&result.environment.id],
            )
            .expect("environment branch should be cleared");

        let event = harness
            .service
            .first_prompt_rename_failure_event(&result.thread.id, "naming failed".to_string())
            .expect("event should be built");

        assert_eq!(event.environment_name, result.environment.name);
        assert_eq!(event.branch_name, result.environment.name);
    }

    #[test]
    fn snapshot_with_pull_requests_projects_worktree_pull_request_state() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("pr-sync-repo"))
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
            .create_managed_worktree(CreateManagedWorktreeRequest::for_project(&project.id))
            .expect("worktree should be created");

        let snapshot = harness
            .service
            .snapshot_with_pull_requests(
                Vec::new(),
                &HashMap::from([(
                    result.environment.id.clone(),
                    EnvironmentPullRequestSnapshot {
                        number: 42,
                        title: "Add PR sync".to_string(),
                        url: "https://github.com/acme/skein/pull/42".to_string(),
                        state: PullRequestState::Open,
                        checks: None,
                    },
                )]),
            )
            .expect("snapshot should resolve");
        let environment = snapshot
            .projects
            .into_iter()
            .flat_map(|project| project.environments.into_iter())
            .find(|environment| environment.id == result.environment.id)
            .expect("environment should exist");

        assert_eq!(
            environment.pull_request.as_ref().map(|value| value.number),
            Some(42)
        );
        assert_eq!(
            environment.pull_request.as_ref().map(|value| value.state),
            Some(PullRequestState::Open)
        );
    }

    #[test]
    fn snapshot_does_not_seed_chat_workspace_project() {
        let harness = WorkspaceHarness::new().expect("harness");

        let before_count: i64 = harness
            .open_connection()
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = ?1",
                params![CHAT_WORKSPACE_PROJECT_ID],
                |row| row.get(0),
            )
            .expect("chat workspace count should load");
        assert_eq!(before_count, 0);

        let snapshot = harness
            .service
            .snapshot(Vec::new())
            .expect("snapshot should load");

        assert_eq!(snapshot.chat.project_id, CHAT_WORKSPACE_PROJECT_ID);
        assert_eq!(
            snapshot.chat.root_path,
            harness
                .temp_root
                .join("chats")
                .to_string_lossy()
                .to_string()
        );

        let after_count: i64 = harness
            .open_connection()
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = ?1",
                params![CHAT_WORKSPACE_PROJECT_ID],
                |row| row.get(0),
            )
            .expect("chat workspace count should load");
        assert_eq!(after_count, 0);
    }

    #[test]
    fn project_order_is_persistent_and_new_projects_append_to_the_bottom() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo_one = harness
            .create_repo(&harness.temp_root.join("repos").join("first-project"))
            .expect("repo one");
        let repo_two = harness
            .create_repo(&harness.temp_root.join("repos").join("second-project"))
            .expect("repo two");
        let repo_three = harness
            .create_repo(&harness.temp_root.join("repos").join("third-project"))
            .expect("repo three");

        let project_one = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_one.path.to_string_lossy().to_string(),
                name: Some("First".to_string()),
            })
            .expect("project one should be added");
        let project_two = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_two.path.to_string_lossy().to_string(),
                name: Some("Second".to_string()),
            })
            .expect("project two should be added");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        assert_eq!(
            snapshot
                .projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec![project_one.id.as_str(), project_two.id.as_str()]
        );

        harness
            .service
            .reorder_projects(ReorderProjectsRequest {
                project_ids: vec![project_two.id.clone(), project_one.id.clone()],
            })
            .expect("projects should reorder");
        let project_three = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_three.path.to_string_lossy().to_string(),
                name: Some("Third".to_string()),
            })
            .expect("project three should be added");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        assert_eq!(
            snapshot
                .projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                project_two.id.as_str(),
                project_one.id.as_str(),
                project_three.id.as_str()
            ]
        );
    }

    #[test]
    fn project_order_does_not_change_when_project_timestamps_change() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo_one = harness
            .create_repo(&harness.temp_root.join("repos").join("timestamp-first"))
            .expect("repo one");
        let repo_two = harness
            .create_repo(&harness.temp_root.join("repos").join("timestamp-second"))
            .expect("repo two");

        let project_one = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_one.path.to_string_lossy().to_string(),
                name: Some("First".to_string()),
            })
            .expect("project one should be added");
        let project_two = harness
            .service
            .add_project(AddProjectRequest {
                path: repo_two.path.to_string_lossy().to_string(),
                name: Some("Second".to_string()),
            })
            .expect("project two should be added");

        harness
            .service
            .reorder_projects(ReorderProjectsRequest {
                project_ids: vec![project_two.id.clone(), project_one.id.clone()],
            })
            .expect("projects should reorder");

        harness
            .open_connection()
            .execute(
                "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), project_one.id],
            )
            .expect("project timestamp should update");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        assert_eq!(
            snapshot
                .projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec![project_two.id.as_str(), project_one.id.as_str()]
        );
    }

    #[test]
    fn project_sidebar_collapse_state_is_persistent() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("collapse-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        harness
            .service
            .set_project_sidebar_collapsed(SetProjectSidebarCollapsedRequest {
                project_id: project.id.clone(),
                collapsed: true,
            })
            .expect("collapse state should save");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        let project = snapshot
            .projects
            .into_iter()
            .find(|candidate| candidate.id == project.id)
            .expect("project should exist");
        assert!(project.sidebar_collapsed);
    }

    #[test]
    fn rename_project_rejects_blank_names() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("rename-blank-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        let error = harness
            .service
            .rename_project(RenameProjectRequest {
                project_id: project.id,
                name: "   ".to_string(),
            })
            .expect_err("blank project names should fail");

        assert!(error.to_string().contains("Project name cannot be empty."));
    }

    #[test]
    fn reorder_validates_complete_project_payloads() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("validate-reorder-repo"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        let duplicate_project_error = harness
            .service
            .reorder_projects(ReorderProjectsRequest {
                project_ids: vec![project.id.clone(), project.id.clone()],
            })
            .expect_err("duplicate projects should fail");
        assert!(duplicate_project_error.to_string().contains("duplicate"));

        let blank_collapse_error = harness
            .service
            .set_project_sidebar_collapsed(SetProjectSidebarCollapsedRequest {
                project_id: "   ".to_string(),
                collapsed: true,
            })
            .expect_err("blank project id should fail");
        assert!(blank_collapse_error
            .to_string()
            .contains("project id cannot be empty"));
    }

    #[test]
    fn snapshot_repairs_invalid_shortcut_settings_without_losing_other_values() {
        let harness = WorkspaceHarness::new().expect("harness");
        let mut settings = GlobalSettings {
            default_model: "gpt-5.4-mini".to_string(),
            ..GlobalSettings::default()
        };
        settings.shortcuts.toggle_terminal = Some("mod+j".to_string());
        settings.shortcuts.new_thread = Some("mod+j".to_string());

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    serde_json::to_string(&settings).expect("settings payload"),
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");

        assert_eq!(snapshot.settings.default_model, "gpt-5.4-mini");
        assert_eq!(snapshot.settings.shortcuts, ShortcutSettings::default());
    }

    #[test]
    fn snapshot_repairs_invalid_multi_agent_nudge_settings_without_losing_other_values() {
        let harness = WorkspaceHarness::new().expect("harness");
        let settings = GlobalSettings {
            default_model: "gpt-5.4-mini".to_string(),
            multi_agent_nudge_enabled: true,
            multi_agent_nudge_max_subagents: 0,
            ..GlobalSettings::default()
        };

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    serde_json::to_string(&settings).expect("settings payload"),
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        let stored_payload: String = harness
            .open_connection()
            .query_row(
                "SELECT payload_json FROM global_settings WHERE singleton_key = 'global'",
                [],
                |row| row.get(0),
            )
            .expect("stored settings payload");

        assert_eq!(snapshot.settings.default_model, "gpt-5.4-mini");
        assert!(snapshot.settings.multi_agent_nudge_enabled);
        assert_eq!(snapshot.settings.multi_agent_nudge_max_subagents, 4);
        assert!(stored_payload.contains("\"multiAgentNudgeMaxSubagents\":4"));
    }

    #[test]
    fn snapshot_projects_supported_open_targets_without_rewriting_stored_legacy_values() {
        let harness = WorkspaceHarness::new().expect("harness");
        let settings = GlobalSettings {
            default_model: "gpt-5.4-mini".to_string(),
            open_targets: vec![
                OpenTarget {
                    id: "custom-app".to_string(),
                    label: "Custom App".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Custom App".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor".to_string(),
                    label: "Cursor".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Malicious Cursor".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor-cli".to_string(),
                    label: "Cursor CLI".to_string(),
                    kind: OpenTargetKind::Command,
                    app_name: None,
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "file-manager".to_string(),
                    label: "Finder".to_string(),
                    kind: OpenTargetKind::FileManager,
                    app_name: None,
                    args: Vec::new(),
                },
            ],
            default_open_target_id: "custom-app".to_string(),
            ..GlobalSettings::default()
        };

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    serde_json::to_string(&settings).expect("settings payload"),
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let snapshot = harness.service.snapshot(Vec::new()).expect("snapshot");
        let stored_payload: String = harness
            .open_connection()
            .query_row(
                "SELECT payload_json FROM global_settings WHERE singleton_key = 'global'",
                [],
                |row| row.get(0),
            )
            .expect("stored settings payload");

        assert_eq!(snapshot.settings.default_model, "gpt-5.4-mini");
        assert!(snapshot
            .settings
            .open_targets
            .iter()
            .map(|target| target.id.as_str())
            .eq(["cursor", "file-manager"].into_iter()));
        assert_eq!(snapshot.settings.default_open_target_id, "file-manager");
        assert!(stored_payload.contains("\"custom-app\""));
        assert!(stored_payload.contains("\"cursor-cli\""));
        assert!(stored_payload.contains("\"--reuse-window\""));
    }

    #[test]
    fn update_settings_preserves_stored_legacy_open_targets_until_open_in_is_saved() {
        let harness = WorkspaceHarness::new().expect("harness");
        let settings = GlobalSettings {
            default_model: "gpt-5.4".to_string(),
            open_targets: vec![
                OpenTarget {
                    id: "custom-app".to_string(),
                    label: "Custom App".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Custom App".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor".to_string(),
                    label: "Cursor".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Cursor".to_string()),
                    args: Vec::new(),
                },
                OpenTarget {
                    id: "file-manager".to_string(),
                    label: "Finder".to_string(),
                    kind: OpenTargetKind::FileManager,
                    app_name: None,
                    args: Vec::new(),
                },
            ],
            default_open_target_id: "custom-app".to_string(),
            ..GlobalSettings::default()
        };

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    serde_json::to_string(&settings).expect("settings payload"),
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let updated = harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_model: Some("gpt-5.4-mini".to_string()),
                ..GlobalSettingsPatch::default()
            })
            .expect("settings update");
        let stored_payload: String = harness
            .open_connection()
            .query_row(
                "SELECT payload_json FROM global_settings WHERE singleton_key = 'global'",
                [],
                |row| row.get(0),
            )
            .expect("stored settings payload");

        assert_eq!(updated.default_model, "gpt-5.4-mini");
        assert!(updated
            .open_targets
            .iter()
            .map(|target| target.id.as_str())
            .eq(["cursor", "file-manager"].into_iter()));
        assert_eq!(updated.default_open_target_id, "file-manager");
        assert!(stored_payload.contains("\"custom-app\""));
        assert!(stored_payload.contains("\"--reuse-window\""));
    }

    #[test]
    fn update_settings_migrates_legacy_open_targets_only_when_open_in_payload_is_saved() {
        let harness = WorkspaceHarness::new().expect("harness");
        let settings = GlobalSettings {
            open_targets: vec![
                OpenTarget {
                    id: "custom-app".to_string(),
                    label: "Custom App".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Custom App".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor".to_string(),
                    label: "Cursor".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Cursor".to_string()),
                    args: Vec::new(),
                },
                OpenTarget {
                    id: "file-manager".to_string(),
                    label: "Finder".to_string(),
                    kind: OpenTargetKind::FileManager,
                    app_name: None,
                    args: Vec::new(),
                },
            ],
            default_open_target_id: "custom-app".to_string(),
            ..GlobalSettings::default()
        };

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    serde_json::to_string(&settings).expect("settings payload"),
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let updated = harness
            .service
            .update_settings(GlobalSettingsPatch {
                open_targets: Some(vec![
                    OpenTarget {
                        id: "zed".to_string(),
                        label: "Zed".to_string(),
                        kind: OpenTargetKind::App,
                        app_name: Some("Zed".to_string()),
                        args: Vec::new(),
                    },
                    OpenTarget {
                        id: "file-manager".to_string(),
                        label: "Finder".to_string(),
                        kind: OpenTargetKind::FileManager,
                        app_name: None,
                        args: Vec::new(),
                    },
                ]),
                default_open_target_id: Some("zed".to_string()),
                ..GlobalSettingsPatch::default()
            })
            .expect("open in migration save");
        let stored_payload: String = harness
            .open_connection()
            .query_row(
                "SELECT payload_json FROM global_settings WHERE singleton_key = 'global'",
                [],
                |row| row.get(0),
            )
            .expect("stored settings payload");

        assert_eq!(
            updated
                .open_targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            vec!["zed", "file-manager"]
        );
        assert_eq!(updated.default_open_target_id, "zed");
        assert!(!stored_payload.contains("\"custom-app\""));
        assert!(!stored_payload.contains("\"--reuse-window\""));
    }

    #[test]
    fn update_settings_can_change_the_default_open_target_without_migrating_stored_targets() {
        let harness = WorkspaceHarness::new().expect("harness");
        let settings = GlobalSettings {
            open_targets: vec![
                OpenTarget {
                    id: "custom-app".to_string(),
                    label: "Custom App".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Custom App".to_string()),
                    args: vec!["--reuse-window".to_string()],
                },
                OpenTarget {
                    id: "cursor".to_string(),
                    label: "Cursor".to_string(),
                    kind: OpenTargetKind::App,
                    app_name: Some("Cursor".to_string()),
                    args: Vec::new(),
                },
                OpenTarget {
                    id: "file-manager".to_string(),
                    label: "Finder".to_string(),
                    kind: OpenTargetKind::FileManager,
                    app_name: None,
                    args: Vec::new(),
                },
            ],
            default_open_target_id: "custom-app".to_string(),
            ..GlobalSettings::default()
        };

        harness
            .open_connection()
            .execute(
                "
                INSERT INTO global_settings (singleton_key, payload_json, updated_at)
                VALUES ('global', ?1, ?2)
                ON CONFLICT(singleton_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    serde_json::to_string(&settings).expect("settings payload"),
                    Utc::now(),
                ],
            )
            .expect("settings should be persisted");

        let updated = harness
            .service
            .update_settings(GlobalSettingsPatch {
                default_open_target_id: Some("cursor".to_string()),
                ..GlobalSettingsPatch::default()
            })
            .expect("default open target update");
        let stored_payload: String = harness
            .open_connection()
            .query_row(
                "SELECT payload_json FROM global_settings WHERE singleton_key = 'global'",
                [],
                |row| row.get(0),
            )
            .expect("stored settings payload");

        assert_eq!(updated.default_open_target_id, "cursor");
        assert!(stored_payload.contains("\"custom-app\""));
        assert!(stored_payload.contains("\"defaultOpenTargetId\":\"cursor\""));
    }

    #[test]
    fn thread_composer_drafts_round_trip_and_clear() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("draft-roundtrip-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let environment_id = project
            .environments
            .first()
            .expect("environment should exist")
            .id
            .clone();
        let thread = harness
            .service
            .create_thread(CreateThreadRequest {
                environment_id,
                title: Some("Draft thread".to_string()),
                overrides: None,
            })
            .expect("thread should be created");
        let thread_id = thread.id.clone();
        let draft = ConversationComposerDraft {
            text: "Keep this thread-scoped draft".to_string(),
            images: vec![ConversationImageAttachment::LocalImage {
                path: "/tmp/thread-draft.png".to_string(),
            }],
            mention_bindings: vec![ComposerDraftMentionBinding {
                mention: "github".to_string(),
                kind: ComposerMentionBindingKind::App,
                path: "app://github".to_string(),
                start: 5,
                end: 12,
            }],
            is_refining_plan: true,
        };

        harness
            .service
            .persist_thread_composer_draft(&thread_id, Some(&draft))
            .expect("draft should persist");
        assert_eq!(
            harness
                .service
                .thread_composer_draft(&thread_id)
                .expect("draft should load"),
            Some(draft.clone())
        );

        harness
            .service
            .clear_thread_composer_draft(&thread_id)
            .expect("draft should clear");
        assert_eq!(
            harness
                .service
                .thread_composer_draft(&thread_id)
                .expect("cleared draft should load"),
            None
        );
    }

    #[test]
    fn draft_thread_states_round_trip_for_project_and_chat_and_clear() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("draft-thread-state-repo"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");

        let project_target = DraftThreadTarget::Project {
            project_id: project.id.clone(),
        };
        let project_state = saved_draft_thread_state(Some(DraftProjectSelection::Local));
        harness
            .service
            .persist_draft_thread_state(&project_target, Some(&project_state))
            .expect("project draft should persist");
        assert_eq!(
            harness
                .service
                .draft_thread_state(&project_target)
                .expect("project draft should load"),
            Some(project_state)
        );

        let chat_target = DraftThreadTarget::Chat;
        let chat_state = saved_draft_thread_state(None);
        harness
            .service
            .persist_draft_thread_state(&chat_target, Some(&chat_state))
            .expect("chat draft should persist");
        assert_eq!(
            harness
                .service
                .draft_thread_state(&chat_target)
                .expect("chat draft should load"),
            Some(chat_state)
        );

        harness
            .service
            .persist_draft_thread_state(&project_target, None)
            .expect("project draft should clear");
        harness
            .service
            .persist_draft_thread_state(&chat_target, None)
            .expect("chat draft should clear");

        assert_eq!(
            harness
                .service
                .draft_thread_state(&project_target)
                .expect("cleared project draft should load"),
            None
        );
        assert_eq!(
            harness
                .service
                .draft_thread_state(&chat_target)
                .expect("cleared chat draft should load"),
            None
        );
    }

    #[test]
    fn remove_project_clears_persisted_project_draft_thread_state() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(&harness.temp_root.join("repos").join("draft-cleanup-repo"))
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let project_target = DraftThreadTarget::Project {
            project_id: project.id.clone(),
        };
        let chat_target = DraftThreadTarget::Chat;

        harness
            .service
            .persist_draft_thread_state(
                &project_target,
                Some(&saved_draft_thread_state(Some(
                    DraftProjectSelection::Local,
                ))),
            )
            .expect("project draft should persist");
        harness
            .service
            .persist_draft_thread_state(&chat_target, Some(&saved_draft_thread_state(None)))
            .expect("chat draft should persist");

        harness
            .service
            .remove_project(&project.id)
            .expect("project should be removed");

        let connection = harness.open_connection();
        let project_rows: i64 = connection
            .query_row(
                "
                SELECT COUNT(*)
                FROM draft_thread_states
                WHERE scope_kind = 'project' AND scope_id = ?1
                ",
                params![project.id],
                |row| row.get(0),
            )
            .expect("project draft count should read");
        let chat_rows: i64 = connection
            .query_row(
                "
                SELECT COUNT(*)
                FROM draft_thread_states
                WHERE scope_kind = 'chat' AND scope_id = 'chat'
                ",
                [],
                |row| row.get(0),
            )
            .expect("chat draft count should read");

        assert_eq!(project_rows, 0);
        assert_eq!(chat_rows, 1);
    }

    #[test]
    fn create_managed_worktree_persists_requested_thread_overrides() {
        let harness = WorkspaceHarness::new().expect("harness");
        let repo = harness
            .create_repo(
                &harness
                    .temp_root
                    .join("repos")
                    .join("worktree-overrides-repo"),
            )
            .expect("repo");
        let project = harness
            .service
            .add_project(AddProjectRequest {
                path: repo.path.to_string_lossy().to_string(),
                name: None,
            })
            .expect("project should be added");
        let overrides = ThreadOverrides {
            model: Some("gpt-5.4-mini".to_string()),
            service_tier: Some(ServiceTier::Fast),
            service_tier_overridden: true,
            ..ThreadOverrides::default()
        };

        let result = harness
            .service
            .create_managed_worktree(CreateManagedWorktreeRequest {
                project_id: project.id.clone(),
                base_branch: None,
                name: Some("feature-overrides".to_string()),
                overrides: Some(overrides.clone()),
            })
            .expect("worktree should be created");

        assert_eq!(result.thread.overrides.model, overrides.model);
        assert_eq!(result.thread.overrides.service_tier, overrides.service_tier);
        assert_eq!(
            result.thread.overrides.service_tier_overridden,
            overrides.service_tier_overridden
        );
    }

    fn saved_draft_thread_state(
        project_selection: Option<DraftProjectSelection>,
    ) -> SavedDraftThreadState {
        SavedDraftThreadState {
            composer_draft: ConversationComposerDraft {
                text: "Persist me".to_string(),
                images: vec![ConversationImageAttachment::LocalImage {
                    path: "/tmp/draft-thread-state.png".to_string(),
                }],
                mention_bindings: vec![ComposerDraftMentionBinding {
                    mention: "skill".to_string(),
                    kind: ComposerMentionBindingKind::Skill,
                    path: "/tmp/skill.md".to_string(),
                    start: 0,
                    end: 5,
                }],
                is_refining_plan: true,
            },
            composer: default_composer_settings(),
            project_selection,
        }
    }

    fn default_composer_settings() -> ConversationComposerSettings {
        let settings = GlobalSettings::default();
        ConversationComposerSettings {
            model: settings.default_model,
            reasoning_effort: settings.default_reasoning_effort,
            collaboration_mode: settings.default_collaboration_mode,
            approval_policy: settings.default_approval_policy,
            service_tier: settings.default_service_tier,
        }
    }

    struct WorkspaceHarness {
        service: WorkspaceService,
        managed_root: PathBuf,
        temp_root: PathBuf,
    }

    impl WorkspaceHarness {
        fn new() -> Result<Self, Box<dyn std::error::Error>> {
            let temp_root =
                std::env::temp_dir().join(format!("skein-workspace-test-{}", Uuid::now_v7()));
            fs::create_dir_all(&temp_root)?;
            let database = crate::infrastructure::database::AppDatabase::for_test(
                temp_root.join("skein.sqlite3"),
            )?;
            let managed_root = temp_root.join("managed-worktrees");
            fs::create_dir_all(&managed_root)?;
            let chats_root = temp_root.join("chats");
            fs::create_dir_all(&chats_root)?;
            let service = WorkspaceService::new(
                database,
                managed_root.clone(),
                chats_root,
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
            let expected_model = crate::services::prompt_naming::FIRST_PROMPT_NAMING_MODEL;
            let script_path = self
                .temp_root
                .join(format!("fake-codex-{}.sh", Uuid::now_v7()));
            fs::write(
                &script_path,
                format!(
                    "#!/bin/sh\nset -eu\noutput=\"\"\nmodel=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--output-last-message\" ]; then\n    output=\"$2\"\n    shift 2\n    continue\n  fi\n  if [ \"$1\" = \"--model\" ]; then\n    model=\"$2\"\n    shift 2\n    continue\n  fi\n  shift\ndone\nif [ \"$model\" != \"{expected_model}\" ]; then\n  printf 'expected naming model {expected_model}, got %s\\n' \"$model\" >&2\n  exit 88\nfi\ncat >/dev/null\ncat <<'EOF' > \"$output\"\n{json}\nEOF\n"
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

        fn create_failing_fake_codex(&self, message: &str, exit_code: i32) -> PathBuf {
            let script_path = self
                .temp_root
                .join(format!("failing-fake-codex-{}.sh", Uuid::now_v7()));
            fs::write(
                &script_path,
                format!("#!/bin/sh\nprintf '%s\\n' '{message}' >&2\nexit {exit_code}\n"),
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
            git::run_git(&path, ["config", "user.email", "skein@example.com"])?;
            git::run_git(&path, ["config", "user.name", "Skein Tests"])?;
            fs::write(path.join("README.md"), "# Skein\n")?;
            git::run_git(&path, ["add", "README.md"])?;
            git::run_git(&path, ["commit", "-m", "Initial commit"])?;
            Ok(Self { path })
        }
    }
}
