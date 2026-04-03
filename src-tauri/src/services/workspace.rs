use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use uuid::Uuid;

use crate::domain::conversation::ConversationComposerSettings;
use crate::domain::settings::{GlobalSettings, GlobalSettingsPatch};
use crate::domain::workspace::{
    EnvironmentKind, EnvironmentRecord, ProjectRecord, RuntimeState, RuntimeStatusSnapshot,
    ThreadOverrides, ThreadRecord, ThreadStatus, WorkspaceSnapshot,
};
use crate::error::{AppError, AppResult};
use crate::infrastructure::database::AppDatabase;
use crate::services::git;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectRequest {
    pub path: String,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeRequest {
    pub project_id: String,
    pub name: String,
    pub branch_name: Option<String>,
    pub base_branch: Option<String>,
    pub permanent: bool,
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

impl WorkspaceService {
    pub fn new(database: AppDatabase) -> Self {
        Self { database }
    }

    pub fn database_path(&self) -> PathBuf {
        self.database.path().to_path_buf()
    }

    pub fn snapshot(&self, runtime_statuses: Vec<RuntimeStatusSnapshot>) -> AppResult<WorkspaceSnapshot> {
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
            transaction.execute(
                "
                INSERT INTO projects (id, name, root_path, created_at, updated_at, archived_at)
                VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                ",
                params![project_id, project_name, root_path_string, now, now],
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

    pub fn project_environment_ids(&self, project_id: &str) -> AppResult<Vec<String>> {
        let connection = self.database.open()?;
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
        let affected = connection.execute(
            "DELETE FROM projects WHERE id = ?1 AND archived_at IS NULL",
            params![project_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Project not found.".to_string()));
        }

        Ok(())
    }

    pub fn create_worktree(&self, input: CreateWorktreeRequest) -> AppResult<EnvironmentRecord> {
        let project = self.project_metadata(&input.project_id)?;
        let branch_name = git::ensure_branch_name(
            input
                .branch_name
                .as_deref()
                .unwrap_or(input.name.as_str()),
        )?;
        let base_branch = match input.base_branch {
            Some(base_branch) => base_branch,
            None => git::current_branch(&project.root_path)?.unwrap_or_else(|| "main".to_string()),
        };
        let destination = git::managed_worktree_path(&project.root_path, &branch_name);
        git::create_worktree(&project.root_path, &destination, &branch_name, &base_branch)?;

        let now = Utc::now();
        let environment_id = Uuid::now_v7().to_string();
        let kind = if input.permanent {
            EnvironmentKind::PermanentWorktree
        } else {
            EnvironmentKind::ManagedWorktree
        };

        let connection = self.database.open()?;
        connection.execute(
            "
            INSERT INTO environments (
              id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
            ",
            params![
                environment_id,
                input.project_id,
                input.name.trim(),
                environment_kind_value(kind),
                destination.to_string_lossy().to_string(),
                branch_name,
                base_branch,
                now,
                now,
            ],
        )?;

        self.environment_by_id(&environment_id, RuntimeStatusSnapshot {
            environment_id: environment_id.clone(),
            state: RuntimeState::Stopped,
            pid: None,
            binary_path: None,
            started_at: None,
            last_exit_code: None,
        })
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

    pub fn archive_thread(&self, input: ArchiveThreadRequest) -> AppResult<ThreadRecord> {
        let now = Utc::now();
        let connection = self.database.open()?;
        let affected = connection.execute(
            "
            UPDATE threads
            SET status = ?1, archived_at = ?2, updated_at = ?3
            WHERE id = ?4
            ",
            params![thread_status_value(ThreadStatus::Archived), now, now, input.thread_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound("Thread not found.".to_string()));
        }

        self.thread_by_id(&input.thread_id)
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

    fn project_metadata(&self, project_id: &str) -> AppResult<ProjectMetadata> {
        let connection = self.database.open()?;
        connection
            .query_row(
                "SELECT root_path FROM projects WHERE id = ?1 AND archived_at IS NULL",
                params![project_id],
                |row| Ok(ProjectMetadata {
                    root_path: PathBuf::from(row.get::<_, String>(0)?),
                }),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Project not found.".to_string()))
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
            SELECT id, name, root_path, created_at, updated_at
            FROM projects
            WHERE archived_at IS NULL
            ",
        )?;
        let project_rows = project_statement.query_map([], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
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
                runtime: runtime_map
                    .get(&environment_id)
                    .cloned()
                    .unwrap_or(RuntimeStatusSnapshot {
                        environment_id,
                        state: RuntimeState::Stopped,
                        pid: None,
                        binary_path: None,
                        started_at: None,
                        last_exit_code: None,
                    }),
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
            let overrides = serde_json::from_str::<ThreadOverrides>(&overrides_json).map_err(|error| {
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
    root_path: PathBuf,
}

fn infer_project_name(root_path: &std::path::Path) -> String {
    root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project")
        .to_string()
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
