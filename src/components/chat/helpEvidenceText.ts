import registry from "../../models/modelRegistryData.json";
import type { TFunction } from "i18next";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
import type { HelpEvidenceData } from "./helpEvidence";
import { markdownToPlainText } from "../../helpers/markdownToPlainText";

const factLabels: Record<string, string> = {
  appVersion: "productHelp.appVersion",
  platform: "productHelp.platform",
  dictationKey: "settingsPage.general.hotkey.title",
  voiceAgentKey: "settingsPage.general.voiceAgentHotkey.title",
  translationKey: "settingsPage.general.translationHotkey.title",
  meetingKey: "settingsPage.general.meetingHotkey.title",
  activationMode: "settingsPage.general.hotkey.activationMode",
  microphoneSelectionMode: "microphoneSettings.inputDevice",
  microphonePermission: "productHelp.microphonePermission",
  accessibilityPermission: "onboarding.permissions.accessibilityTitle",
  systemAudioPermission: "settingsPage.permissions.systemAudioTitle",
  agentAllowed: "productHelp.policy",
  chatProvider: "providerErrors.details.provider",
  uiLanguage: "settings.language.uiLabel",
  preferredLanguage: "settings.language.transcriptionLabel",
  cloudBackupEnabled: "settingsPage.privacy.cloudBackup",
  gcalConnected: "integrations.googleCalendar.title",
  mcalConnected: "integrations.microsoftCalendar.title",
  appleCalendarConnected: "integrations.appleCalendar.title",
};
const activityKeys: Record<string, [string, string]> = {
  transcriptionMode: ["dictation", "processing"],
  meetingTranscriptionMode: ["noteRecording", "processing"],
  uploadTranscriptionMode: ["upload", "processing"],
  dictationEngine: ["dictation", "engine"],
  meetingEngine: ["noteRecording", "engine"],
  uploadEngine: ["upload", "engine"],
};
const factValues: Record<string, string> = {
  push: "common.hold",
  tap: "common.tap",
  system: "microphoneSettings.systemDefault",
  "built-in": "microphoneSettings.preferBuiltIn.label",
  "Prefer Built-in Microphone": "microphoneSettings.preferBuiltIn.label",
  specific: "productHelp.specificMicrophone",
  "Specific microphone": "productHelp.specificMicrophone",
  granted: "productHelp.permissionGranted",
  denied: "productHelp.permissionDenied",
  restricted: "productHelp.permissionRestricted",
  "not-determined": "productHelp.permissionNotDetermined",
  unknown: "common.unknown",
  Hold: "common.hold",
  Tap: "common.tap",
  "System Default": "microphoneSettings.systemDefault",
  Unknown: "common.unknown",
  On: "productHelp.on",
  Off: "productHelp.off",
  local: "common.local",
  cloud: "common.cloud",
  openwhispr: "settingsPage.aiModels.modes.openwhispr",
  providers: "settingsPage.aiModels.modes.providers",
};

const providerNames = new Map(
  [
    ...registry.transcriptionProviders,
    ...registry.cloudProviders,
    ...registry.enterpriseProviders,
    ...registry.localProviders,
  ].map((provider) => [provider.id, provider.name])
);
providerNames.set("whisper-local", "Whisper");
providerNames.set("parakeet", "NVIDIA Parakeet");

export function helpFactLabel(key: string, t: TFunction): string {
  if (factLabels[key]) return t(factLabels[key]);
  const activity = activityKeys[key];
  if (activity)
    return `${t(`settingsPage.speechToText.tabs.${activity[0]}`)} (${t(`productHelp.${activity[1]}`)})`;
  const modeLabels: Record<string, string> = {
    chatMode: "chatIntelligence",
    voiceAssistantMode: "dictationAgent",
    cleanupMode: "dictationCleanup",
  };
  return modeLabels[key]
    ? `${t(`settingsPage.llms.tabs.${modeLabels[key]}`)} (${t("productHelp.processing")})`
    : key;
}

export function helpFactValue(value: string, t: TFunction, key?: string, locale?: string): string {
  if (value === "Unknown" || value === "unknown") return t("common.unknown");
  if (key && ["dictationKey", "voiceAgentKey", "translationKey", "meetingKey"].includes(key))
    return formatHotkeyListLabel(value);
  if (key === "platform")
    return (
      ({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string, string>)[value] ??
      value
    );
  if (key === "uiLanguage" || key === "preferredLanguage") {
    try {
      return (
        new Intl.DisplayNames(locale ? [locale] : undefined, { type: "language" }).of(value) ??
        value
      );
    } catch {
      return value;
    }
  }
  if (factValues[value]) return t(factValues[value]);
  if (key && ["chatProvider", "dictationEngine", "meetingEngine", "uploadEngine"].includes(key))
    return providerNames.get(value) ?? t("common.unknown");
  return value;
}

/** Explicit Copy keeps the help qualifications and validated links with the answer. */
export function helpAnswerPlainText(
  content: string,
  evidence: HelpEvidenceData | null,
  t: TFunction,
  locale?: string
): string {
  if (!evidence) return content;
  const lines = [markdownToPlainText(content), "", t("productHelp.guidance")];
  const reasons = [...new Set(evidence.sources.flatMap((source) => source.reason ?? []))];
  for (const reason of reasons) lines.push(t(`productHelp.reason.${reason}`));
  if (evidence.facts.length) {
    lines.push("", t("productHelp.settings"), t("productHelp.settingsNote"));
    if (evidence.readAt)
      lines.push(t("productHelp.readAt", { time: new Date(evidence.readAt).toLocaleString() }));
    for (const fact of evidence.facts)
      lines.push(
        `${helpFactLabel(fact.key, t)}: ${helpFactValue(fact.value, t, fact.key, locale)}`
      );
  }
  if (evidence.sources.length) {
    lines.push("", t("productHelp.sources"));
    for (const source of evidence.sources) {
      const title = t(`productHelp.topicsList.${source.title}`, { defaultValue: source.title });
      lines.push(`- ${title} (${t(`productHelp.sourceStatus.${source.source}`)}): ${source.url}`);
    }
  }
  return lines.join("\n");
}
