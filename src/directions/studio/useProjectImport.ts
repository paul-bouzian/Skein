import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as bridge from "../../lib/bridge";
import { useWorkspaceStore } from "../../stores/workspace-store";
import type { EnvironmentRecord } from "../../lib/types";

function pickDefaultEnvironment(environments: EnvironmentRecord[]): EnvironmentRecord | null {
  return (
    environments.find((environment) => environment.kind === "local") ??
    environments[0] ??
    null
  );
}

export function useProjectImport() {
  const refreshSnapshot = useWorkspaceStore((state) => state.refreshSnapshot);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const selectEnvironment = useWorkspaceStore((state) => state.selectEnvironment);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importProject() {
    const selection = await open({
      title: "Choose a project folder",
      directory: true,
      multiple: false,
      canCreateDirectories: false,
    });

    if (!selection || Array.isArray(selection)) {
      return null;
    }

    setIsImporting(true);
    setError(null);

    try {
      const project = await bridge.addProject({ path: selection });
      await refreshSnapshot();
      selectImportedProject(project.id, pickDefaultEnvironment(project.environments)?.id ?? null);

      return project;
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : "Failed to add project";
      setError(message);
      return null;
    } finally {
      setIsImporting(false);
    }
  }

  function clearError() {
    setError(null);
  }

  function selectImportedProject(projectId: string, environmentId: string | null) {
    if (environmentId) {
      selectEnvironment(environmentId);
      return;
    }

    selectProject(projectId);
  }

  return {
    error,
    clearError,
    importProject,
    isImporting,
  };
}
