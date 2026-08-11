import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { InferenceModeSelector, SettingsRow } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode, MeetingDetectionStatus } from "../../types/electron";
import { useStartOnboarding } from "../../hooks/useStartOnboarding";
import { useMeetingDetectionHealth } from "../../hooks/useMeetingDetectionHealth";
import { Button } from "../ui/button";

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

const STATUS_STYLES: Record<MeetingDetectionStatus, string> = {
  healthy: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  degraded: "bg-warning/15 text-amber-700 dark:text-warning",
  unavailable: "bg-destructive/10 text-destructive",
  off: "bg-muted text-muted-foreground",
};

export function MeetingDetectionStatusRow() {
  const { t } = useTranslation();
  const { health } = useMeetingDetectionHealth();
  const status: MeetingDetectionStatus = health?.status ?? "off";
  // Reasons are diagnostic identifiers ("no-pollable-mic-signal"); they are for
  // the log and the bug report, so they are shown rather than translated.
  const reason = status === "healthy" ? null : health?.reason;

  return (
    <SettingsRow
      label={t("settings.meetingDetection.title")}
      description={
        reason
          ? t("settings.meetingDetection.reason", { reason })
          : t("settings.meetingDetection.description")
      }
    >
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
          {t(`settings.meetingDetection.status.${status}`)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => window.electronAPI?.openLogsFolder?.()}
        >
          {t("settings.meetingDetection.openLogs")}
        </Button>
      </div>
    </SettingsRow>
  );
}

export function MeetingAutoProcessRow() {
  const { t } = useTranslation();
  const autoPostCallPipeline = useSettingsStore((s) => s.autoPostCallPipeline);
  const setAutoPostCallPipeline = useSettingsStore((s) => s.setAutoPostCallPipeline);

  return (
    <SettingsRow
      label={t("settings.pipeline.autoProcess")}
      description={t("settings.pipeline.autoProcessDescription")}
    >
      <Toggle checked={autoPostCallPipeline} onChange={setAutoPostCallPipeline} />
    </SettingsRow>
  );
}

const noop = () => {};

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();
  const startOnboarding = useStartOnboarding();

  const {
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
  } = useSettingsStore();

  // Fork: hosted cloud modes removed — only on-device (local) and self-hosted.
  const transcriptionModes: InferenceModeOption[] = [
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
    if (mode === meetingTranscriptionMode) return;
    setMeetingTranscriptionMode(mode);
    setMeetingUseLocalWhisper(mode === "local");
    setMeetingCloudTranscriptionMode("byok");
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
      <MeetingAutoProcessRow />
    </div>
  );
}
