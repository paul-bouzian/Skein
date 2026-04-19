import { useEffect, useMemo, useState } from "react";

import skeinAppIcon from "../../../../src-tauri/icons/icon.png";
import * as bridge from "../../../lib/bridge";
import type {
  CollaborationModeOption,
  ComposerDraftMentionBinding,
  ComposerMentionBindingInput,
  ComposerTarget,
  ConversationComposerSettings,
  ConversationImageAttachment,
  GlobalSettings,
  ModelOption,
  ReasoningEffort,
} from "../../../lib/types";
import { useConversationStore } from "../../../stores/conversation-store";
import {
  selectChatWorkspace,
  selectProjects,
  selectSettings,
  useWorkspaceStore,
  type SlotKey,
  type ThreadDraftState,
} from "../../../stores/workspace-store";
import { InlineComposer } from "../composer/InlineComposer";
import { sendThreadDraft } from "../studioActions";
import {
  EnvironmentSelector,
  type DraftLocationSelection,
  type EnvSelection,
} from "./EnvironmentSelector";
import "../ThreadConversation.css";
import "./ThreadDraftComposer.css";

type Props = {
  draft: ThreadDraftState;
  paneId: SlotKey;
};

const BOOTSTRAP_COMPOSER: ConversationComposerSettings = {
  model: "gpt-5.4",
  reasoningEffort: "high",
  collaborationMode: "build",
  approvalPolicy: "askToEdit",
  serviceTier: null,
};

const FALLBACK_COLLABORATION_MODES: CollaborationModeOption[] = [
  { id: "build", label: "Build", mode: "build" },
  { id: "plan", label: "Plan", mode: "plan" },
];

const FALLBACK_EFFORT_OPTIONS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Primary Codex model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["flex", "fast"],
    isDefault: true,
  },
];

const PRIORITY_BRANCHES = ["main", "master"] as const;
const PRIORITY_SET: ReadonlySet<string> = new Set(PRIORITY_BRANCHES);
const CHAT_WORKSPACE_CATALOG_TARGET: ComposerTarget = { kind: "chatWorkspace" };

function composerFromSettings(
  settings: GlobalSettings,
): ConversationComposerSettings {
  return {
    model: settings.defaultModel,
    reasoningEffort: settings.defaultReasoningEffort,
    collaborationMode: settings.defaultCollaborationMode,
    approvalPolicy: settings.defaultApprovalPolicy,
    serviceTier: settings.defaultServiceTier ?? null,
  };
}

function orderBranchesWithDefaults(branches: string[]): string[] {
  const priority = PRIORITY_BRANCHES.filter((name) => branches.includes(name));
  const rest = branches
    .filter((name) => !PRIORITY_SET.has(name))
    .sort((left, right) => left.localeCompare(right));
  return [...priority, ...rest];
}

