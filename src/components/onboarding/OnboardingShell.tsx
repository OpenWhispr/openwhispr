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
}

interface CompactOnboardingFrameProps {
  children: ReactNode;
  showBrandMark?: boolean;
  showLegalNotice?: boolean;
}

export function OnboardingProgress({ index }: { index: number }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((item) => (
        <span
          key={item}
          className={`h-1.5 w-4 rounded-full transition-colors ${
            item <= index ? "bg-neutral-950" : "bg-neutral-200"
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
    <header className="mx-auto w-full max-w-lg space-y-3 text-center">
      <h1
        className={`onboarding-display-title mx-auto text-neutral-950 ${wideTitle ? "max-w-none" : "max-w-xs"}`}
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
        <p className="mx-auto max-w-md text-sm leading-5 text-neutral-500">
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
}: OnboardingShellProps) {
  const { t } = useTranslation();
  const hasFooter = onBack || onContinue || onSkip || progressIndex !== undefined;

  return (
    <main
      className={`onboarding-canvas relative flex h-screen flex-col overflow-hidden ${compact ? "compact rounded-[2rem]" : ""}`}
    >
      <div
        className="absolute inset-x-0 top-0 z-50 h-4"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        aria-hidden="true"
      />

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${compact ? "px-0 pb-0" : "px-6 py-8 md:px-12"}`}
      >
        <div
          className={`mx-auto flex min-h-full w-full justify-center ${
            compact ? "max-w-none items-center" : "max-w-6xl items-start"
          }`}
        >
          {children}
        </div>
      </div>

      {hasFooter && (
        <footer className="shrink-0 px-6 pb-[4.75rem] pt-3 md:px-12">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4">
            <div className="flex items-center justify-center gap-2">
              {onBack && (
                <Button
                  type="button"
                  variant="outline-flat"
                  size={showBackLabel ? "default" : "icon"}
                  onClick={onBack}
                  className={`h-9 rounded-full! border! border-neutral-200! bg-white! text-neutral-950 hover:bg-neutral-50! ${
                    showBackLabel ? "min-w-[5.5rem] px-4" : "w-9 p-0"
                  }`}
                  aria-label={t("common.back")}
                >
                  <Undo2 className="size-4" />
                  {showBackLabel && t("common.back")}
                </Button>
              )}
              {onSkip && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onSkip}
                  className="h-9 min-w-[5.5rem] rounded-full px-4 text-sm"
                >
                  {skipLabel ?? t("common.skip")}
                </Button>
              )}
              {onContinue && (
                <Button
                  type="button"
                  onClick={onContinue}
                  disabled={continueDisabled || continueLoading}
                  className="h-9 min-w-[5.5rem] rounded-full bg-blue-500 px-4 text-sm text-white hover:bg-blue-600 disabled:border-neutral-200 disabled:bg-neutral-200 disabled:text-neutral-500 disabled:opacity-100!"
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
    <section className="relative flex h-full min-h-screen w-full flex-col overflow-hidden rounded-[2rem] bg-white text-neutral-950 dark:bg-white dark:text-neutral-950">
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
