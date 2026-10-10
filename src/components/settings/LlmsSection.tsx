import { memo, useMemo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { BookOpen, Languages, MessageSquare, Sparkles, Wand2 } from "../icons";
import { usePolicyStore } from "../../stores/policyStore";
import { isAgentAllowed } from "../../stores/policyRules";
import { useSettingsStore } from "../../stores/settingsStore";
import { ProviderTabs } from "../ui/ProviderTabs";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import PromptStudio from "../ui/PromptStudio";
import ChatAgentSettings from "./ChatAgentSettings";
import DictationAgentSettings from "./DictationAgentSettings";
import DictationTranslationSettings from "./DictationTranslationSettings";
import GpuDeviceSelector from "./GpuDeviceSelector";
import InferenceConfigEditor from "./InferenceConfigEditor";
import { KeepAlive, TabPanel } from "./KeepAlive";
import type { InferenceMode } from "../../types/electron";
import {
  LLM_TABS,
  AGENT_LLM_TABS,
  type LlmTab,
  type SettingsNavigationStore,
} from "../../stores/settingsNavigationStore";
const NON_AGENT_LLM_TABS = LLM_TABS.filter((tabId) => !AGENT_LLM_TABS.has(tabId));

const CLEANUP_MODE_TOAST_KEY: Record<InferenceMode, string> = {
  openwhispr: "switchedCloud",
  providers: "switchedProviders",
  local: "switchedLocal",
  "self-hosted": "switchedSelfHosted",
  enterprise: "switchedEnterprise",
};

function CleanupSettings({ navigation }: { navigation: SettingsNavigationStore }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const useCleanupModel = useSettingsStore((settings) => settings.useCleanupModel);
  const setUseCleanupModel = useSettingsStore((settings) => settings.setUseCleanupModel);

  const handleCleanupModeChange = (mode: InferenceMode) => {
    const toastKey = CLEANUP_MODE_TOAST_KEY[mode];
    toast({
      title: t(`settingsPage.aiModels.toasts.${toastKey}.title`),
      description: t(`settingsPage.aiModels.toasts.${toastKey}.description`),
      variant: "success",
      duration: 3000,
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.aiModels.enableTextCleanup")}
              description={t("settingsPage.aiModels.enableTextCleanupDescription")}
            >
              <Toggle
                ariaLabel={t("settingsPage.aiModels.enableTextCleanup")}
                checked={useCleanupModel}
                onChange={setUseCleanupModel}
              />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>

        {useCleanupModel && (
          <>
            <InferenceConfigEditor
              scope="dictationCleanup"
              navigation={navigation}
              onModeChange={handleCleanupModeChange}
            />
            <GpuDeviceSelector purpose="intelligence" />
          </>
        )}
      </div>
      <div className="border-t border-border/70 pt-6">
        <SectionHeader
          title={t("settingsPage.prompts.title")}
          description={t("settingsPage.prompts.description")}
        />
        <PromptStudio />
      </div>
    </div>
  );
}

function NoteFormattingSettings({ navigation }: { navigation: SettingsNavigationStore }) {
  const { t } = useTranslation();
  const autoGenerateNoteTitle = useSettingsStore((settings) => settings.autoGenerateNoteTitle);
  const setAutoGenerateNoteTitle = useSettingsStore(
    (settings) => settings.setAutoGenerateNoteTitle
  );

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.noteFormatting.autoGenerateTitle")}
            description={t("settingsPage.noteFormatting.autoGenerateTitleDescription")}
          >
            <Toggle
              ariaLabel={t("settingsPage.noteFormatting.autoGenerateTitle")}
              checked={autoGenerateNoteTitle}
              onChange={setAutoGenerateNoteTitle}
            />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
      <InferenceConfigEditor scope="noteFormatting" navigation={navigation} />
    </div>
  );
}

const LlmsTabs = memo(function LlmsTabs({ navigation }: { navigation: SettingsNavigationStore }) {
  const { t } = useTranslation();
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const visibleTabIds = agentAllowed ? LLM_TABS : NON_AGENT_LLM_TABS;
  const tab = useStore(navigation, (state) => state.llmTab ?? "dictationCleanup");
  const selectTab = useStore(navigation, (state) => state.selectLlmTab);
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<LlmTab>>(() => new Set([tab]));
  if (!visitedTabs.has(tab)) setVisitedTabs(new Set(visitedTabs).add(tab));
  const content = useMemo(
    () => ({
      dictationCleanup: <CleanupSettings navigation={navigation} />,
      dictationAgent: <DictationAgentSettings navigation={navigation} />,
      dictationTranslation: <DictationTranslationSettings navigation={navigation} />,
      noteFormatting: <NoteFormattingSettings navigation={navigation} />,
      chatIntelligence: <ChatAgentSettings navigation={navigation} />,
    }),
    [navigation]
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const removedFocusedPanel = useRef<HTMLDivElement | null>(null);
  const captureRemovedPanelFocus = useCallback((panel: HTMLDivElement | null) => {
    if (!panel) return;
    // Ref cleanup runs at removal, before the panel's DOM disappears. Unlike
    // a last-focus event, this cannot retain a control removed on an earlier edit.
    return () => {
      if (panel.contains(panel.ownerDocument.activeElement)) removedFocusedPanel.current = panel;
    };
  }, []);

  useLayoutEffect(() => {
    const panel = removedFocusedPanel.current;
    removedFocusedPanel.current = null;
    const root = rootRef.current;
    if (
      agentAllowed ||
      !panel ||
      panel.isConnected ||
      !root ||
      root.closest("[hidden]") ||
      root.ownerDocument.activeElement !== root.ownerDocument.body
    )
      return;
    root.querySelector<HTMLButtonElement>(`[data-tab-id="${tab}"]`)?.focus();
  }, [agentAllowed, tab]);

  const subTabs = [
    { id: "dictationCleanup", name: t("settingsPage.llms.tabs.dictationCleanup") },
    { id: "dictationAgent", name: t("settingsPage.llms.tabs.dictationAgent") },
    { id: "dictationTranslation", name: t("settingsPage.llms.tabs.dictationTranslation") },
    { id: "noteFormatting", name: t("settingsPage.llms.tabs.noteFormatting") },
    { id: "chatIntelligence", name: t("settingsPage.llms.tabs.chatIntelligence") },
  ].filter((item) => visibleTabIds.includes(item.id as LlmTab));

  return (
    <div ref={rootRef} className="space-y-4">
      <SectionHeader
        title={t("settingsPage.llms.title")}
        description={t("settingsPage.llms.description")}
      />
      <ProviderTabs
        providers={subTabs}
        selectedId={tab}
        onSelect={(id) => selectTab(id as LlmTab)}
        renderIcon={(id) => {
          if (id === "dictationCleanup") return <Wand2 className="w-3.5 h-3.5" />;
          if (id === "dictationAgent") return <Sparkles className="w-3.5 h-3.5" />;
          if (id === "dictationTranslation") return <Languages className="w-3.5 h-3.5" />;
          if (id === "noteFormatting") return <BookOpen className="w-3.5 h-3.5" />;
          return <MessageSquare className="w-3.5 h-3.5" />;
        }}
      />
      {(tab === "dictationCleanup" || visitedTabs.has("dictationCleanup")) && (
        <TabPanel active={tab === "dictationCleanup"}>{content.dictationCleanup}</TabPanel>
      )}
      {agentAllowed && (tab === "dictationAgent" || visitedTabs.has("dictationAgent")) && (
        <TabPanel active={tab === "dictationAgent"} ref={captureRemovedPanelFocus}>
          {content.dictationAgent}
        </TabPanel>
      )}
      {(tab === "dictationTranslation" || visitedTabs.has("dictationTranslation")) && (
        <TabPanel active={tab === "dictationTranslation"}>{content.dictationTranslation}</TabPanel>
      )}
      {(tab === "noteFormatting" || visitedTabs.has("noteFormatting")) && (
        <TabPanel active={tab === "noteFormatting"}>{content.noteFormatting}</TabPanel>
      )}
      {agentAllowed && (tab === "chatIntelligence" || visitedTabs.has("chatIntelligence")) && (
        <TabPanel active={tab === "chatIntelligence"} ref={captureRemovedPanelFocus}>
          {content.chatIntelligence}
        </TabPanel>
      )}
    </div>
  );
});

export default function LlmsKeepAlive({ navigation }: { navigation: SettingsNavigationStore }) {
  const active = useStore(navigation, (state) => state.section === "llms");
  return (
    <KeepAlive active={active}>
      <LlmsTabs navigation={navigation} />
    </KeepAlive>
  );
}