export function ThreadDraftComposer({ draft, paneId }: Props) {
  const projects = useWorkspaceStore(selectProjects);
  const chatWorkspace = useWorkspaceStore(selectChatWorkspace);
  const settings = useWorkspaceStore(selectSettings);
  const updateThreadDraftTarget = useWorkspaceStore(
    (state) => state.updateThreadDraftTarget,
  );
  const tryLoadEnvironmentCapabilities = useConversationStore(
    (state) => state.tryLoadEnvironmentCapabilities,
  );
  const [text, setText] = useState("");
  const [images, setImages] = useState<ConversationImageAttachment[]>([]);
  const [mentionBindings, setMentionBindings] = useState<
    ComposerDraftMentionBinding[]
  >([]);
  const [composer, setComposer] = useState<ConversationComposerSettings>(() =>
    settings ? composerFromSettings(settings) : BOOTSTRAP_COMPOSER,
  );
  const [projectSelections, setProjectSelections] = useState<
    Record<string, EnvSelection>
  >({});
  const [lastProjectId, setLastProjectId] = useState<string | null>(
    draft.kind === "project" ? draft.projectId : (projects[0]?.id ?? null),
  );
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(draft.kind === "chat");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (draft.kind === "project") {
      setLastProjectId(draft.projectId);
      setProjectSelections((current) =>
        current[draft.projectId]
          ? current
          : { ...current, [draft.projectId]: { kind: "local" } },
      );
      return;
    }
    if (!lastProjectId && projects[0]) {
      setLastProjectId(projects[0].id);
    }
  }, [draft, lastProjectId, projects]);

  const activeProjectId = draft.kind === "project" ? draft.projectId : lastProjectId;
  const project = useMemo(
    () =>
      activeProjectId
        ? (projects.find((candidate) => candidate.id === activeProjectId) ?? null)
        : null,
    [activeProjectId, projects],
  );

  const selection = useMemo<EnvSelection>(() => {
    if (!activeProjectId) {
      return { kind: "local" };
    }
    return projectSelections[activeProjectId] ?? { kind: "local" };
  }, [activeProjectId, projectSelections]);

  const localEnvironment =
    project?.environments.find((environment) => environment.kind === "local") ?? null;
  const worktreeEnvironments =
    project?.environments.filter((environment) => environment.kind !== "local") ?? [];

  useEffect(() => {
    if (draft.kind !== "project" || !draft.projectId) {
      setBranches([]);
      setBranchesLoaded(true);
      return;
    }

    let cancelled = false;
    setBranchesLoaded(false);
    bridge
      .listProjectBranches(draft.projectId)
      .then((next) => {
        if (cancelled) return;
        setBranches(orderBranchesWithDefaults(next));
        setBranchesLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBranches([]);
        setBranchesLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [draft]);

  const defaultBaseBranch = branches[0] ?? localEnvironment?.gitBranch ?? null;

  useEffect(() => {
    if (draft.kind !== "project" || selection.kind !== "new" || !branchesLoaded) return;
    if (selection.baseBranch.length === 0) return;
    if (branches.includes(selection.baseBranch)) return;
    const fallback = defaultBaseBranch ?? "";
    if (fallback === selection.baseBranch) return;
    setProjectSelections((current) => ({
      ...current,
      [draft.projectId]: { ...selection, baseBranch: fallback },
    }));
  }, [branches, branchesLoaded, defaultBaseBranch, draft, selection]);

  const resolvedComposerEnvId =
    draft.kind === "project"
      ? ((selection.kind === "existing"
          ? selection.environmentId
          : localEnvironment?.id) ?? "draft")
      : "draft";
  const composerCapabilityEnvironmentId =
    draft.kind === "project"
      ? selection.kind === "existing"
        ? selection.environmentId
        : (localEnvironment?.id ?? null)
      : null;
  const selectedComposerEnvironment =
    draft.kind === "project"
      ? selection.kind === "existing"
        ? (worktreeEnvironments.find(
            (environment) => environment.id === selection.environmentId,
          ) ?? null)
        : selection.kind === "local"
          ? localEnvironment
          : null
      : null;
  const transportEnabled =
    selectedComposerEnvironment?.threads.some(
      (thread) => thread.status === "active",
    ) ?? false;
  const environmentCatalogTarget = useMemo(
    () =>
      resolvedComposerEnvId === "draft"
        ? null
        : {
            kind: "environment" as const,
            environmentId: resolvedComposerEnvId,
          },
    [resolvedComposerEnvId],
  );
  const catalogTarget =
    draft.kind === "chat"
      ? CHAT_WORKSPACE_CATALOG_TARGET
      : environmentCatalogTarget;
  const fileSearchTarget =
    draft.kind === "chat" ? null : environmentCatalogTarget;

  const capabilities = useConversationStore((state) =>
    composerCapabilityEnvironmentId
      ? (state.capabilitiesByEnvironmentId[composerCapabilityEnvironmentId] ??
        null)
      : null,
  );

  useEffect(() => {
    if (!composerCapabilityEnvironmentId) {
      return;
    }
    void tryLoadEnvironmentCapabilities(composerCapabilityEnvironmentId);
  }, [composerCapabilityEnvironmentId, tryLoadEnvironmentCapabilities]);

  const cachedModels = capabilities?.models ?? [];
  const modelOptions: ModelOption[] =
    cachedModels.length > 0 ? cachedModels : FALLBACK_MODEL_OPTIONS;
  const collaborationModes: CollaborationModeOption[] =
    capabilities?.collaborationModes ?? FALLBACK_COLLABORATION_MODES;
  const selectedModel =
    modelOptions.find((candidate) => candidate.id === composer.model) ?? null;
  const effortOptions: ReasoningEffort[] =
    selectedModel?.supportedReasoningEfforts ?? FALLBACK_EFFORT_OPTIONS;

  function handleLocationChange(next: DraftLocationSelection) {
    if (next.kind === "chat") {
      updateThreadDraftTarget(paneId, { kind: "chat" });
      return;
    }

    setLastProjectId(next.projectId);
    setProjectSelections((current) => ({
      ...current,
      [next.projectId]:
        draft.kind === "chat" &&
        next.target.kind === "local" &&
        current[next.projectId]
          ? current[next.projectId]!
          : next.target,
    }));
    updateThreadDraftTarget(paneId, {
      kind: "project",
      projectId: next.projectId,
    });
  }

  async function handleSend(
    sendText: string,
    sendImages: ConversationImageAttachment[],
    sendMentionBindings: ComposerMentionBindingInput[],
  ) {
    if (isSending) return;
    setIsSending(true);
    setError(null);
    try {
      const result = await sendThreadDraft({
        paneId,
        draft,
        projectSelection: selection,
        text: sendText,
        images: sendImages,
        mentionBindings: sendMentionBindings,
        composer,
      });
      if (!result.ok) {
        setError(result.error);
        setIsSending(false);
      }
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Failed to send message",
      );
      setIsSending(false);
    }
  }

  if (draft.kind === "project" && !project) {
    return (
      <div className="tx-conversation thread-draft">
        <p className="thread-draft__empty">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="tx-conversation thread-draft">
      <div className="tx-conversation__timeline">
        <div className="thread-draft__welcome">
          <img
            src={skeinAppIcon}
            alt=""
            className="thread-draft__welcome-logo"
          />
          <h2 className="thread-draft__welcome-heading">
            {draft.kind === "chat" ? "Ask Codex anything" : "Let's build"}
          </h2>
          <p className="thread-draft__welcome-project">
            {draft.kind === "chat"
              ? chatWorkspace?.title ?? "Chats"
              : project?.name ?? "Project"}
          </p>
        </div>
      </div>
      <InlineComposer
        environmentId={resolvedComposerEnvId}
        threadId={`draft:${paneId}`}
        composer={composer}
        collaborationModes={collaborationModes}
        disabled={false}
        draft={text}
        effortOptions={effortOptions}
        focusKey={`draft:${paneId}`}
        images={images}
        isBusy={false}
        isSending={isSending}
        isRefiningPlan={false}
        mentionBindings={mentionBindings}
        modelOptions={modelOptions}
        catalogTarget={catalogTarget}
        fileSearchTarget={fileSearchTarget}
        transportEnabled={transportEnabled}
        voiceEnabled={draft.kind === "project" && resolvedComposerEnvId !== "draft"}
        onChangeImages={setImages}
        tokenUsage={null}
        onCancelRefine={() => undefined}
        onChangeDraft={(value, bindings) => {
          setText(value);
          if (bindings) setMentionBindings(bindings);
        }}
        onChangeMentionBindings={setMentionBindings}
        onInterrupt={() => undefined}
        onSend={(next, nextImages, nextMentionBindings) => {
          void handleSend(next, nextImages, nextMentionBindings);
        }}
        onUpdateComposer={(patch) =>
          setComposer((previous) => ({ ...previous, ...patch }))
        }
      />
      <EnvironmentSelector
        projects={projects}
        localEnvironment={draft.kind === "project" ? localEnvironment : null}
        worktreeEnvironments={draft.kind === "project" ? worktreeEnvironments : []}
        availableBranches={branches}
        branchesLoading={!branchesLoaded}
        defaultBaseBranch={defaultBaseBranch}
        value={
          draft.kind === "chat"
            ? { kind: "chat" }
            : {
                kind: "project",
                projectId: draft.projectId,
                target: selection,
              }
        }
        onChange={handleLocationChange}
        disabled={isSending}
      />
      {error ? <p className="thread-draft__error">{error}</p> : null}
    </div>
  );
}
