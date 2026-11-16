import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { InfoBox } from "../ui/InfoBox";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { dismissToneStyleBanner } from "../../hooks/useToneStylePrompt";
import { TONE_APP_CATEGORIES, TONE_OPTIONS, type ToneStyles } from "../../config/toneStyle";
import { AppMarkStack } from "../toneStyle/toneStyleVisuals";
import { CATEGORY_APP_MARKS } from "../toneStyle/appMarks";
import { dictationCleanupHasModel, turnOnDictationCleanup } from "../toneStyle/dictationCleanup";

interface ToneStyleSectionProps {
  onOpenCleanupSettings: () => void;
}

export default function ToneStyleSection({ onOpenCleanupSettings }: ToneStyleSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const savedStyles = useSettingsStore((s) => s.toneStyles);
  const toneStyleEnabled = useSettingsStore((s) => s.toneStyleEnabled);
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const [draft, setDraft] = useState<ToneStyles>(savedStyles);
  const canSave =
    toneStyleEnabled &&
    TONE_APP_CATEGORIES.some((category) => draft[category] !== savedStyles[category]);

  const save = () => {
    useSettingsStore.getState().setToneStyles(draft);
    toast({ title: t("toneStyle.settings.saved") });
  };

  // As in the setup dialog: cleanup without a usable model goes on to pick one.
  const turnOnCleanup = () => {
    turnOnDictationCleanup();
    if (!dictationCleanupHasModel()) onOpenCleanupSettings();
  };

  return (
    <div>
      <div className="mb-5">
        <h3 className="text-base font-normal! tracking-normal! text-foreground">
          {t("toneStyle.title")}
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">{t("toneStyle.description")}</p>
      </div>

      {/* Off, cleanup keeps the speaker's own tone (the standard tone). */}
      <SettingsPanel className="mb-6">
        <SettingsPanelRow>
          <SettingsRow
            label={t("toneStyle.settings.enabled")}
            description={t("toneStyle.settings.enabledDescription")}
          >
            <Toggle
              checked={toneStyleEnabled}
              onChange={(enabled) => {
                useSettingsStore.getState().setToneStyleEnabled(enabled);
                if (enabled) dismissToneStyleBanner();
              }}
              ariaLabel={t("toneStyle.settings.enabled")}
            />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {/* Tones only shape what cleanup writes. */}
      {toneStyleEnabled && !useCleanupModel && (
        <InfoBox variant="warning" className="mb-6 flex items-center justify-between gap-4 p-3">
          <p className="text-[13px] text-foreground">{t("toneStyle.settings.cleanupOff")}</p>
          <Button variant="outline" size="sm" className="shrink-0" onClick={turnOnCleanup}>
            {t("toneStyle.settings.turnOnCleanup")}
          </Button>
        </InfoBox>
      )}

      <div className={cn(!toneStyleEnabled && "pointer-events-none opacity-50")}>
        <div className="space-y-6">
          {TONE_APP_CATEGORIES.map((category) => {
            const title = t(`toneStyle.categories.${category}.title`);
            return (
              <section key={category}>
                <div className="mb-4 flex items-center gap-3">
                  <AppMarkStack marks={CATEGORY_APP_MARKS[category].settings} size={22} />
                  <h4 className="text-[15px] font-normal! tracking-normal! text-foreground">
                    {title}
                  </h4>
                </div>
                <div role="group" aria-label={title} className="grid grid-cols-3 gap-4">
                  {TONE_OPTIONS[category].map((tone) => {
                    const selected = draft[category] === tone;
                    return (
                      <button
                        key={tone}
                        type="button"
                        aria-pressed={selected}
                        disabled={!toneStyleEnabled}
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
                            <span className="size-1.5 rounded-full bg-primary-foreground" />
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

        <div className="mt-6 flex justify-end">
          <Button
            variant={canSave ? "default" : "secondary"}
            className="h-8 border-transparent px-4 text-[13px] disabled:opacity-100 disabled:text-muted-foreground/60"
            disabled={!canSave}
            onClick={save}
          >
            {t("toneStyle.settings.saveChanges")}
          </Button>
        </div>
      </div>
    </div>
  );
}
