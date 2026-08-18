import type { ReactNode } from "react";
import { Undo2 } from "lucide-react";
import { Button } from "../ui/button";
import { useTranslation } from "react-i18next";

interface OnboardingShellProps {
  compact?: boolean;
  children: ReactNode;
  onBack?: () => void;
  onContinue?: () => void;
  onSkip?: () => void;
  continueLabel?: string;
  skipLabel?: string;
  continueDisabled?: boolean;
  continueLoading?: boolean;
  progressIndex?: number;
  showBackLabel?: boolean;
  /** Changing this replays the step entry animation. Pass the current step id. */
  stepKey?: string;
}

interface CompactOnboardingFrameProps {
  children: ReactNode;
  showBrandMark?: boolean;
  showLegalNotice?: boolean;
}

export function OnboardingProgress({ index }: { index: number }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-hidden="true">
      {/* Figma "Frame 26": 20x6 pills, filled light/text-primary, the remaining
          one on light/surface-stroke. */}
      {[0, 1, 2, 3].map((item) => (
        <span
          key={item}
          className={`h-1.5 w-5 rounded-full transition-colors ${
            item <= index
              ? "bg-[var(--onboarding-text-primary)]"
              : "bg-[var(--onboarding-control-border)]"
          }`}
        />
      ))}
    </div>
  );
}

export function OnboardingStepHeader({
  title,
  titleLines,
  description,
  descriptionLines,
  wideTitle = false,
}: {
  title: string;
  titleLines?: string[];
  description?: string;
  descriptionLines?: string[];
  wideTitle?: boolean;
}) {
  return (
    // Figma "Frame 29": 18 between the title and the description.
    <header className="mx-auto w-full max-w-lg space-y-[1.125rem] text-center">
      <h1
        // titleLines already carries the authored line breaks, so the 20rem
        // clamp only re-wraps them — "keyboard shortcut" is ~350px at 40px
        // Inter and was splitting across three lines. Lines still wrap inside
        // the header's 32rem cap if a translation runs long.
        className={`onboarding-display-title mx-auto text-neutral-950 ${
          wideTitle || titleLines ? "max-w-none" : "max-w-xs"
        }`}
      >
        {titleLines ? (
          <>
            <span className="sr-only">{title}</span>
            <span aria-hidden="true">
              {titleLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </span>
          </>
        ) : (
          title
        )}
      </h1>
      {(description || descriptionLines) && (
        // Figma: Inter Regular 16/140% on light/text-secondary.
        <p className="mx-auto max-w-md text-balance text-base leading-[1.4] text-[var(--onboarding-text-secondary)]">
          {descriptionLines ? (
            <>
              <span className="sr-only">{description}</span>
              <span aria-hidden="true">
                {descriptionLines.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </span>
            </>
          ) : (
            description
          )}
        </p>
      )}
    </header>
  );
}

export default function OnboardingShell({
  compact = false,
  children,
  onBack,
  onContinue,
  onSkip,
  continueLabel,
  skipLabel,
  continueDisabled = false,
  continueLoading = false,
  progressIndex,
  showBackLabel = false,
  stepKey,
}: OnboardingShellProps) {
  const { t } = useTranslation();
  const hasFooter = onBack || onContinue || onSkip || progressIndex !== undefined;

  return (
    <main
      className={`onboarding-canvas relative flex h-screen flex-col overflow-hidden ${compact ? "compact rounded-[44px]" : ""}`}
    >
      <div
        className="absolute inset-x-0 top-0 z-50 h-4"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        aria-hidden="true"
      />

      <div
        // Deliberately not scrollable: each step sizes itself to the window and
        // anything long (e.g. the language list) scrolls inside its own
        // container, so an outer scrollbar would just double up.
        className={`onboarding-shell-scroll min-h-0 flex-1 overflow-hidden ${compact ? "px-0 pb-0" : "px-6 py-8 md:px-12"}`}
      >
        <div
          // Keyed on the step so React remounts this subtree and the CSS entry
          // animation replays; without a changing key the div is reused and the
          // animation only ever runs once, on first paint.
          key={stepKey}
          // h-full, not min-h-full: a percentage height only resolves against a
          // parent with a definite height, so min-h-full would collapse any
          // flex-1 descendant back to content height and overflow the shell.
          className={`onboarding-step-enter mx-auto flex h-full w-full justify-center ${
            compact ? "max-w-none items-center" : "max-w-6xl items-stretch"
          }`}
        >
          {children}
        </div>
      </div>

      {hasFooter && (
        <footer className="shrink-0 px-6 pb-[4.5rem] pt-3 md:px-12">
          {/* Figma "Frame 2147258967": 24 between the button row and the dots. */}
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6">
            <div className="flex items-center justify-center gap-2">
              {onBack && (
                <Button
                  type="button"
                  variant="outline-flat"
                  // One size across both states: size="icon" pins a fixed 40x40
                  // box, which would leave nothing for the collapse to animate.
                  size="default"
                  onClick={onBack}
                  // One duration and curve for the pill and the label, so the
                  // min-width/padding collapse and the label collapse read as a
                  // single motion instead of two.
                  // Figma "Frame 32": stroke-only pill on light/surface-stroke, 38
                  // radius, 10/24 padding, gap 8, 20px glyph, Inter Medium 14/140%.
                  // No fill in Figma, so the page gradient reads through.
                  className={`h-10 rounded-[38px]! border! border-[var(--onboarding-control-border)]! text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)] transition-[background-color,border-color,color,transform,min-width,padding,gap] duration-[400ms] ease-[cubic-bezier(0.19,1,0.22,1)] ${
                    showBackLabel ? "gap-2 px-6" : "min-w-10 gap-0 px-0"
                  }`}
                  aria-label={t("common.back")}
                >
                  <Undo2 className="size-5" />
                  {/* The label collapses on a 0fr/1fr grid track rather than through
                      TextMorph. Morphing to "" sends torph down its collapse path,
                      which pins the span at its previous width for the full duration
                      and only releases to width:auto afterwards — the pill sat at
                      full width for 400ms and then snapped. A grid track animates
                      from the first frame, so this shares one curve with the
                      button's min-width/padding collapse. The aria-label carries the
                      name, so the hidden text costs nothing. */}
                  <span
                    className="grid overflow-hidden transition-[grid-template-columns,opacity] duration-[400ms] ease-[cubic-bezier(0.19,1,0.22,1)]"
                    style={{
                      gridTemplateColumns: showBackLabel ? "1fr" : "0fr",
                      opacity: showBackLabel ? 1 : 0,
                    }}
                  >
                    <span className="min-w-0 overflow-hidden whitespace-nowrap">
                      {t("common.back")}
                    </span>
                  </span>
                </Button>
              )}
              {onSkip && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onSkip}
                  className="h-10 min-w-[5.5rem] rounded-full px-4 text-sm"
                >
                  {skipLabel ?? t("common.skip")}
                </Button>
              )}
              {onContinue && (
                <Button
                  type="button"
                  onClick={onContinue}
                  disabled={continueDisabled || continueLoading}
                  // Figma "Onboarding / Frame 31 → Frame 25": flat brand fill, no
                  // shadow and no stroke, 10/24 padding, 38 radius, Inter Medium
                  // 14/140%. The fill is the onboarding accent (#4079ED), not
                  // blue-500. Frame 25 hugs its content at 39.6px tall, so the
                  // height is pinned to 40 to keep the pill aligned with the back
                  // and skip buttons beside it.
                  className="h-10 gap-4 rounded-[38px] border-0 bg-[var(--onboarding-accent)] px-6 py-2.5 text-sm font-medium leading-[1.4] tracking-normal text-white shadow-none! hover:bg-[color-mix(in_srgb,var(--onboarding-accent)_88%,black)] hover:shadow-none! disabled:bg-neutral-200 disabled:text-neutral-500 disabled:opacity-100!"
                >
                  {continueLoading ? t("common.loading") : (continueLabel ?? t("common.continue"))}
                </Button>
              )}
            </div>

            {progressIndex !== undefined && <OnboardingProgress index={progressIndex} />}
          </div>
        </footer>
      )}
    </main>
  );
}

