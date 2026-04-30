import { useEffect, useMemo, useRef, useState } from "react";

import skeinAppIcon from "../../../../desktop-backend/icons/icon.png";
import * as bridge from "../../../lib/bridge";
import type {
  CollaborationModeOption,
  ComposerDraftMentionBinding,
  ComposerMentionBindingInput,
  ConversationComposerDraft,
  ConversationComposerSettings,
  ConversationImageAttachment,
  ConversationMessageItem,
  DraftProjectSelection,
  ModelOption,
  ReasoningEffort,
  SavedDraftThreadState,
} from "../../../lib/types";
import { useConversationStore } from "../../../stores/conversation-store";
import { EMPTY_CONVERSATION_COMPOSER_DRAFT } from "../../../stores/conversation-drafts";
import {
  composerFromSettings,
  defaultProjectSelectionFromSettings,
  draftThreadTargetKey,
} from "../../../stores/draft-threads";
import {
  selectDraftThreadState,
  selectProjects,
  selectSettings,
  useWorkspaceStore,
  type SlotKey,
  type ThreadDraftState,
} from "../../../stores/workspace-store";
import { ProjectIcon } from "../../../shared/ProjectIcon";
import { InlineComposer } from "../composer/InlineComposer";
import { ConversationItemRow } from "../ConversationItemRow";
import { sortModelOptionsByPreference } from "../composerOptions";
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
  provider: "codex",
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
  "max",
];

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  {
    provider: "codex",
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Latest OpenAI model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: false,
  },
  {
    provider: "codex",
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Primary OpenAI model.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: true,
  },
  {
    provider: "codex",
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "Fast OpenAI model for simpler coding tasks.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: false,
  },
  {
    provider: "codex",
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    description: "Coding-optimized OpenAI model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: false,
  },
  {
    provider: "codex",
    id: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    description: "Low-latency OpenAI coding model.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: false,
  },
  {
    provider: "codex",
    id: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    description: "Previous Codex model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: false,
  },
  {
    provider: "codex",
    id: "gpt-5.2",
    displayName: "GPT-5.2",
    description: "Previous OpenAI model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    description: "Most capable Anthropic model for complex agentic coding.",
    defaultReasoningEffort: "xhigh",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-opus-4-7[1m]",
    displayName: "Claude Opus 4.7 1M",
    description: "Claude Opus 4.7 with the 1M-token context window enabled.",
    defaultReasoningEffort: "xhigh",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "Previous Anthropic Opus model with fast mode support.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-opus-4-6[1m]",
    displayName: "Claude Opus 4.6 1M",
    description: "Claude Opus 4.6 with the 1M-token context window enabled.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: ["fast"],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-opus-4-5",
    displayName: "Claude Opus 4.5",
    description: "Anthropic Opus model.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: [],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-opus-4-5[1m]",
    displayName: "Claude Opus 4.5 1M",
    description: "Claude Opus 4.5 with the 1M-token context window enabled.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: [],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Balanced Anthropic model.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: [],
    supportsThinking: true,
    isDefault: true,
  },
  {
    provider: "claude",
    id: "claude-sonnet-4-6[1m]",
    displayName: "Claude Sonnet 4.6 1M",
    description: "Claude Sonnet 4.6 with the 1M-token context window enabled.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: [],
    supportsThinking: true,
    isDefault: false,
  },
  {
    provider: "claude",
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Fast Anthropic model for simple scoped coding tasks.",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low"],
    inputModalities: ["text", "image"],
    supportedServiceTiers: [],
    supportsThinking: false,
    isDefault: false,
  },
];

