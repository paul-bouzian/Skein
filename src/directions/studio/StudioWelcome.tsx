import { EmptyState } from "../../shared/EmptyState";
import { useProjectImport } from "./useProjectImport";
import "./StudioWelcome.css";

export function StudioWelcome() {
  const { error, importProject, isImporting } = useProjectImport();

  return (
    <div className="studio-welcome">
      <EmptyState
        icon={<span className="studio-welcome__icon">TX</span>}
        heading="Welcome to Loom"
        body={
          error ??
          "Add your first project to start managing Codex environments and threads."
        }
        action={
          <button
            type="button"
            className="studio-welcome__cta"
            onClick={() => void importProject()}
            disabled={isImporting}
          >
            {isImporting ? "Importing..." : "Add Project"}
          </button>
        }
      />
    </div>
  );
}
