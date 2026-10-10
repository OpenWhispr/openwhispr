import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type SettingsSectionType =
  | "account"
  | "plansBilling"
  | "workspace"
  | "general"
  | "hotkeys"
  | "speechToText"
  | "llms"
  | "privacyData"
  | "system";
export const SPEECH_TABS = ["dictation", "noteRecording", "upload"] as const;
export type SpeechTab = (typeof SPEECH_TABS)[number];
export const LLM_TABS = [
  "dictationCleanup",
  "dictationAgent",
  "dictationTranslation",
  "noteFormatting",
  "chatIntelligence",
] as const;
export type LlmTab = (typeof LLM_TABS)[number];
export const AGENT_LLM_TABS = new Set<LlmTab>(["dictationAgent", "chatIntelligence"]);

const SECTIONS = new Set<string>([
  "account",
  "plansBilling",
  "workspace",
  "general",
  "hotkeys",
  "speechToText",
  "llms",
  "privacyData",
  "system",
]);
// Legacy aliases remain requests, not saved section preferences.
const ALIASES: Record<string, SettingsSectionType> = {
  aiModels: "llms",
  agentConfig: "llms",
  agentMode: "llms",
  dictationAgent: "llms",
  intelligence: "llms",
  meetings: "llms",
  prompts: "llms",
  transcription: "speechToText",
  uploadTranscription: "speechToText",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};
const ALIAS_TABS: Record<string, LlmTab | SpeechTab> = {
  transcription: "dictation",
  uploadTranscription: "upload",
  dictationAgent: "dictationAgent",
  meetings: "noteFormatting",
  intelligence: "dictationCleanup",
  agentMode: "chatIntelligence",
  agentConfig: "chatIntelligence",
  aiModels: "dictationCleanup",
  prompts: "dictationCleanup",
};
const LLM_KEY = "settings.llmsTab";
const SPEECH_KEY = "settings.speechToTextTab";

function readTab(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function persistTab(key: string, tab: string): boolean {
  try {
    const value = JSON.stringify(tab);
    if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.error(`Error setting localStorage key "${key}":`, error);
    return false;
  }
}
function speechTab(value: unknown): SpeechTab {
  return SPEECH_TABS.includes(value as SpeechTab) ? (value as SpeechTab) : "dictation";
}
function llmTab(value: unknown, agentAllowed: boolean): LlmTab {
  return LLM_TABS.includes(value as LlmTab) &&
    (agentAllowed || !AGENT_LLM_TABS.has(value as LlmTab))
    ? (value as LlmTab)
    : "dictationCleanup";
}

interface NavigationState {
  section: SettingsSectionType | null;
  speechTab: SpeechTab | null;
  llmTab: LlmTab | null;
  gpuBannerDismissed: boolean;
  dismissGpuBanner: () => void;
  openSettings: (section?: string) => void;
  setSettingsOpen: (open: boolean) => void;
  selectSpeechTab: (tab: string) => void;
  selectLlmTab: (tab: string) => void;
  reconcilePolicy: () => void;
  persistCurrentTab: () => void;
}

// A private instance belongs to one host. Construction reads but never writes
// preferences, so a StrictMode initializer may safely allocate it twice.
export function createSettingsNavigationStore(
  initialSection?: string,
  readAgentAllowed: () => boolean = () => true
) {
  const resolve = (request: string): SettingsSectionType =>
    ALIASES[request] ?? (SECTIONS.has(request) ? (request as SettingsSectionType) : "account");
  const initial: Pick<NavigationState, "section" | "speechTab" | "llmTab"> = {
    section: initialSection ? resolve(initialSection) : null,
    speechTab: null,
    llmTab: null,
  };
  const prepare = (current: typeof initial, request: string): typeof initial => {
    const section = resolve(request);
    return {
      section,
      speechTab:
        section === "speechToText"
          ? speechTab(ALIAS_TABS[request] ?? current.speechTab ?? readTab(SPEECH_KEY))
          : current.speechTab,
      llmTab:
        section === "llms"
          ? llmTab(ALIAS_TABS[request] ?? current.llmTab ?? readTab(LLM_KEY), readAgentAllowed())
          : current.llmTab,
    };
  };
  const state = initialSection ? prepare(initial, initialSection) : initial;
  return createStore<NavigationState>()((set, get) => ({
    ...state,
    gpuBannerDismissed: (() => {
      try {
        return localStorage.getItem("gpuBannerDismissedUnified") === "true";
      } catch {
        return false;
      }
    })(),
    dismissGpuBanner: () => {
      set({ gpuBannerDismissed: true });
      localStorage.setItem("gpuBannerDismissedUnified", "true");
    },
    openSettings: (request) => {
      const current = get();
      if (!request && current.section !== null) return;
      set(prepare(current, request || "account"));
      get().persistCurrentTab();
    },
    setSettingsOpen: (open) => {
      if (open) get().openSettings();
      else set({ section: null, speechTab: null, llmTab: null });
    },
    selectSpeechTab: (requested) => {
      if (get().section === null) return;
      const next = speechTab(requested);
      if (persistTab(SPEECH_KEY, next)) set({ speechTab: next });
    },
    selectLlmTab: (requested) => {
      if (get().section === null) return;
      const next = llmTab(requested, readAgentAllowed());
      if (persistTab(LLM_KEY, next)) set({ llmTab: next });
    },
    reconcilePolicy: () => {
      const current = get().llmTab;
      if (current && !readAgentAllowed() && AGENT_LLM_TABS.has(current)) {
        set({ llmTab: "dictationCleanup" });
        persistTab(LLM_KEY, "dictationCleanup");
      }
    },
    persistCurrentTab: () => {
      const current = get();
      if (current.section === "speechToText" && current.speechTab)
        persistTab(SPEECH_KEY, current.speechTab);
      if (current.section === "llms" && current.llmTab) persistTab(LLM_KEY, current.llmTab);
    },
  }));
}
export type SettingsNavigationStore = ReturnType<typeof createSettingsNavigationStore>;

// Non-Settings callers do not opt into navigation visibility. This untouched
// store supplies useStore's stable subscription API, not global navigation.
const outsideSettings = createSettingsNavigationStore();
export function useSettingsModelVisible(
  navigation: SettingsNavigationStore | undefined,
  section: "speechToText" | "llms",
  tab: string
): boolean {
  return useStore(
    navigation ?? outsideSettings,
    (state) =>
      !navigation ||
      (state.section === section && (section === "llms" ? state.llmTab : state.speechTab) === tab)
  );
}
