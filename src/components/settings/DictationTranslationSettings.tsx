import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import registry from "../../config/languageRegistry.json";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import PromptStudio from "../ui/PromptStudio";
import LanguageSelector from "../ui/LanguageSelector";
import InferenceConfigEditor from "./InferenceConfigEditor";

const TARGET_OPTIONS = registry.languages
  .filter((l) => l.code !== "auto")
  .map(({ code, label, flag }) => ({ value: code, label, flag }));

export default function DictationTranslationSettings() {
  const { t } = useTranslation();
  const useDictationTranslation = useSettingsStore((s) => s.useDictationTranslation);
  const setUseDictationTranslation = useSettingsStore((s) => s.setUseDictationTranslation);
  const translationSourceLanguage = useSettingsStore((s) => s.translationSourceLanguage);
  const setTranslationSourceLanguage = useSettingsStore((s) => s.setTranslationSourceLanguage);
  const translationTargetLanguage = useSettingsStore((s) => s.translationTargetLanguage);
  const setTranslationTargetLanguage = useSettingsStore((s) => s.setTranslationTargetLanguage);

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("dictationTranslation.enabled")}
            description={t("dictationTranslation.enabledDescription")}
          >
            <Toggle checked={useDictationTranslation} onChange={setUseDictationTranslation} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {useDictationTranslation && (
        <>
          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("dictationTranslation.sourceLanguage")}
                description={t("dictationTranslation.sourceLanguageDescription")}
              >
                <LanguageSelector
                  value={translationSourceLanguage}
                  onChange={setTranslationSourceLanguage}
                />
              </SettingsRow>
            </SettingsPanelRow>
            <SettingsPanelRow>
              <SettingsRow
                label={t("dictationTranslation.targetLanguage")}
                description={t("dictationTranslation.targetLanguageDescription")}
              >
                <LanguageSelector
                  value={translationTargetLanguage}
                  onChange={setTranslationTargetLanguage}
                  options={TARGET_OPTIONS}
                />
              </SettingsRow>
            </SettingsPanelRow>
          </SettingsPanel>

          {!translationTargetLanguage && (
            <p className="text-xs text-muted-foreground">
              {t("dictationTranslation.targetLanguageMissing")}
            </p>
          )}

          <InferenceConfigEditor scope="dictationTranslation" />

          <div className="border-t border-border/40 pt-6">
            <SectionHeader
              title={t("dictationTranslation.prompt.title")}
              description={t("dictationTranslation.prompt.description")}
            />
            <PromptStudio kind="translate" />
          </div>

          <p className="text-xs text-muted-foreground">
            {t("dictationTranslation.hotkeyHint")}
          </p>
        </>
      )}
    </div>
  );
}
