use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalStatus {
    Running,
    Exited,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentTerminalSnapshot {
    pub environment_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub status: TerminalStatus,
    pub history: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEventPayload {
    Started {
        environment_id: String,
        terminal_id: String,
        created_at: DateTime<Utc>,
        snapshot: EnvironmentTerminalSnapshot,
    },
    Output {
        environment_id: String,
        terminal_id: String,
        created_at: DateTime<Utc>,
        data: String,
    },
    Exited {
        environment_id: String,
        terminal_id: String,
        created_at: DateTime<Utc>,
        exit_code: Option<i32>,
    },
    Error {
        environment_id: String,
        terminal_id: String,
        created_at: DateTime<Utc>,
        message: String,
    },
}
