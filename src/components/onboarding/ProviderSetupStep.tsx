import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AudioLines, Check, CircleCheck, MousePointer2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseProviderConfig from "../EnterpriseProviderConfig";
import ProviderConnectionTest from "./ProviderConnectionTest";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { useSettings } from "../../hooks/useSettings";
import { LLM_ENTERPRISE_POLICY_PROVIDER_IDS, useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  filterByokProviderOptionsByPolicy,
  isEnterpriseProviderAllowed,
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
} from "../../stores/policyRules";
import {
  getTranscriptionProviders,
  modelRegistry,
  type CloudProviderData,
  type TranscriptionProviderData,
} from "../../models/ModelRegistry";
import type { OnboardingStepId } from "./flow";

export function SetupStageStepper({ stepId }: { stepId: OnboardingStepId }) {
  const { t } = useTranslation();
  const assistant = stepId.endsWith("assistant");
  const enterprise = stepId.startsWith("enterprise");
  return (
    <div
      className="relative mx-auto flex w-36 items-start justify-between"
      aria-label={t("onboarding.rehaul.provider.progress")}
    >
      <span className="absolute left-8 right-8 top-3.5 border-t border-dashed border-neutral-200" />
      <div className="relative z-10 flex w-14 flex-col items-center gap-1.5 text-neutral-500">
        <span
          className={`flex size-7 items-center justify-center rounded-full ${
            assistant ? "bg-blue-500 text-white" : "bg-neutral-950 text-white"
          }`}
        >
          {assistant ? (
            <CircleCheck className="size-3.5" strokeWidth={2} />
          ) : (
            <AudioLines className="size-3.5" />
          )}
        </span>
        <span className="text-[0.6875rem]">
          {enterprise
            ? t("onboarding.rehaul.enterprise.dictationIntelligence")
            : t("onboarding.rehaul.provider.dictation")}
        </span>
      </div>
      <div className="relative z-10 flex w-14 flex-col items-center gap-1.5 text-neutral-500">
        <span
          className={`flex size-7 items-center justify-center rounded-full ${
            assistant
              ? "bg-neutral-950 text-white"
              : "border border-neutral-200 bg-white text-neutral-950"
          }`}
        >
          <MousePointer2 className="size-3.5" />
        </span>
        <span className="text-[0.6875rem]">{t("onboarding.rehaul.provider.assistant")}</span>
      </div>
    </div>
  );
}

function providerCredential(provider: string, store: ReturnType<typeof useSettingsStore.getState>) {
  switch (provider) {
    case "openai":
      return { value: store.openaiApiKey, set: store.setOpenaiApiKey };
    case "anthropic":
      return { value: store.anthropicApiKey, set: store.setAnthropicApiKey };
    case "gemini":
      return { value: store.geminiApiKey, set: store.setGeminiApiKey };
    case "groq":
      return { value: store.groqApiKey, set: store.setGroqApiKey };
    case "xai":
      return { value: store.xaiApiKey, set: store.setXaiApiKey };
    case "mistral":
      return { value: store.mistralApiKey, set: store.setMistralApiKey };
    case "openrouter":
      return { value: store.openrouterApiKey, set: store.setOpenrouterApiKey };
    case "tinfoil":
      return { value: store.tinfoilApiKey, set: store.setTinfoilApiKey };
    case "corti":
      return { value: store.cortiApiKey, set: store.setCortiApiKey };
    default:
      return { value: "", set: (_value: string) => undefined };
  }
}

type HostedProvider = CloudProviderData | TranscriptionProviderData;

function providerDisplayName(provider: HostedProvider) {
  return provider.id === "xai" ? "SpaceXAI" : provider.name;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1.5 block text-xs text-neutral-400">{children}</span>;
}

