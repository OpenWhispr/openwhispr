import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { BidiInterpolatedText, BIDI_VALUE_TOKEN } from "../ui/BidiInterpolatedText";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  TONE_APP_CATEGORIES,
  TONE_OPTIONS,
  type ToneAppCategory,
  type ToneStyles,
} from "../../config/toneStyle";
import { AppMarkStack, ToneSample } from "./toneStyleVisuals";
import { CATEGORY_APP_MARKS } from "./appMarks";
import { dictationCleanupHasModel, turnOnDictationCleanup } from "./dictationCleanup";
import logo from "../../assets/logo.svg";
import notion from "../../assets/icons/apps/notion-glyph.svg";
import slack from "../../assets/icons/slack.svg";
import openai from "../../assets/icons/providers/openai.svg";

interface ToneStyleSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Settings at a section, for cleanup that still needs a model after setup. */
  onOpenSettings: (section: string) => void;
}

// The global h1–h6 rule (Yowza Soft 600, tight tracking) outranks utilities, so
// these titles force the design's medium weight, spacing and line height.
const TITLE_TYPE = "whitespace-pre-line font-medium! leading-[31px]! tracking-normal!";

// The intro art: OpenWhispr among the apps it writes into, fading out at the
// edges. Notion is its own gray app tile with the mark in white, as designed.
type IntroTile = { src: string; size: number; className: string; tileClassName?: string };
const INTRO_TILES: (IntroTile | "logo" | null)[] = [
  {
    src: notion,
    size: 36,
    className: "opacity-95",
    tileClassName:
      "border-transparent bg-gradient-to-br from-[#d4d4d4] to-[#a8a8a8] dark:from-[#4a4a4a] dark:to-[#2e2e2e]",
  },
  null,
  { src: slack, size: 40, className: "opacity-45 grayscale-[40%]" },
  null,
  "logo",
  null,
  null,
  { src: openai, size: 50, className: "opacity-25 dark:invert dark:opacity-30" },
  null,
];

function IntroArt() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-3 gap-2.5 [mask-image:radial-gradient(circle_at_50%_42%,black_38%,transparent_74%)]"
    >
      {INTRO_TILES.map((tile, index) =>
        tile === "logo" ? (
          <img
            key={index}
            src={logo}
            alt=""
            width={68}
            height={68}
            decoding="async"
            draggable={false}
            className="size-[68px] rounded-[18px] shadow-[0_0_0_3px_white,0_6px_16px_rgba(32,86,223,0.25)] dark:shadow-[0_0_0_3px_var(--color-surface-2),0_6px_16px_rgba(0,0,0,0.4)]"
          />
        ) : (
          <div
            key={index}
            className={cn(
              "flex size-[68px] items-center justify-center rounded-[18px] border border-primary/15 bg-card dark:bg-surface-2",
              tile?.tileClassName
            )}
          >
            {tile && (
              <img
                src={tile.src}
                alt=""
                width={tile.size}
                height={tile.size}
                decoding="async"
                draggable={false}
                className={tile.className}
              />
            )}
          </div>
        )
      )}
    </div>
  );
}

function Pager({ step, total }: { step: number; total: number }) {
  const { t } = useTranslation();
  return (
    <div
      role="img"
      aria-label={t("toneStyle.setup.progress", { current: step, total })}
      className="flex items-center justify-center gap-2"
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2 rounded-full transition-all duration-300",
            index + 1 === step ? "w-6 bg-primary" : "w-2 bg-border dark:bg-white/15"
          )}
        />
      ))}
    </div>
  );
}

export default function ToneStyleSetupDialog({
  open,
  onOpenChange,
  onOpenSettings,
}: ToneStyleSetupDialogProps) {
  const { t } = useTranslation();
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ToneStyles>(() => useSettingsStore.getState().toneStyles);

  // Every opening starts at the intro with the saved picks.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setDraft(useSettingsStore.getState().toneStyles);
  }, [open]);

  const start = () => {
    if (!useCleanupModel) turnOnDictationCleanup();
    setStep(1);
  };

  const finish = () => {
    const { setToneStyles, setToneStyleEnabled } = useSettingsStore.getState();
    setToneStyles(draft);
    setToneStyleEnabled(true);
    onOpenChange(false);
    if (!dictationCleanupHasModel()) onOpenSettings("intelligence");
  };

  const category: ToneAppCategory | null = step > 0 ? TONE_APP_CATEGORIES[step - 1] : null;
  const total = TONE_APP_CATEGORIES.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[838px] gap-0 px-8.5 pb-10 pt-10">
        {category === null ? (
          <div className="flex flex-col items-center text-center">
            <IntroArt />
            <DialogTitle className={cn("mt-[86px] text-[25px]", TITLE_TYPE)}>
              {useCleanupModel
                ? t("toneStyle.setup.introTitle")
                : t("toneStyle.setup.cleanupOffTitle")}
            </DialogTitle>
            <DialogDescription className="mt-4 text-[15px]">
              {useCleanupModel
                ? t("toneStyle.setup.introDescription")
                : t("toneStyle.setup.cleanupOffDescription")}
            </DialogDescription>
            <Button className="mt-[38px] h-[41px] px-7 text-[15px]" onClick={start}>
              {useCleanupModel ? t("toneStyle.setup.personalize") : t("toneStyle.turnOnAndSetUp")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <AppMarkStack marks={CATEGORY_APP_MARKS[category].dialog} size={40} />
            <DialogTitle className={cn("mt-4 text-center text-2xl", TITLE_TYPE)}>
              <BidiInterpolatedText
                text={t(`toneStyle.categories.${category}.question`, {
                  category: BIDI_VALUE_TOKEN,
                })}
                value={
                  <span className="text-primary">
                    {t(`toneStyle.categories.${category}.inline`)}
                  </span>
                }
                dir="auto"
              />
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("toneStyle.setup.stepDescription")}
            </DialogDescription>
            <div
              role="group"
              aria-label={t(`toneStyle.categories.${category}.title`)}
              className="mt-6 grid w-full grid-cols-3 gap-2.5"
            >
              {TONE_OPTIONS[category].map((tone) => {
                const selected = draft[category] === tone;
                return (
                  <button
                    key={tone}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setDraft((current) => ({ ...current, [category]: tone }))}
                    className={cn(
                      "flex h-[250px] flex-col gap-3 rounded-2xl border bg-muted/60 px-4.5 pb-4 text-start transition-colors",
                      category === "email" ? "pt-3.5" : "pt-7",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-white/5",
                      selected
                        ? "border-primary"
                        : "border-transparent shadow-[0_1px_3px_rgba(0,0,0,0.06)] hover:border-border"
                    )}
                  >
                    {/* A long translation is cut off above the label, fading out. */}
                    <div className="min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]">
                      <ToneSample category={category} tone={tone} selected={selected} />
                    </div>
                    <span className="self-center text-[15px] font-medium text-foreground">
                      {t(`toneStyle.tones.${tone}`)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-7.5">
              <Pager step={step} total={total} />
            </div>
            <div className="mt-7.5 flex items-center gap-3">
              <Button
                variant="secondary"
                className="h-10 min-w-[84px] border-transparent text-muted-foreground"
                onClick={() => setStep(step - 1)}
              >
                {t("common.back")}
              </Button>
              <Button
                className="h-10 min-w-[80px]"
                onClick={step === total ? finish : () => setStep(step + 1)}
              >
                {step === total ? t("toneStyle.setup.finish") : t("common.next")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