const PRIORITY_BRANCHES = ["main", "master"] as const;
const PRIORITY_SET: ReadonlySet<string> = new Set(PRIORITY_BRANCHES);
function draftModelOptionsWithFallbacks(models: ModelOption[]): ModelOption[] {
  if (models.length === 0) {
    return FALLBACK_MODEL_OPTIONS;
  }

  const merged = new Map<string, ModelOption>();
  for (const model of models) {
    merged.set(modelOptionKey(model), model);
  }
  for (const fallback of FALLBACK_MODEL_OPTIONS) {
    if (!merged.has(modelOptionKey(fallback))) {
      merged.set(modelOptionKey(fallback), fallback);
    }
  }

  return sortModelOptionsByPreference([...merged.values()]);
}

function modelOptionKey(model: Pick<ModelOption, "id" | "provider">) {
  return `${model.provider ?? "codex"}:${model.id}`;
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
  const settings = useWorkspaceStore(selectSettings);
  const persistedDraftState = useWorkspaceStore(selectDraftThreadState(draft));
  const hydrateDraftThreadState = useWorkspaceStore(
    (state) => state.hydrateDraftThreadState,
  );
  const updateDraftThreadState = useWorkspaceStore(
    (state) => state.updateDraftThreadState,
  );
  const moveDraftThreadState = useWorkspaceStore(
    (state) => state.moveDraftThreadState,
  );
  const updateThreadDraftTarget = useWorkspaceStore(
    (state) => state.updateThreadDraftTarget,
  );
  const tryLoadEnvironmentCapabilities = useConversationStore(
    (state) => state.tryLoadEnvironmentCapabilities,
  );
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(draft.kind === "chat");
  const [isSending, setIsSending] = useState(false);
  const [isRetargeting, setIsRetargeting] = useState(false);
  const [hasSentOnce, setHasSentOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimisticMessage, setOptimisticMessage] =
    useState<ConversationMessageItem | null>(null);
  const sendSequenceRef = useRef(0);
  const activeSendRef = useRef<{
    id: number;
    cancelled: boolean;
    rollbackDraft: ConversationComposerDraft;
  } | null>(null);

  // Reset send-related layout state whenever the draft target changes —
  // the component is reused in-place when the user retargets the same pane.
  const draftKey = draftThreadTargetKey(draft);
  useEffect(() => {
    setHasSentOnce(false);
    setOptimisticMessage(null);
    setError(null);
    setIsSending(false);
    setIsRetargeting(false);
    if (activeSendRef.current) {
      activeSendRef.current.cancelled = true;
    }
    activeSendRef.current = null;
  }, [draftKey]);

  useEffect(() => {
    void hydrateDraftThreadState(draft);
  }, [draft, hydrateDraftThreadState]);

  const composer =
    persistedDraftState?.composer ??
    (settings ? composerFromSettings(settings) : BOOTSTRAP_COMPOSER);
  const composerDraft = persistedDraftState?.composerDraft ?? {
    text: "",
    images: [],
    mentionBindings: [],
    isRefiningPlan: false,
  };
  const defaultProjectSelection = useMemo<EnvSelection>(
    () =>
      settings ? defaultProjectSelectionFromSettings(settings) : { kind: "local" },
    [settings],
  );
  const selection = useMemo<EnvSelection>(
    () =>
      draft.kind === "project"
        ? ((persistedDraftState?.projectSelection as EnvSelection | null) ??
          defaultProjectSelection)
        : { kind: "local" },
    [defaultProjectSelection, draft, persistedDraftState?.projectSelection],
  );
  const project = useMemo(
    () =>
      draft.kind === "project"
        ? (projects.find((candidate) => candidate.id === draft.projectId) ??
          null)
        : null,
    [draft, projects],
  );

  const localEnvironment = useMemo(
    () =>
      project?.environments.find(
        (environment) => environment.kind === "local",
      ) ?? null,
    [project],
  );
  const worktreeEnvironments = useMemo(
    () =>
      project?.environments.filter(
        (environment) => environment.kind !== "local",
      ) ?? [],
    [project],
  );

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
    if (draft.kind !== "project" || selection.kind !== "new" || !branchesLoaded)
      return;
    if (selection.baseBranch.length === 0) return;
    if (branches.includes(selection.baseBranch)) return;
    const fallback = defaultBaseBranch ?? "";
    if (fallback === selection.baseBranch) return;
    updateDraftThreadState(draft, (current) => ({
      ...current,
      projectSelection: { ...selection, baseBranch: fallback },
    }));
  }, [
    branches,
    branchesLoaded,
    defaultBaseBranch,
    draft,
    selection,
    updateDraftThreadState,
  ]);

  useEffect(() => {
    if (draft.kind !== "project" || selection.kind !== "existing") {
      return;
    }
    if (
      worktreeEnvironments.some(
        (environment) => environment.id === selection.environmentId,
      )
    ) {
      return;
    }
    updateDraftThreadState(draft, (current) => ({
      ...current,
      projectSelection: { kind: "local" },
    }));
  }, [draft, selection, updateDraftThreadState, worktreeEnvironments]);

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
            provider: composer.provider,
          },
    [composer.provider, resolvedComposerEnvId],
  );
  const chatCatalogTarget = useMemo(
    () => ({ kind: "chatWorkspace" as const, provider: composer.provider }),
    [composer.provider],
  );
  const catalogTarget =
    draft.kind === "chat" ? chatCatalogTarget : environmentCatalogTarget;
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
    draftModelOptionsWithFallbacks(cachedModels);
  const collaborationModes: CollaborationModeOption[] =
    capabilities?.collaborationModes ?? FALLBACK_COLLABORATION_MODES;
  const selectedModel =
    modelOptions.find(
      (candidate) =>
        candidate.id === composer.model &&
        (candidate.provider ?? "codex") === composer.provider,
    ) ?? null;
  const effortOptions: ReasoningEffort[] =
    selectedModel?.supportedReasoningEfforts ?? FALLBACK_EFFORT_OPTIONS;

  function handleLocationChange(next: DraftLocationSelection) {
    if (next.kind === "chat") {
      updateThreadDraftTarget(paneId, { kind: "chat" });
      return;
    }

    const nextTarget: ThreadDraftState = {
      kind: "project",
      projectId: next.projectId,
    };
    if (draft.kind === "chat") {
      void moveChatDraftToProject(next, nextTarget);
      return;
    }

    updateThreadDraftTarget(paneId, nextTarget);
    void hydrateDraftThreadState(nextTarget).then(() => {
      updateDraftThreadState(nextTarget, (current) => ({
        ...current,
        projectSelection: next.target as DraftProjectSelection,
      }));
    });
  }

  async function moveChatDraftToProject(
    next: DraftLocationSelection & { kind: "project" },
    nextTarget: ThreadDraftState,
  ) {
    const sourceTarget = draft;
    const fallbackSourceState: SavedDraftThreadState = {
      composerDraft: cloneComposerDraft(composerDraft),
      composer: { ...composer },
      projectSelection: null,
    };
    const sourceKey = draftThreadTargetKey(sourceTarget);
    let latestSourceState =
      selectDraftThreadState(sourceTarget)(useWorkspaceStore.getState()) ?? null;

    if (!latestSourceState) {
      setIsRetargeting(true);
      setError(null);
      await hydrateDraftThreadState(sourceTarget);
      const workspaceState = useWorkspaceStore.getState();
      const currentSlotDraft = workspaceState.draftBySlot[paneId] ?? null;
      if (
        !currentSlotDraft ||
        draftThreadTargetKey(currentSlotDraft) !== sourceKey
      ) {
        setIsRetargeting(false);
        return;
      }
      latestSourceState =
        selectDraftThreadState(sourceTarget)(workspaceState) ?? null;
      if (
        !latestSourceState &&
        workspaceState.draftHydrationByTargetKey[sourceKey] === "error"
      ) {
        setError("Unable to load the chat draft. Try moving it again.");
        setIsRetargeting(false);
        return;
      }
      setIsRetargeting(false);
    }

    const currentSlotDraft = useWorkspaceStore.getState().draftBySlot[paneId] ?? null;
    if (
      !currentSlotDraft ||
      draftThreadTargetKey(currentSlotDraft) !== sourceKey
    ) {
      return;
    }

    const sourceState = latestSourceState ?? fallbackSourceState;
    moveDraftThreadState(sourceTarget, nextTarget, {
      composerDraft: cloneComposerDraft(sourceState.composerDraft),
      composer: { ...sourceState.composer },
      projectSelection: next.target as DraftProjectSelection,
    });
    updateThreadDraftTarget(paneId, nextTarget);
  }

  async function handleSend(
    sendText: string,
    sendImages: ConversationImageAttachment[],
    sendMentionBindings: ComposerMentionBindingInput[],
    draftMentionBindings: ComposerDraftMentionBinding[],
  ) {
    if (isSending || isRetargeting) return;
    const previousComposerDraft = cloneComposerDraft(composerDraft);
    const activeSend = {
      id: ++sendSequenceRef.current,
      cancelled: false,
      rollbackDraft: previousComposerDraft,
    };
    activeSendRef.current = activeSend;
    const optimisticUserMessage = buildOptimisticUserMessage(
      sendText,
      sendImages,
    );
    setIsSending(true);
    setError(null);
    if (optimisticUserMessage) {
      setOptimisticMessage(optimisticUserMessage);
      setHasSentOnce(true);
      updateDraftThreadState(draft, (current) => ({
        ...current,
        composerDraft: cloneComposerDraft(EMPTY_CONVERSATION_COMPOSER_DRAFT),
      }));
    }
    try {
      const result = await sendThreadDraft({
        paneId,
        draft,
        persistedState: {
          composerDraft: previousComposerDraft,
          composer,
          projectSelection: draft.kind === "project" ? selection : null,
        },
        projectSelection: selection,
        text: sendText,
        images: sendImages,
        mentionBindings: sendMentionBindings,
        draftMentionBindings,
        isCancelled: () => activeSend.cancelled,
      });
      if (activeSendRef.current?.id !== activeSend.id) {
        return;
      }
      if (!result.ok && result.cancelled) {
        activeSendRef.current = null;
        return;
      }
      if (!result.ok) {
        setError(result.error);
        setOptimisticMessage(null);
        updateDraftThreadState(draft, (current) => ({
          ...current,
          composerDraft: previousComposerDraft,
        }));
        setIsSending(false);
        activeSendRef.current = null;
      }
    } catch (cause: unknown) {
      if (activeSendRef.current?.id !== activeSend.id) {
        return;
      }
      setError(
        cause instanceof Error ? cause.message : "Failed to send message",
      );
      setOptimisticMessage(null);
      updateDraftThreadState(draft, (current) => ({
        ...current,
        composerDraft: previousComposerDraft,
      }));
      setIsSending(false);
      activeSendRef.current = null;
    }
  }

  function handleDraftInterrupt() {
    if (!isSending) return;
    const activeSend = activeSendRef.current;
    if (activeSend) {
      activeSend.cancelled = true;
    }
    setOptimisticMessage(null);
    setIsSending(false);
    const rollbackDraft = activeSend?.rollbackDraft ?? null;
    if (rollbackDraft) {
      updateDraftThreadState(draft, (current) => ({
        ...current,
        composerDraft: rollbackDraft,
      }));
    }
  }

  if (draft.kind === "project" && !project) {
    return (
      <div className="tx-conversation thread-draft">
        <p className="thread-draft__empty">Project not found.</p>
      </div>
    );
  }

  const welcomeHeading =
    draft.kind === "chat"
      ? "How can I help?"
      : `What should we build in ${project?.name ?? "this project"}?`;

  return (
    <div
      className={`tx-conversation thread-draft ${
        hasSentOnce ? "thread-draft--sent" : "thread-draft--centered"
      }`}
    >
      {optimisticMessage ? (
        <div className="tx-conversation__timeline">
          <div className="thread-draft__optimistic">
            <ConversationItemRow
              item={optimisticMessage}
              provider={composer.provider}
            />
          </div>
        </div>
      ) : (
        <div className="thread-draft__centered-stack">
          <div className="thread-draft__welcome">
            {project ? (
              <ProjectIcon
                name={project.name}
                rootPath={project.rootPath}
                size="lg"
              />
            ) : (
              <img
                src={skeinAppIcon}
                alt=""
                className="thread-draft__welcome-logo"
              />
            )}
            <h2 className="thread-draft__welcome-heading">{welcomeHeading}</h2>
          </div>
        </div>
      )}
      <InlineComposer
        environmentId={resolvedComposerEnvId}
        threadId={`draft:${paneId}`}
        composer={composer}
        collaborationModes={collaborationModes}
        disabled={isRetargeting}
        draft={composerDraft.text}
        effortOptions={effortOptions}
        focusKey={`draft:${paneId}`}
        images={composerDraft.images}
        isBusy={isSending || isRetargeting}
        isSending={isSending}
        isRefiningPlan={false}
        mentionBindings={composerDraft.mentionBindings}
        modelOptions={modelOptions}
        catalogTarget={catalogTarget}
        fileSearchTarget={fileSearchTarget}
        imageSupportNoticeEnabled
        transportEnabled={transportEnabled}
        voiceEnabled={
          draft.kind === "project" && resolvedComposerEnvId !== "draft"
        }
        providerLocked={false}
        onChangeImages={(nextImages) =>
          updateDraftThreadState(draft, (current) => ({
            ...current,
            composerDraft: {
              ...current.composerDraft,
              images:
                typeof nextImages === "function"
                  ? nextImages(current.composerDraft.images)
                  : nextImages,
            },
          }))
        }
        onCancelRefine={() => undefined}
        onChangeDraft={(value, bindings) => {
          updateDraftThreadState(draft, (current) => ({
            ...current,
            composerDraft: {
              ...current.composerDraft,
              text: value,
              mentionBindings:
                bindings ?? current.composerDraft.mentionBindings,
            },
          }));
        }}
        onChangeMentionBindings={(nextMentionBindings) =>
          updateDraftThreadState(draft, (current) => ({
            ...current,
            composerDraft: {
              ...current.composerDraft,
              mentionBindings: nextMentionBindings,
            },
          }))
        }
        onInterrupt={handleDraftInterrupt}
        onSend={(
          next,
          nextImages,
          nextMentionBindings,
          draftMentionBindings,
        ) => {
          void handleSend(
            next,
            nextImages,
            nextMentionBindings,
            draftMentionBindings,
          );
        }}
        onUpdateComposer={(patch) =>
          updateDraftThreadState(draft, (current) => ({
            ...current,
            composer: {
              ...current.composer,
              ...patch,
            },
          }))
        }
      />
      <EnvironmentSelector
        projects={projects}
        defaultProjectTarget={defaultProjectSelection}
        localEnvironment={draft.kind === "project" ? localEnvironment : null}
        worktreeEnvironments={
          draft.kind === "project" ? worktreeEnvironments : []
        }
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
        disabled={isSending || isRetargeting}
      />
      {error ? <p className="thread-draft__error">{error}</p> : null}
    </div>
  );
}

function cloneComposerDraft(
  draft: ConversationComposerDraft,
): ConversationComposerDraft {
  return {
    text: draft.text,
    images: [...draft.images],
    mentionBindings: [...draft.mentionBindings],
    isRefiningPlan: draft.isRefiningPlan,
  };
}

function buildOptimisticUserMessage(
  text: string,
  images: ConversationImageAttachment[],
): ConversationMessageItem | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0 && images.length === 0) {
    return null;
  }
  return {
    kind: "message",
    id: `draft-optimistic-user-${Date.now()}`,
    turnId: null,
    role: "user",
    text: trimmedText,
    images: images.length > 0 ? [...images] : null,
    isStreaming: false,
  };
}
