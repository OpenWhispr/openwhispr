import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network, Building2 } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  SettingsPanel,
  SettingsPanelRow,
  SectionHeader,
  InferenceModeSelector,
} from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseSection from "../EnterpriseSection";
import SelfHostedPanel from "../SelfHostedPanel";
import PromptStudio from "../ui/PromptStudio";
import type { InferenceMode } from "../../types/electron";
import { modelRegistry, isEnterpriseProvider } from "../../models/ModelRegistry";

function isProviderValidForMode(provider: string, mode: InferenceMode): boolean {
  switch (mode) {
    case "providers":
      return modelRegistry.getCloudProviders().some((p) => p.id === provider);
    case "local":
      return modelRegistry.getAllProviders().some((p) => p.id === provider);
    case "enterprise":
      return isEnterpriseProvider(provider);
    default:
      return true;
  }
}

export default function DictationAgentSettings() {
  const { t } = useTranslation();
  const {
    dictationAgentMode,
    setDictationAgentMode,
    dictationAgentModel,
    setDictationAgentModel,
    dictationAgentProvider,
    setDictationAgentProvider,
    dictationAgentRemoteUrl,
    setDictationAgentRemoteUrl,
    dictationAgentCustomApiKey,
    setDictationAgentCustomApiKey,
    dictationAgentCloudBaseUrl,
    setDictationAgentCloudBaseUrl,
    isSignedIn,
    openaiApiKey,
    setOpenaiApiKey,
    anthropicApiKey,
    setAnthropicApiKey,
    geminiApiKey,
    setGeminiApiKey,
    groqApiKey,
    setGroqApiKey,
  } = useSettingsStore();

  const modes: InferenceModeOption[] = [
    {
      id: "openwhispr",
      label: t("dictationAgent.modes.openwhispr"),
      description: t("dictationAgent.modes.openwhisprDesc"),
      icon: <Cloud className="w-4 h-4" />,
      disabled: !isSignedIn,
      badge: !isSignedIn ? t("common.freeAccountRequired") : undefined,
    },
    {
      id: "providers",
      label: t("dictationAgent.modes.providers"),
      description: t("dictationAgent.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("dictationAgent.modes.local"),
      description: t("dictationAgent.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("dictationAgent.modes.selfHosted"),
      description: t("dictationAgent.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
    {
      id: "enterprise",
      label: t("dictationAgent.modes.enterprise"),
      description: t("dictationAgent.modes.enterpriseDesc"),
      icon: <Building2 className="w-4 h-4" />,
    },
  ];

  const handleModeSelect = (mode: InferenceMode) => {
    if (mode === dictationAgentMode) return;
    setDictationAgentMode(mode);
    if (!isProviderValidForMode(dictationAgentProvider, mode)) {
      setDictationAgentProvider("");
      setDictationAgentModel("");
    }
  };

  const renderModelSelector = (mode?: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={dictationAgentModel}
      setReasoningModel={setDictationAgentModel}
      localReasoningProvider={dictationAgentProvider}
      setLocalReasoningProvider={setDictationAgentProvider}
      cloudReasoningBaseUrl={dictationAgentCloudBaseUrl}
      setCloudReasoningBaseUrl={setDictationAgentCloudBaseUrl}
      openaiApiKey={openaiApiKey}
      setOpenaiApiKey={setOpenaiApiKey}
      anthropicApiKey={anthropicApiKey}
      setAnthropicApiKey={setAnthropicApiKey}
      geminiApiKey={geminiApiKey}
      setGeminiApiKey={setGeminiApiKey}
      groqApiKey={groqApiKey}
      setGroqApiKey={setGroqApiKey}
      customReasoningApiKey={dictationAgentCustomApiKey}
      setCustomReasoningApiKey={setDictationAgentCustomApiKey}
      setReasoningMode={setDictationAgentMode}
      mode={mode}
    />
  );

  return (
    <div className="space-y-6">
      <SettingsPanel>
        <SettingsPanelRow>
          <SectionHeader
            title={t("dictationAgent.title")}
            description={t("dictationAgent.description")}
          />
        </SettingsPanelRow>
      </SettingsPanel>

      <InferenceModeSelector
        modes={modes}
        activeMode={dictationAgentMode}
        onSelect={handleModeSelect}
      />

      {dictationAgentMode === "providers" && renderModelSelector("cloud")}
      {dictationAgentMode === "local" && renderModelSelector("local")}

      {dictationAgentMode === "self-hosted" && (
        <SelfHostedPanel
          service="reasoning"
          url={dictationAgentRemoteUrl}
          onUrlChange={setDictationAgentRemoteUrl}
        />
      )}

      {dictationAgentMode === "enterprise" && (
        <EnterpriseSection
          currentProvider={dictationAgentProvider}
          reasoningModel={dictationAgentModel}
          setReasoningModel={setDictationAgentModel}
          setLocalReasoningProvider={setDictationAgentProvider}
        />
      )}

      <div className="border-t border-border/40 pt-6">
        <SectionHeader
          title={t("dictationAgent.prompt.title")}
          description={t("dictationAgent.prompt.description")}
        />
        <PromptStudio kind="dictationAgent" />
      </div>
    </div>
  );
}
