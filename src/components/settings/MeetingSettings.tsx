import { useCallback, useMemo } from "react";
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
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseSection from "../EnterpriseSection";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode } from "../../types/electron";

const noop = () => {};

function useStartOnboarding() {
  return useCallback(() => {
    localStorage.setItem("pendingCloudMigration", "true");
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  }, []);
}

export function MeetingTranscriptionPanel({ showHeader = false }: { showHeader?: boolean } = {}) {
  const { t } = useTranslation();
  const startOnboarding = useStartOnboarding();

  const {
    isSignedIn,
    meetingFollowsTranscription,
    setMeetingFollowsTranscription,
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
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    transcriptionMode,
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

  const transcriptionSummary = useMemo(() => {
    if (transcriptionMode === "openwhispr") return t("settingsPage.transcription.modes.openwhispr");
    if (transcriptionMode === "self-hosted")
      return t("settingsPage.transcription.modes.selfHosted");
    if (useLocalWhisper) {
      const model =
        localTranscriptionProvider === "nvidia"
          ? parakeetModel || "parakeet"
          : whisperModel || "base";
      return `${t("common.local")} · ${model}`;
    }
    return `${cloudTranscriptionProvider || "openai"} · ${cloudTranscriptionModel || "gpt-4o-mini-transcribe"}`;
  }, [
    t,
    transcriptionMode,
    useLocalWhisper,
    localTranscriptionProvider,
    parakeetModel,
    whisperModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
  ]);

  return (
    <div className="space-y-3">
      {showHeader && <SectionHeader title={t("settingsPage.meetings.speechTitle")} />}
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.meetings.followTranscription.label")}
            description={t("settingsPage.meetings.followTranscription.description")}
          >
            <Toggle
              checked={meetingFollowsTranscription}
              onChange={setMeetingFollowsTranscription}
            />
          </SettingsRow>
        </SettingsPanelRow>
        {meetingFollowsTranscription && (
          <SettingsPanelRow>
            <p className="text-xs text-muted-foreground/80">
              {t("settingsPage.meetings.inheritedSummary", { summary: transcriptionSummary })}
            </p>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      {!meetingFollowsTranscription && (
        <>
          <InferenceModeSelector
            modes={transcriptionModes}
            activeMode={meetingTranscriptionMode}
            onSelect={handleTranscriptionModeSelect}
          />

          {meetingTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
          {meetingTranscriptionMode === "local" && renderTranscriptionPicker("local")}
          {meetingTranscriptionMode === "self-hosted" && (
            <SelfHostedPanel
              service="transcription"
              url={meetingRemoteTranscriptionUrl}
              onUrlChange={setMeetingRemoteTranscriptionUrl}
            />
          )}
        </>
      )}
    </div>
  );
}

export function MeetingReasoningPanel({ showHeader = false }: { showHeader?: boolean } = {}) {
  const { t } = useTranslation();
  const startOnboarding = useStartOnboarding();

  const {
    isSignedIn,
    meetingFollowsReasoning,
    setMeetingFollowsReasoning,
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
    reasoningMode,
    reasoningProvider,
    reasoningModel,
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

  const reasoningSummary = useMemo(() => {
    if (reasoningMode === "openwhispr") return t("settingsPage.aiModels.modes.openwhispr");
    if (reasoningMode === "self-hosted") return t("settingsPage.aiModels.modes.selfHosted");
    if (reasoningMode === "enterprise") return t("settingsPage.aiModels.modes.enterprise");
    const provider = reasoningProvider || "openai";
    return reasoningModel ? `${provider} · ${reasoningModel}` : provider;
  }, [t, reasoningMode, reasoningProvider, reasoningModel]);

  return (
    <div className="space-y-3">
      {showHeader && <SectionHeader title={t("settingsPage.meetings.intelligenceTitle")} />}
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.meetings.followIntelligence.label")}
            description={t("settingsPage.meetings.followIntelligence.description")}
          >
            <Toggle checked={meetingFollowsReasoning} onChange={setMeetingFollowsReasoning} />
          </SettingsRow>
        </SettingsPanelRow>
        {meetingFollowsReasoning && (
          <SettingsPanelRow>
            <p className="text-xs text-muted-foreground/80">
              {t("settingsPage.meetings.inheritedSummary", { summary: reasoningSummary })}
            </p>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      {!meetingFollowsReasoning && (
        <>
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
        </>
      )}
    </div>
  );
}

export default function MeetingSettings() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <SectionHeader
        title={t("settingsPage.meetings.title")}
        description={t("settingsPage.meetings.description")}
      />
      <MeetingTranscriptionPanel showHeader />
      <div className="border-t border-border/40 pt-6">
        <MeetingReasoningPanel showHeader />
      </div>
    </div>
  );
}
