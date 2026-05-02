use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::app_identity::{
    AppStoragePaths, APP_DATABASE_FILE_NAME, LEGACY_APP_DATABASE_FILE_NAMES,
};
use crate::domain::conversation::{
    ComposerDraftMentionBinding, ConversationComposerDraft, ConversationImageAttachment,
    ConversationItem, ThreadConversationSnapshot,
};
use crate::domain::workspace::SavedDraftThreadState;
use crate::error::{AppError, AppResult};

const CURRENT_SCHEMA_VERSION: i32 = 10;

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
            &storage_paths.legacy_app_home_dirs,
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
                      kind TEXT NOT NULL DEFAULT 'repository',
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
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
                    CREATE INDEX idx_environments_project_id ON environments(project_id);
                    CREATE INDEX idx_threads_environment_id ON threads(environment_id);
                    CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                    ON projects(managed_worktree_dir)
                    WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                    PRAGMA user_version = 7;
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
                    ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
                    ALTER TABLE projects
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects
                    ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE environments
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
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
                    PRAGMA user_version = 7;
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
                    ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
                    ALTER TABLE projects
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects
                    ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE environments
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
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
                    PRAGMA user_version = 7;
                    COMMIT;
                    ",
                )?;
            }
            3 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
                    ALTER TABLE projects
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects
                    ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE environments
                    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
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
                    PRAGMA user_version = 7;
                    COMMIT;
                    ",
                )?;
            }
            4 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
                    ALTER TABLE threads
                    ADD COLUMN composer_draft_json TEXT;
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
                    PRAGMA user_version = 7;
                    COMMIT;
                    ",
                )?;
            }
            5 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    ALTER TABLE projects
                    ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
                    PRAGMA user_version = 7;
                    COMMIT;
                    ",
                )?;
            }
            6 => {
                connection.execute_batch(
                    "
                    BEGIN;
                    CREATE TABLE draft_thread_states (
                      scope_kind TEXT NOT NULL,
                      scope_id TEXT NOT NULL,
                      payload_json TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (scope_kind, scope_id)
                    );
                    PRAGMA user_version = 7;
                    COMMIT;
                    ",
                )?;
            }
            7 => {}
            8 => {}
            9 => {}
            CURRENT_SCHEMA_VERSION => {}
            other => {
                return Err(AppError::Runtime(format!(
                    "Unsupported database schema version {other}.",
                )));
            }
        }

        if version < 8 {
            migrate_to_v8(&connection)?;
        }
        if version < 9 {
            migrate_to_v9(&connection)?;
        }
        if version < 10 {
            migrate_to_v10(&connection)?;
        }

        Ok(())
    }

    fn normalize_workspace_paths(
        &self,
        legacy_app_home_dirs: &[PathBuf],
        app_home_dir: &Path,
    ) -> AppResult<()> {
        let connection = self.open()?;
        let current = app_home_dir.to_string_lossy().to_string();

        for legacy_app_home_dir in legacy_app_home_dirs {
            if legacy_app_home_dir == app_home_dir {
                continue;
            }

            let legacy = legacy_app_home_dir.to_string_lossy().to_string();
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

            let draft_thread_states = {
                let mut statement = connection.prepare(
                    "
                    SELECT scope_kind, scope_id, payload_json
                    FROM draft_thread_states
                    WHERE INSTR(payload_json, ?1) > 0
                    ",
                )?;
                let states = statement
                    .query_map([&legacy], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                states
            };

            for (scope_kind, scope_id, payload_json) in draft_thread_states {
                let state = serde_json::from_str::<SavedDraftThreadState>(&payload_json).map_err(
                    |error| {
                        AppError::Runtime(format!(
                            "Failed to deserialize persisted draft thread state for {scope_kind}:{scope_id}: {error}",
                        ))
                    },
                )?;
                let normalized_state =
                    normalize_saved_draft_thread_state_paths(state, &legacy, &current);
                connection.execute(
                    "
                    UPDATE draft_thread_states
                    SET payload_json = ?1
                    WHERE scope_kind = ?2 AND scope_id = ?3
                    ",
                    rusqlite::params![
                        serde_json::to_string(&normalized_state)
                            .map_err(|error| AppError::Runtime(error.to_string()))?,
                        scope_kind,
                        scope_id,
                    ],
                )?;
            }
        }
        Ok(())
    }

    pub fn save_conversation_item(
        &self,
        thread_id: &str,
        item: &ConversationItem,
    ) -> AppResult<()> {
        let connection = self.open()?;
        let (item_id, turn_id) = match item {
            ConversationItem::Message(m) => (&m.id, m.turn_id.as_deref()),
            ConversationItem::Reasoning(r) => (&r.id, r.turn_id.as_deref()),
            ConversationItem::Tool(t) => (&t.id, t.turn_id.as_deref()),
            ConversationItem::AutoApprovalReview(a) => (&a.id, a.turn_id.as_deref()),
            ConversationItem::System(s) => (&s.id, s.turn_id.as_deref()),
        };
        let payload =
            serde_json::to_string(item).map_err(|error| AppError::Runtime(error.to_string()))?;
        let now = Utc::now().to_rfc3339();
        connection.execute(
            "
            INSERT INTO conversation_items (id, thread_id, turn_id, payload_json, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(thread_id, id) DO UPDATE SET
              turn_id = excluded.turn_id,
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
            ",
            params![item_id, thread_id, turn_id, payload, now],
        )?;
        Ok(())
    }

    pub fn load_conversation_items(&self, thread_id: &str) -> AppResult<Vec<ConversationItem>> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT payload_json FROM conversation_items WHERE thread_id = ?1 ORDER BY rowid",
        )?;
        let rows = statement
            .query_map([thread_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut items = Vec::with_capacity(rows.len());
        for payload in rows {
            match serde_json::from_str::<ConversationItem>(&payload) {
                Ok(item) => items.push(item),
                Err(error) => {
                    tracing::warn!(
                        thread_id,
                        ?error,
                        "skipping unparseable persisted conversation item"
                    );
                }
            }
        }
        Ok(items)
    }

    #[allow(dead_code)]
    pub fn delete_conversation_items(&self, thread_id: &str) -> AppResult<()> {
        let connection = self.open()?;
        connection.execute(
            "DELETE FROM conversation_items WHERE thread_id = ?1",
            [thread_id],
        )?;
        Ok(())
    }

    pub fn delete_conversation_items_for_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> AppResult<()> {
        let connection = self.open()?;
        connection.execute(
            "DELETE FROM conversation_items WHERE thread_id = ?1 AND turn_id = ?2",
            params![thread_id, turn_id],
        )?;
        Ok(())
    }

    pub fn save_conversation_snapshot(
        &self,
        snapshot: &ThreadConversationSnapshot,
    ) -> AppResult<()> {
        let connection = self.open()?;
        let payload = serde_json::to_string(snapshot)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        let now = Utc::now().to_rfc3339();
        connection.execute(
            "
            INSERT INTO conversation_snapshots (thread_id, payload_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(thread_id) DO UPDATE SET
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
            ",
            params![&snapshot.thread_id, payload, now],
        )?;
        Ok(())
    }

    pub fn load_conversation_snapshot(
        &self,
        thread_id: &str,
    ) -> AppResult<Option<ThreadConversationSnapshot>> {
        let connection = self.open()?;
        let payload = match connection.query_row(
            "SELECT payload_json FROM conversation_snapshots WHERE thread_id = ?1",
            [thread_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(payload) => payload,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let snapshot = serde_json::from_str::<ThreadConversationSnapshot>(&payload)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        Ok(Some(snapshot))
    }
}

fn migrate_to_v8(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "
        BEGIN;
        ALTER TABLE threads ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex';
        ALTER TABLE threads ADD COLUMN provider_thread_id TEXT;
        ALTER TABLE threads ADD COLUMN handoff_json TEXT;
        UPDATE threads
        SET provider = 'codex',
            provider_thread_id = codex_thread_id
        WHERE provider_thread_id IS NULL
          AND codex_thread_id IS NOT NULL;
        PRAGMA user_version = 8;
        COMMIT;
        ",
    )?;
    Ok(())
}

fn migrate_to_v9(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "
        BEGIN;
        CREATE TABLE conversation_items (
          id TEXT NOT NULL,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          turn_id TEXT,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, id)
        );
        CREATE INDEX conversation_items_thread_idx ON conversation_items(thread_id);
        PRAGMA user_version = 9;
        COMMIT;
        ",
    )?;
    Ok(())
}

fn migrate_to_v10(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "
        BEGIN;
        CREATE TABLE conversation_snapshots (
          thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 10;
        COMMIT;
        ",
    )?;
    Ok(())
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

fn normalize_saved_draft_thread_state_paths(
    state: SavedDraftThreadState,
    legacy_home: &str,
    current_home: &str,
) -> SavedDraftThreadState {
    SavedDraftThreadState {
        composer_draft: normalize_composer_draft_paths(
            state.composer_draft,
            legacy_home,
            current_home,
        ),
        ..state
    }
}

fn rewrite_legacy_home_prefix(path: &str, legacy_home: &str, current_home: &str) -> String {
    match path.strip_prefix(legacy_home) {
        Some(suffix) => format!("{current_home}{suffix}"),
        None => path.to_string(),
    }
}

fn migrate_legacy_database_file(db_dir: &Path) -> AppResult<()> {
    let db_path = db_dir.join(APP_DATABASE_FILE_NAME);
    if db_path.exists() {
        return Ok(());
    }

    let mut existing_legacy_paths = LEGACY_APP_DATABASE_FILE_NAMES
        .iter()
        .map(|name| db_dir.join(name))
        .filter(|path: &PathBuf| path.exists())
        .collect::<Vec<_>>();

    existing_legacy_paths.sort_by_key(|path| {
        LEGACY_APP_DATABASE_FILE_NAMES
            .iter()
            .position(|candidate| {
                path.file_name().and_then(|name| name.to_str()) == Some(*candidate)
            })
            .unwrap_or(LEGACY_APP_DATABASE_FILE_NAMES.len())
    });

    if let Some(legacy_db_path) = existing_legacy_paths.first().cloned() {
        std::fs::rename(legacy_db_path, db_path)?;
    }

    for legacy_db_path in existing_legacy_paths.into_iter().skip(1) {
        std::fs::rename(
            &legacy_db_path,
            legacy_database_backup_path(&legacy_db_path),
        )?;
    }

    Ok(())
}

fn legacy_database_backup_path(legacy_db_path: &Path) -> PathBuf {
    let file_name = legacy_db_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("legacy.sqlite3");
    let mut index = 0usize;

    loop {
        let suffix = if index == 0 {
            ".backup".to_string()
        } else {
            format!(".backup.{index}")
        };
        let candidate = legacy_db_path.with_file_name(format!("{file_name}{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{migrate_legacy_database_file, AppDatabase, CURRENT_SCHEMA_VERSION};
    use crate::domain::conversation::{
        ComposerDraftMentionBinding, ComposerMentionBindingKind, ConversationComposerDraft,
        ConversationComposerSettings, ConversationImageAttachment, ConversationItem,
        ConversationMessageItem, ConversationRole, ThreadConversationSnapshot,
    };
    use crate::domain::settings::{
        ApprovalPolicy, CollaborationMode, ProviderKind, ReasoningEffort,
    };
    use rusqlite::Connection;
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn migrate_v1_projects_adds_workspace_order_columns() {
        let root = std::env::temp_dir().join(format!("skein-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
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

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
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
        let root = std::env::temp_dir().join(format!("skein-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
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

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
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
        let root = std::env::temp_dir().join(format!("skein-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
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

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
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
        let root = std::env::temp_dir().join(format!("skein-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
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

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(composer_draft_default, None);

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_v6_adds_draft_thread_states_table() {
        let root = std::env::temp_dir().join(format!("skein-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
        let connection = Connection::open(&db_path).expect("db should open");
        connection
            .execute_batch(
                "
                BEGIN;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  kind TEXT NOT NULL DEFAULT 'repository',
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
                CREATE UNIQUE INDEX idx_projects_managed_worktree_dir_active
                ON projects(managed_worktree_dir)
                WHERE archived_at IS NULL AND managed_worktree_dir IS NOT NULL;
                CREATE INDEX idx_environments_project_id ON environments(project_id);
                CREATE INDEX idx_threads_environment_id ON threads(environment_id);
                PRAGMA user_version = 6;
                COMMIT;
                ",
            )
            .expect("v6 schema should be created");
        drop(connection);

        let database = AppDatabase::for_test(db_path.clone()).expect("migration should succeed");
        let connection = database.open().expect("db should reopen");
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let draft_thread_states_exists: String = connection
            .query_row(
                "
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'draft_thread_states'
                ",
                [],
                |row| row.get(0),
            )
            .expect("draft_thread_states table should exist");

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(draft_thread_states_exists, "draft_thread_states");

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_v9_adds_conversation_snapshots_table() {
        let root = std::env::temp_dir().join(format!("skein-db-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
        let connection = Connection::open(&db_path).expect("db should open");
        connection
            .execute_batch(
                "
                BEGIN;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  kind TEXT NOT NULL DEFAULT 'repository',
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
                  provider TEXT NOT NULL DEFAULT 'codex',
                  provider_thread_id TEXT,
                  handoff_json TEXT,
                  overrides_json TEXT NOT NULL,
                  composer_draft_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  archived_at TEXT
                );
                CREATE TABLE conversation_items (
                  id TEXT NOT NULL,
                  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                  turn_id TEXT,
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (thread_id, id)
                );
                PRAGMA user_version = 9;
                COMMIT;
                ",
            )
            .expect("v9 schema should be created");
        drop(connection);

        let database = AppDatabase::for_test(db_path.clone()).expect("migration should succeed");
        let connection = database.open().expect("db should reopen");
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let snapshots_exists: String = connection
            .query_row(
                "
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'conversation_snapshots'
                ",
                [],
                |row| row.get(0),
            )
            .expect("conversation_snapshots table should exist");

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(snapshots_exists, "conversation_snapshots");

        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_legacy_database_file_renames_the_old_database_name() {
        let root = std::env::temp_dir().join(format!("skein-db-rename-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let legacy_db_path = root.join("threadex.sqlite3");
        Connection::open(&legacy_db_path).expect("legacy db should open");

        migrate_legacy_database_file(&root).expect("legacy db rename should succeed");

        assert!(!legacy_db_path.exists());
        assert!(root.join("skein.sqlite3").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_legacy_database_file_renames_the_previous_release_database_name() {
        let root =
            std::env::temp_dir().join(format!("skein-db-rename-previous-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let legacy_db_path = root.join("loom.sqlite3");
        Connection::open(&legacy_db_path).expect("legacy db should open");

        migrate_legacy_database_file(&root).expect("legacy db rename should succeed");

        assert!(!legacy_db_path.exists());
        assert!(root.join("skein.sqlite3").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_legacy_database_file_prefers_previous_release_and_backs_up_older_names() {
        let root = std::env::temp_dir().join(format!("skein-db-rename-multi-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let previous_release_db_path = root.join("loom.sqlite3");
        let oldest_release_db_path = root.join("threadex.sqlite3");
        std::fs::write(&previous_release_db_path, b"loom").expect("loom db should write");
        std::fs::write(&oldest_release_db_path, b"threadex").expect("threadex db should write");

        migrate_legacy_database_file(&root).expect("legacy db rename should succeed");

        assert_eq!(
            std::fs::read(root.join("skein.sqlite3")).expect("canonical db should read"),
            b"loom"
        );
        assert_eq!(
            std::fs::read(root.join("threadex.sqlite3.backup")).expect("backup db should read"),
            b"threadex"
        );
        assert!(!previous_release_db_path.exists());
        assert!(!oldest_release_db_path.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_workspace_paths_rewrites_legacy_home_prefixes() {
        let root = std::env::temp_dir().join(format!("skein-db-paths-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
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
                    "Skein",
                    "/Users/test/.threadex/worktrees/skein/project-root"
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
                    "/Users/test/.threadex/worktrees/skein/feature"
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
                            path: "/Users/test/.threadex/worktrees/skein/feature/screenshot.png"
                                .to_string(),
                        }],
                        mention_bindings: vec![ComposerDraftMentionBinding {
                            mention: "notes".to_string(),
                            kind: ComposerMentionBindingKind::Skill,
                            path: "/Users/test/.threadex/worktrees/skein/feature/notes.md"
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
        connection
            .execute(
                "
                INSERT INTO draft_thread_states (scope_kind, scope_id, payload_json, updated_at)
                VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
                ",
                rusqlite::params![
                    "project",
                    "project-1",
                    serde_json::json!({
                        "composerDraft": {
                            "text": "Persist this",
                            "images": [
                                {
                                    "type": "localImage",
                                    "path": "/Users/test/.loom/worktrees/skein/feature/draft.png",
                                }
                            ],
                            "mentionBindings": [
                                {
                                    "mention": "draft",
                                    "kind": "app",
                                    "path": "/Users/test/.threadex/worktrees/skein/feature/draft.md",
                                    "start": 0,
                                    "end": 5,
                                }
                            ],
                            "isRefiningPlan": false,
                        },
                        "composer": {
                            "model": "gpt-5.4",
                            "reasoningEffort": "high",
                            "collaborationMode": "build",
                            "approvalPolicy": "askToEdit",
                            "serviceTier": null,
                        },
                        "projectSelection": {
                            "kind": "existing",
                            "environmentId": "env-1",
                        },
                    })
                    .to_string(),
                ],
            )
            .expect("draft thread state should insert");
        drop(connection);

        database
            .normalize_workspace_paths(
                &[
                    Path::new("/Users/test/.threadex").to_path_buf(),
                    Path::new("/Users/test/.loom").to_path_buf(),
                ],
                Path::new("/Users/test/.skein"),
            )
            .expect("path migration should succeed");

        let connection = database.open().expect("db should reopen");
        let project_root: String = connection
            .query_row(
                "SELECT root_path FROM projects WHERE id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("project path should read");
        let environment_path: String = connection
            .query_row(
                "SELECT path FROM environments WHERE id = 'env-1'",
                [],
                |row| row.get(0),
            )
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
        let draft_thread_state: String = connection
            .query_row(
                "
                SELECT payload_json
                FROM draft_thread_states
                WHERE scope_kind = 'project' AND scope_id = 'project-1'
                ",
                [],
                |row| row.get(0),
            )
            .expect("draft thread state should read");

        assert_eq!(
            project_root,
            "/Users/test/.skein/worktrees/skein/project-root"
        );
        assert_eq!(
            environment_path,
            "/Users/test/.skein/worktrees/skein/feature"
        );
        assert_eq!(
            draft.images,
            vec![ConversationImageAttachment::LocalImage {
                path: "/Users/test/.skein/worktrees/skein/feature/screenshot.png".to_string(),
            }]
        );
        assert_eq!(
            draft.mention_bindings,
            vec![ComposerDraftMentionBinding {
                mention: "notes".to_string(),
                kind: ComposerMentionBindingKind::Skill,
                path: "/Users/test/.skein/worktrees/skein/feature/notes.md".to_string(),
                start: 0,
                end: 6,
            }]
        );
        assert!(draft_thread_state.contains("/Users/test/.skein/worktrees/skein/feature/draft.png"));
        assert!(draft_thread_state.contains("/Users/test/.skein/worktrees/skein/feature/draft.md"));
        assert!(!draft_thread_state.contains("/Users/test/.threadex"));
        assert!(!draft_thread_state.contains("/Users/test/.loom"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_conversation_items_for_turn_only_removes_target_turn() {
        let root = std::env::temp_dir().join(format!("skein-db-items-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
        let database = AppDatabase::for_test(db_path).expect("db should initialize");
        let connection = database.open().expect("db should open");
        connection
            .execute(
                "
                INSERT INTO projects (
                  id, name, root_path, settings_json, created_at, updated_at
                )
                VALUES ('project-1', 'Skein', '/tmp/skein-db-items', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                [],
            )
            .expect("project should insert");
        connection
            .execute(
                "
                INSERT INTO environments (
                  id, project_id, name, kind, path, is_default, created_at, updated_at
                )
                VALUES ('env-1', 'project-1', 'main', 'repository', '/tmp/skein-db-items', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                [],
            )
            .expect("environment should insert");
        connection
            .execute(
                "
                INSERT INTO threads (
                  id, environment_id, title, status, codex_thread_id, overrides_json, created_at, updated_at
                )
                VALUES ('thread-1', 'env-1', 'Thread', 'active', NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                [],
            )
            .expect("thread should insert");

        for (id, turn_id, text) in [
            ("assistant-failed", "turn-failed", "failed"),
            ("assistant-kept", "turn-kept", "kept"),
        ] {
            database
                .save_conversation_item(
                    "thread-1",
                    &ConversationItem::Message(ConversationMessageItem {
                        id: id.to_string(),
                        turn_id: Some(turn_id.to_string()),
                        role: ConversationRole::Assistant,
                        text: text.to_string(),
                        images: None,
                        is_streaming: false,
                    }),
                )
                .expect("item should save");
        }

        database
            .delete_conversation_items_for_turn("thread-1", "turn-failed")
            .expect("target turn should delete");

        let remaining = database
            .load_conversation_items("thread-1")
            .expect("items should load");
        assert_eq!(remaining.len(), 1);
        assert!(matches!(
            &remaining[0],
            ConversationItem::Message(message) if message.id == "assistant-kept"
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn saves_and_loads_full_conversation_snapshot() {
        let root = std::env::temp_dir().join(format!("skein-db-snapshot-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).expect("test directory should exist");
        let db_path = root.join("skein.sqlite3");
        let database = AppDatabase::for_test(db_path).expect("db should initialize");
        seed_thread(&database, "thread-1");

        let mut snapshot = ThreadConversationSnapshot::new_for_provider(
            "thread-1".to_string(),
            "env-1".to_string(),
            ProviderKind::Codex,
            Some("codex-thread-1".to_string()),
            Some("codex-thread-1".to_string()),
            test_composer(),
        );
        snapshot
            .items
            .push(ConversationItem::Message(ConversationMessageItem {
                id: "user-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: ConversationRole::User,
                text: "Show instantly".to_string(),
                images: None,
                is_streaming: false,
            }));

        database
            .save_conversation_snapshot(&snapshot)
            .expect("snapshot should save");

        let loaded = database
            .load_conversation_snapshot("thread-1")
            .expect("snapshot should load")
            .expect("snapshot should exist");
        assert_eq!(loaded, snapshot);

        let _ = std::fs::remove_dir_all(root);
    }

    fn seed_thread(database: &AppDatabase, thread_id: &str) {
        let connection = database.open().expect("db should open");
        connection
            .execute(
                "
                INSERT OR IGNORE INTO projects (
                  id, name, root_path, settings_json, created_at, updated_at
                )
                VALUES ('project-1', 'Skein', '/tmp/skein-db-snapshot', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                [],
            )
            .expect("project should insert");
        connection
            .execute(
                "
                INSERT OR IGNORE INTO environments (
                  id, project_id, name, kind, path, is_default, created_at, updated_at
                )
                VALUES ('env-1', 'project-1', 'main', 'repository', '/tmp/skein-db-snapshot', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                [],
            )
            .expect("environment should insert");
        connection
            .execute(
                "
                INSERT INTO threads (
                  id, environment_id, title, status, codex_thread_id, overrides_json, created_at, updated_at
                )
                VALUES (?1, 'env-1', 'Thread', 'active', NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ",
                [thread_id],
            )
            .expect("thread should insert");
    }

    fn test_composer() -> ConversationComposerSettings {
        ConversationComposerSettings {
            provider: ProviderKind::Codex,
            model: "gpt-5.3-codex".to_string(),
            reasoning_effort: ReasoningEffort::High,
            collaboration_mode: CollaborationMode::Build,
            approval_policy: ApprovalPolicy::AskToEdit,
            service_tier: None,
        }
    }
}
