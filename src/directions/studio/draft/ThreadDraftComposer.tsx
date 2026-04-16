import { useEffect, useState } from "react";
import * as bridge from "../../../lib/bridge";
import type {
  CollaborationModeOption,
  ComposerDraftMentionBinding,
  ComposerMentionBindingInput,
  ConversationComposerSettings,
  ConversationImageAttachment,
  EnvironmentRecord,
  EnvironmentCapabilitiesSnapshot,
  GlobalSettings,
  ModelOption,
  ProjectRecord,
  ReasoningEffort,
} from "../../../lib/types";
import { ThreadIcon } from "../../../shared/Icons";
import { useConversationStore } from "../../../stores/conversation-store";
import {
  selectProjects,
  selectSettings,
  useWorkspaceStore,
  type SlotKey,
} from "../../../stores/workspace-store";
import { InlineComposer } from "../composer/InlineComposer";
import "../ThreadConversation.css";
import { sendThreadDraft } from "../studioActions";
import { EnvironmentSelector, type EnvSelection } from "./EnvironmentSelector";
import "./ThreadDraftComposer.css";

type Props = {
  projectId: string;
  paneId: SlotKey;
};

// Used only when the workspace has not yet loaded its global settings.
// Once settings are available we seed the draft composer from them so the
// user's configured defaults (model, effort, mode, approval, tier) take
// precedence over these hard-coded fallbacks.
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

// Keeps the draft composer's model/effort/tier toggles accurate before any
// thread has been opened (and therefore before real env capabilities have
// been hydrated into the conversation store). The fallback mirrors the
// defaults the backend advertises for Codex, including fast-mode support.
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

function pickCapabilitiesForProject(
  cache: Record<string, EnvironmentCapabilitiesSnapshot>,
  project: ProjectRecord | undefined,
  preferredEnvId: string,
): EnvironmentCapabilitiesSnapshot | null {
  if (cache[preferredEnvId]) return cache[preferredEnvId];
  if (!project) return null;
  return (
    project.environments.map((env) => cache[env.id]).find(Boolean) ?? null
  );
}

function orderBranchesWithDefaults(branches: string[]): string[] {
  const priority = PRIORITY_BRANCHES.filter((name) => branches.includes(name));
  const rest = branches
    .filter((name) => !PRIORITY_SET.has(name))
    .sort((a, b) => a.localeCompare(b));
  return [...priority, ...rest];
}

function findLatestActiveThreadId(environment: EnvironmentRecord | null): string | null {
  return (
    [...(environment?.threads ?? [])]
      .filter((thread) => thread.status === "active")
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )[0]?.id ?? null
  );
}

export function ThreadDraftComposer({ projectId, paneId }: Props) {
  const project = useWorkspaceStore((state) =>
    selectProjects(state).find((candidate) => candidate.id === projectId),
  );
  const settings = useWorkspaceStore(selectSettings);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ConversationImageAttachment[]>([]);
  const [mentionBindings, setMentionBindings] = useState<
    ComposerDraftMentionBinding[]
  >([]);
  const [composer, setComposer] = useState<ConversationComposerSettings>(() =>
    settings ? composerFromSettings(settings) : BOOTSTRAP_COMPOSER,
  );
  const [selection, setSelection] = useState<EnvSelection>({ kind: "local" });
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localEnvironment =
    project?.environments.find((env) => env.kind === "local") ?? null;
  const worktreeEnvironments =
    project?.environments.filter((env) => env.kind !== "local") ?? [];

  useEffect(() => {
    let cancelled = false;
    bridge
      .listProjectBranches(projectId)
      .then((next) => {
        if (cancelled) return;
        setBranches(orderBranchesWithDefaults(next));
        setBranchesLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBranchesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Branches are already ordered with main/master first, so branches[0]
  // naturally gives the preferred default.
  const defaultBaseBranch =
    branches[0] ?? localEnvironment?.gitBranch ?? null;

  // Realign the selection's baseBranch when the user's previously-picked
  // branch disappears from the listing. An empty baseBranch is a valid
  // state — it tells the backend to pick the repository default, which is
  // how detached-HEAD / no-local-branch repos still land on a sensible
  // base.
  useEffect(() => {
    if (selection.kind !== "new" || !branchesLoaded) return;
    if (selection.baseBranch.length === 0) return;
    if (branches.includes(selection.baseBranch)) return;
    const fallback = defaultBaseBranch ?? "";
    if (fallback === selection.baseBranch) return;
    setSelection({ ...selection, baseBranch: fallback });
  }, [selection, branches, branchesLoaded, defaultBaseBranch]);

  const resolvedComposerEnvId =
    (selection.kind === "existing"
      ? selection.environmentId
      : localEnvironment?.id) ?? "draft";
  const selectedComposerEnvironment =
    selection.kind === "existing"
      ? (worktreeEnvironments.find(
          (environment) => environment.id === selection.environmentId,
        ) ?? null)
      : selection.kind === "local"
        ? localEnvironment
        : null;
  const composerTransportThreadId =
    findLatestActiveThreadId(selectedComposerEnvironment);

  const capabilities = useConversationStore((state) =>
    pickCapabilitiesForProject(
      state.capabilitiesByEnvironmentId,
      project,
      resolvedComposerEnvId,
    ),
  );
  const cachedModels = capabilities?.models ?? [];
  // When the user has already hydrated a thread somewhere in this project we
  // reuse its capabilities verbatim. Otherwise we fall back to a synthetic
  // gpt-5.4 option so model/effort/fast-mode toggles stay accurate in the
  // draft composer — the real capabilities will refresh once the thread is
  // actually created.
  const modelOptions: ModelOption[] =
    cachedModels.length > 0 ? cachedModels : FALLBACK_MODEL_OPTIONS;
  const collaborationModes: CollaborationModeOption[] =
    capabilities?.collaborationModes ?? FALLBACK_COLLABORATION_MODES;
  const selectedModel =
    modelOptions.find((candidate) => candidate.id === composer.model) ?? null;
  const effortOptions: ReasoningEffort[] =
    selectedModel?.supportedReasoningEfforts ?? FALLBACK_EFFORT_OPTIONS;

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
        projectId,
        selection,
        text: sendText,
        images: sendImages,
        mentionBindings: sendMentionBindings,
        composer,
      });
      if (!result.ok) {
        setError(result.error);
        setIsSending(false);
      }
      // On success, the pane switches to the thread view — this component
      // unmounts before setIsSending(false) runs.
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Failed to send message",
      );
      setIsSending(false);
    }
  }

  if (!project) {
    return (
      <div className="tx-conversation thread-draft">
        <p className="thread-draft__empty">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="tx-conversation thread-draft">
      <div className="tx-conversation__meta">
        <div>
          <h2 className="tx-conversation__title">New thread</h2>
          <p className="tx-conversation__subtitle">{project.name}</p>
        </div>
      </div>
      <div className="tx-conversation__timeline">
        <div className="tx-conversation__empty">
          <ThreadIcon size={20} />
          <h3>Start a conversation</h3>
          <p>Type a message below to begin</p>
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
        transportEnabled={composerTransportThreadId !== null}
        transportThreadId={composerTransportThreadId}
        voiceEnabled={resolvedComposerEnvId !== "draft"}
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
        localEnvironment={localEnvironment}
        worktreeEnvironments={worktreeEnvironments}
        availableBranches={branches}
        branchesLoading={!branchesLoaded}
        defaultBaseBranch={defaultBaseBranch}
        value={selection}
        onChange={setSelection}
        disabled={isSending}
      />
      {error ? <p className="thread-draft__error">{error}</p> : null}
    </div>
  );
}
