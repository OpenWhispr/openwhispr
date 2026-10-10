import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../stores/settingsStore";
import { Info } from "../icons";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";

function VADLabelWithInfo({ label, description }: { label: string; description: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
      <span>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-sm p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function WhisperVadSettings({ context }: { context: "dictation" | "meeting" }) {
  const visible = useSettingsStore((s) =>
    context === "dictation"
      ? s.transcriptionMode === "local" && s.localTranscriptionProvider === "whisper"
      : s.meetingTranscriptionMode === "local" && s.meetingLocalTranscriptionProvider === "whisper"
  );
  return visible ? <WhisperVadControls /> : null;
}

function WhisperVadControls() {
  const { t } = useTranslation();
  const {
    dictationSileroEnabled,
    setDictationSileroEnabled,
    noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled,
    meetingSileroEnabled,
    setMeetingSileroEnabled,
    whisperVadThreshold,
    setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap,
  } = useSettingsStore(
    useShallow((s) => ({
      dictationSileroEnabled: s.dictationSileroEnabled,
      setDictationSileroEnabled: s.setDictationSileroEnabled,
      noteRecordingSileroEnabled: s.noteRecordingSileroEnabled,
      setNoteRecordingSileroEnabled: s.setNoteRecordingSileroEnabled,
      meetingSileroEnabled: s.meetingSileroEnabled,
      setMeetingSileroEnabled: s.setMeetingSileroEnabled,
      whisperVadThreshold: s.whisperVadThreshold,
      setWhisperVadThreshold: s.setWhisperVadThreshold,
      whisperVadMinSpeechDurationMs: s.whisperVadMinSpeechDurationMs,
      setWhisperVadMinSpeechDurationMs: s.setWhisperVadMinSpeechDurationMs,
      whisperVadMinSilenceDurationMs: s.whisperVadMinSilenceDurationMs,
      setWhisperVadMinSilenceDurationMs: s.setWhisperVadMinSilenceDurationMs,
      whisperVadMaxSpeechDurationS: s.whisperVadMaxSpeechDurationS,
      setWhisperVadMaxSpeechDurationS: s.setWhisperVadMaxSpeechDurationS,
      whisperVadSpeechPadMs: s.whisperVadSpeechPadMs,
      setWhisperVadSpeechPadMs: s.setWhisperVadSpeechPadMs,
      whisperVadSamplesOverlap: s.whisperVadSamplesOverlap,
      setWhisperVadSamplesOverlap: s.setWhisperVadSamplesOverlap,
    }))
  );

  return (
    <div>
      <SectionHeader
        title={t("settingsPage.transcription.vad.title")}
        description={t("settingsPage.transcription.vad.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.dictation.title")}
            description={t("settingsPage.transcription.vad.toggles.dictation.description")}
          >
            <Toggle
              ariaLabel={t("settingsPage.transcription.vad.toggles.dictation.title")}
              checked={dictationSileroEnabled}
              onChange={setDictationSileroEnabled}
            />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.noteRecording.title")}
            description={t("settingsPage.transcription.vad.toggles.noteRecording.description")}
          >
            <Toggle
              ariaLabel={t("settingsPage.transcription.vad.toggles.noteRecording.title")}
              checked={noteRecordingSileroEnabled}
              onChange={setNoteRecordingSileroEnabled}
            />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.meeting.title")}
            description={t("settingsPage.transcription.vad.toggles.meeting.description")}
          >
            <Toggle
              ariaLabel={t("settingsPage.transcription.vad.toggles.meeting.title")}
              checked={meetingSileroEnabled}
              onChange={setMeetingSileroEnabled}
            />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.threshold.label")}
                description={t("settingsPage.transcription.vad.fields.threshold.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="0.01"
                min="0.1"
                max="0.95"
                aria-label={t("settingsPage.transcription.vad.fields.threshold.label")}
                value={whisperVadThreshold}
                onChange={(e) => setWhisperVadThreshold(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.label")}
                description={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="50"
                max="2000"
                aria-label={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.label")}
                value={whisperVadMinSpeechDurationMs}
                onChange={(e) => setWhisperVadMinSpeechDurationMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.label")}
                description={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="50"
                max="2000"
                aria-label={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.label")}
                value={whisperVadMinSilenceDurationMs}
                onChange={(e) => setWhisperVadMinSilenceDurationMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.label")}
                description={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="1"
                min="5"
                max="120"
                aria-label={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.label")}
                value={whisperVadMaxSpeechDurationS}
                onChange={(e) => setWhisperVadMaxSpeechDurationS(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.speechPadMs.label")}
                description={t("settingsPage.transcription.vad.fields.speechPadMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="0"
                max="1000"
                aria-label={t("settingsPage.transcription.vad.fields.speechPadMs.label")}
                value={whisperVadSpeechPadMs}
                onChange={(e) => setWhisperVadSpeechPadMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.samplesOverlap.label")}
                description={t("settingsPage.transcription.vad.fields.samplesOverlap.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="0.01"
                min="0"
                max="0.95"
                aria-label={t("settingsPage.transcription.vad.fields.samplesOverlap.label")}
                value={whisperVadSamplesOverlap}
                onChange={(e) => setWhisperVadSamplesOverlap(Number(e.target.value))}
              />
            </div>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
