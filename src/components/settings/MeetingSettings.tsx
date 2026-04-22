import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network, Building2 } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useStreamingProviders } from "../../stores/streamingProvidersStore";
import { InferenceModeSelector, SettingsRow } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseSection from "../EnterpriseSection";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode } from "../../types/electron";

function MeetingStreamingProviderPicker() {
  const { t } = useTranslation();
  const providers = useStreamingProviders();
  const meetingCloudTranscriptionProvider = useSettingsStore(
    (s) => s.meetingCloudTranscriptionProvider
  );
  const meetingCloudTranscriptionModel = useSettingsStore((s) => s.meetingCloudTranscriptionModel);
  const setMeetingCloudTranscriptionProvider = useSettingsStore(
    (s) => s.setMeetingCloudTranscriptionProvider
  );
  const setMeetingCloudTranscriptionModel = useSettingsStore(
    (s) => s.setMeetingCloudTranscriptionModel
  );

  const selectedProvider = useMemo(() => {
    if (!providers?.length) return null;
    return providers.find((p) => p.id === meetingCloudTranscriptionProvider) ?? providers[0];
  }, [providers, meetingCloudTranscriptionProvider]);

  const selectedModel = useMemo(() => {
    if (!selectedProvider) return "";
    const stored = selectedProvider.models.find((m) => m.id === meetingCloudTranscriptionModel);
    if (stored) return stored.id;
    return (
      selectedProvider.models.find((m) => m.default)?.id ?? selectedProvider.models[0]?.id ?? ""
    );
  }, [selectedProvider, meetingCloudTranscriptionModel]);

  const handleProviderChange = useCallback(
    (providerId: string) => {
      if (providerId === meetingCloudTranscriptionProvider) return;
      setMeetingCloudTranscriptionProvider(providerId);
      setMeetingCloudTranscriptionModel("");
    },
    [
      meetingCloudTranscriptionProvider,
      setMeetingCloudTranscriptionProvider,
      setMeetingCloudTranscriptionModel,
    ]
  );

  if (providers === null) return null;

  if (providers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/80 px-1">
        {t("settings.meeting.streamingProvider.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <SettingsRow label={t("settings.meeting.streamingProvider.providerLabel")}>
        <Select value={selectedProvider?.id ?? ""} onValueChange={handleProviderChange}>
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {selectedProvider && selectedProvider.models.length > 0 && (
        <SettingsRow label={t("settings.meeting.streamingProvider.modelLabel")}>
          <Select value={selectedModel} onValueChange={setMeetingCloudTranscriptionModel}>
            <SelectTrigger className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectedProvider.models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      )}
    </div>
  );
}

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

const noop = () => {};

function useStartOnboarding() {
  return useCallback(() => {
    localStorage.setItem("pendingCloudMigration", "true");
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  }, []);
}

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();
  const startOnboarding = useStartOnboarding();

  const {
    isSignedIn,
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    meetingWhisperModel,
    setMeetingWhisperModel,
    meetingLocalTranscriptionProvider,
    setMeetingLocalTranscriptionProvider,
    meetingParakeetModel,
    setMeetingParakeetModel,
    meetingCloudTranscriptionProvider,
    setMeetingCloudTranscriptionProvider,
    meetingCloudTranscriptionModel,
    setMeetingCloudTranscriptionModel,
    meetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionMode,
    meetingRemoteTranscriptionUrl,
    setMeetingRemoteTranscriptionUrl,
    openaiApiKey,
    setOpenaiApiKey,
    groqApiKey,
    setGroqApiKey,
    mistralApiKey,
    setMistralApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
  } = useSettingsStore();

  const transcriptionModes: InferenceModeOption[] = [
    {
      id: "openwhispr",
      label: t("settingsPage.transcription.modes.openwhispr"),
      description: t("settingsPage.transcription.modes.openwhisprDesc"),
      icon: <Cloud className="w-4 h-4" />,
      disabled: !isSignedIn,
      badge: !isSignedIn ? t("common.freeAccountRequired") : undefined,
    },
    {
      id: "providers",
      label: t("settingsPage.transcription.modes.providers"),
      description: t("settingsPage.transcription.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.transcription.modes.selfHosted"),
      description: t("settingsPage.transcription.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];

  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (mode === "openwhispr" && !isSignedIn) {
      startOnboarding();
      return;
    }
    if (mode === meetingTranscriptionMode) return;
    setMeetingTranscriptionMode(mode);
    setMeetingUseLocalWhisper(mode === "local");
    setMeetingCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string) => {
      if (meetingLocalTranscriptionProvider === "nvidia") {
        setMeetingParakeetModel(modelId);
      } else {
        setMeetingWhisperModel(modelId);
      }
    },
    [meetingLocalTranscriptionProvider, setMeetingParakeetModel, setMeetingWhisperModel]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      streamingOnly
      selectedCloudProvider={meetingCloudTranscriptionProvider}
      onCloudProviderSelect={setMeetingCloudTranscriptionProvider}
      selectedCloudModel={meetingCloudTranscriptionModel}
      onCloudModelSelect={setMeetingCloudTranscriptionModel}
      selectedLocalModel={
        meetingLocalTranscriptionProvider === "nvidia" ? meetingParakeetModel : meetingWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={meetingLocalTranscriptionProvider}
      onLocalProviderSelect={setMeetingLocalTranscriptionProvider}
      useLocalWhisper={mode === "local"}
      onModeChange={noop}
      mode={mode}
      openaiApiKey={openaiApiKey}
      setOpenaiApiKey={setOpenaiApiKey}
      groqApiKey={groqApiKey}
      setGroqApiKey={setGroqApiKey}
      mistralApiKey={mistralApiKey}
      setMistralApiKey={setMistralApiKey}
      customTranscriptionApiKey={customTranscriptionApiKey}
      setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
      cloudTranscriptionBaseUrl={meetingCloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setMeetingCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  return (
    <div className="space-y-3">
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={meetingTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {meetingTranscriptionMode === "openwhispr" && <MeetingStreamingProviderPicker />}
      {meetingTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {meetingTranscriptionMode === "local" && renderTranscriptionPicker("local")}
      {meetingTranscriptionMode === "self-hosted" && (
        <>
          <SelfHostedPanel
            service="transcription"
            url={meetingRemoteTranscriptionUrl}
            onUrlChange={setMeetingRemoteTranscriptionUrl}
          />
          <p className="text-xs text-muted-foreground/80 px-1">
            {t("settingsPage.speechToText.selfHostedStreamingNote")}
          </p>
        </>
      )}
      <MeetingSpeakerDetectionRow />
    </div>
  );
}

export function MeetingReasoningPanel() {
  const { t } = useTranslation();
  const startOnboarding = useStartOnboarding();

  const {
    isSignedIn,
    meetingReasoningMode,
    setMeetingReasoningMode,
    meetingReasoningProvider,
    setMeetingReasoningProvider,
    meetingReasoningModel,
    setMeetingReasoningModel,
    setMeetingCloudReasoningMode,
    meetingCloudReasoningBaseUrl,
    setMeetingCloudReasoningBaseUrl,
    meetingRemoteReasoningUrl,
    setMeetingRemoteReasoningUrl,
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
  } = useSettingsStore();

  const aiModes: InferenceModeOption[] = [
    {
      id: "openwhispr",
      label: t("settingsPage.aiModels.modes.openwhispr"),
      description: t("settingsPage.aiModels.modes.openwhisprDesc"),
      icon: <Cloud className="w-4 h-4" />,
      disabled: !isSignedIn,
      badge: !isSignedIn ? t("common.freeAccountRequired") : undefined,
    },
    {
      id: "providers",
      label: t("settingsPage.aiModels.modes.providers"),
      description: t("settingsPage.aiModels.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("settingsPage.aiModels.modes.local"),
      description: t("settingsPage.aiModels.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.aiModels.modes.selfHosted"),
      description: t("settingsPage.aiModels.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
    {
      id: "enterprise",
      label: t("settingsPage.aiModels.modes.enterprise"),
      description: t("settingsPage.aiModels.modes.enterpriseDesc"),
      icon: <Building2 className="w-4 h-4" />,
    },
  ];

  const handleReasoningModeSelect = (mode: InferenceMode) => {
    if (mode === "openwhispr" && !isSignedIn) {
      startOnboarding();
      return;
    }
    if (mode === meetingReasoningMode) return;
    setMeetingReasoningMode(mode);
    setMeetingCloudReasoningMode(mode === "openwhispr" ? "openwhispr" : "byok");
  };

  const renderReasoningSelector = (mode?: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={meetingReasoningModel}
      setReasoningModel={setMeetingReasoningModel}
      localReasoningProvider={meetingReasoningProvider}
      setLocalReasoningProvider={setMeetingReasoningProvider}
      cloudReasoningBaseUrl={meetingCloudReasoningBaseUrl}
      setCloudReasoningBaseUrl={setMeetingCloudReasoningBaseUrl}
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
      setReasoningMode={setMeetingReasoningMode}
      mode={mode}
    />
  );

  return (
    <div className="space-y-3">
      <InferenceModeSelector
        modes={aiModes}
        activeMode={meetingReasoningMode}
        onSelect={handleReasoningModeSelect}
      />

      {meetingReasoningMode === "providers" && renderReasoningSelector("cloud")}
      {meetingReasoningMode === "local" && renderReasoningSelector("local")}
      {meetingReasoningMode === "self-hosted" && (
        <SelfHostedPanel
          service="reasoning"
          url={meetingRemoteReasoningUrl}
          onUrlChange={setMeetingRemoteReasoningUrl}
        />
      )}
      {meetingReasoningMode === "enterprise" && (
        <EnterpriseSection
          currentProvider={meetingReasoningProvider}
          reasoningModel={meetingReasoningModel}
          setReasoningModel={setMeetingReasoningModel}
          setLocalReasoningProvider={setMeetingReasoningProvider}
        />
      )}
    </div>
  );
}
