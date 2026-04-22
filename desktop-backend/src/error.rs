use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Runtime(String),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        match error {
            AppError::Validation(message) => Self {
                code: "validation_error",
                message,
            },
            AppError::NotFound(message) => Self {
                code: "not_found",
                message,
            },
            AppError::Git(message) => Self {
                code: "git_error",
                message,
            },
            AppError::Runtime(message) => Self {
                code: "runtime_error",
                message,
            },
            AppError::Database(error) => Self {
                code: "database_error",
                message: error.to_string(),
            },
            AppError::Io(error) => Self {
                code: "io_error",
                message: error.to_string(),
            },
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
