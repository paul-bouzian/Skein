use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitReviewScope {
    Uncommitted,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeSection {
    Staged,
    Unstaged,
    Untracked,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitDiffLineKind {
    Hunk,
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitAction {
    Commit,
    Push,
    Pull,
    CommitPush,
    CreatePr,
    CommitPushCreatePr,
    ViewPr,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoSummary {
    pub environment_id: String,
    pub repo_path: String,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub upstream_branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub has_staged_changes: bool,
    pub has_unstaged_changes: bool,
    pub has_untracked_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub section: GitChangeSection,
    pub kind: GitChangeKind,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub can_stage: bool,
    pub can_unstage: bool,
    pub can_revert: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeSectionSnapshot {
    pub id: GitChangeSection,
    pub label: String,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewSnapshot {
    pub environment_id: String,
    pub scope: GitReviewScope,
    pub summary: GitRepoSummary,
    pub sections: Vec<GitChangeSectionSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    pub kind: GitDiffLineKind,
    pub text: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    pub header: String,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub environment_id: String,
    pub scope: GitReviewScope,
    pub section: GitChangeSection,
    pub path: String,
    pub old_path: Option<String>,
    pub kind: GitChangeKind,
    pub is_binary: bool,
    pub hunks: Vec<GitDiffHunk>,
    pub empty_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionCommitResult {
    pub sha: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionPushResult {
    pub branch: String,
    pub upstream_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionPullResult {
    pub branch: String,
    pub upstream_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionPullRequestResult {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionResult {
    pub environment_id: String,
    pub action: GitAction,
    pub snapshot: GitReviewSnapshot,
    pub commit: Option<GitActionCommitResult>,
    pub push: Option<GitActionPushResult>,
    pub pull: Option<GitActionPullResult>,
    pub pr: Option<GitActionPullRequestResult>,
    pub error: Option<String>,
}
