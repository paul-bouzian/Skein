import { create } from "zustand";

export type TerminalTab = {
  id: string;
  title: string;
};

export type EnvironmentTerminalUiState = {
  open: boolean;
  heightPx: number;
  tabs: TerminalTab[];
  activeTerminalId: string | null;
};

type TerminalStoreState = {
  environments: Record<string, EnvironmentTerminalUiState>;
  ensurePanel: (environmentId: string) => string;
  togglePanel: (environmentId: string) => string | null;
  createTerminal: (environmentId: string) => string;
  closeTerminal: (environmentId: string, terminalId: string) => void;
  setActiveTerminal: (environmentId: string, terminalId: string) => void;
  setHeight: (environmentId: string, heightPx: number) => void;
  pruneEnvironments: (environmentIds: string[]) => void;
};

const STORAGE_KEY = "threadex-terminal-ui:v1";
export const DEFAULT_TERMINAL_HEIGHT_PX = 280;
export const MIN_TERMINAL_HEIGHT_PX = 160;
export const MAX_TERMINAL_HEIGHT_RATIO = 0.65;

const EMPTY_TERMINAL_UI_STATE: Readonly<EnvironmentTerminalUiState> =
  Object.freeze({
    open: false,
    heightPx: DEFAULT_TERMINAL_HEIGHT_PX,
    tabs: [],
    activeTerminalId: null,
  });

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  environments: readStoredEnvironments(),

  ensurePanel: (environmentId) => {
    const existing = get().environments[environmentId];
    if (existing && existing.tabs.length > 0) {
      const activeTerminalId = resolveActiveTerminalId(existing);
      persistTerminalState(
        updateStore(set, (state) => ({
          environments: {
            ...state.environments,
            [environmentId]: {
              ...existing,
              open: true,
              activeTerminalId,
            },
          },
        })),
      );
      return activeTerminalId ?? createTerminalInStore(set, environmentId);
    }

    return createTerminalInStore(set, environmentId);
  },

  togglePanel: (environmentId) => {
    const existing = get().environments[environmentId];
    if (existing?.open) {
      persistTerminalState(
        updateStore(set, (state) => ({
          environments: {
            ...state.environments,
            [environmentId]: {
              ...existing,
              open: false,
            },
          },
        })),
      );
      return null;
    }
    return get().ensurePanel(environmentId);
  },

  createTerminal: (environmentId) => createTerminalInStore(set, environmentId),

  closeTerminal: (environmentId, terminalId) =>
    persistTerminalState(
      updateStore(set, (state) => {
        const current =
          state.environments[environmentId] ?? EMPTY_TERMINAL_UI_STATE;
        const remainingTabs = renumberTerminalTabs(
          current.tabs.filter((tab) => tab.id !== terminalId),
        );
        if (remainingTabs.length === 0) {
          return {
            environments: {
              ...state.environments,
              [environmentId]: {
                ...current,
                open: false,
                tabs: [],
                activeTerminalId: null,
              },
            },
          };
        }

        const activeTerminalId = resolveActiveTerminalId({
          ...current,
          tabs: remainingTabs,
          activeTerminalId:
            current.activeTerminalId === terminalId
              ? null
              : current.activeTerminalId,
        });

        return {
          environments: {
            ...state.environments,
            [environmentId]: {
              ...current,
              tabs: remainingTabs,
              activeTerminalId,
            },
          },
        };
      }),
    ),

  setActiveTerminal: (environmentId, terminalId) =>
    persistTerminalState(
      updateStore(set, (state) => {
        const current = state.environments[environmentId];
        if (!current?.tabs.some((tab) => tab.id === terminalId)) {
          return state;
        }

        return {
          environments: {
            ...state.environments,
            [environmentId]: {
              ...current,
              activeTerminalId: terminalId,
            },
          },
        };
      }),
    ),

  setHeight: (environmentId, heightPx) =>
    persistTerminalState(
      updateStore(set, (state) => {
        const current =
          state.environments[environmentId] ?? EMPTY_TERMINAL_UI_STATE;
        return {
          environments: {
            ...state.environments,
            [environmentId]: {
              ...current,
              heightPx: Math.max(MIN_TERMINAL_HEIGHT_PX, Math.round(heightPx)),
            },
          },
        };
      }),
    ),

  pruneEnvironments: (environmentIds) =>
    persistTerminalState(
      updateStore(set, (state) => {
        const validIds = new Set(environmentIds);
        const nextEnvironments = Object.fromEntries(
          Object.entries(state.environments).filter(([environmentId]) =>
            validIds.has(environmentId),
          ),
        );
        if (
          Object.keys(nextEnvironments).length ===
          Object.keys(state.environments).length
        ) {
          return state;
        }
        return { environments: nextEnvironments };
      }),
    ),
}));

