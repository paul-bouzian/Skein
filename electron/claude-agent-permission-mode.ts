export type ClaudeApprovalPolicy = "askToEdit" | "autoReview" | "fullAccess";
export type ClaudeCollaborationMode = "build" | "plan";
export type ClaudePermissionMode = "default" | "auto" | "bypassPermissions" | "plan";

export function claudePermissionMode(
  collaborationMode: ClaudeCollaborationMode,
  approvalPolicy: ClaudeApprovalPolicy,
): ClaudePermissionMode {
  if (collaborationMode === "plan") return "plan";
  if (approvalPolicy === "autoReview") return "auto";
  if (approvalPolicy === "fullAccess") return "bypassPermissions";
  return "default";
}