export function CompactOnboardingFrame({
  children,
  showBrandMark = true,
  showLegalNotice = true,
}: CompactOnboardingFrameProps) {
  const { t } = useTranslation();

  return (
    <section className="relative flex h-full min-h-screen w-full flex-col overflow-hidden rounded-[44px] bg-white text-neutral-950 dark:bg-white dark:text-neutral-950">
      <div className="onboarding-compact-hero pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-indigo-400 via-indigo-300 to-white" />
      {showBrandMark && (
        <BrandMark className="pointer-events-none absolute left-1/2 top-13 z-10 size-28 -translate-x-1/2 text-white" />
      )}

      <div className="relative z-10 flex flex-1 flex-col">{children}</div>

      {showLegalNotice && (
        <p className="relative z-10 mx-auto mt-auto w-full max-w-xs shrink-0 px-2 pb-6 pt-5 text-center text-sm leading-5 text-neutral-500 dark:text-neutral-500">
          {t("auth.legal.prefix")}{" "}
          <a
            href="https://openwhispr.com/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-600 dark:hover:text-blue-500"
          >
            {t("auth.legal.terms")}
          </a>{" "}
          {t("auth.legal.and")}{" "}
          <a
            href="https://openwhispr.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-600 dark:hover:text-blue-500"
          >
            {t("auth.legal.privacy")}
          </a>
          {t("auth.legal.suffix")}
        </p>
      )}
    </section>
  );
}

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="512" cy="512" r="314" stroke="currentColor" strokeWidth="74" />
      <path d="M512 383V641" stroke="currentColor" strokeWidth="74" strokeLinecap="round" />
      <path d="M627 457V568" stroke="currentColor" strokeWidth="74" strokeLinecap="round" />
      <path d="M397 457V568" stroke="currentColor" strokeWidth="74" strokeLinecap="round" />
    </svg>
  );
}
