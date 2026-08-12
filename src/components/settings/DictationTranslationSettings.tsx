import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettingsStore, MAX_TRANSLATION_TARGETS } from "../../stores/settingsStore";
import registry from "../../config/languageRegistry.json";
import { getLanguageLabel } from "../../utils/languageSupport";
import { cn } from "../lib/utils";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import PromptStudio from "../ui/PromptStudio";
import LanguageSelector from "../ui/LanguageSelector";
import InferenceConfigEditor from "./InferenceConfigEditor";

const TARGET_OPTIONS = registry.languages
  .filter((l) => l.code !== "auto")
  .map(({ code, label, flag }) => ({ value: code, label, flag }));

const OPTION_BY_CODE = new Map(TARGET_OPTIONS.map((o) => [o.value, o]));

export default function DictationTranslationSettings() {
  const { t } = useTranslation();
  const useDictationTranslation = useSettingsStore((s) => s.useDictationTranslation);
  const setUseDictationTranslation = useSettingsStore((s) => s.setUseDictationTranslation);
  const translationSourceLanguage = useSettingsStore((s) => s.translationSourceLanguage);
  const setTranslationSourceLanguage = useSettingsStore((s) => s.setTranslationSourceLanguage);
  const translationTargetLanguage = useSettingsStore((s) => s.translationTargetLanguage);
  const setTranslationTargetLanguage = useSettingsStore((s) => s.setTranslationTargetLanguage);
  const translationTargets = useSettingsStore((s) => s.translationTargets);
  const setTranslationTargets = useSettingsStore((s) => s.setTranslationTargets);

  const atCap = translationTargets.length >= MAX_TRANSLATION_TARGETS;
  const availableOptions = TARGET_OPTIONS.filter((o) => !translationTargets.includes(o.value));

  const addTarget = (code: string) => {
    if (!code || translationTargets.includes(code) || atCap) return;
    setTranslationTargets([...translationTargets, code]);
    setTranslationTargetLanguage(code);
  };

  const removeTarget = (code: string) => {
    if (translationTargets.length <= 1) return;
    const next = translationTargets.filter((v) => v !== code);
    setTranslationTargets(next);
    // Moving away from the removed active target keeps a valid active language.
    if (translationTargetLanguage === code) setTranslationTargetLanguage(next[0] ?? "");
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("dictationTranslation.title")}
        description={t("dictationTranslation.description")}
      />
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
                label={t("dictationTranslation.targetsLabel")}
                description={t("dictationTranslation.maxTargets", {
                  max: MAX_TRANSLATION_TARGETS,
                })}
              >
                <div className="flex flex-col items-end gap-2">
                  {translationTargets.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {translationTargets.map((target) => {
                        const label = OPTION_BY_CODE.get(target)?.label ?? getLanguageLabel(target);
                        const flag = OPTION_BY_CODE.get(target)?.flag ?? "";
                        const isActive = target === translationTargetLanguage;
                        return (
                          <div
                            key={target}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs font-medium transition-colors",
                              isActive
                                ? "bg-primary/10 text-primary ring-1 ring-primary/30"
                                : "bg-muted text-muted-foreground"
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => setTranslationTargetLanguage(target)}
                              aria-pressed={isActive}
                              aria-label={t("dictationTranslation.activeTarget")}
                              className="inline-flex items-center gap-1"
                            >
                              {flag && <span aria-hidden="true">{flag}</span>}
                              <span>{label}</span>
                            </button>
                            {translationTargets.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeTarget(target)}
                                aria-label={t("dictationTranslation.removeTarget", {
                                  language: label,
                                })}
                                className="rounded-full p-0.5 hover:text-destructive"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!atCap && (
                    <LanguageSelector
                      value=""
                      onChange={addTarget}
                      options={availableOptions}
                      placeholder={t("dictationTranslation.addTarget")}
                    />
                  )}
                </div>
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

          <p className="text-xs text-muted-foreground">{t("dictationTranslation.hotkeyHint")}</p>
        </>
      )}
    </div>
  );
}
