import { useTranslation } from "react-i18next";
import { SettingsPanel, SettingsPanelRow, SectionHeader } from "../ui/SettingsSection";
import PromptStudio from "../ui/PromptStudio";
import InferenceConfigEditor from "./InferenceConfigEditor";

export default function DictationAgentSettings() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
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
    </div>
  );
}