export function ByokProviderStep({
  stepId,
  onConnectionChange,
  onProceed,
}: {
  stepId: "byok-dictation" | "byok-assistant";
  onConnectionChange: (connected: boolean) => void;
  onProceed: () => void;
}) {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const policy = usePolicySnapshot();
  const assistant = stepId === "byok-assistant";
  const scope = assistant ? "llm" : "transcription";
  const [selfHosted, setSelfHosted] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftCustomModel, setDraftCustomModel] = useState("");
  const [draftCortiClientId, setDraftCortiClientId] = useState("");
  const [draftCortiClientSecret, setDraftCortiClientSecret] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSelfHosted(false);
    setSelectedProvider("");
    setSelectedModel("");
    setDraftApiKey("");
    setDraftBaseUrl("");
    setDraftCustomModel("");
    setDraftCortiClientId("");
    setDraftCortiClientSecret("");
    setConnected(false);
    onConnectionChange(false);
  }, [onConnectionChange, stepId]);

  const providers = useMemo(
    () =>
      filterByokProviderOptionsByPolicy<HostedProvider>(
        assistant ? modelRegistry.getCloudProviders() : getTranscriptionProviders(),
        scope,
        policy
      ),
    [assistant, policy, scope]
  );
  const currentProvider = providers.find((provider) => provider.id === selectedProvider);
  const models = currentProvider?.models ?? [];
  const knownCredential = providerCredential(selectedProvider, store);
  const selfHostedAllowed =
    isModeAllowedByPolicy(policy, scope, "self-hosted") &&
    isProviderAllowedByPolicy(policy, scope, "custom");

  const toggleSelfHosted = () => {
    const next = !selfHosted;
    setSelfHosted(next);
    setSelectedProvider("");
    setSelectedModel("");
    setDraftApiKey("");
    setDraftBaseUrl("");
    setDraftCustomModel("");
    setConnected(false);
    onConnectionChange(false);
  };

  const chooseProvider = (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId);
    const fallbackModel = provider?.models[0]?.id ?? "";
    setSelectedProvider(providerId);
    setSelectedModel(fallbackModel);
    setDraftApiKey(providerCredential(providerId, store).value);
    setConnected(false);
    onConnectionChange(false);
  };

  const chooseModel = (modelId: string) => {
    setSelectedModel(modelId);
    setConnected(false);
    onConnectionChange(false);
  };

  const handleConnected = useCallback(
    (success: boolean) => {
      setConnected(success);
      onConnectionChange(success);
    },
    [onConnectionChange]
  );

  const testingProvider = selfHosted ? "custom" : selectedProvider;
  const testingKey = draftApiKey;
  const testingBaseUrl = selfHosted ? draftBaseUrl : undefined;
  const isCortiTranscription = !assistant && !selfHosted && selectedProvider === "corti";
  const fieldsReady = selfHosted
    ? Boolean(draftBaseUrl.trim() && draftCustomModel.trim())
    : isCortiTranscription
      ? Boolean(draftCortiClientId.trim() && draftCortiClientSecret.trim() && selectedModel)
      : Boolean(selectedProvider && selectedModel && testingKey.trim());

  const commitAndProceed = () => {
    if (selfHosted) {
      if (assistant) {
        store.setChatAgentRemoteUrl(draftBaseUrl);
        store.setChatAgentCustomApiKey(draftApiKey);
        store.setChatAgentModel(draftCustomModel);
        store.setChatAgentMode("self-hosted");
        store.setChatAgentProvider("custom");
      } else {
        store.setCloudTranscriptionBaseUrl(draftBaseUrl);
        store.setCustomTranscriptionApiKey(draftApiKey);
        store.setCloudTranscriptionModel(draftCustomModel);
        store.switchCloudTranscriptionProvider("dictation", "custom");
        store.setCloudTranscriptionMode("byok");
      }
    } else if (assistant) {
      knownCredential.set(draftApiKey);
      store.setChatAgentMode("providers");
      store.switchReasoningProvider("chatIntelligence", selectedProvider, selectedModel);
      store.setChatAgentModel(selectedModel);
    } else {
      if (isCortiTranscription) {
        store.setCortiClientId(draftCortiClientId);
        store.setCortiClientSecret(draftCortiClientSecret);
      } else {
        knownCredential.set(draftApiKey);
      }
      store.setCloudTranscriptionMode("byok");
      store.switchCloudTranscriptionProvider("dictation", selectedProvider);
      store.setCloudTranscriptionModel(selectedModel);
    }
    onProceed();
  };

  const inputClass =
    "onboarding-provider-input h-9 rounded-xl! border px-3 text-xs shadow-none! focus:ring-2 focus:ring-blue-500/15";

  return (
    <section className="mx-auto mt-8 w-full max-w-[23.75rem] rounded-[1.125rem] border border-neutral-200 bg-white px-3 py-[1.125rem] text-neutral-950">
      <SetupStageStepper stepId={stepId} />

      <div className="mt-3 space-y-3">
        {selfHostedAllowed && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selfHosted}
            onClick={toggleSelfHosted}
            className="flex items-center gap-2 text-xs text-neutral-950"
          >
            <span
              className={`flex size-5 items-center justify-center rounded border ${
                selfHosted
                  ? "border-blue-500 bg-blue-500 text-white"
                  : "border-neutral-200 bg-white"
              }`}
            >
              {selfHosted && <Check className="size-3.5" strokeWidth={2.5} />}
            </span>
            {t("onboarding.rehaul.provider.selfHosted")}
          </button>
        )}

        {selfHosted ? (
          <>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.endpointUrl")}</FieldLabel>
              <Input
                value={draftBaseUrl}
                onChange={(event) => setDraftBaseUrl(event.target.value)}
                placeholder={t("onboarding.rehaul.provider.endpointPlaceholder")}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.apiKey")}</FieldLabel>
              <Input
                value={draftApiKey}
                onChange={(event) => setDraftApiKey(event.target.value)}
                placeholder={t("onboarding.rehaul.provider.optional")}
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.modelId")}</FieldLabel>
              <Input
                value={draftCustomModel}
                onChange={(event) => setDraftCustomModel(event.target.value)}
                placeholder={t("onboarding.rehaul.provider.modelIdPlaceholder")}
                className={inputClass}
              />
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.providerLabel")}</FieldLabel>
              <Select value={selectedProvider || undefined} onValueChange={chooseProvider}>
                <SelectTrigger className="h-9 rounded-xl border-neutral-200 bg-neutral-100 px-3 text-xs text-neutral-950 disabled:opacity-100 disabled:[&>svg]:hidden dark:border-neutral-200 dark:bg-neutral-100 dark:text-neutral-950">
                  {currentProvider ? (
                    <span className="flex items-center gap-2">
                      <ProviderIcon provider={currentProvider.id} className="size-4" forceLight />
                      {providerDisplayName(currentProvider)}
                    </span>
                  ) : (
                    <span className="text-neutral-500">
                      {t("onboarding.rehaul.provider.providerPlaceholder")}
                    </span>
                  )}
                </SelectTrigger>
                <SelectContent className="max-h-[12.5rem] border-neutral-200 bg-white text-neutral-950 dark:border-neutral-200 dark:bg-white dark:text-neutral-950">
                  {providers.map((provider) => (
                    <SelectItem
                      key={provider.id}
                      value={provider.id}
                      className="rounded-none border-b border-neutral-200 py-2 pr-2 last:border-b-0 [&>span:nth-child(2)]:w-full"
                    >
                      <span className="flex items-center gap-2">
                        <ProviderIcon provider={provider.id} className="size-4" forceLight />
                        <span>{providerDisplayName(provider)}</span>
                        {provider.id === "corti" && (
                          <span className="ml-auto rounded bg-blue-50 px-2 py-1 text-[0.625rem] text-blue-500">
                            {t("onboarding.rehaul.provider.clinical")}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.modelLabel")}</FieldLabel>
              <Select
                value={selectedModel || undefined}
                onValueChange={chooseModel}
                disabled={!selectedProvider}
              >
                <SelectTrigger className="h-9 rounded-xl border-neutral-200 bg-neutral-100 px-3 text-xs text-neutral-950 disabled:opacity-100 disabled:[&>svg]:hidden dark:border-neutral-200 dark:bg-neutral-100 dark:text-neutral-950">
                  {selectedModel ? (
                    <span>
                      {models.find((model) => model.id === selectedModel)?.name ?? selectedModel}
                    </span>
                  ) : (
                    <span className="text-neutral-500">
                      {t("onboarding.rehaul.provider.modelPlaceholder")}
                    </span>
                  )}
                </SelectTrigger>
                <SelectContent className="border-neutral-200 bg-white text-neutral-950 dark:border-neutral-200 dark:bg-white dark:text-neutral-950">
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            {isCortiTranscription ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <FieldLabel>{t("onboarding.rehaul.provider.clientId")}</FieldLabel>
                  <Input
                    value={draftCortiClientId}
                    onChange={(event) => setDraftCortiClientId(event.target.value)}
                    className={inputClass}
                    autoComplete="off"
                  />
                </label>
                <label className="block">
                  <FieldLabel>{t("onboarding.rehaul.provider.clientSecret")}</FieldLabel>
                  <Input
                    value={draftCortiClientSecret}
                    onChange={(event) => setDraftCortiClientSecret(event.target.value)}
                    className={inputClass}
                    autoComplete="off"
                  />
                </label>
              </div>
            ) : (
              <label className="block">
                <FieldLabel>{t("onboarding.rehaul.provider.apiKey")}</FieldLabel>
                <Input
                  value={draftApiKey}
                  onChange={(event) => setDraftApiKey(event.target.value)}
                  placeholder={t("onboarding.rehaul.provider.apiKeyPlaceholder")}
                  disabled={!selectedProvider}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
            )}
          </>
        )}

        <ProviderConnectionTest
          key={`${stepId}:${testingProvider}:${testingBaseUrl ?? ""}:${selfHosted ? draftCustomModel : selectedModel}`}
          config={{
            scope: assistant ? "reasoning" : "transcription",
            provider: testingProvider,
            apiKey: testingKey,
            baseUrl: testingBaseUrl,
            clientId: isCortiTranscription ? draftCortiClientId : undefined,
            clientSecret: isCortiTranscription ? draftCortiClientSecret : undefined,
            environment: store.cortiEnvironment,
            tenant: store.cortiTenant,
          }}
          onSuccessChange={handleConnected}
          variant="inline"
        />

        <Button
          type="button"
          onClick={commitAndProceed}
          disabled={!connected || !fieldsReady}
          className="mt-4! h-8 w-full rounded-full border-neutral-200! bg-blue-500 text-sm font-normal text-white shadow-none! hover:bg-blue-600 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:bg-neutral-200 disabled:text-neutral-500 disabled:opacity-100!"
        >
          {t("onboarding.rehaul.provider.proceed")}
        </Button>
      </div>
    </section>
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

function ProviderCard({ children, stepId }: { children: ReactNode; stepId: OnboardingStepId }) {
  return (
    <div className="mx-auto mt-8 w-full max-w-2xl rounded-3xl border border-border bg-card p-6 shadow-lg md:p-8">
      <SetupStageStepper stepId={stepId} />
      <div className="mt-8 space-y-5">{children}</div>
    </div>
  );
}
