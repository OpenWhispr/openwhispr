import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { HelpEvidenceData } from "./helpEvidence";

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
  providers: "settingsPage.aiModels.modes.providers",
};

export function HelpEvidence({ evidence }: { evidence: HelpEvidenceData }) {
  const { t } = useTranslation();
  const [openFailed, setOpenFailed] = useState(false);
  const reasons = [...new Set(evidence.sources.flatMap((source) => source.reason ?? []))];
  const labelFor = (label: string) => {
    if (factLabels[label]) return t(factLabels[label], { defaultValue: label });
    const match = label.match(/^(.*) (processing|engine)$/);
    return match && activities[match[1]]
      ? `${t(activities[match[1]])} (${t(`productHelp.${match[2]}`)})`
      : label;
  };

  return (
    <div className="mt-3 border-t border-border/70 pt-2 text-xs" data-help-evidence>
      <p className="text-muted-foreground">{t("productHelp.guidance")}</p>
      {reasons.map((reason) => (
        <p key={reason} className="mt-1 text-muted-foreground">
          {t(`productHelp.reason.${reason}`)}
        </p>
      ))}
      {evidence.facts.length > 0 && (
        <details className="mt-2" open>
          <summary className="cursor-pointer font-medium">{t("productHelp.settings")}</summary>
          <p className="mt-1 text-muted-foreground">{t("productHelp.settingsNote")}</p>
          {evidence.readAt && (
            <p className="mt-1 text-muted-foreground">
              {t("productHelp.readAt", { time: new Date(evidence.readAt).toLocaleString() })}
            </p>
          )}
          <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {evidence.facts.map((fact, index) => (
              <div key={`${fact.label}-${index}`} className="contents">
                <dt className="text-muted-foreground break-words">{labelFor(fact.label)}</dt>
                <dd dir="auto" className="break-words">
                  {factValues[fact.value] ? t(factValues[fact.value]) : fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {evidence.sources.length > 0 && (
        <div className="mt-2">
          <p className="font-medium">{t("productHelp.sources")}</p>
          <ul className="mt-1 space-y-1">
            {evidence.sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  className="text-primary underline underline-offset-2 break-words"
                  onClick={async (event) => {
                    event.preventDefault();
                    try {
                      const result = await window.electronAPI?.openExternal(source.url);
                      setOpenFailed(!result?.success);
                    } catch {
                      setOpenFailed(true);
                    }
                  }}
                >
                  {t(`productHelp.topicsList.${source.title}`, { defaultValue: source.title })}
                </a>
                <span className="ms-1 text-muted-foreground">
                  ({t(`productHelp.sourceStatus.${source.source}`)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {openFailed && (
        <p role="alert" className="mt-1 text-destructive">
          {t("productHelp.openFailed")}
        </p>
      )}
    </div>
  );
}
