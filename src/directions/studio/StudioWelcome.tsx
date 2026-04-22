import { EmptyState } from "../../shared/EmptyState";
import { useProjectImport } from "./useProjectImport";
import { APP_NAME } from "../../lib/app-identity";
import skeinAppIcon from "../../../desktop-backend/icons/icon.png";
import "./StudioWelcome.css";

export function StudioWelcome() {
  const { error, importProject, isImporting } = useProjectImport();

  return (
    <div className="studio-welcome">
      <EmptyState
        icon={<img src={skeinAppIcon} alt="" className="studio-welcome__logo" />}
        heading={`Welcome to ${APP_NAME}`}
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
