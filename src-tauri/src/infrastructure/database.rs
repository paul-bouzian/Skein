use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::app_identity::{
    AppStoragePaths, APP_DATABASE_FILE_NAME, LEGACY_APP_DATABASE_FILE_NAME,
};
use crate::error::{AppError, AppResult};

const CURRENT_SCHEMA_VERSION: i32 = 3;

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
                    PRAGMA user_version = 3;
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
                    CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                    ON projects(managed_worktree_dir)
                    WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                    PRAGMA user_version = 3;
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
                    CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                    ON projects(managed_worktree_dir)
                    WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                    PRAGMA user_version = 3;
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
        Ok(())
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
    use rusqlite::Connection;
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn migrate_v1_projects_adds_project_settings_and_managed_worktree_dir_columns() {
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

        assert_eq!(version, 3);
        assert_eq!(default_settings, "'{}'");
        assert_eq!(managed_worktree_dir_default, None);
        assert_eq!(
            managed_worktree_dir_index,
            "idx_projects_managed_worktree_dir_active"
        );

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_v2_projects_adds_managed_worktree_dir_column() {
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

        assert_eq!(version, 3);
        assert_eq!(
            managed_worktree_dir_index,
            "idx_projects_managed_worktree_dir_active"
        );

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

        assert_eq!(project_root, "/Users/test/.loom/worktrees/loom/project-root");
        assert_eq!(environment_path, "/Users/test/.loom/worktrees/loom/feature");

        let _ = std::fs::remove_dir_all(root);
    }
}
