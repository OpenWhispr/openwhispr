import type { CSSProperties, ReactNode } from "react";
import type { OnboardingProgressState } from "./flow";
import { Minus, Undo2, X } from "lucide-react";
import { Button } from "../ui/button";
import { useTranslation } from "react-i18next";
import { getPlatform } from "../../utils/platform";
// Imported (not referenced by path) so Vite fingerprints it and it resolves
// under the packaged app's file:// origin. See .onboarding-compact-hero.
import heroDither from "@/assets/onboarding-hero-dither.webp";
import heroDitherDark from "@/assets/onboarding-hero-dither-dark.webp";

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
  progress?: OnboardingProgressState | null;
  showBackLabel?: boolean;
  /** Changing this replays the step entry animation. Pass the current step id. */
  stepKey?: string;
}

interface CompactOnboardingFrameProps {
  children: ReactNode;
  showBrandMark?: boolean;
  showLegalNotice?: boolean;
  /**
   * AuthenticationStep and EmailVerificationStep also render inside the control
   * panel's SignInDialog, where the compact window chrome makes no sense: the
   * min-h-screen surface would blow out the dialog, and the --onboarding-*
   * tokens only exist inside .onboarding-canvas. Embedded drops the chrome and
   * lets the dialog size to its content.
   */
  embedded?: boolean;
}

/**
 * Minimise/close for the frameless window on Windows and Linux — macOS shows
 * its native traffic lights instead (the window manager keeps them visible on
 * the expanded scaffold). Close hides to the tray; the persisted session
 * resumes the flow on reopen, so this is never a way to lose progress.
 *
 * Expanded scaffold only: the compact card (auth, permissions) is a fixed
 * chromeless design and the window manager locks its chrome to match.
 */
function OnboardingWindowControls() {
  const { t } = useTranslation();
  if (getPlatform() === "darwin") return null;

  const buttonClass =
    "inline-flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-tertiary)] focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)]";

  return (
    <div
      className="absolute right-3 top-3 z-[60] flex items-center gap-1"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <button
        type="button"
        onClick={() => void window.electronAPI?.windowMinimize?.()}
        title={t("windowControls.minimize")}
        className={buttonClass}
      >
        <Minus className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void window.electronAPI?.windowClose?.()}
        title={t("windowControls.close")}
        className={buttonClass}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function OnboardingProgress({ index, total }: { index: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-hidden="true">
      {/* Figma "Frame 26": 20x6 pills, filled light/text-primary, the remaining
          ones on light/surface-stroke. Figma draws four because that is what the
          mock happened to show; the real count is one per step in the live route,
          which getOnboardingProgress derives (6-10 depending on whether the agent
          is allowed and which setup mode was picked). */}
      {Array.from({ length: total }, (_, item) => (
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
        className={`onboarding-display-title mx-auto text-[var(--onboarding-text-primary)] ${
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
  progress,
  showBackLabel = false,
  stepKey,
}: OnboardingShellProps) {
  const { t } = useTranslation();
  const hasFooter = onBack || onContinue || onSkip || progress;

  return (
    <main
      className={`onboarding-canvas relative flex h-screen flex-col overflow-hidden ${compact ? "compact" : ""}`}
    >
      {/* 48px, not a sliver: this is the frameless window's only title bar, so
          it has to be a target someone can actually grab. Interactive overlays
          in this band (window controls, the compact Skip) sit above it at z-60
          with app-region: no-drag. */}
      <div
        className="absolute inset-x-0 top-0 z-50 h-12"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        aria-hidden="true"
      />
      {!compact && <OnboardingWindowControls />}

      <div
        // Normally nothing scrolls here: each step sizes itself to the window and
        // anything long (e.g. the language list) scrolls inside its own container.
        // auto rather than hidden is the short-display fallback — the expanded
        // window wants 910px of work area and centeredBounds clamps below that on
        // a 1366x768-class screen, where a step built from fixed heights would
        // otherwise clip with its controls unreachable. The bar itself is hidden
        // (.onboarding-shell-scroll), so on a tall display this is invisible and
        // cannot double up with an inner scroller.
        className={`onboarding-shell-scroll min-h-0 flex-1 overflow-y-auto ${compact ? "px-0 pb-0" : "px-6 py-8 md:px-12"}`}
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
        <footer className="shrink-0 px-6 pb-13 pt-3 md:px-12">
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
                  className="h-10 gap-4 rounded-[38px] border-0 bg-[var(--onboarding-accent)] px-6 py-2.5 text-sm font-medium leading-[1.4] tracking-normal text-[var(--onboarding-accent-foreground)] shadow-none! hover:bg-[var(--onboarding-accent-hover)] hover:shadow-none! disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-tertiary)] disabled:opacity-100!"
                >
                  {continueLoading ? t("common.loading") : (continueLabel ?? t("common.continue"))}
                </Button>
              )}
            </div>

            {progress && <OnboardingProgress index={progress.index} total={progress.total} />}
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
  embedded = false,
}: CompactOnboardingFrameProps) {
  const { t } = useTranslation();

  if (embedded) return <>{children}</>;

  return (
    <section className="relative flex h-full min-h-screen w-full flex-col overflow-hidden bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)]">
      <div
        className="onboarding-compact-hero pointer-events-none absolute inset-x-0 top-0 h-48"
        // Both strips are handed over as custom properties and .onboarding-compact-hero
        // picks one per theme; the URLs have to come from here because only an import
        // gets fingerprinted by Vite and resolves under the packaged file:// origin.
        style={
          {
            "--onboarding-hero-dither-light": `url(${heroDither})`,
            "--onboarding-hero-dither-dark": `url(${heroDitherDark})`,
          } as React.CSSProperties
        }
      />
      {showBrandMark && (
        <BrandMark className="pointer-events-none absolute left-1/2 top-13 z-10 size-28 -translate-x-1/2 text-white" />
      )}

      {/* Capped at the compact window's own width (546, ONBOARDING_WINDOW_SIZES.COMPACT
          in windowConfig.js) and centred, so a viewport wider than the real window —
          the browser dev harness, or an unlocked window in dev tools — keeps the
          authored column instead of stretching the email field and the OAuth row
          edge to edge. The hero strip stays full-bleed above it: it is a background
          ramp, so it reads correctly at any width. */}
      <div className="relative z-10 mx-auto flex w-full max-w-[34.125rem] flex-1 flex-col">
        {children}
      </div>

      {showLegalNotice && (
        <p className="relative z-10 mx-auto mt-auto w-full max-w-xs shrink-0 px-2 pb-6 pt-5 text-center text-sm leading-5 text-[var(--onboarding-text-secondary)]">
          {t("auth.legal.prefix")}{" "}
          <a
            href="https://openwhispr.com/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--onboarding-link)] transition-colors hover:opacity-80"
          >
            {t("auth.legal.terms")}
          </a>{" "}
          {t("auth.legal.and")}{" "}
          <a
            href="https://openwhispr.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--onboarding-link)] transition-colors hover:opacity-80"
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
