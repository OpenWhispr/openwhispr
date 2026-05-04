import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useSettingsStore,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
} from "../../stores/settingsStore";
import { useAgentName } from "../../utils/agentName";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { Toggle } from "../ui/toggle";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import PromptStudio from "../ui/PromptStudio";
import InferenceConfigEditor from "./InferenceConfigEditor";

export default function DictationAgentSettings() {
  const { t } = useTranslation();
  const useDictationAgent = useSettingsStore((s) => s.useDictationAgent);
  const setUseDictationAgent = useSettingsStore((s) => s.setUseDictationAgent);
  const agentConfig = useSettingsStore(
    useShallow((s) => selectResolvedLLMConfig(s, "dictationAgent"))
  );
  const cleanupConfig = useSettingsStore(
    useShallow((s) => selectResolvedLLMConfig(s, "dictationCleanup"))
  );
  const showUseCleanup = !agentConfig.provider && !agentConfig.model && !!cleanupConfig.provider;

  const { agentName, setAgentName } = useAgentName();
  const [agentNameInput, setAgentNameInput] = useState(agentName);
  const { customDictionary, setCustomDictionary } = useSettings();
  const { showAlertDialog } = useDialogs();

  const useCleanupModel = () => {
    setResolvedLLMConfig("dictationAgent", {
      provider: cleanupConfig.provider,
      model: cleanupConfig.model,
      cloudMode: cleanupConfig.cloudMode,
      cloudBaseUrl: cleanupConfig.cloudBaseUrl,
      remoteUrl: cleanupConfig.remoteUrl,
    });
  };

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

  const instructionMode = t("settingsPage.agentConfig.instructionMode");
  const examples = [
    {
      input: t("settingsPage.agentConfig.examples.formalEmail", { agentName }),
      mode: instructionMode,
    },
    {
      input: t("settingsPage.agentConfig.examples.professional", { agentName }),
      mode: instructionMode,
    },
    {
      input: t("settingsPage.agentConfig.examples.bulletPoints", { agentName }),
      mode: instructionMode,
    },
    {
      input: t("settingsPage.agentConfig.cleanupExample"),
      mode: t("settingsPage.agentConfig.cleanupMode"),
    },
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
              {examples.map((example, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span
                    className={`shrink-0 mt-0.5 text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                      example.mode === instructionMode
                        ? "bg-primary/10 text-primary dark:bg-primary/15"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {example.mode}
                  </span>
                  <p className="text-xs text-muted-foreground leading-relaxed">"{example.input}"</p>
                </div>
              ))}
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("dictationAgent.enabled")}
            description={t("dictationAgent.enabledDescription")}
          >
            <Toggle checked={useDictationAgent} onChange={setUseDictationAgent} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {useDictationAgent && (
        <>
          <SettingsPanel>
            <SettingsPanelRow>
              <SectionHeader
                title={t("dictationAgent.title")}
                description={t("dictationAgent.description")}
              />
            </SettingsPanelRow>
          </SettingsPanel>

          {showUseCleanup && (
            <button
              type="button"
              onClick={useCleanupModel}
              className="text-sm text-primary hover:underline"
            >
              {t("dictationAgent.useCleanupModel")}
            </button>
          )}

          <InferenceConfigEditor scope="dictationAgent" />
        </>
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
