use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const CURRENT_SCHEMA_VERSION: i32 = 2;

#[derive(Debug, Clone)]
pub struct AppDatabase {
    db_path: PathBuf,
}

impl AppDatabase {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        let db_dir = app_data_dir.join("state");
        std::fs::create_dir_all(&db_dir)?;

        let db_path = db_dir.join("threadex.sqlite3");
        let database = Self { db_path };
        database.migrate()?;
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
                )?;
            }
            1 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
                    PRAGMA user_version = 2;
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
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use uuid::Uuid;

    use super::AppDatabase;

    #[test]
    fn migrate_v1_projects_adds_project_settings_column() {
        let root = std::env::temp_dir().join(format!("threadex-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("threadex.sqlite3");
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

        assert_eq!(version, 2);
        assert_eq!(default_settings, "'{}'");

        let _ = std::fs::remove_dir_all(root);
    }
}
