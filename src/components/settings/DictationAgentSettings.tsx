import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAgentName } from "../../utils/agentName";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { useScreenRecordingPermission } from "../../hooks/useScreenRecordingPermission";
import { Toggle } from "../ui/toggle";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import PermissionCard from "../ui/PermissionCard";
import PromptStudio from "../ui/PromptStudio";
import InferenceConfigEditor from "./InferenceConfigEditor";

export default function DictationAgentSettings() {
  const { t } = useTranslation();
  const useDictationAgent = useSettingsStore((s) => s.useDictationAgent);
  const setUseDictationAgent = useSettingsStore((s) => s.setUseDictationAgent);
  const voiceAgentScreenContext = useSettingsStore((s) => s.voiceAgentScreenContext);
  const setVoiceAgentScreenContext = useSettingsStore((s) => s.setVoiceAgentScreenContext);
  const useDictationAgentVisionModel = useSettingsStore((s) => s.useDictationAgentVisionModel);
  const setUseDictationAgentVisionModel = useSettingsStore(
    (s) => s.setUseDictationAgentVisionModel
  );
  const {
    isMacOS,
    granted: screenGranted,
    supported: screenSupported,
    request: requestScreenAccess,
  } = useScreenRecordingPermission();

  const { agentName, setAgentName } = useAgentName();
  const [agentNameInput, setAgentNameInput] = useState(agentName);
  const { customDictionary, setCustomDictionary } = useSettings();
  const { showAlertDialog } = useDialogs();

  const handleSaveAgentName = useCallback(() => {
    const trimmed = agentNameInput.trim();
    const previousName = agentName;

    setAgentName(trimmed);
    setAgentNameInput(trimmed);

    let nextDictionary = customDictionary.filter((w) => w !== previousName);
    if (trimmed) {
      const hasName = nextDictionary.some((w) => w.toLowerCase() === trimmed.toLowerCase());
      if (!hasName) {
        nextDictionary = [trimmed, ...nextDictionary];
      }
    }
    setCustomDictionary(nextDictionary);

    showAlertDialog({
      title: t("settingsPage.agentConfig.dialogs.updatedTitle"),
      description: t("settingsPage.agentConfig.dialogs.updatedDescription", {
        name: trimmed,
      }),
    });
  }, [
    agentNameInput,
    agentName,
    customDictionary,
    setAgentName,
    setCustomDictionary,
    showAlertDialog,
    t,
  ]);

  const handleScreenContextToggle = useCallback(
    (enabled: boolean) => {
      setVoiceAgentScreenContext(enabled);
      // Keeps the dictation overlay out of its own screenshots.
      window.electronAPI?.setScreenContextEnabled?.(enabled);
      if (enabled && isMacOS && !screenGranted) {
        void requestScreenAccess();
      }
    },
    [setVoiceAgentScreenContext, isMacOS, screenGranted, requestScreenAccess]
  );

  const instructionMode = t("settingsPage.agentConfig.instructionMode");
  const examples = [
    t("settingsPage.agentConfig.examples.formalEmail", { agentName }),
    t("settingsPage.agentConfig.examples.professional", { agentName }),
    t("settingsPage.agentConfig.examples.bulletPoints", { agentName }),
  ];

  const voiceAgentSection = (
    <div className="border-t border-border/40 pt-6 space-y-5">
      <SectionHeader
        title={t("settingsPage.agentConfig.title")}
        description={t("settingsPage.agentConfig.description")}
      />

      <div>
        <p className="text-xs font-medium text-foreground mb-3">
          {t("settingsPage.agentConfig.agentName")}
        </p>
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder={t("settingsPage.agentConfig.placeholder")}
                  value={agentNameInput}
                  onChange={(e) => setAgentNameInput(e.target.value)}
                  className="flex-1 text-center text-base font-mono"
                />
                <Button onClick={handleSaveAgentName} disabled={!agentNameInput.trim()} size="sm">
                  {t("settingsPage.agentConfig.save")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground/60">
                {t("settingsPage.agentConfig.helper")}
              </p>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
        <SettingsPanel>
          <SettingsPanelRow>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
            </p>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-2.5">
              {examples.map((input, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="shrink-0 mt-0.5 text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded bg-primary/10 text-primary dark:bg-primary/15">
                    {instructionMode}
                  </span>
                  <p className="text-xs text-muted-foreground leading-relaxed">"{input}"</p>
                </div>
              ))}
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("dictationAgent.enabled")}
            description={t("dictationAgent.enabledDescription", { agentName })}
          >
            <Toggle checked={useDictationAgent} onChange={setUseDictationAgent} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {useDictationAgent && <InferenceConfigEditor scope="dictationAgent" />}

      {useDictationAgent && (
        <div className="border-t border-border/40 pt-6 space-y-3">
          <SectionHeader
            title={t("dictationAgent.screenContext.title")}
            description={t("dictationAgent.screenContext.description")}
          />
          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("dictationAgent.screenContext.enable")}
                description={
                  screenSupported
                    ? t("dictationAgent.screenContext.enableDescription")
                    : t("dictationAgent.screenContext.unsupported")
                }
              >
                <Toggle
                  checked={voiceAgentScreenContext}
                  onChange={handleScreenContextToggle}
                  disabled={!screenSupported}
                />
              </SettingsRow>
            </SettingsPanelRow>
            {voiceAgentScreenContext && (
              <SettingsPanelRow>
                <SettingsRow
                  label={t("dictationAgent.screenContext.visionModel")}
                  description={t("dictationAgent.screenContext.visionModelDescription")}
                >
                  <Toggle
                    checked={useDictationAgentVisionModel}
                    onChange={setUseDictationAgentVisionModel}
                  />
                </SettingsRow>
              </SettingsPanelRow>
            )}
          </SettingsPanel>
          {voiceAgentScreenContext && isMacOS && !screenGranted && (
            <PermissionCard
              icon={Monitor}
              title={t("dictationAgent.screenContext.permissionTitle")}
              description={t("dictationAgent.screenContext.permissionDescription")}
              granted={false}
              onRequest={requestScreenAccess}
              buttonText={t("onboarding.permissions.grantAccess")}
            />
          )}
          {voiceAgentScreenContext && useDictationAgentVisionModel && (
            <InferenceConfigEditor
              scope="dictationAgentVision"
              allowedModes={["openwhispr", "providers"]}
            />
          )}
        </div>
      )}

      {voiceAgentSection}

      {useDictationAgent && (
        <div className="border-t border-border/40 pt-6">
          <SectionHeader
            title={t("dictationAgent.prompt.title")}
            description={t("dictationAgent.prompt.description")}
          />
          <PromptStudio kind="dictationAgent" />
        </div>
      )}
    </div>
  );
}
