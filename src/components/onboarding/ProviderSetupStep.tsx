import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseProviderConfig from "../EnterpriseProviderConfig";
import ProviderConnectionTest from "./ProviderConnectionTest";
import { useSettings } from "../../hooks/useSettings";
import { LLM_ENTERPRISE_POLICY_PROVIDER_IDS, useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isEnterpriseProviderAllowed } from "../../stores/policyRules";
import type { OnboardingStepId } from "./flow";

export function SetupStageStepper({ stepId }: { stepId: OnboardingStepId }) {
  const { t } = useTranslation();
  const assistant = stepId.endsWith("assistant");
  const enterprise = stepId.startsWith("enterprise");
  return (
    <div
      className="flex items-center justify-center gap-3"
      aria-label={t("onboarding.rehaul.provider.progress")}
    >
      <div className={`flex items-center gap-2 ${assistant ? "text-primary" : "text-foreground"}`}>
        <span
          className={`flex size-7 items-center justify-center rounded-full text-xs font-medium ${
            assistant ? "bg-primary text-primary-foreground" : "bg-foreground text-background"
          }`}
        >
          {assistant ? <Check className="size-4" /> : "1"}
        </span>
        <span className="text-sm font-medium">
          {enterprise
            ? t("onboarding.rehaul.enterprise.dictationIntelligence")
            : t("onboarding.rehaul.provider.dictation")}
        </span>
      </div>
      <span className="w-16 border-t border-dashed border-border" />
      <div
        className={`flex items-center gap-2 ${assistant ? "text-foreground" : "text-muted-foreground"}`}
      >
        <span
          className={`flex size-7 items-center justify-center rounded-full text-xs font-medium ${
            assistant ? "bg-foreground text-background" : "border border-border bg-card"
          }`}
        >
          2
        </span>
        <span className="text-sm font-medium">{t("onboarding.rehaul.provider.assistant")}</span>
      </div>
    </div>
  );
}

function providerKey(provider: string, store: ReturnType<typeof useSettingsStore.getState>) {
  switch (provider) {
    case "openai":
      return store.openaiApiKey;
    case "groq":
      return store.groqApiKey;
    case "xai":
      return store.xaiApiKey;
    case "mistral":
      return store.mistralApiKey;
    case "anthropic":
      return store.anthropicApiKey;
    case "gemini":
      return store.geminiApiKey;
    case "openrouter":
      return store.openrouterApiKey;
    case "tinfoil":
      return store.tinfoilApiKey;
    case "corti":
      return store.cortiApiKey;
    default:
      return "";
  }
}

export function ByokProviderStep({
  stepId,
  onConnectionChange,
}: {
  stepId: "byok-dictation" | "byok-assistant";
  onConnectionChange: (connected: boolean) => void;
}) {
  const settings = useSettings();
  const store = useSettingsStore();
  const assistant = stepId === "byok-assistant";
  const provider = assistant ? store.chatAgentProvider : settings.cloudTranscriptionProvider;
  const baseUrl = assistant ? store.chatAgentCloudBaseUrl : settings.cloudTranscriptionBaseUrl;
  const apiKey =
    provider === "custom"
      ? assistant
        ? store.chatAgentCustomApiKey
        : store.customTranscriptionApiKey
      : providerKey(provider, store);

  return (
    <ProviderCard stepId={stepId}>
      {assistant ? (
        <ReasoningModelSelector
          reasoningModel={store.chatAgentModel}
          setReasoningModel={store.setChatAgentModel}
          localReasoningProvider={store.chatAgentProvider}
          setLocalReasoningProvider={store.setChatAgentProvider}
          cloudReasoningBaseUrl={store.chatAgentCloudBaseUrl}
          setCloudReasoningBaseUrl={store.setChatAgentCloudBaseUrl}
          customReasoningApiKey={store.chatAgentCustomApiKey}
          setCustomReasoningApiKey={store.setChatAgentCustomApiKey}
          setReasoningMode={store.setChatAgentMode}
          mode="cloud"
          onCloudProviderSelect={(nextProvider, fallbackModel) => {
            store.setChatAgentProvider(nextProvider);
            store.setChatAgentModel(fallbackModel);
          }}
        />
      ) : (
        <TranscriptionModelPicker
          transcriptionContext="dictation"
          selectedCloudProvider={settings.cloudTranscriptionProvider}
          onCloudProviderSelect={settings.setCloudTranscriptionProvider}
          selectedCloudModel={settings.cloudTranscriptionModel}
          onCloudModelSelect={settings.setCloudTranscriptionModel}
          selectedLocalModel={
            settings.localTranscriptionProvider === "nvidia"
              ? settings.parakeetModel
              : settings.whisperModel
          }
          onLocalModelSelect={(model) => {
            if (settings.localTranscriptionProvider === "nvidia") settings.setParakeetModel(model);
            else settings.setWhisperModel(model);
          }}
          selectedLocalProvider={settings.localTranscriptionProvider}
          onLocalProviderSelect={settings.setLocalTranscriptionProvider}
          useLocalWhisper={false}
          onModeChange={settings.setUseLocalWhisper}
          cloudTranscriptionBaseUrl={settings.cloudTranscriptionBaseUrl}
          setCloudTranscriptionBaseUrl={settings.setCloudTranscriptionBaseUrl}
          variant="onboarding"
          mode="cloud"
        />
      )}

      <ProviderConnectionTest
        key={`${stepId}:${provider}:${baseUrl ?? ""}:${assistant ? store.chatAgentModel : settings.cloudTranscriptionModel}`}
        config={{
          scope: assistant ? "reasoning" : "transcription",
          provider,
          apiKey,
          baseUrl,
        }}
        onSuccessChange={onConnectionChange}
      />
    </ProviderCard>
  );
}

