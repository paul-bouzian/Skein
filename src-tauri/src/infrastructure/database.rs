use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::app_identity::{
    AppStoragePaths, APP_DATABASE_FILE_NAME, LEGACY_APP_DATABASE_FILE_NAME,
};
use crate::domain::conversation::{
    ComposerDraftMentionBinding, ConversationComposerDraft, ConversationImageAttachment,
};
use crate::error::{AppError, AppResult};

const CURRENT_SCHEMA_VERSION: i32 = 5;

#[derive(Debug, Clone)]
pub struct AppDatabase {
    db_path: PathBuf,
}

impl AppDatabase {
    pub fn new(storage_paths: &AppStoragePaths) -> AppResult<Self> {
        let db_dir = storage_paths.app_data_dir.join("state");
        std::fs::create_dir_all(&db_dir)?;
        migrate_legacy_database_file(&db_dir)?;

        let db_path = db_dir.join(APP_DATABASE_FILE_NAME);
        let database = Self { db_path };
        database.migrate()?;
        database.normalize_workspace_paths(
            &storage_paths.legacy_app_home_dir,
            &storage_paths.app_home_dir,
        )?;
        Ok(database)
    }

    pub fn path(&self) -> &Path {
        &self.db_path
    }

    pub fn open(&self) -> AppResult<Connection> {
        let connection = Connection::open(&self.db_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        Ok(connection)
    }

    #[cfg(test)]
    pub fn for_test(db_path: PathBuf) -> AppResult<Self> {
        let database = Self { db_path };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&self) -> AppResult<()> {
        let connection = self.open()?;
        let version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        match version {
            0 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    CREATE TABLE projects (
                      id TEXT PRIMARY KEY,
                      name TEXT NOT NULL,
                      root_path TEXT NOT NULL UNIQUE,
                      managed_worktree_dir TEXT,
                      settings_json TEXT NOT NULL DEFAULT '{}',
                      sort_order INTEGER NOT NULL DEFAULT 0,
                      sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      archived_at TEXT
                    );
                    CREATE TABLE environments (
                      id TEXT PRIMARY KEY,
                      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                      name TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      path TEXT NOT NULL UNIQUE,
                      git_branch TEXT,
                      base_branch TEXT,
                      is_default INTEGER NOT NULL DEFAULT 0,
                      sort_order INTEGER NOT NULL DEFAULT 0,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL
                    );
                    CREATE TABLE threads (
                      id TEXT PRIMARY KEY,
                      environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
                      title TEXT NOT NULL,
                      status TEXT NOT NULL,
                      codex_thread_id TEXT,
                      overrides_json TEXT NOT NULL,
                      composer_draft_json TEXT,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      archived_at TEXT
                    );
                    CREATE TABLE global_settings (
                      singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL
                    );
                    CREATE INDEX idx_environments_project_id ON environments(project_id);
                    CREATE INDEX idx_threads_environment_id ON threads(environment_id);
                    CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                    ON projects(managed_worktree_dir)
                    WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                    PRAGMA user_version = 5;
                    COMMIT;
                    ",
                )?;
            }
            1 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
                    ALTER TABLE projects
                    ADD COLUMN managed_worktree_dir TEXT;
                    ALTER TABLE projects
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects
                    ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE environments
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                    ON projects(managed_worktree_dir)
                    WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
	                    WITH ranked_projects AS (
	                      SELECT
	                        id,
	                        ROW_NUMBER() OVER (ORDER BY rowid ASC) - 1 AS next_sort_order
	                      FROM projects
	                      WHERE archived_at IS NULL
	                    )
                    UPDATE projects
                    SET sort_order = (
                      SELECT next_sort_order
                      FROM ranked_projects
                      WHERE ranked_projects.id = projects.id
                    )
                    WHERE id IN (SELECT id FROM ranked_projects);
                    WITH ranked_environments AS (
                      SELECT
                        id,
                        ROW_NUMBER() OVER (
                          PARTITION BY project_id
                          ORDER BY is_default DESC, created_at ASC, id ASC
                        ) - 1 AS next_sort_order
                      FROM environments
                    )
                    UPDATE environments
                    SET sort_order = (
                      SELECT next_sort_order
                      FROM ranked_environments
                      WHERE ranked_environments.id = environments.id
                    );
                    PRAGMA user_version = 5;
                    COMMIT;
                    ",
                )?;
            }
            2 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN managed_worktree_dir TEXT;
                    ALTER TABLE projects
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects
                    ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE environments
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                    ON projects(managed_worktree_dir)
                    WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
	                    WITH ranked_projects AS (
	                      SELECT
	                        id,
	                        ROW_NUMBER() OVER (ORDER BY rowid ASC) - 1 AS next_sort_order
	                      FROM projects
	                      WHERE archived_at IS NULL
	                    )
                    UPDATE projects
                    SET sort_order = (
                      SELECT next_sort_order
                      FROM ranked_projects
                      WHERE ranked_projects.id = projects.id
                    )
                    WHERE id IN (SELECT id FROM ranked_projects);
                    WITH ranked_environments AS (
                      SELECT
                        id,
                        ROW_NUMBER() OVER (
                          PARTITION BY project_id
                          ORDER BY is_default DESC, created_at ASC, id ASC
                        ) - 1 AS next_sort_order
                      FROM environments
                    )
                    UPDATE environments
                    SET sort_order = (
                      SELECT next_sort_order
                      FROM ranked_environments
                      WHERE ranked_environments.id = environments.id
                    );
                    PRAGMA user_version = 5;
                    COMMIT;
                    ",
                )?;
            }
            3 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects
                    ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE environments
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
	                    WITH ranked_projects AS (
	                      SELECT
	                        id,
	                        ROW_NUMBER() OVER (ORDER BY rowid ASC) - 1 AS next_sort_order
	                      FROM projects
	                      WHERE archived_at IS NULL
	                    )
                    UPDATE projects
                    SET sort_order = (
                      SELECT next_sort_order
                      FROM ranked_projects
                      WHERE ranked_projects.id = projects.id
                    )
                    WHERE id IN (SELECT id FROM ranked_projects);
                    WITH ranked_environments AS (
                      SELECT
                        id,
                        ROW_NUMBER() OVER (
                          PARTITION BY project_id
                          ORDER BY is_default DESC, created_at ASC, id ASC
                        ) - 1 AS next_sort_order
                      FROM environments
                    )
                    UPDATE environments
                    SET sort_order = (
                      SELECT next_sort_order
                      FROM ranked_environments
                      WHERE ranked_environments.id = environments.id
                    );
                    PRAGMA user_version = 5;
                    COMMIT;
                    ",
                )?;
            }
            4 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    PRAGMA user_version = 5;
                    COMMIT;
                    ",
                )?;
            }
            CURRENT_SCHEMA_VERSION => {}
            other => {
                return Err(AppError::Runtime(format!(
                    "Unsupported database schema version {other}.",
                )));
            }
        }

        Ok(())
    }

    fn normalize_workspace_paths(
        &self,
        legacy_app_home_dir: &Path,
        app_home_dir: &Path,
    ) -> AppResult<()> {
        if legacy_app_home_dir == app_home_dir {
            return Ok(());
        }

        let legacy = legacy_app_home_dir.to_string_lossy().to_string();
        let current = app_home_dir.to_string_lossy().to_string();
        let connection = self.open()?;
        connection.execute(
            "UPDATE projects SET root_path = REPLACE(root_path, ?1, ?2) WHERE INSTR(root_path, ?1) > 0",
            [&legacy, &current],
        )?;
        connection.execute(
            "UPDATE environments SET path = REPLACE(path, ?1, ?2) WHERE INSTR(path, ?1) > 0",
            [&legacy, &current],
        )?;
        let thread_drafts = {
            let mut statement = connection.prepare(
                "
                SELECT id, composer_draft_json
                FROM threads
                WHERE composer_draft_json IS NOT NULL
                  AND INSTR(composer_draft_json, ?1) > 0
                ",
            )?;
            let drafts = statement
                .query_map([&legacy], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drafts
        };

        for (thread_id, draft_json) in thread_drafts {
            let draft = serde_json::from_str::<ConversationComposerDraft>(&draft_json)
                .map_err(|error| {
                    AppError::Runtime(format!(
                        "Failed to deserialize persisted composer draft for thread {thread_id}: {error}",
                    ))
                })?;
            let normalized_draft = normalize_composer_draft_paths(draft, &legacy, &current);
            connection.execute(
                "
                UPDATE threads
                SET composer_draft_json = ?1
                WHERE id = ?2
                ",
                rusqlite::params![
                    serde_json::to_string(&normalized_draft)
                        .map_err(|error| AppError::Runtime(error.to_string()))?,
                    thread_id,
                ],
            )?;
        }
        Ok(())
    }
}