export function selectEnvironmentTerminalUi(environmentId: string | null) {
  return (state: TerminalStoreState): EnvironmentTerminalUiState =>
    (environmentId ? state.environments[environmentId] : null) ??
    EMPTY_TERMINAL_UI_STATE;
}

function createTerminalInStore(
  set: (
    partial:
      | TerminalStoreState
      | Partial<TerminalStoreState>
      | ((
          state: TerminalStoreState,
        ) => TerminalStoreState | Partial<TerminalStoreState>),
  ) => void,
  environmentId: string,
) {
  const terminalId = createTerminalId();
  persistTerminalState(
    updateStore(set, (state) => {
      const current =
        state.environments[environmentId] ?? EMPTY_TERMINAL_UI_STATE;
      const tabs = renumberTerminalTabs([
        ...current.tabs,
        { id: terminalId, title: "" },
      ]);
      return {
        environments: {
          ...state.environments,
          [environmentId]: {
            ...current,
            open: true,
            tabs,
            activeTerminalId: terminalId,
          },
        },
      };
    }),
  );
  return terminalId;
}

function resolveActiveTerminalId(state: EnvironmentTerminalUiState) {
  if (
    state.activeTerminalId &&
    state.tabs.some((tab) => tab.id === state.activeTerminalId)
  ) {
    return state.activeTerminalId;
  }
  return state.tabs[state.tabs.length - 1]?.id ?? null;
}

function createTerminalId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renumberTerminalTabs(tabs: TerminalTab[]): TerminalTab[] {
  return tabs.map((tab, index) => ({
    ...tab,
    title: `Terminal ${index + 1}`,
  }));
}

function readStoredEnvironments(): Record<string, EnvironmentTerminalUiState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<
      string,
      EnvironmentTerminalUiState
    >;
    return Object.fromEntries(
      Object.entries(parsed).map(([environmentId, value]) => [
        environmentId,
        normalizeEnvironmentState(value),
      ]),
    );
  } catch {
    return {};
  }
}

function persistTerminalState(partial: Partial<TerminalStoreState>) {
  if (!partial.environments) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(partial.environments));
  } catch {
    /* ignore persistence failures */
  }
}

function updateStore(
  set: (
    partial:
      | TerminalStoreState
      | Partial<TerminalStoreState>
      | ((
          state: TerminalStoreState,
        ) => TerminalStoreState | Partial<TerminalStoreState>),
  ) => void,
  updater: (
    state: TerminalStoreState,
  ) => TerminalStoreState | Partial<TerminalStoreState>,
) {
  let nextState: TerminalStoreState | Partial<TerminalStoreState> | null = null;
  set((state) => {
    nextState = updater(state);
    return nextState;
  });
  return nextState ?? {};
}

function normalizeEnvironmentState(
  value: EnvironmentTerminalUiState | undefined,
): EnvironmentTerminalUiState {
  if (!value) {
    return { ...EMPTY_TERMINAL_UI_STATE };
  }

  const tabs = renumberTerminalTabs(value.tabs ?? []);
  const activeTerminalId = tabs.some((tab) => tab.id === value.activeTerminalId)
    ? value.activeTerminalId
    : (tabs[0]?.id ?? null);

  return {
    open: Boolean(value.open) && tabs.length > 0,
    heightPx: Math.max(
      MIN_TERMINAL_HEIGHT_PX,
      Math.round(value.heightPx ?? DEFAULT_TERMINAL_HEIGHT_PX),
    ),
    tabs,
    activeTerminalId,
  };
}