export function LocalModelSetupStep({
  stepId,
  onReadinessChange,
}: {
  stepId: "local-dictation" | "local-assistant";
  onReadinessChange: (ready: boolean) => void;
}) {
  const settings = useSettings();
  const store = useSettingsStore();
  const assistant = stepId === "local-assistant";
  const selectedModel = assistant
    ? store.chatAgentModel
    : settings.localTranscriptionProvider === "nvidia"
      ? settings.parakeetModel
      : settings.whisperModel;

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!selectedModel) {
        onReadinessChange(false);
        return;
      }
      if (assistant) {
        const models = await window.electronAPI?.modelGetAll?.();
        if (!cancelled) {
          onReadinessChange(
            Array.isArray(models) &&
              models.some((model) => model.id === selectedModel && model.isDownloaded)
          );
        }
      } else {
        const status =
          settings.localTranscriptionProvider === "nvidia"
            ? await window.electronAPI?.checkParakeetModelStatus?.(selectedModel)
            : await window.electronAPI?.checkModelStatus?.(selectedModel);
        if (!cancelled) onReadinessChange(status?.downloaded === true);
      }
    };
    void check();
    const interval = window.setInterval(check, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [assistant, onReadinessChange, selectedModel, settings.localTranscriptionProvider]);

  return (
    <ProviderCard stepId={stepId}>
      {assistant ? (
        <ReasoningModelSelector
          reasoningModel={store.chatAgentModel}
          setReasoningModel={store.setChatAgentModel}
          localReasoningProvider={store.chatAgentProvider}
          setLocalReasoningProvider={store.setChatAgentProvider}
          cloudReasoningBaseUrl={store.chatAgentCloudBaseUrl}
          setCloudReasoningBaseUrl={store.setChatAgentCloudBaseUrl}
          setReasoningMode={store.setChatAgentMode}
          mode="local"
        />
      ) : (
        <TranscriptionModelPicker
          transcriptionContext="dictation"
          selectedCloudProvider={settings.cloudTranscriptionProvider}
          onCloudProviderSelect={settings.setCloudTranscriptionProvider}
          selectedCloudModel={settings.cloudTranscriptionModel}
          onCloudModelSelect={settings.setCloudTranscriptionModel}
          selectedLocalModel={selectedModel}
          onLocalModelSelect={(model) => {
            if (settings.localTranscriptionProvider === "nvidia") settings.setParakeetModel(model);
            else settings.setWhisperModel(model);
          }}
          selectedLocalProvider={settings.localTranscriptionProvider}
          onLocalProviderSelect={settings.setLocalTranscriptionProvider}
          useLocalWhisper
          onModeChange={settings.setUseLocalWhisper}
          variant="onboarding"
          mode="local"
        />
      )}
    </ProviderCard>
  );
}

export function EnterpriseSetupStep({
  stepId,
  onConnectionChange,
}: {
  stepId: "enterprise-dictation" | "enterprise-assistant";
  onConnectionChange: (connected: boolean) => void;
}) {
  const store = useSettingsStore();
  const policy = usePolicySnapshot();
  const assistant = stepId === "enterprise-assistant";
  const setChatAgentMode = store.setChatAgentMode;
  const setChatAgentProvider = store.setChatAgentProvider;
  const setDictationAgentMode = store.setDictationAgentMode;
  const setDictationAgentProvider = store.setDictationAgentProvider;
  const [provider, setProvider] = useState<"bedrock" | "azure" | "vertex">("bedrock");
  const providers = useMemo(
    () =>
      (["bedrock", "azure", "vertex"] as const).filter(
        (item) =>
          LLM_ENTERPRISE_POLICY_PROVIDER_IDS.includes(
            item as (typeof LLM_ENTERPRISE_POLICY_PROVIDER_IDS)[number]
          ) && isEnterpriseProviderAllowed(policy, item)
      ),
    [policy]
  );
  const model = assistant ? store.chatAgentModel : store.dictationAgentModel;
  const setModel = assistant ? store.setChatAgentModel : store.setDictationAgentModel;

  useEffect(() => {
    if (!providers.includes(provider) && providers[0]) setProvider(providers[0]);
  }, [provider, providers]);

  useEffect(() => {
    if (assistant) {
      setChatAgentMode("enterprise");
      setChatAgentProvider(provider);
    } else {
      setDictationAgentMode("enterprise");
      setDictationAgentProvider(provider);
    }
    onConnectionChange(false);
  }, [
    assistant,
    onConnectionChange,
    provider,
    setChatAgentMode,
    setChatAgentProvider,
    setDictationAgentMode,
    setDictationAgentProvider,
  ]);

  return (
    <ProviderCard stepId={stepId}>
      {providers.length > 1 && (
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value as typeof provider)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          {providers.map((item) => (
            <option key={item} value={item}>
              {item === "bedrock" ? "AWS Bedrock" : item === "azure" ? "Azure OpenAI" : "Vertex AI"}
            </option>
          ))}
        </select>
      )}
      <EnterpriseProviderConfig
        provider={provider}
        reasoningModel={model}
        setReasoningModel={setModel}
        onConnectionChange={onConnectionChange}
      />
    </ProviderCard>
  );
}

function ProviderCard({
  children,
  stepId,
}: {
  children: React.ReactNode;
  stepId: OnboardingStepId;
}) {
  return (
    <div className="mx-auto mt-8 w-full max-w-2xl rounded-3xl border border-border bg-card p-6 shadow-lg md:p-8">
      <SetupStageStepper stepId={stepId} />
      <div className="mt-8 space-y-5">{children}</div>
    </div>
  );
}
