import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { TONE_APP_CATEGORIES, TONE_OPTIONS, type ToneStyles } from "../../config/toneStyle";
import { AppMarkStack } from "../toneStyle/toneStyleVisuals";
import { CATEGORY_APP_MARKS } from "../toneStyle/appMarks";
import { dictationCleanupHasModel, turnOnDictationCleanup } from "../toneStyle/dictationCleanup";

interface ToneStyleSectionProps {
  /** Opens the cleanup model settings when cleanup was turned on without one. */
  onSetUpCleanup: () => void;
}

export default function ToneStyleSection({ onSetUpCleanup }: ToneStyleSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const savedStyles = useSettingsStore((s) => s.toneStyles);
  const toneStyleEnabled = useSettingsStore((s) => s.toneStyleEnabled);
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const [draft, setDraft] = useState<ToneStyles>(savedStyles);
  const dirty = TONE_APP_CATEGORIES.some((category) => draft[category] !== savedStyles[category]);

  const save = () => {
    useSettingsStore.getState().setToneStyles(draft);
    toast({ title: t("toneStyle.settings.saved") });
  };

  const turnOnCleanup = () => {
    turnOnDictationCleanup();
    if (!dictationCleanupHasModel()) onSetUpCleanup();
  };

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="brand-heading text-base font-semibold text-foreground">
            {t("toneStyle.title")}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("toneStyle.description")}</p>
        </div>
        {/* Clear of the modal's close button in the corner. */}
        <Button
          variant={dirty ? "default" : "secondary"}
          className="me-8 h-8 shrink-0 border-transparent px-4 text-[13px] disabled:opacity-100 disabled:text-muted-foreground/60"
          disabled={!dirty}
          onClick={save}
        >
          {t("toneStyle.settings.saveChanges")}
        </Button>
      </div>

      <SettingsPanel className="mb-6">
        <SettingsPanelRow>
          <SettingsRow
            label={t("toneStyle.settings.enable")}
            description={
              useCleanupModel ? (
                t("toneStyle.settings.enableDescription")
              ) : (
                <>
                  {t("toneStyle.settings.cleanupOff")}{" "}
                  <button
                    type="button"
                    onClick={turnOnCleanup}
                    className="font-medium text-primary hover:underline"
                  >
                    {t("toneStyle.settings.turnOnCleanup")}
                  </button>
                </>
              )
            }
          >
            <Toggle
              checked={toneStyleEnabled}
              onChange={(value) => useSettingsStore.getState().setToneStyleEnabled(value)}
              ariaLabel={t("toneStyle.settings.enable")}
            />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <div className="space-y-6">
        {TONE_APP_CATEGORIES.map((category) => {
          const title = t(`toneStyle.categories.${category}.title`);
          return (
            <section key={category}>
              <div className="mb-4 flex items-center gap-3">
                <AppMarkStack marks={CATEGORY_APP_MARKS[category].settings} size={22} />
                <h4 className="text-[15px] font-medium text-foreground">{title}</h4>
              </div>
              <div role="group" aria-label={title} className="grid grid-cols-3 gap-4">
                {TONE_OPTIONS[category].map((tone) => {
                  const selected = draft[category] === tone;
                  return (
                    <button
                      key={tone}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setDraft((current) => ({ ...current, [category]: tone }))}
                      className={cn(
                        "flex h-[34px] items-center gap-2.5 rounded-[9px] border px-3 text-start text-[13px] text-foreground transition-colors",
                        "outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                        selected
                          ? "border-transparent bg-primary/12 dark:bg-primary/15"
                          : "border-border hover:bg-muted/50 dark:border-white/10 dark:hover:bg-white/5"
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                          selected
                            ? "border-primary bg-primary"
                            : "border-border-hover dark:border-white/25"
                        )}
                      >
                        {selected && (
                          <span className="size-1.25 rounded-full bg-primary-foreground" />
                        )}
                      </span>
                      {t(`toneStyle.tones.${tone}`)}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
