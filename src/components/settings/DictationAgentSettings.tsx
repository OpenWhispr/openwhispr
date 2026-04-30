import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import PromptStudio from "../ui/PromptStudio";
import InferenceConfigEditor from "./InferenceConfigEditor";

export default function DictationAgentSettings() {
  const { t } = useTranslation();
  const useDictationAgent = useSettingsStore((s) => s.useDictationAgent);
  const setUseDictationAgent = useSettingsStore((s) => s.setUseDictationAgent);

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
