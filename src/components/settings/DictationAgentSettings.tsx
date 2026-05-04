import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useSettingsStore,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
} from "../../stores/settingsStore";
import { Toggle } from "../ui/toggle";
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

  const useCleanupModel = () => {
    setResolvedLLMConfig("dictationAgent", {
      provider: cleanupConfig.provider,
      model: cleanupConfig.model,
      cloudMode: cleanupConfig.cloudMode,
      cloudBaseUrl: cleanupConfig.cloudBaseUrl,
      remoteUrl: cleanupConfig.remoteUrl,
    });
  };

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

          <div className="border-t border-border/40 pt-6">
            <SectionHeader
              title={t("dictationAgent.prompt.title")}
              description={t("dictationAgent.prompt.description")}
            />
            <PromptStudio kind="dictationAgent" />
          </div>
        </>
      )}
    </div>
  );
}
