import type { CSSProperties, ReactNode } from "react";
import type { OnboardingProgressState } from "./flow";
import { Copy, Minus, Square, Undo2, X } from "lucide-react";
import { Button } from "../ui/button";
import { useTranslation } from "react-i18next";
import { getPlatform } from "../../utils/platform";
import { useWindowControls } from "../../hooks/useWindowControls";
// Imported (not referenced by path) so Vite fingerprints it and it resolves
// under the packaged app's file:// origin. See .onboarding-compact-hero.
import heroDither from "@/assets/onboarding-hero-dither.webp";
import heroDitherDark from "@/assets/onboarding-hero-dither-dark.webp";
import onboardingBackgroundLight from "@/assets/onboarding-bg-light.svg";
import onboardingBackgroundDark from "@/assets/onboarding-bg-dark.svg";

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
 * Window controls for the frameless window on Windows and Linux — macOS uses
 * its native traffic lights, so OnboardingShell skips rendering this there.
 * Close hides to the tray; the persisted session resumes the flow on reopen,
 * so this is never a way to lose progress.
 */
function OnboardingWindowControls() {
  const { t } = useTranslation();
  const { isMaximized, minimize, toggleMaximize, close } = useWindowControls();

  const minimizeLabel = t("windowControls.minimize");
  const maximizeLabel = t(isMaximized ? "windowControls.restore" : "windowControls.maximize");
  const closeLabel = t("windowControls.close");
  const buttonClass =
    "inline-flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-tertiary)] focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)]";

  return (
    <div
      className="absolute right-3 top-3 z-[60] flex items-center gap-1"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <button
        type="button"
        onClick={minimize}
        title={minimizeLabel}
        aria-label={minimizeLabel}
        className={buttonClass}
      >
        <Minus className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={toggleMaximize}
        title={maximizeLabel}
        aria-label={maximizeLabel}
        className={buttonClass}
      >
        {isMaximized ? (
          <Copy className="size-4" aria-hidden="true" />
        ) : (
          <Square className="size-3.5" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={close}
        title={closeLabel}
        aria-label={closeLabel}
        className={buttonClass}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function OnboardingProgress({ index, total }: { index: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5" aria-hidden="true">
      {/* One pill per step in the live route; the compact 16px width keeps long
          conditional routes from making the footer feel oversized. */}
      {Array.from({ length: total }, (_, item) => (
        <span
          key={item}
          className={`h-1.5 w-4 rounded-full transition-colors ${
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
  description?: ReactNode;
  descriptionLines?: string[];
  wideTitle?: boolean;
}) {
  return (
    <header className="mx-auto w-full max-w-md space-y-3 text-center">
      <h1
        // titleLines already carries the authored line breaks. Lines can still
        // wrap inside the header's 32rem cap when a translation runs long.
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
        <p className="mx-auto max-w-xs text-balance text-sm leading-[1.5] text-[var(--onboarding-text-secondary)]">
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
      style={
        {
          "--onboarding-background-light": `url(${onboardingBackgroundLight})`,
          "--onboarding-background-dark": `url(${onboardingBackgroundDark})`,
        } as CSSProperties
      }
    >
      {/* 48px, not a sliver: this is the frameless window's only title bar, so
          it has to be a target someone can actually grab. Interactive overlays
          in this band need z-60 + app-region: no-drag and must live outside the
          step wrapper (a sibling here, or portalled to body) — the wrapper's
          entry animation retains a transform, capping its descendants below
          z-50. */}
      <div
        className="absolute inset-x-0 top-0 z-50 h-12"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
        aria-hidden="true"
      />
      {getPlatform() !== "darwin" && <OnboardingWindowControls />}

      <div
        // Normally nothing scrolls here: each step sizes itself to the window and
        // anything long (e.g. the language list) scrolls inside its own container.
        // auto rather than hidden is the short-display fallback — the expanded
        // window wants 910px of work area and centeredBounds clamps below that on
        // a 1366x768-class screen, where a step built from fixed heights would
        // otherwise clip with its controls unreachable. The bar itself is hidden
        // (.onboarding-shell-scroll), so on a tall display this is invisible and
        // cannot double up with an inner scroller.
        className={`onboarding-shell-scroll min-h-0 flex-1 overflow-y-auto ${compact ? "px-0 pb-0" : "px-5 pb-5 pt-8 md:px-8"}`}
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
        <footer className="shrink-0 px-5 pb-6 pt-2 md:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-3.5">
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
                  // Stroke-only pill so the page gradient reads through.
                  className={`h-9 rounded-[38px]! border! border-[var(--onboarding-control-border)]! text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)] transition-[background-color,border-color,color,transform,min-width,padding,gap] duration-[400ms] ease-[cubic-bezier(0.19,1,0.22,1)] ${
                    showBackLabel ? "gap-2 px-5" : "min-w-9 gap-0 px-0"
                  }`}
                  aria-label={t("common.back")}
                >
                  <Undo2 className="size-4" />
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
                  className="h-9 min-w-20 rounded-full px-4 text-sm"
                >
                  {skipLabel ?? t("common.skip")}
                </Button>
              )}
              {onContinue && (
                <Button
                  type="button"
                  onClick={onContinue}
                  disabled={continueDisabled || continueLoading}
                  // Flat brand fill with no shadow or stroke. It shares the same
                  // compact height as the Back and Skip controls.
                  className="h-9 gap-3 rounded-[38px] border-0 bg-[var(--onboarding-accent)] px-5 py-2 text-sm font-medium leading-[1.4] tracking-normal text-[var(--onboarding-accent-foreground)] shadow-none! hover:bg-[var(--onboarding-accent-hover)] hover:shadow-none! disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-tertiary)] disabled:opacity-100!"
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

  if (embedded) return <div className="onboarding-embedded-auth">{children}</div>;

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
          } as CSSProperties
        }
      />
      {showBrandMark && (
        <BrandMark className="pointer-events-none absolute left-1/2 top-13 z-10 size-28 -translate-x-1/2 text-white" />
      )}

      {/* The compact BrowserWindow is the authored 480x624 surface. This layer
          deliberately remains square and full-bleed: Electron owns the actual
          window clipping, so a second CSS radius cannot expose dark seams around
          the top or bottom edges. */}
      <div className="relative z-10 mx-auto flex w-full max-w-[30rem] flex-1 flex-col">
        {children}
      </div>

      {showLegalNotice && (
        <p className="relative z-10 mx-auto mt-auto w-full max-w-xs shrink-0 px-2 pb-4 pt-5 text-center text-sm leading-5 text-[var(--onboarding-text-secondary)]">
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
