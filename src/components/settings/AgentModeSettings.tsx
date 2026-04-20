import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network, Building2 } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { Toggle } from "../ui/toggle";
import {
  SettingsRow,
  SettingsPanel,
  SettingsPanelRow,
  SectionHeader,
  InferenceModeSelector,
} from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseSection from "../EnterpriseSection";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode } from "../../types/electron";

export default function AgentModeSettings() {
  const { t } = useTranslation();
  const {
    agentEnabled,
    setAgentEnabled,
    agentModel,
    setAgentModel,
    agentProvider,
    setAgentProvider,
    agentSystemPrompt,
    setAgentSystemPrompt,
    cloudAgentMode,
    setCloudAgentMode,
    agentInferenceMode,
    setAgentInferenceMode,
    remoteAgentUrl,
    setRemoteAgentUrl,
    isSignedIn,
    openaiApiKey,
    setOpenaiApiKey,
    anthropicApiKey,
    setAnthropicApiKey,
    geminiApiKey,
    setGeminiApiKey,
    groqApiKey,
    setGroqApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    cloudReasoningBaseUrl,
    setCloudReasoningBaseUrl,
  } = useSettingsStore();

  const startOnboarding = useCallback(() => {
    localStorage.setItem("pendingCloudMigration", "true");
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  }, []);

  const agentModes: InferenceModeOption[] = [
    {
      id: "openwhispr",
      label: t("agentMode.settings.modes.openwhispr"),
      description: t("agentMode.settings.modes.openwhisprDesc"),
      icon: <Cloud className="w-4 h-4" />,
      disabled: !isSignedIn,
      badge: !isSignedIn ? t("common.freeAccountRequired") : undefined,
    },
    {
      id: "providers",
      label: t("agentMode.settings.modes.providers"),
      description: t("agentMode.settings.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("agentMode.settings.modes.local"),
      description: t("agentMode.settings.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("agentMode.settings.modes.selfHosted"),
      description: t("agentMode.settings.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
    {
      id: "enterprise",
      label: t("agentMode.settings.modes.enterprise"),
      description: t("agentMode.settings.modes.enterpriseDesc"),
      icon: <Building2 className="w-4 h-4" />,
    },
  ];

  const handleAgentModeSelect = (mode: InferenceMode) => {
    if (mode === "openwhispr" && !isSignedIn) {
      startOnboarding();
      return;
    }
    if (mode === agentInferenceMode) return;
    setAgentInferenceMode(mode);
    setCloudAgentMode(mode === "openwhispr" ? "openwhispr" : "byok");
    if (mode === "openwhispr" || mode === "self-hosted" || mode === "enterprise") {
      window.electronAPI?.llamaServerStop?.();
    }
  };

  const renderModelSelector = (mode?: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={agentModel}
      setReasoningModel={setAgentModel}
      localReasoningProvider={agentProvider}
      setLocalReasoningProvider={setAgentProvider}
      cloudReasoningBaseUrl={cloudReasoningBaseUrl}
      setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
      openaiApiKey={openaiApiKey}
      setOpenaiApiKey={setOpenaiApiKey}
      anthropicApiKey={anthropicApiKey}
      setAnthropicApiKey={setAnthropicApiKey}
      geminiApiKey={geminiApiKey}
      setGeminiApiKey={setGeminiApiKey}
      groqApiKey={groqApiKey}
      setGroqApiKey={setGroqApiKey}
      customReasoningApiKey={customReasoningApiKey}
      setCustomReasoningApiKey={setCustomReasoningApiKey}
      setReasoningMode={setAgentInferenceMode}
      mode={mode}
    />
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t("agentMode.settings.title")}
        description={t("agentMode.settings.description")}
      />

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("agentMode.settings.enabled")}
            description={t("agentMode.settings.enabledDescription")}
          >
            <Toggle checked={agentEnabled} onChange={setAgentEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {agentEnabled && (
        <>
          <InferenceModeSelector
            modes={agentModes}
            activeMode={agentInferenceMode}
            onSelect={handleAgentModeSelect}
          />

          {agentInferenceMode === "providers" && renderModelSelector("cloud")}
          {agentInferenceMode === "local" && renderModelSelector("local")}

          {agentInferenceMode === "self-hosted" && (
            <SelfHostedPanel
              service="reasoning"
              url={remoteAgentUrl}
              onUrlChange={setRemoteAgentUrl}
            />
          )}

          {agentInferenceMode === "enterprise" && (
            <EnterpriseSection
              currentProvider={agentProvider}
              reasoningModel={agentModel}
              setReasoningModel={setAgentModel}
              setLocalReasoningProvider={setAgentProvider}
            />
          )}

          <div>
            <SectionHeader
              title={t("agentMode.settings.systemPrompt")}
              description={t("agentMode.settings.systemPromptDescription")}
            />
            <textarea
              value={agentSystemPrompt}
              onChange={(e) => setAgentSystemPrompt(e.target.value)}
              placeholder={t("agentMode.settings.systemPromptPlaceholder")}
              rows={4}
              className="w-full text-xs bg-transparent border border-border/50 rounded-md px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/30 placeholder:text-muted-foreground/50"
            />
          </div>
        </>
      )}
    </div>
  );
}