fn normalize_composer_draft_paths(
    draft: ConversationComposerDraft,
    legacy_home: &str,
    current_home: &str,
) -> ConversationComposerDraft {
    let ConversationComposerDraft {
        text,
        images,
        mention_bindings,
        is_refining_plan,
    } = draft;

    ConversationComposerDraft {
        text,
        images: images
            .into_iter()
            .map(|attachment| match attachment {
                ConversationImageAttachment::Image { .. } => attachment,
                ConversationImageAttachment::LocalImage { path } => {
                    ConversationImageAttachment::LocalImage {
                        path: rewrite_legacy_home_prefix(&path, legacy_home, current_home),
                    }
                }
            })
            .collect(),
        mention_bindings: mention_bindings
            .into_iter()
            .map(|binding| ComposerDraftMentionBinding {
                path: rewrite_legacy_home_prefix(&binding.path, legacy_home, current_home),
                ..binding
            })
            .collect(),
        is_refining_plan,
    }
}

fn rewrite_legacy_home_prefix(path: &str, legacy_home: &str, current_home: &str) -> String {
    match path.strip_prefix(legacy_home) {
        Some(suffix) => format!("{current_home}{suffix}"),
        None => path.to_string(),
    }
}

fn migrate_legacy_database_file(db_dir: &Path) -> AppResult<()> {
    let legacy_db_path = db_dir.join(LEGACY_APP_DATABASE_FILE_NAME);
    let db_path = db_dir.join(APP_DATABASE_FILE_NAME);
    if !db_path.exists() && legacy_db_path.exists() {
        std::fs::rename(legacy_db_path, db_path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate_legacy_database_file, AppDatabase};
    use crate::domain::conversation::{
        ComposerDraftMentionBinding, ComposerMentionBindingKind, ConversationComposerDraft,
        ConversationImageAttachment,
    };
    use rusqlite::Connection;
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn migrate_v1_projects_adds_workspace_order_columns() {
        let root = std::env::temp_dir().join(format!("loom-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("loom.sqlite3");
        let connection = Connection::open(&db_path).expect("db should open");
        connection
            .execute_batch(
                "
                BEGIN;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  root_path TEXT NOT NULL UNIQUE,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE environments (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  path TEXT NOT NULL UNIQUE,
                  git_branch TEXT,
                  base_branch TEXT,
                  is_default INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE threads (
                  id TEXT PRIMARY KEY,
                  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
                  title TEXT NOT NULL,
                  status TEXT NOT NULL,
                  codex_thread_id TEXT,
                  overrides_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE global_settings (
                  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 1;
                COMMIT;
                ",
            )
            .expect("v1 schema should be created");
        drop(connection);

        let database = AppDatabase::for_test(db_path.clone()).expect("migration should succeed");
        let connection = database.open().expect("db should reopen");
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let default_settings: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('projects') WHERE name = 'settings_json'",
                [],
                |row| row.get(0),
            )
            .expect("settings_json column should exist");
        let managed_worktree_dir_default: Option<String> = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('projects') WHERE name = 'managed_worktree_dir'",
                [],
                |row| row.get(0),
            )
            .expect("managed_worktree_dir column should exist");
        let managed_worktree_dir_index: String = connection
            .query_row(
                "
                SELECT name
                FROM sqlite_master
                WHERE type = 'index' AND name = 'idx_projects_managed_worktree_dir_active'
                ",
                [],
                |row| row.get(0),
            )
            .expect("managed_worktree_dir index should exist");

        let project_sort_order_default: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('projects') WHERE name = 'sort_order'",
                [],
                |row| row.get(0),
            )
            .expect("project sort_order column should exist");
        let project_sidebar_collapsed_default: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('projects') WHERE name = 'sidebar_collapsed'",
                [],
                |row| row.get(0),
            )
            .expect("project sidebar_collapsed column should exist");
        let environment_sort_order_default: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('environments') WHERE name = 'sort_order'",
                [],
                |row| row.get(0),
            )
            .expect("environment sort_order column should exist");

        assert_eq!(version, 5);
        assert_eq!(default_settings, "'{}'");
        assert_eq!(managed_worktree_dir_default, None);
        assert_eq!(project_sort_order_default, "0");
        assert_eq!(project_sidebar_collapsed_default, "0");
        assert_eq!(environment_sort_order_default, "0");
        assert_eq!(
            managed_worktree_dir_index,
            "idx_projects_managed_worktree_dir_active"
        );

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_v2_projects_adds_workspace_order_columns() {
        let root = std::env::temp_dir().join(format!("loom-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("loom.sqlite3");
        let connection = Connection::open(&db_path).expect("db should open");
        connection
            .execute_batch(
                "
                BEGIN;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  root_path TEXT NOT NULL UNIQUE,
                  settings_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE environments (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  path TEXT NOT NULL UNIQUE,
                  git_branch TEXT,
                  base_branch TEXT,
                  is_default INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE threads (
                  id TEXT PRIMARY KEY,
                  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
                  title TEXT NOT NULL,
                  status TEXT NOT NULL,
                  codex_thread_id TEXT,
                  overrides_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE global_settings (
                  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX idx_environments_project_id ON environments(project_id);
                CREATE INDEX idx_threads_environment_id ON threads(environment_id);
                PRAGMA user_version = 2;
                COMMIT;
                ",
            )
            .expect("v2 schema should be created");
        drop(connection);

        let database = AppDatabase::for_test(db_path.clone()).expect("migration should succeed");
        let connection = database.open().expect("db should reopen");
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let managed_worktree_dir_index: String = connection
            .query_row(
                "
                SELECT name
                FROM sqlite_master
                WHERE type = 'index' AND name = 'idx_projects_managed_worktree_dir_active'
                ",
                [],
                |row| row.get(0),
            )
            .expect("managed_worktree_dir index should exist");

        let project_sort_order_default: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('projects') WHERE name = 'sort_order'",
                [],
                |row| row.get(0),
            )
            .expect("project sort_order column should exist");
        let environment_sort_order_default: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('environments') WHERE name = 'sort_order'",
                [],
                |row| row.get(0),
            )
            .expect("environment sort_order column should exist");

        assert_eq!(version, 5);
        assert_eq!(project_sort_order_default, "0");
        assert_eq!(environment_sort_order_default, "0");
        assert_eq!(
            managed_worktree_dir_index,
            "idx_projects_managed_worktree_dir_active"
        );

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_v3_preserves_legacy_project_order_when_timestamps_differ() {
        let root = std::env::temp_dir().join(format!("loom-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("loom.sqlite3");
        let connection = Connection::open(&db_path).expect("db should open");
        connection
            .execute_batch(
                "
                BEGIN;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  root_path TEXT NOT NULL UNIQUE,
                  managed_worktree_dir TEXT,
                  settings_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE environments (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  path TEXT NOT NULL UNIQUE,
                  git_branch TEXT,
                  base_branch TEXT,
                  is_default INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE threads (
                  id TEXT PRIMARY KEY,
                  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
                  title TEXT NOT NULL,
                  status TEXT NOT NULL,
                  codex_thread_id TEXT,
                  overrides_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE global_settings (
                  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX idx_environments_project_id ON environments(project_id);
                CREATE INDEX idx_threads_environment_id ON threads(environment_id);
                CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                ON projects(managed_worktree_dir)
                WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                INSERT INTO projects (
                  id, name, root_path, managed_worktree_dir, settings_json, created_at, updated_at, archived_at
                ) VALUES
                  ('project-first', 'First', '/tmp/first', 'first', '{}', '2026-04-01T08:00:00Z', '2026-04-03T08:00:00Z', NULL),
                  ('project-second', 'Second', '/tmp/second', 'second', '{}', '2026-04-02T08:00:00Z', '2026-04-01T08:00:00Z', NULL);
                INSERT INTO environments (
                  id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
                ) VALUES
                  ('env-worktree-late', 'project-second', 'Late', 'managedWorktree', '/tmp/second-late', 'late', 'main', 0, '2026-04-02T10:00:00Z', '2026-04-02T10:00:00Z'),
                  ('env-local', 'project-second', 'Local', 'local', '/tmp/second', 'main', 'main', 1, '2026-04-02T08:00:00Z', '2026-04-02T08:00:00Z'),
                  ('env-worktree-early', 'project-second', 'Early', 'managedWorktree', '/tmp/second-early', 'early', 'main', 0, '2026-04-02T09:00:00Z', '2026-04-02T09:00:00Z');
                PRAGMA user_version = 3;
                COMMIT;
                ",
            )
            .expect("v3 schema should be created");
        drop(connection);

        let database = AppDatabase::for_test(db_path.clone()).expect("migration should succeed");
        let connection = database.open().expect("db should reopen");
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let project_order = connection
            .prepare("SELECT id FROM projects ORDER BY sort_order ASC")
            .expect("project order query should prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("project order query should run")
            .collect::<Result<Vec<_>, _>>()
            .expect("project order should collect");
        let environment_order = connection
            .prepare(
                "
                SELECT id
                FROM environments
                WHERE project_id = 'project-second'
                ORDER BY sort_order ASC
                ",
            )
            .expect("environment order query should prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("environment order query should run")
            .collect::<Result<Vec<_>, _>>()
            .expect("environment order should collect");

        assert_eq!(version, 5);
        assert_eq!(project_order, vec!["project-first", "project-second"]);
        assert_eq!(
            environment_order,
            vec!["env-local", "env-worktree-early", "env-worktree-late"]
        );

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_v4_adds_thread_composer_draft_storage() {
        let root = std::env::temp_dir().join(format!("loom-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("loom.sqlite3");
        let connection = Connection::open(&db_path).expect("db should open");
        connection
            .execute_batch(
                "
                BEGIN;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  root_path TEXT NOT NULL UNIQUE,
                  managed_worktree_dir TEXT,
                  settings_json TEXT NOT NULL DEFAULT '{}',
                  sort_order INTEGER NOT NULL DEFAULT 0,
                  sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE environments (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  path TEXT NOT NULL UNIQUE,
                  git_branch TEXT,
                  base_branch TEXT,
                  is_default INTEGER NOT NULL DEFAULT 0,
                  sort_order INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE threads (
                  id TEXT PRIMARY KEY,
                  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
                  title TEXT NOT NULL,
                  status TEXT NOT NULL,
                  codex_thread_id TEXT,
                  overrides_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE global_settings (
                  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX idx_environments_project_id ON environments(project_id);
                CREATE INDEX idx_threads_environment_id ON threads(environment_id);
                CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                ON projects(managed_worktree_dir)
                WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                PRAGMA user_version = 4;
                COMMIT;
                ",
            )
            .expect("v4 schema should be created");
        drop(connection);

        let database = AppDatabase::for_test(db_path.clone()).expect("migration should succeed");
        let connection = database.open().expect("db should reopen");
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let composer_draft_default: Option<String> = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('threads') WHERE name = 'composer_draft_json'",
                [],
                |row| row.get(0),
            )
            .expect("composer_draft_json column should exist");

        assert_eq!(version, 5);
        assert_eq!(composer_draft_default, None);

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_legacy_database_file_renames_the_old_database_name() {
        let root = std::env::temp_dir().join(format!("loom-db-rename-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let legacy_db_path = root.join("threadex.sqlite3");
        Connection::open(&legacy_db_path).expect("legacy db should open");

        migrate_legacy_database_file(&root).expect("legacy db rename should succeed");

        assert!(!legacy_db_path.exists());
        assert!(root.join("loom.sqlite3").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_workspace_paths_rewrites_legacy_home_prefixes() {
        let root = std::env::temp_dir().join(format!("loom-db-paths-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("loom.sqlite3");
        let database = AppDatabase::for_test(db_path).expect("db should initialize");
        let connection = database.open().expect("db should open");
        connection
            .execute(
                "
                INSERT INTO projects (
                  id, name, root_path, managed_worktree_dir, settings_json, created_at, updated_at, archived_at
                )
                VALUES (?1, ?2, ?3, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
                ",
                rusqlite::params![
                    "project-1",
                    "Loom",
                    "/Users/test/.threadex/worktrees/loom/project-root"
                ],
            )
            .expect("project should insert");
        connection
            .execute(
                "
                INSERT INTO environments (
                  id, project_id, name, kind, path, git_branch, base_branch, is_default, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, 'managedWorktree', ?4, 'main', 'origin/main', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                rusqlite::params![
                    "env-1",
                    "project-1",
                    "feature",
                    "/Users/test/.threadex/worktrees/loom/feature"
                ],
            )
            .expect("environment should insert");
        connection
            .execute(
                "
                INSERT INTO threads (
                  id, environment_id, title, status, codex_thread_id, overrides_json, composer_draft_json, created_at, updated_at, archived_at
                )
                VALUES (?1, ?2, ?3, ?4, NULL, '{}', ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
                ",
                rusqlite::params![
                    "thread-1",
                    "env-1",
                    "Draft thread",
                    "active",
                    serde_json::to_string(&ConversationComposerDraft {
                        text: "Keep this".to_string(),
                        images: vec![ConversationImageAttachment::LocalImage {
                            path: "/Users/test/.threadex/worktrees/loom/feature/screenshot.png"
                                .to_string(),
                        }],
                        mention_bindings: vec![ComposerDraftMentionBinding {
                            mention: "notes".to_string(),
                            kind: ComposerMentionBindingKind::Skill,
                            path: "/Users/test/.threadex/worktrees/loom/feature/notes.md"
                                .to_string(),
                            start: 0,
                            end: 6,
                        }],
                        is_refining_plan: true,
                    })
                    .expect("draft should serialize"),
                ],
            )
            .expect("thread should insert");
        drop(connection);

        database
            .normalize_workspace_paths(Path::new("/Users/test/.threadex"), Path::new("/Users/test/.loom"))
            .expect("path migration should succeed");

        let connection = database.open().expect("db should reopen");
        let project_root: String = connection
            .query_row("SELECT root_path FROM projects WHERE id = 'project-1'", [], |row| row.get(0))
            .expect("project path should read");
        let environment_path: String = connection
            .query_row("SELECT path FROM environments WHERE id = 'env-1'", [], |row| row.get(0))
            .expect("environment path should read");
        let draft: ConversationComposerDraft = connection
            .query_row(
                "SELECT composer_draft_json FROM threads WHERE id = 'thread-1'",
                [],
                |row| {
                    let draft_json = row.get::<_, String>(0)?;
                    serde_json::from_str(&draft_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            draft_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                },
            )
            .expect("thread draft should read");

        assert_eq!(project_root, "/Users/test/.loom/worktrees/loom/project-root");
        assert_eq!(environment_path, "/Users/test/.loom/worktrees/loom/feature");
        assert_eq!(
            draft.images,
            vec![ConversationImageAttachment::LocalImage {
                path: "/Users/test/.loom/worktrees/loom/feature/screenshot.png".to_string(),
            }]
        );
        assert_eq!(
            draft.mention_bindings,
            vec![ComposerDraftMentionBinding {
                mention: "notes".to_string(),
                kind: ComposerMentionBindingKind::Skill,
                path: "/Users/test/.loom/worktrees/loom/feature/notes.md".to_string(),
                start: 0,
                end: 6,
            }]
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
