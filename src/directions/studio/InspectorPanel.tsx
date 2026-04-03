import {
  useWorkspaceStore,
  selectSelectedProject,
  selectSelectedEnvironment,
  selectSelectedThread,
  selectSettings,
} from "../../stores/workspace-store";
import {
  useConversationStore,
  selectConversationSnapshot,
} from "../../stores/conversation-store";
import { EnvironmentKindBadge } from "../../shared/EnvironmentKindBadge";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import type {
  EnvironmentRecord,
  GlobalSettings,
  ProjectRecord,
  ThreadRecord,
} from "../../lib/types";
import "./InspectorPanel.css";

export function InspectorPanel() {
  const settings = useWorkspaceStore(selectSettings);
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedThread = useWorkspaceStore(selectSelectedThread);

  let content;
  if (selectedThread) {
    content = <ThreadInspector thread={selectedThread} />;
  } else if (selectedEnvironment) {
    content = <EnvironmentInspector environment={selectedEnvironment} />;
  } else if (selectedProject) {
    content = <ProjectInspector project={selectedProject} />;
  } else if (settings) {
    content = <SettingsInspector settings={settings} />;
  } else {
    content = <p className="inspector__empty">No selection</p>;
  }

  return (
    <aside className="inspector-panel">
      <div className="inspector__header">
        <span className="inspector__title">Inspector</span>
      </div>
      <div className="inspector__content">{content}</div>
    </aside>
  );
}

function InspectorSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="inspector-section">
      <h4 className="inspector-section__label">{label}</h4>
      {children}
    </div>
  );
}

function InspectorRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="inspector-row">
      <span className="inspector-row__label">{label}</span>
      <span className="inspector-row__value">{value}</span>
    </div>
  );
}

function SettingsInspector({ settings }: { settings: GlobalSettings }) {
  return (
    <InspectorSection label="Global Settings">
      <InspectorRow label="Model" value={settings.defaultModel} />
      <InspectorRow label="Reasoning" value={settings.defaultReasoningEffort} />
      <InspectorRow label="Mode" value={settings.defaultCollaborationMode} />
      <InspectorRow label="Approval" value={settings.defaultApprovalPolicy} />
      <InspectorRow label="Binary" value={settings.codexBinaryPath ?? "auto"} />
    </InspectorSection>
  );
}

function ProjectInspector({ project }: { project: ProjectRecord }) {
  const envCount = project.environments.length;
  const threadCount = project.environments.reduce(
    (sum, e) => sum + e.threads.length,
    0,
  );

  return (
    <>
      <InspectorSection label="Project">
        <InspectorRow label="Name" value={project.name} />
        <InspectorRow
          label="Path"
          value={<code className="inspector-mono">{project.rootPath}</code>}
        />
        <InspectorRow
          label="Created"
          value={new Date(project.createdAt).toLocaleDateString()}
        />
      </InspectorSection>
      <InspectorSection label="Stats">
        <InspectorRow label="Environments" value={envCount} />
        <InspectorRow label="Threads" value={threadCount} />
      </InspectorSection>
    </>
  );
}

function EnvironmentInspector({ environment }: { environment: EnvironmentRecord }) {
  return (
    <>
      <InspectorSection label="Environment">
        <InspectorRow label="Name" value={environment.name} />
        <InspectorRow label="Kind" value={<EnvironmentKindBadge kind={environment.kind} />} />
        <InspectorRow
          label="Path"
          value={<code className="inspector-mono">{environment.path}</code>}
        />
        {environment.gitBranch && (
          <InspectorRow
            label="Branch"
            value={<code className="inspector-mono">{environment.gitBranch}</code>}
          />
        )}
        {environment.baseBranch && (
          <InspectorRow
            label="Base"
            value={<code className="inspector-mono">{environment.baseBranch}</code>}
          />
        )}
      </InspectorSection>
      <InspectorSection label="Runtime">
        <InspectorRow
          label="Status"
          value={<RuntimeIndicator state={environment.runtime.state} size="md" label />}
        />
        {environment.runtime.pid != null && (
          <InspectorRow label="PID" value={environment.runtime.pid} />
        )}
      </InspectorSection>
      <InspectorSection label="Threads">
        <InspectorRow
          label="Active"
          value={environment.threads.filter((t) => t.status === "active").length}
        />
        <InspectorRow
          label="Archived"
          value={environment.threads.filter((t) => t.status === "archived").length}
        />
      </InspectorSection>
    </>
  );
}

function ThreadInspector({ thread }: { thread: ThreadRecord }) {
  const snapshot = useConversationStore(selectConversationSnapshot(thread.id));

  return (
    <>
      <InspectorSection label="Thread">
        <InspectorRow label="Title" value={thread.title} />
        <InspectorRow label="Status" value={thread.status} />
        <InspectorRow
          label="Codex ID"
          value={snapshot?.codexThreadId ?? thread.codexThreadId ?? "pending"}
        />
        <InspectorRow label="Conversation" value={snapshot?.status ?? "idle"} />
        <InspectorRow label="Turn" value={snapshot?.activeTurnId ?? "none"} />
        <InspectorRow
          label="Created"
          value={new Date(thread.createdAt).toLocaleDateString()}
        />
        <InspectorRow
          label="Updated"
          value={new Date(thread.updatedAt).toLocaleDateString()}
        />
      </InspectorSection>
      <InspectorSection label="Overrides">
        <InspectorRow label="Model" value={thread.overrides.model ?? "default"} />
        <InspectorRow label="Reasoning" value={thread.overrides.reasoningEffort ?? "default"} />
        <InspectorRow label="Mode" value={thread.overrides.collaborationMode ?? "default"} />
        <InspectorRow label="Approval" value={thread.overrides.approvalPolicy ?? "default"} />
      </InspectorSection>
      {snapshot ? (
        <>
          <InspectorSection label="Runtime">
            <InspectorRow label="Items" value={snapshot.items.length} />
            <InspectorRow
              label="Tokens"
              value={snapshot.tokenUsage?.total.totalTokens.toLocaleString() ?? "pending"}
            />
            <InspectorRow
              label="Last output"
              value={snapshot.tokenUsage?.last.outputTokens.toLocaleString() ?? "pending"}
            />
          </InspectorSection>
          {snapshot.blockedInteraction ? (
            <InspectorSection label="Blocked">
              <InspectorRow label="Method" value={snapshot.blockedInteraction.method} />
              <InspectorRow label="State" value={snapshot.blockedInteraction.title} />
            </InspectorSection>
          ) : null}
          {snapshot.error ? (
            <InspectorSection label="Error">
              <InspectorRow label="Message" value={snapshot.error.message} />
              {snapshot.error.additionalDetails ? (
                <InspectorRow
                  label="Details"
                  value={snapshot.error.additionalDetails}
                />
              ) : null}
            </InspectorSection>
          ) : null}
        </>
      ) : null}
    </>
  );
}
