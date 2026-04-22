import { dialog } from "../../lib/shell";
import type { GitChangeSection } from "../../lib/types";

export async function confirmRevertAll(
  environmentId: string,
  revertAll: (environmentId: string) => Promise<void>,
) {
  const approved = await dialog.confirm("Are you sure you want to revert all tracked changes?", {
    title: "Revert All Changes",
    kind: "warning",
    okLabel: "Revert",
    cancelLabel: "Cancel",
  });
  if (!approved) return;
  await revertAll(environmentId);
}

export async function confirmRevertFile(
  environmentId: string,
  section: GitChangeSection,
  path: string,
  revertFile: (environmentId: string, section: GitChangeSection, path: string) => Promise<void>,
) {
  const approved = await dialog.confirm(`Are you sure you want to revert ${path}?`, {
    title: "Revert File",
    kind: "warning",
    okLabel: "Revert",
    cancelLabel: "Cancel",
  });
  if (!approved) return;
  await revertFile(environmentId, section, path);
}
