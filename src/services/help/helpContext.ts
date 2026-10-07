import type { HelpTopic, HelpBasics } from "./productHelp";

export function projectHelpSettings(
  topic: HelpTopic,
  state: Record<string, unknown>,
  basics: HelpBasics,
  chat: { mode: string; provider: string },
  agentAllowed: boolean
) {
  const values: Record<string, string | boolean | null> = {};
  const add = (key: string, value: unknown) => {
    values[key] =
      typeof value === "boolean"
        ? value
        : typeof value === "string" && value.length <= 100 && !/[\r\n/@\\]|https?:|sk-/i.test(value)
          ? value || null
          : null;
  };
  if (topic === "hotkeys") {
    add("dictationKey", state.activeDictationKey || state.dictationKey);
    add("voiceAgentKey", state.voiceAgentKey);
    add("translationKey", state.translationKey);
    add("meetingKey", state.meetingKey);
    add("activationMode", state.activationMode);
    add(
      "activationModeLabel",
      state.activationMode === "push" ? "Hold" : state.activationMode === "tap" ? "Tap" : null
    );
  }
  if (topic === "microphone" || topic === "meetings") {
    add("microphoneSelectionMode", state.microphoneSelectionMode);
    const microphoneLabels: Record<string, string> = {
      system: "System Default",
      "built-in": "Prefer Built-in Microphone",
      specific: "Specific microphone",
    };
    add("microphoneSelectionModeLabel", microphoneLabels[String(state.microphoneSelectionMode)]);
    if (state.microphoneSelectionMode === "specific")
      add("selectedMicDeviceLabel", state.selectedMicDeviceLabel);
    add("microphonePermission", basics.microphonePermission);
  }
  if (topic === "meetings") add("systemAudioPermission", basics.systemAudioPermission);
  if (topic === "models" || topic === "meetings") {
    const engine = (prefix: string) => {
      const key = (name: string) =>
        prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
      const mode = state[key("transcriptionMode")];
      const provider =
        mode === "local"
          ? state[key("localTranscriptionProvider")]
          : mode === "providers"
            ? state[key("cloudTranscriptionProvider")]
            : mode;
      return typeof provider === "string" && /^[a-z-]{1,32}$/.test(provider) ? provider : null;
    };
    add("dictationEngine", engine(""));
    add("meetingEngine", engine("meeting"));
    add("uploadEngine", engine("upload"));
    add("transcriptionMode", state.transcriptionMode);
    add("meetingTranscriptionMode", state.meetingTranscriptionMode);
    add("uploadTranscriptionMode", state.uploadTranscriptionMode);
  }
  if (topic === "models" || topic === "assistant") {
    add("chatMode", chat.mode);
    // Custom model names and enterprise deployment identifiers can be private.
    add(
      "chatProvider",
      chat.mode === "providers" || chat.mode === "local" ? chat.provider : chat.mode
    );
    add("agentAllowed", agentAllowed);
  }
  if (topic === "language") {
    add("uiLanguage", state.uiLanguage);
    add("preferredLanguage", state.preferredLanguage);
  }
  if (topic === "backup") add("cloudBackupEnabled", state.cloudBackupEnabled);
  if (topic === "calendar") {
    add("gcalConnected", state.gcalConnected);
    add("mcalConnected", state.mcalConnected);
    add("appleCalendarConnected", state.appleCalendarConnected);
  }
  if (topic === "hotkeys") add("accessibilityPermission", basics.accessibilityPermission);
  return values;
}
