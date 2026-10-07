import type { TFunction } from "i18next";
import type { HelpEvidenceData } from "./helpEvidence";
import { markdownToPlainText } from "../../helpers/markdownToPlainText";

const factLabels: Record<string, string> = {
  "App version": "productHelp.appVersion",
  Platform: "productHelp.platform",
  "OS version": "productHelp.osVersion",
  "Dictation shortcut": "settingsPage.general.hotkey.title",
  "Voice Assistant shortcut": "settingsPage.general.voiceAgentHotkey.title",
  "Translation shortcut": "settingsPage.general.translationHotkey.title",
  "Meeting shortcut": "settingsPage.general.meetingHotkey.title",
  "Activation mode": "settingsPage.general.hotkey.activationMode",
  "Microphone selection": "microphoneSettings.inputDevice",
  "Selected microphone": "settingsPage.general.microphone.title",
  "Microphone permission": "onboarding.permissions.microphoneTitle",
  "Accessibility permission": "onboarding.permissions.accessibilityTitle",
  "System audio permission": "settingsPage.permissions.systemAudioTitle",
  "Assistant allowed by policy": "productHelp.policy",
  "Chat provider": "providerErrors.details.provider",
  "Interface language": "settings.language.uiLabel",
  "Transcription language": "settings.language.transcriptionLabel",
  "Cloud backup": "settingsPage.privacy.cloudBackup",
  "Google Calendar connected": "integrations.googleCalendar.title",
  "Microsoft Calendar connected": "integrations.microsoftCalendar.title",
  "Apple Calendar connected": "integrations.appleCalendar.title",
};
const activities: Record<string, string> = {
  Dictation: "settingsPage.speechToText.tabs.dictation",
  Meeting: "settingsPage.speechToText.tabs.noteRecording",
  Upload: "settingsPage.speechToText.tabs.upload",
  Chat: "settingsPage.llms.tabs.chatIntelligence",
  "Voice Assistant": "settingsPage.llms.tabs.dictationAgent",
  Cleanup: "settingsPage.llms.tabs.dictationCleanup",
};
const factValues: Record<string, string> = {
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

export function helpFactLabel(label: string, t: TFunction): string {
  if (factLabels[label]) return t(factLabels[label], { defaultValue: label });
  const match = label.match(/^(.*) (processing|engine)$/);
  return match && activities[match[1]]
    ? `${t(activities[match[1]])} (${t(`productHelp.${match[2]}`)})`
    : label;
}

export function helpFactValue(value: string, t: TFunction): string {
  return factValues[value] ? t(factValues[value]) : value;
}

/** Explicit Copy keeps the help qualifications and validated links with the answer. */
export function helpAnswerPlainText(
  content: string,
  evidence: HelpEvidenceData | null,
  t: TFunction
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
      lines.push(`${helpFactLabel(fact.label, t)}: ${helpFactValue(fact.value, t)}`);
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
